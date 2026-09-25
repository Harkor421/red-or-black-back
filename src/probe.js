// ============================================================================
// probe.js — `npm run probe <mint> [<wallet>…]`. Reads a pump.fun coin the way
// the table does, simulates against mainnet — as the coin's creator, without
// any key — the claim a bell would send and a payout batch to the wallets
// given, and says what each of those wallets holds. Nothing is signed.
// ============================================================================

import { createChain, isWallet } from './chain.js'
import { config } from './config.js'

const chain = createChain()
const [mint, ...wallets] = process.argv.slice(2)
if (!mint) {
  console.error('usage: npm run probe <mint> [<wallet>…]')
  process.exit(1)
}
try {
  const coin = await chain.readCoin(mint)
  const minRaw = (BigInt(coin.supplyRaw) * BigInt(Math.round(config.minHoldPct * 10_000))) / 1_000_000n
  const ui = (raw) => (Number(raw) / 10 ** coin.decimals).toLocaleString('en-US')
  console.info(`\n${mint}`)
  console.info(`  venue ${coin.venue} · creator ${coin.creator} (${coin.creatorKind}) · decimals ${coin.decimals}` + (coin.mcapSol ? ` · mcap ${coin.mcapSol.toFixed(1)} SOL` : ''))
  console.info(`  to win you must hold ${ui(minRaw)} tokens (MIN_HOLD_PCT=${config.minHoldPct}%)`)
  if (coin.creatorKind !== 'wallet') {
    console.info('  the creator is not a wallet (fee sharing?) — this coin cannot be played live')
    process.exit(0)
  }
  const [v, bal] = await Promise.all([chain.vaults(coin.creator), chain.balance(coin.creator)])
  console.info(`  claimable ${(v.total / 1e9).toFixed(6)} SOL (curve ${v.curve} · amm ${v.amm} lamports) · creator wallet ${(bal / 1e9).toFixed(4)} SOL`)
  const claim = await chain.previewClaim(coin.creator)
  console.info(`  claim simulation: ${claim.empty ? 'nothing to claim' : claim.ok ? `ok (${claim.units} CU)` : claim.error}`)

  const good = wallets.filter(isWallet)
  for (const w of wallets.filter((w) => !isWallet(w))) console.info(`  ${w}: not a wallet (off-curve or invalid)`)
  if (good.length) {
    const held = await chain.holdings(good, coin)
    for (const w of good) {
      const h = held.get(w)
      const ok = h.payable && h.raw > 0n && h.raw >= minRaw
      console.info(`  ${w}: holds ${ui(h.raw)}${h.payable ? '' : ' · CANNOT RECEIVE SOL'} → ${ok ? 'eligible' : 'not eligible'}`)
    }
    const payable = good.filter((w) => held.get(w).payable)
    const share = BigInt(Math.floor(config.minShareSol * 1e9))
    const pay = await chain.previewTransfer(coin.creator, payable.slice(0, config.perTx).map((wallet) => ({ wallet, lamports: share })))
    console.info(`  payout of ${config.minShareSol} SOL to ${Math.min(payable.length, config.perTx)} payable wallet(s) simulation: ${pay.ok ? `ok (${pay.units} CU)` : pay.error}`)
  }
} catch (e) {
  console.info(`${mint}: ${e.message}`)
}
process.exit(0)
