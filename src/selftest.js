// ============================================================================
// selftest.js — `npm run check`. The parts that must never be wrong, checked
// without a wallet: the wheel is 18/18, the arithmetic is fair, the beacon
// round math matches drand's clock, and a real beacon re-derives.
// ============================================================================

import assert from 'assert'
import crypto from 'crypto'
import { WHEEL, colorOf, spin, tieBreak, communityPick } from './wheel.js'
import { roundAt, publishedAt, beaconFor, fetchBeacon } from './drand.js'

// The wheel: 36 distinct numbers 1..36, strictly alternating colours.
assert.equal(WHEEL.length, 36)
assert.equal(new Set(WHEEL).size, 36)
assert.ok(WHEEL.every((n) => n >= 1 && n <= 36))
WHEEL.forEach((n, i) => assert.equal(colorOf(n), i % 2 === 0 ? 'red' : 'black', `pocket ${i} (${n})`))

// Fairness over many random beacons: both colours within 1% of half.
const N = 200_000
let reds = 0
let tieReds = 0
const pockets = new Array(36).fill(0)
for (let i = 0; i < N; i++) {
  const r = crypto.randomBytes(32).toString('hex')
  const s = spin(r, i)
  pockets[s.index]++
  if (s.color === 'red') reds++
  if (tieBreak(r, i) === 'red') tieReds++
}
assert.ok(Math.abs(reds / N - 0.5) < 0.01, `red share ${reds / N}`)
assert.ok(Math.abs(tieReds / N - 0.5) < 0.01, `tie red share ${tieReds / N}`)
assert.ok(pockets.every((c) => Math.abs(c / N - 1 / 36) < 0.003), 'pockets uniform')

assert.equal(communityPick({ red: 3, black: 1 }), 'red')
assert.equal(communityPick({ red: 0, black: 2 }), 'black')
assert.equal(communityPick({ red: 2, black: 2 }), null)

// Beacon clock: the round for a moment is never published before it.
for (let t = Date.now(); t < Date.now() + 60_000; t += 777) {
  const r = roundAt(t)
  assert.ok(publishedAt(r) >= t, 'round published at or after t')
  assert.ok(publishedAt(r - 1) < t, 'and it is the first such round')
}
const endsAt = Date.now()
assert.ok(publishedAt(beaconFor(endsAt)) >= endsAt + 1000, 'beacon is at least the margin after the bell')

// A real beacon, fetched and re-derived.
const past = roundAt(Date.now() - 30_000)
const b = await fetchBeacon(past, { timeoutMs: 15_000 })
const s = spin(b.randomness, 123)
console.info(`beacon ${b.round} from ${b.source}: ${b.randomness.slice(0, 16)}… → pocket ${s.number} ${s.color}`)

console.info(`ok — ${N.toLocaleString()} spins: ${((reds / N) * 100).toFixed(2)}% red`)
