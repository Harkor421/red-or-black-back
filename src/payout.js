// ============================================================================
// payout.js — how a pot becomes equal shares. Pure, so it is tested without a
// wallet (selftest.js) and the page can show exactly what the rule is.
//
//   winners   everyone who picked the colour the ball landed on AND held the
//             minimum at the bell, in the order they picked
//   budget    the pot, capped by what the wallet can spend above its reserve
//             and by MAX_PAYOUT_SOL, minus the fees of the transfers
//   share     budget ÷ winners, rounded down to the lamport
//
// A share below MIN_SHARE_SOL is not paid at all: the pot rolls over and grows
// until it can give every winner a real amount. Nobody is sent dust and told
// they won.
// ============================================================================

/**
 * @param {object} o
 * @param {bigint} o.potLamports       what the ledger says is in play
 * @param {bigint} o.spendableLamports what the wallet holds above its reserve (Infinity-like for demo)
 * @param {string[]} o.winners         eligible wallets, first pick first
 * @param {bigint} o.minShare
 * @param {bigint|null} o.maxPayout
 * @param {number} o.perTx
 * @param {(n:number)=>number} o.txFee lamports for one transaction of n transfers
 */
export function planPayout({ potLamports, spendableLamports, winners, minShare, maxPayout = null, perTx, txFee }) {
  const n = winners.length
  if (n === 0) return { ok: false, reason: 'nobody' }

  const batches = []
  for (let i = 0; i < n; i += perTx) batches.push(winners.slice(i, i + perTx))
  const fees = batches.reduce((acc, b) => acc + BigInt(txFee(b.length)), 0n)

  let budget = potLamports < spendableLamports ? potLamports : spendableLamports
  if (maxPayout != null && budget > maxPayout) budget = maxPayout
  budget -= fees
  if (budget <= 0n) return { ok: false, reason: 'too_small', fees, n }

  const share = budget / BigInt(n)
  if (share < minShare) return { ok: false, reason: 'too_small', share, fees, n }

  return {
    ok: true,
    share,
    total: share * BigInt(n),
    fees,
    batches: batches.map((b) => b.map((wallet) => ({ wallet, lamports: share }))),
  }
}
