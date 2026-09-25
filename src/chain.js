// ============================================================================
// chain.js — everything that touches Solana: read the coin, read the vaults,
// read what a wallet holds, claim, pay.
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
const bs58mod = require('bs58')
const bs58 = bs58mod.decode ? bs58mod : bs58mod.default

const { ComputeBudgetProgram, Connection, Keypair, PublicKey, SystemProgram, TransactionMessage, VersionedTransaction, LAMPORTS_PER_SOL } = web3

export { LAMPORTS_PER_SOL }
export const lamportsToSol = (l) => Number(l) / LAMPORTS_PER_SOL
export const solToLamports = (s) => BigInt(Math.floor(Number(s) * LAMPORTS_PER_SOL))

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** Collect on both programs, an ATA create and close. */
const CLAIM_CU = 200_000
const CONFIRM_POLL_MS = 600
const REBROADCAST_EVERY_MS = 2000
/** getMultipleAccountsInfo takes at most 100 keys. */
const ACCOUNTS_PER_RPC = 100

export function isPubkey(s) {
  try {
    new PublicKey(s)
    return true
  } catch {
    return false
  }
}

/**
 * A wallet a person can own: a valid address ON the ed25519 curve. Program
 * addresses (pools, bonding curves, vaults) are off-curve by construction, so
 * this keeps every one of them out of the line without a list to maintain.
 */
export function isWallet(s) {
  try {
    return PublicKey.isOnCurve(new PublicKey(s).toBytes())
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
    throw new Error(`the secret key decodes to ${bytes.length} bytes, not 64 — a full base58 secret is 87–88 characters`)
  }
  return Keypair.fromSecretKey(bytes)
}

export function createChain() {
  const connection = new Connection(config.rpcUrl, 'confirmed')
  const onlinePump = new pump.OnlinePumpSdk(connection)
  const onlineAmm = new amm.OnlinePumpAmmSdk(connection)
  const rentByLength = new Map()

  async function rentFor(len) {
    if (rentByLength.has(len)) return rentByLength.get(len)
    const r = await connection.getMinimumBalanceForRentExemption(len)
    rentByLength.set(len, r)
    return r
  }

  // ── the coin ─────────────────────────────────────────────────────────────

  /**
   * Who created the coin, which token program owns it, its supply, and where
   * it trades. The creator is read off the chain rather than configured, so
   * the pot can be shown before any key is set and a key that is not the
   * creator's can be refused. On the curve it is `bondingCurve.creator`; once
   * graduated, the pool's `coinCreator` is the one pump-swap pays.
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
    const venue = curve && !curve.complete ? 'curve' : 'amm'
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
      creatorKind = !ci || ci.owner.equals(SystemProgram.programId) ? 'wallet' : 'program'
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

  // ── holdings ─────────────────────────────────────────────────────────────

  /**
   * For each wallet: what it holds of the coin (raw, from its associated token
   * account — a wallet with no ATA holds 0) and whether it can be paid.
   *
   * "Payable" is not the same as "a valid address on the curve". The System
   * Program's own address is on the curve, and anyone can open a token account
   * for it and send it tokens; a transfer to it fails with "changed the balance
   * of a read-only account" and takes the whole batch down with it. So a
   * recipient must be either a fresh address (nothing there yet) or a plain
   * system-owned, non-executable account. Fifty wallets per RPC call.
   */
  async function holdings(wallets, coin) {
    const out = new Map()
    const mint = new PublicKey(coin.mint)
    const program = new PublicKey(coin.tokenProgram)
    const per = ACCOUNTS_PER_RPC / 2
    for (let i = 0; i < wallets.length; i += per) {
      const batch = wallets.slice(i, i + per)
      const keys = []
      for (const w of batch) {
        const owner = new PublicKey(w)
        keys.push(spl.getAssociatedTokenAddressSync(mint, owner, false, program), owner)
      }
      const infos = await connection.getMultipleAccountsInfo(keys, 'confirmed')
      batch.forEach((w, j) => {
        const ata = infos[2 * j]
        const acct = infos[2 * j + 1]
        out.set(w, {
          raw: ata ? spl.unpackAccount(keys[2 * j], ata, program).amount : 0n,
          payable: !acct || (acct.owner.equals(SystemProgram.programId) && !acct.executable),
        })
      })
    }
    return out
  }

  // ── sending ──────────────────────────────────────────────────────────────

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

  /**
   * Build, sign, simulate, send, confirm.
   *
   * The transaction is signed BEFORE it is broadcast, so its signature is
   * known even when the send throws — `onSigned` gets it first, which is what
   * lets the caller write it down before any money can move. A send or a
   * confirm that throws does not mean the transaction did not land; only a
   * status that is still empty after the blockhash expired means that.
   */
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
      console.warn(`[chain] first send of ${signature} threw (${e?.message ?? e}) — confirming anyway`)
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
        if (/landed but failed/.test(e?.message ?? '')) throw e
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

  /** Whether an already-signed transaction landed: true, false (landed with an error), or null (not seen). */
  async function landed(sig) {
    const st = await connection.getSignatureStatuses([sig], { searchTransactionHistory: true })
    const s = st?.value?.[0]
    if (!s) return null
    if (s.err) return false
    return s.confirmationStatus === 'confirmed' || s.confirmationStatus === 'finalized' ? true : null
  }

  // ── claim ────────────────────────────────────────────────────────────────

  function claimInstructions(creator, v) {
    return onlinePump
      .collectCoinCreatorFeeInstructions(creator, creator)
      .then((ixs) => ixs.filter((ix) => (ix.programId.equals(pump.PUMP_PROGRAM_ID) ? v.curve > 0 : v.amm > 0)))
  }

  /**
   * Collect the creator's fees from both programs into the creator wallet.
   * The creator pays the fee, which is what makes the SDK unwrap the WSOL the
   * pump-swap leg pays out — SOL lands as SOL. A leg whose vault is empty is
   * dropped: the pump-swap leg would otherwise pay rent to open vault
   * accounts that hold nothing.
   */
  async function claim(kp, v, { onSigned } = {}) {
    const ixs = await claimInstructions(kp.publicKey, v)
    if (ixs.length === 0) return null
    return send(ixs, kp, { cu: CLAIM_CU, onSigned })
  }

  async function previewClaim(creatorStr) {
    const creator = new PublicKey(creatorStr)
    const v = await vaults(creatorStr)
    const ixs = await claimInstructions(creator, v)
    if (!ixs.length) return { ok: true, empty: true, vaults: v }
    const { blockhash } = await connection.getLatestBlockhash('confirmed')
    return { vaults: v, ...(await simulate(build(ixs, creator, CLAIM_CU, blockhash))) }
  }

  // ── pay ──────────────────────────────────────────────────────────────────

  const transferCu = (n) => 1_000 + 300 * n
  const transferIxs = (from, recipients) =>
    recipients.map((r) => SystemProgram.transfer({ fromPubkey: from, toPubkey: new PublicKey(r.wallet), lamports: BigInt(r.lamports) }))

  /** Native SOL to many wallets in one transaction. No swap, no token account — nothing that can revert but the balance. */
  function transferMany(kp, recipients, { onSigned } = {}) {
    return send(transferIxs(kp.publicKey, recipients), kp, { cu: transferCu(recipients.length), onSigned })
  }

  /** The same batch, built for the creator's address and simulated on mainnet without a signature. */
  async function previewTransfer(ownerStr, recipients) {
    const owner = new PublicKey(ownerStr)
    const { blockhash } = await connection.getLatestBlockhash('confirmed')
    return simulate(build(transferIxs(owner, recipients), owner, transferCu(recipients.length), blockhash))
  }

  /** Lamports one transaction of `n` transfers costs: the signature plus the priority it asks for. */
  const txFee = (n) => 5_000 + Math.ceil((config.priorityFeeMicroLamports * transferCu(n)) / 1_000_000)

  return {
    connection,
    readCoin,
    vaults,
    balance,
    holdings,
    claim,
    previewClaim,
    transferMany,
    previewTransfer,
    txFee,
    landed,
  }
}
