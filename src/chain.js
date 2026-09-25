// ============================================================================
// chain.js — everything that touches Solana: read the coin, read the vaults,
// claim, buy, burn.
//
// The whole Solana stack is loaded through `require`, not `import`. The pump
// SDKs' ESM build does not load under Node (it named-imports from a CommonJS
// dependency), and loading web3.js as ESM next to an SDK that loaded it as
// CommonJS gives two different `PublicKey` classes — which works until some
// `instanceof` inside Anchor quietly says no. One module system, one class.
// ============================================================================

import { createRequire } from 'module'
import { config } from './config.js'

const require = createRequire(import.meta.url)
const web3 = require('@solana/web3.js')
const spl = require('@solana/spl-token')
const pump = require('@pump-fun/pump-sdk')
const amm = require('@pump-fun/pump-swap-sdk')
const BN = require('bn.js')
const bs58mod = require('bs58')
const bs58 = bs58mod.decode ? bs58mod : bs58mod.default

const {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  TransactionMessage,
  VersionedTransaction,
  LAMPORTS_PER_SOL,
} = web3

export { LAMPORTS_PER_SOL }
export const lamportsToSol = (l) => Number(l) / LAMPORTS_PER_SOL
export const solToLamports = (s) => BigInt(Math.floor(Number(s) * LAMPORTS_PER_SOL))

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const errMsg = (e) => (e instanceof Error ? e.message : String(e))

/** Fee payer's spend on the claim: collect on both programs, an ATA create and close. */
const CLAIM_CU = 200_000
/** Account rent a first buy can open (token ATA, volume accumulator) plus fees. Sized generously. */
const BUY_OVERHEAD_LAMPORTS = 6_000_000n
const CONFIRM_POLL_MS = 600
const REBROADCAST_EVERY_MS = 2000

export function isPubkey(s) {
  try {
    new PublicKey(s)
    return true
  } catch {
    return false
  }
}

/** A base58 64-byte secret, or a JSON byte array. Says what is wrong instead of crashing. */
export function parseSecret(raw) {
  const s = String(raw || '').trim()
  if (!s) return null
  const bytes = s.startsWith('[') ? Uint8Array.from(JSON.parse(s)) : bs58.decode(s)
  if (bytes.length !== 64) {
    throw new Error(
      `the secret key decodes to ${bytes.length} bytes, not 64 — a full base58 secret is 87–88 characters`
    )
  }
  return Keypair.fromSecretKey(bytes)
}

export function createChain() {
  const connection = new Connection(config.rpcUrl, 'confirmed')
  const pumpSdk = new pump.PumpSdk()
  const onlinePump = new pump.OnlinePumpSdk(connection)
  const ammSdk = new amm.PumpAmmSdk()
  const onlineAmm = new amm.OnlinePumpAmmSdk(connection)

  let globals = null
  const rentByLength = new Map()

  async function rentFor(len) {
    if (rentByLength.has(len)) return rentByLength.get(len)
    const r = await connection.getMinimumBalanceForRentExemption(len)
    rentByLength.set(len, r)
    return r
  }

  async function fetchGlobals() {
    if (globals && Date.now() - globals.at < 60_000) return globals
    const [global, feeConfig] = await Promise.all([onlinePump.fetchGlobal(), onlinePump.fetchFeeConfig()])
    globals = { global, feeConfig, at: Date.now() }
    return globals
  }

  // ── the coin ─────────────────────────────────────────────────────────────

  /**
   * Who created the coin, which token program owns it, and where it trades.
   *
   * The creator is read off the chain rather than configured, so the pot can
   * be shown before any key is set, and so a key that is not the creator's can
   * be refused instead of trusted. On the curve it is `bondingCurve.creator`;
   * once graduated the curve still exists but reads `complete`, and the pool's
   * `coinCreator` is the one pump-swap pays.
   */
  async function readCoin(mintStr) {
    const mint = new PublicKey(mintStr)
    const info = await connection.getAccountInfo(mint)
    if (!info) throw new Error(`mint ${mintStr} not found on chain`)
    const tokenProgram = info.owner.equals(spl.TOKEN_2022_PROGRAM_ID) ? spl.TOKEN_2022_PROGRAM_ID : spl.TOKEN_PROGRAM_ID
    const mintData = spl.unpackMint(mint, info, tokenProgram)

    let curve = null
    try {
      curve = await onlinePump.fetchBondingCurve(mint)
    } catch {
      curve = null
    }

    let creator = curve?.creator ?? null
    let venue = curve && !curve.complete ? 'curve' : 'amm'
    let mcapSol = null

    if (venue === 'curve') {
      const vt = BigInt(curve.virtualTokenReserves.toString())
      const vs = BigInt(curve.virtualQuoteReserves?.toString?.() ?? curve.virtualSolReserves?.toString?.() ?? '0')
      const supply = BigInt(curve.tokenTotalSupply.toString())
      if (vt > 0n) mcapSol = Number((vs * supply) / vt) / LAMPORTS_PER_SOL
    } else {
      try {
        const pool = await onlineAmm.fetchPool(amm.canonicalPumpPoolPda(mint))
        creator = pool.coinCreator ?? creator
      } catch {
        /* not a pump-swap coin either — the caller sees creator null */
      }
    }

    // A coin with pump.fun fee sharing turned on names a sharing-config PDA as
    // its creator, not a wallet. Nothing can sign for that address, so there
    // is nothing to claim as — say so instead of failing at the first claim.
    let creatorKind = null
    if (creator) {
      const ci = await connection.getAccountInfo(creator).catch(() => null)
      creatorKind = !ci || ci.owner.equals(web3.SystemProgram.programId) ? 'wallet' : 'program'
    }

    return {
      mint: mint.toBase58(),
      tokenProgram: tokenProgram.toBase58(),
      creatorKind,
      decimals: mintData.decimals,
      supplyRaw: mintData.supply.toString(),
      creator: creator ? creator.toBase58() : null,
      venue,
      mcapSol,
    }
  }

  // ── the vaults ───────────────────────────────────────────────────────────

  /**
   * What the creator can claim right now, in lamports, from both programs:
   * the pump curve vault (lamports above its own rent) and the pump-swap
   * vault (a WSOL token account). One RPC call.
   */
  async function vaults(creatorStr) {
    const creator = new PublicKey(creatorStr)
    const curveVault = pump.creatorVaultPda(creator)
    const ammVault = amm.coinCreatorVaultAtaPda(amm.coinCreatorVaultAuthorityPda(creator), spl.NATIVE_MINT, spl.TOKEN_PROGRAM_ID)
    const [c, a] = await connection.getMultipleAccountsInfo([curveVault, ammVault], 'confirmed')
    const curve = c ? Math.max(0, c.lamports - (await rentFor(c.data.length))) : 0
    const ammLamports = a ? Number(spl.unpackAccount(ammVault, a, spl.TOKEN_PROGRAM_ID).amount) : 0
    return { curve, amm: ammLamports, total: curve + ammLamports }
  }

  const balance = (pk) => connection.getBalance(new PublicKey(pk), 'confirmed')

  async function tokenBalance(ownerStr, mintStr, tokenProgramStr) {
    const ata = spl.getAssociatedTokenAddressSync(
      new PublicKey(mintStr),
      new PublicKey(ownerStr),
      true,
      new PublicKey(tokenProgramStr)
    )
    const info = await connection.getAccountInfo(ata, 'confirmed')
    if (!info) return { ata: ata.toBase58(), raw: 0n, exists: false }
    const acc = spl.unpackAccount(ata, info, new PublicKey(tokenProgramStr))
    return { ata: ata.toBase58(), raw: acc.amount, exists: true }
  }

  // ── sending ──────────────────────────────────────────────────────────────

  /**
   * Build, sign, simulate, send, confirm.
   *
   * The transaction is signed BEFORE it is broadcast, so its signature is
   * known even when the send throws — `onSigned` gets it first, which is what
   * lets the caller write it down before any money can move. A send or a
   * confirm that throws does not mean the transaction did not land; only a
   * status that is still empty after the blockhash expired means that.
   */
  function build(instructions, payer, cu, blockhash) {
    return new VersionedTransaction(
      new TransactionMessage({
        payerKey: payer,
        recentBlockhash: blockhash,
        instructions: [
          ComputeBudgetProgram.setComputeUnitLimit({ units: cu ?? 200_000 }),
          ComputeBudgetProgram.setComputeUnitPrice({ microLamports: config.priorityFeeMicroLamports }),
          ...instructions,
        ],
      }).compileToV0Message()
    )
  }

  /** Every way a transaction can fail reads as "reverted" from outside; the simulation log names it, and costs nothing. */
  async function simulate(tx) {
    const sim = await connection.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true, commitment: 'confirmed' })
    if (!sim.value.err) return { ok: true, units: sim.value.unitsConsumed ?? null }
    const named = (sim.value.logs || []).find((l) => /AnchorError|Error Code:|insufficient|failed|custom program error/i.test(l))
    return { ok: false, error: named ? named.replace(/^Program log:\s*/, '') : JSON.stringify(sim.value.err), units: sim.value.unitsConsumed ?? null }
  }

  async function send(instructions, signer, { cu, onSigned } = {}) {
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed')
    const tx = build(instructions, signer.publicKey, cu, blockhash)
    tx.sign([signer])
    const signature = bs58.encode(tx.signatures[0])

    const sim = await simulate(tx)
    if (!sim.ok) throw new Error(`rejected in simulation: ${sim.error}`)

    await onSigned?.(signature, lastValidBlockHeight)
    const raw = tx.serialize()
    try {
      await connection.sendRawTransaction(raw, { skipPreflight: true, maxRetries: 0 })
    } catch (e) {
      console.warn(`[chain] first send of ${signature} threw (${errMsg(e)}) — confirming anyway`)
    }
    const landed = await confirm(signature, lastValidBlockHeight, raw)
    return { signature, landed }
  }

  /** Poll until confirmed or the blockhash expires, re-sending the same bytes meanwhile. */
  async function confirm(sig, lastValidBlockHeight, raw) {
    const status = async (history = false) => {
      const st = await connection.getSignatureStatuses([sig], { searchTransactionHistory: history })
      const s = st?.value?.[0]
      if (s?.err) throw new Error(`${sig} landed but failed: ${JSON.stringify(s.err)}`)
      return s?.confirmationStatus === 'confirmed' || s?.confirmationStatus === 'finalized'
    }
    let lastRebroadcast = Date.now()
    const hardDeadline = Date.now() + 120_000
    while (Date.now() < hardDeadline) {
      try {
        if (await status()) return true
      } catch (e) {
        if (/landed but failed/.test(errMsg(e))) throw e
      }
      if (Date.now() - lastRebroadcast > REBROADCAST_EVERY_MS) {
        lastRebroadcast = Date.now()
        connection.sendRawTransaction(raw, { skipPreflight: true, maxRetries: 0 }).catch(() => {})
        try {
          const h = await connection.getBlockHeight('confirmed')
          // Expired: one last look with history, in case it landed in the
          // final slots and the status is only now visible.
          if (h > lastValidBlockHeight) return await status(true)
        } catch {
          /* keep polling */
        }
      }
      await sleep(CONFIRM_POLL_MS)
    }
    return await status(true)
  }

  /** Whether an already-signed transaction landed. Used to reconcile after a restart. */
  async function landed(sig) {
    const st = await connection.getSignatureStatuses([sig], { searchTransactionHistory: true })
    const s = st?.value?.[0]
    if (!s) return null
    if (s.err) return false
    return s.confirmationStatus === 'confirmed' || s.confirmationStatus === 'finalized' ? true : null
  }

  /**
   * What a landed transaction actually did to the payer: SOL out (fees and
   * rent included) and tokens in. Read from the transaction's own balances,
   * which is exact, instead of from two balance reads racing other trades.
   */
  async function effects(sig, ownerStr, mintStr) {
    for (let i = 0; i < 20; i++) {
      const tx = await connection
        .getTransaction(sig, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' })
        .catch(() => null)
      if (tx?.meta) {
        // Index 0 is the fee payer, which is the creator wallet in every transaction sent here.
        const solOut = BigInt(tx.meta.preBalances[0]) - BigInt(tx.meta.postBalances[0])
        const tok = (list) =>
          (list || [])
            .filter((b) => b.mint === mintStr && b.owner === ownerStr)
            .reduce((acc, b) => acc + BigInt(b.uiTokenAmount.amount), 0n)
        const tokensIn = tok(tx.meta.postTokenBalances) - tok(tx.meta.preTokenBalances)
        return { solOut, tokensIn }
      }
      await sleep(1000)
    }
    return null
  }

  // ── claim ────────────────────────────────────────────────────────────────

  /**
   * Collect the creator's fees from both programs into the creator wallet.
   * The creator pays the fee, which is what makes the SDK unwrap the WSOL the
   * pump-swap leg pays out — SOL lands as SOL.
   *
   * A leg whose vault is empty is dropped: the pump-swap leg would otherwise
   * pay rent to open vault accounts that hold nothing.
   */
  async function claim(kp, v, { onSigned } = {}) {
    let ixs = await onlinePump.collectCoinCreatorFeeInstructions(kp.publicKey, kp.publicKey)
    ixs = ixs.filter((ix) => (ix.programId.equals(pump.PUMP_PROGRAM_ID) ? v.curve > 0 : v.amm > 0))
    if (ixs.length === 0) return null
    return send(ixs, kp, { cu: CLAIM_CU, onSigned })
  }

  // ── buy ──────────────────────────────────────────────────────────────────

  /**
   * The instructions that spend `lamports` of SOL on the coin, on whichever
   * venue holds it right now. A coin trades on the curve until it fills, then
   * on pump-swap; a buy sent to the wrong program reverts. `complete` is
   * re-read here, not cached — this runs a handful of times an hour.
   */
  async function buyInstructions(kp, coin, lamports) {
    const mint = new PublicKey(coin.mint)
    const tokenProgram = new PublicKey(coin.tokenProgram)
    const slippagePct = config.slippageBps / 100
    const solAmount = new BN(lamports.toString())

    let onCurve = false
    let state = null
    try {
      state = await onlinePump.fetchBuyState(mint, kp.publicKey, tokenProgram)
      onCurve = !state.bondingCurve.complete
    } catch {
      onCurve = false
    }

    if (onCurve) {
      const { global, feeConfig } = await fetchGlobals()
      const amount = pump.getBuyTokenAmountFromSolAmount({
        global,
        feeConfig,
        mintSupply: state.bondingCurve.tokenTotalSupply,
        bondingCurve: state.bondingCurve,
        amount: solAmount,
        quoteMint: spl.NATIVE_MINT,
      })
      const ixs = await pumpSdk.buyInstructions({
        global,
        bondingCurveAccountInfo: state.bondingCurveAccountInfo,
        bondingCurve: state.bondingCurve,
        associatedUserAccountInfo: state.associatedUserAccountInfo,
        mint,
        user: kp.publicKey,
        amount,
        solAmount,
        slippage: slippagePct,
        tokenProgram,
      })
      return { ixs, venue: 'curve', cu: 250_000 }
    }

    const poolKey = amm.canonicalPumpPoolPda(mint)
    const swapState = await onlineAmm.swapSolanaState(poolKey, kp.publicKey)
    const ixs = await ammSdk.buyQuoteInput(swapState, solAmount, slippagePct)
    return { ixs, venue: 'amm', cu: 320_000 }
  }

  /**
   * How much of `potLamports` a buy can actually use: the pot, capped by what
   * the wallet holds above the reserve and the rent a first buy opens, then
   * shrunk by the slippage the program may take on top of the order.
   */
  async function buyBudget(kp, potLamports) {
    const bal = BigInt(await balance(kp.publicKey))
    const reserve = solToLamports(config.leaveSol) + BUY_OVERHEAD_LAMPORTS
    let spend = potLamports
    if (config.maxBuySol != null) {
      const cap = solToLamports(config.maxBuySol)
      if (spend > cap) spend = cap
    }
    if (spend > bal - reserve) spend = bal - reserve
    if (spend < 0n) spend = 0n
    const order = (spend * 10_000n) / (10_000n + BigInt(config.slippageBps))
    return { order, walletLamports: bal }
  }

  async function buy(kp, coin, lamports, { onSigned } = {}) {
    const plan = await buyInstructions(kp, coin, lamports)
    const res = await send(plan.ixs, kp, { cu: plan.cu, onSigned })
    return { ...res, venue: plan.venue }
  }

  // ── burn ─────────────────────────────────────────────────────────────────

  async function burn(kp, coin, rawAmount, { onSigned } = {}) {
    const mint = new PublicKey(coin.mint)
    const tokenProgram = new PublicKey(coin.tokenProgram)
    const ata = spl.getAssociatedTokenAddressSync(mint, kp.publicKey, true, tokenProgram)
    const ix = spl.createBurnCheckedInstruction(ata, mint, kp.publicKey, rawAmount, coin.decimals, [], tokenProgram)
    return send([ix], kp, { cu: 60_000, onSigned })
  }

  /**
   * The buy a win WOULD send, built for the creator's address and simulated
   * against mainnet without a signature. This is what a dry run shows: not
   * "we would have bought", but "this exact transaction would have worked".
   */
  async function previewBuy(ownerStr, coin, lamports) {
    const owner = { publicKey: new PublicKey(ownerStr) }
    const plan = await buyInstructions(owner, coin, lamports)
    const { blockhash } = await connection.getLatestBlockhash('confirmed')
    return { venue: plan.venue, ...(await simulate(build(plan.ixs, owner.publicKey, plan.cu, blockhash))) }
  }

  async function previewBurn(ownerStr, coin, rawAmount) {
    const owner = new PublicKey(ownerStr)
    const mint = new PublicKey(coin.mint)
    const tokenProgram = new PublicKey(coin.tokenProgram)
    const ata = spl.getAssociatedTokenAddressSync(mint, owner, true, tokenProgram)
    const ix = spl.createBurnCheckedInstruction(ata, mint, owner, rawAmount, coin.decimals, [], tokenProgram)
    const { blockhash } = await connection.getLatestBlockhash('confirmed')
    return simulate(build([ix], owner, 60_000, blockhash))
  }

  async function previewClaim(creatorStr) {
    const creator = new PublicKey(creatorStr)
    const v = await vaults(creatorStr)
    let ixs = await onlinePump.collectCoinCreatorFeeInstructions(creator, creator)
    ixs = ixs.filter((ix) => (ix.programId.equals(pump.PUMP_PROGRAM_ID) ? v.curve > 0 : v.amm > 0))
    if (!ixs.length) return { ok: true, empty: true, vaults: v }
    const { blockhash } = await connection.getLatestBlockhash('confirmed')
    return { vaults: v, ...(await simulate(build(ixs, creator, CLAIM_CU, blockhash))) }
  }

  return {
    connection,
    previewBuy,
    previewBurn,
    previewClaim,
    readCoin,
    vaults,
    balance,
    tokenBalance,
    claim,
    buyBudget,
    buy,
    burn,
    landed,
    effects,
  }
}
