// ============================================================================
// selftest.js — `npm run check`. The parts that must never be wrong, checked
// without a wallet: the wheel is 18/18, the arithmetic is fair, the beacon
// round math matches drand's clock, and a real beacon re-derives.
// ============================================================================

import assert from 'assert'
import crypto from 'crypto'
import { WHEEL, colorOf, spin } from './wheel.js'
import { roundAt, publishedAt, beaconFor, fetchBeacon } from './drand.js'
import { planPayout } from './payout.js'

// The wheel: 36 distinct numbers 1..36, strictly alternating colours.
assert.equal(WHEEL.length, 36)
assert.equal(new Set(WHEEL).size, 36)
assert.ok(WHEEL.every((n) => n >= 1 && n <= 36))
WHEEL.forEach((n, i) => assert.equal(colorOf(n), i % 2 === 0 ? 'red' : 'black', `pocket ${i} (${n})`))

// Fairness over many random beacons: both colours within 1% of half.
const N = 200_000
let reds = 0
const pockets = new Array(36).fill(0)
for (let i = 0; i < N; i++) {
  const r = crypto.randomBytes(32).toString('hex')
  const s = spin(r, i)
  pockets[s.index]++
  if (s.color === 'red') reds++
}
assert.ok(Math.abs(reds / N - 0.5) < 0.01, `red share ${reds / N}`)
assert.ok(pockets.every((c) => Math.abs(c / N - 1 / 36) < 0.003), 'pockets uniform')

// Beacon clock: the round for a moment is never published before it.
for (let t = Date.now(); t < Date.now() + 60_000; t += 777) {
  const r = roundAt(t)
  assert.ok(publishedAt(r) >= t, 'round published at or after t')
  assert.ok(publishedAt(r - 1) < t, 'and it is the first such round')
}
const endsAt = Date.now()
assert.ok(publishedAt(beaconFor(endsAt)) >= endsAt + 1000, 'beacon is at least the margin after the bell')

// Equal shares: floor division, fees off the top, dust never sent.
const fee = (n) => 5000 + n * 60
const ws = (n) => Array.from({ length: n }, (_, i) => `w${i}`)
{
  const p = planPayout({ potLamports: 1_000_000_000n, spendableLamports: 10n ** 12n, winners: ws(3), minShare: 1_000_000n, perTx: 16, txFee: fee })
  assert.ok(p.ok)
  assert.equal(p.batches.length, 1)
  assert.equal(p.share, (1_000_000_000n - BigInt(fee(3))) / 3n)
  assert.ok(p.total + p.fees <= 1_000_000_000n, 'never spends more than the pot')
}
{
  // 40 winners → 3 batches of 16/16/8, each with its own fee.
  const p = planPayout({ potLamports: 2_000_000_000n, spendableLamports: 10n ** 12n, winners: ws(40), minShare: 1_000_000n, perTx: 16, txFee: fee })
  assert.deepEqual(p.batches.map((b) => b.length), [16, 16, 8])
  assert.equal(p.fees, BigInt(fee(16) * 2 + fee(8)))
  assert.ok(p.total + p.fees <= 2_000_000_000n)
}
// The wallet caps the pot; a share under the floor rolls over; nobody is nobody.
assert.equal(planPayout({ potLamports: 5_000_000_000n, spendableLamports: 100_000_000n, winners: ws(2), minShare: 1n, perTx: 16, txFee: fee }).share, (100_000_000n - BigInt(fee(2))) / 2n)
assert.equal(planPayout({ potLamports: 5_000_000n, spendableLamports: 10n ** 12n, winners: ws(10), minShare: 1_000_000n, perTx: 16, txFee: fee }).reason, 'too_small')
assert.equal(planPayout({ potLamports: 5_000_000n, spendableLamports: 10n ** 12n, winners: [], minShare: 1n, perTx: 16, txFee: fee }).reason, 'nobody')
assert.equal(planPayout({ potLamports: 5_000_000_000n, spendableLamports: 10n ** 12n, winners: ws(1), minShare: 1n, maxPayout: 1_000_000_000n, perTx: 16, txFee: fee }).share, 1_000_000_000n - BigInt(fee(1)))

// A real beacon, fetched and re-derived.
const past = roundAt(Date.now() - 30_000)
const b = await fetchBeacon(past, { timeoutMs: 15_000 })
const s = spin(b.randomness, 123)
console.info(`beacon ${b.round} from ${b.source}: ${b.randomness.slice(0, 16)}… → pocket ${s.number} ${s.color}`)

console.info(`ok — ${N.toLocaleString()} spins: ${((reds / N) * 100).toFixed(2)}% red`)
