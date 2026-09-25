// ============================================================================
// wheel.js — the wheel, and the arithmetic that turns a beacon into a pocket.
//
// A European wheel with the zero taken out: thirty-six pockets in the real
// wheel order, which alternate red and black all the way round. Eighteen of
// each, so red or black is exactly a coin flip — there is no green pocket for
// a house edge, because there is no house taking anything.
//
// Everything here is pure and is duplicated line for line in the frontend's
// verifier, so a spin can be re-derived in any browser from two public values:
// the drand randomness and the round id.
// ============================================================================

import crypto from 'crypto'

/** Real European wheel order, clockwise, zero removed. Index 0 is red and colours alternate. */
export const WHEEL = Object.freeze([
  32, 15, 19, 4, 21, 2, 25, 17, 34, 6, 27, 13, 36, 11, 30, 8, 23, 10,
  5, 24, 16, 33, 1, 20, 14, 31, 9, 22, 18, 29, 7, 28, 12, 35, 3, 26,
])

const REDS = new Set([1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36])

export const colorOf = (number) => (REDS.has(number) ? 'red' : 'black')

const sha256 = (s) => crypto.createHash('sha256').update(s).digest()

/**
 * The pocket a spin lands in. The randomness is domain-separated by the round
 * id, so two games reading the same beacon do not land on the same pocket.
 *
 * 2^64 mod 36 is 16, so the modulo bias is 16 in 2^64 — nothing.
 */
export function spin(randomness, roundId) {
  const digest = sha256(`${randomness}:${roundId}:spin`)
  const index = Number(digest.readBigUInt64BE(0) % BigInt(WHEEL.length))
  const number = WHEEL[index]
  return { index, number, color: colorOf(number) }
}
