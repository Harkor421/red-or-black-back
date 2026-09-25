// ============================================================================
// drand.js — the randomness, and why it is not ours.
//
// A server that picks its own random numbers asks to be trusted. drand is a
// public beacon run by a threshold network (Cloudflare, Protocol Labs, EPFL,
// universities…); quicknet publishes one signed value every three seconds,
// and which round is published when is fixed forever by its genesis time.
//
// So the round a spin will use is known the moment the round OPENS, and its
// value does not exist until after the bell. Nobody — this server included —
// can know it while votes are open, and nobody can choose it afterwards.
// ============================================================================

import crypto from 'crypto'
import { config } from './config.js'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** The first quicknet round published at or after `ms` (unix ms). */
export function roundAt(ms) {
  const { genesis, period } = config.drand
  const t = ms / 1000
  if (t <= genesis) return 1
  return Math.ceil((t - genesis) / period) + 1
}

/** When a given round is (or was) published, in unix ms. */
export function publishedAt(round) {
  const { genesis, period } = config.drand
  return (genesis + (round - 1) * period) * 1000
}

/** The beacon round a spin that closes at `endsAt` will use. */
export const beaconFor = (endsAt) => roundAt(endsAt + config.drand.marginMs)

export const beaconUrl = (round, base = config.drand.endpoints[0]) =>
  `${base}/${config.drand.chainHash}/public/${round}`

/**
 * Fetch one round, trying every mirror, until it exists or `timeoutMs` passes.
 *
 * quicknet's randomness is sha256(signature). That is checked here: it is not
 * the full BLS verification (the frontend links to the beacon so anyone can
 * do that), but it does mean a mirror cannot hand back a value that is not
 * the one its own signature commits to.
 */
export async function fetchBeacon(round, { timeoutMs = config.drand.timeoutMs } = {}) {
  const deadline = Date.now() + timeoutMs
  const wait = publishedAt(round) - Date.now()
  if (wait > 0) await sleep(wait + 150)

  let lastErr = null
  while (Date.now() < deadline) {
    for (const base of config.drand.endpoints) {
      try {
        const res = await fetch(beaconUrl(round, base), { signal: AbortSignal.timeout(5000) })
        if (!res.ok) throw new Error(`${base} said ${res.status}`)
        const j = await res.json()
        if (Number(j.round) !== round) throw new Error(`${base} returned round ${j.round}, wanted ${round}`)
        const check = crypto.createHash('sha256').update(Buffer.from(j.signature, 'hex')).digest('hex')
        if (check !== j.randomness) throw new Error(`${base} returned randomness that does not match its signature`)
        return { round, randomness: j.randomness, signature: j.signature, source: base, url: beaconUrl(round) }
      } catch (e) {
        lastErr = e
      }
    }
    await sleep(1000)
  }
  throw new Error(`drand round ${round} unavailable: ${lastErr?.message ?? 'timeout'}`)
}
