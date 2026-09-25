// ============================================================================
// probe.js — `npm run probe <mint> [<mint>…]`. Reads a pump.fun coin the way
// the table does and simulates, against mainnet and without any key, the claim
// and the buy a win would send as that coin's creator. Nothing is signed.
// ============================================================================

import { createChain } from './chain.js'

const chain = createChain()
const mints = process.argv.slice(2)
if (!mints.length) {
  console.error('usage: npm run probe <mint> [<mint>…]')
  process.exit(1)
}
for (const mint of mints) {
  try {
    const coin = await chain.readCoin(mint)
    console.info(`\n${mint}`)
    console.info(`  venue ${coin.venue} · creator ${coin.creator} (${coin.creatorKind}) · decimals ${coin.decimals}` + (coin.mcapSol ? ` · mcap ${coin.mcapSol.toFixed(1)} SOL` : ''))
    if (coin.creatorKind !== 'wallet') {
      console.info('  the creator is not a wallet (fee sharing?) — this coin cannot be played live')
      continue
    }
    const [v, bal, held] = await Promise.all([
      chain.vaults(coin.creator),
      chain.balance(coin.creator),
      chain.tokenBalance(coin.creator, coin.mint, coin.tokenProgram),
    ])
    console.info(`  claimable ${(v.total / 1e9).toFixed(6)} SOL (curve ${v.curve} · amm ${v.amm} lamports) · creator wallet ${(bal / 1e9).toFixed(4)} SOL`)
    const claim = await chain.previewClaim(coin.creator)
    console.info(`  claim simulation: ${claim.empty ? 'nothing to claim' : claim.ok ? `ok (${claim.units} CU)` : claim.error}`)
    const lamports = BigInt(Math.max(1_000_000, Math.min(20_000_000, Math.floor(bal * 0.3))))
    const buy = await chain.previewBuy(coin.creator, coin, lamports)
    console.info(`  buy of ${Number(lamports) / 1e9} SOL simulation: ${buy.ok ? `ok on the ${buy.venue} (${buy.units} CU)` : buy.error}`)
    if (held.raw > 0n) {
      const burn = await chain.previewBurn(coin.creator, coin, 1n)
      console.info(`  burn simulation: ${burn.ok ? 'ok' : burn.error}`)
    }
  } catch (e) {
    console.info(`${mint}: ${e.message}`)
  }
}
process.exit(0)
