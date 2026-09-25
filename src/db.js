// ============================================================================
// db.js — the receipt book. MongoDB when MONGO_URL is set, memory otherwise.
//
//   rounds    one document per settled round: picks, beacon, pocket, and every
//             wallet paid with its signature
//   picks     the open round's picks (wallet + colour), so a restart mid-round
//             keeps them
//   payouts   one row per wallet paid — what the page's "your winnings" reads
//   state     the pot ledger (what is carried, a payout in flight) and the CA
//   totals    running sums for the headline numbers
//
// The ledger is what makes the pot safe to spend, so it lives here and not in
// a variable: without it, a restart forgets what was carried (errs low — the
// SOL stays in the wallet, uncounted) and forgets a payout that was in flight
// (the reconcile at boot is what catches that).
// ============================================================================

import { MongoClient } from 'mongodb'
import { config } from './config.js'

export const EMPTY_TOTALS = { rounds: 0, paidRounds: 0, rollovers: 0, voids: 0, solPaid: 0, walletsPaid: 0, claimed: 0, biggestShare: 0 }

const strip = (doc) => {
  if (!doc) return null
  const { _id, updatedAt, ...r } = doc
  return r
}

export function createDb() {
  let client = null
  let db = null

  // Memory fallback. Same shapes as the collections.
  const mem = { rounds: new Map(), picks: new Map(), payouts: [], state: new Map(), totals: { ...EMPTY_TOTALS } }

  return {
    get ready() {
      return !!db
    },

    async connect() {
      if (!config.mongoUrl) {
        console.warn('[db] no MONGO_URL — rounds, picks and the pot ledger live in memory and reset on restart')
        return
      }
      try {
        client = new MongoClient(config.mongoUrl, { serverSelectionTimeoutMS: 8000 })
        await client.connect()
        db = client.db(config.mongoDb)
        await Promise.all([
          db.collection('picks').createIndex({ roundId: 1, wallet: 1 }, { unique: true }),
          db.collection('picks').createIndex({ createdAt: 1 }, { expireAfterSeconds: 2 * 24 * 3600 }),
          db.collection('payouts').createIndex({ roundId: 1, wallet: 1 }, { unique: true }),
          db.collection('payouts').createIndex({ wallet: 1, roundId: -1 }),
          db.collection('rounds').createIndex({ mode: 1, _id: -1 }),
        ])
        console.info(`[db] connected (${config.mongoDb})`)
      } catch (e) {
        console.error(`[db] could not connect (${e.message}) — falling back to memory`)
        db = null
      }
    },

    async getState(key) {
      if (!db) return mem.state.get(key) ?? null
      const doc = await db.collection('state').findOne({ _id: key })
      return doc?.value ?? null
    },

    async setState(key, value) {
      if (!db) return void mem.state.set(key, value)
      await db.collection('state').updateOne({ _id: key }, { $set: { value, at: new Date() } }, { upsert: true })
    },

    /** One wallet's pick in one round. `raw` is a bigint and is stored as a string. */
    async savePick(roundId, wallet, pick) {
      const doc = { side: pick.side, ip: pick.ip, eligible: pick.eligible, raw: pick.raw == null ? null : String(pick.raw), at: pick.at }
      if (!db) {
        if (!mem.picks.has(roundId)) {
          mem.picks.clear()
          mem.picks.set(roundId, new Map())
        }
        mem.picks.get(roundId).set(wallet, { wallet, ...doc })
        return
      }
      await db
        .collection('picks')
        .updateOne({ roundId, wallet }, { $set: doc, $setOnInsert: { createdAt: new Date() } }, { upsert: true })
    },

    async loadPicks(roundId) {
      const rows = !db
        ? [...(mem.picks.get(roundId)?.values() ?? [])]
        : await db.collection('picks').find({ roundId }, { projection: { _id: 0, roundId: 0, createdAt: 0 } }).toArray()
      return rows.map((r) => ({ ...r, raw: r.raw == null ? null : BigInt(r.raw) }))
    },

    async saveRound(doc) {
      if (!db) {
        mem.rounds.set(doc.id, doc)
        if (mem.rounds.size > 500) mem.rounds.delete(mem.rounds.keys().next().value)
        return
      }
      await db.collection('rounds').updateOne({ _id: doc.id }, { $set: { ...doc, updatedAt: new Date() } }, { upsert: true })
    },

    async recentRounds(limit = 60) {
      const n = Math.max(1, Math.min(500, Number(limit) || 60))
      if (!db) return [...mem.rounds.values()].sort((a, b) => b.id - a.id).slice(0, n)
      const rows = await db.collection('rounds').find({ mode: { $ne: 'demo' } }).sort({ _id: -1 }).limit(n).toArray()
      return rows.map(strip)
    },

    async getRound(id) {
      if (!db) return mem.rounds.get(id) ?? null
      return strip(await db.collection('rounds').findOne({ _id: id }))
    },

    /** Rows of {roundId, wallet, lamports, sig}. Idempotent per (round, wallet). */
    async savePayouts(rows) {
      if (!rows.length) return
      const at = new Date()
      if (!db) {
        for (const r of rows) if (!mem.payouts.some((p) => p.roundId === r.roundId && p.wallet === r.wallet)) mem.payouts.push({ ...r, at })
        if (mem.payouts.length > 20_000) mem.payouts.splice(0, mem.payouts.length - 20_000)
        return
      }
      await db.collection('payouts').bulkWrite(
        rows.map((r) => ({ updateOne: { filter: { roundId: r.roundId, wallet: r.wallet }, update: { $setOnInsert: { ...r, at } }, upsert: true } })),
        { ordered: false }
      )
    },

    /** What one wallet has won: total, count, and the latest rows. */
    async walletStats(wallet) {
      const rows = !db
        ? mem.payouts.filter((p) => p.wallet === wallet).sort((a, b) => b.roundId - a.roundId)
        : await db.collection('payouts').find({ wallet }, { projection: { _id: 0 } }).sort({ roundId: -1 }).limit(500).toArray()
      return {
        wallet,
        lamports: rows.reduce((acc, r) => acc + Number(r.lamports), 0),
        wins: rows.length,
        rows: rows.slice(0, 20),
      }
    },

    async incTotals(inc, max = null) {
      if (!db) {
        for (const [k, v] of Object.entries(inc)) mem.totals[k] = (mem.totals[k] ?? 0) + v
        for (const [k, v] of Object.entries(max ?? {})) mem.totals[k] = Math.max(mem.totals[k] ?? 0, v)
        return
      }
      const update = { $inc: inc }
      if (max) update.$max = max
      await db.collection('totals').updateOne({ _id: 'totals' }, update, { upsert: true })
    },

    async totals() {
      if (!db) return { ...mem.totals }
      const doc = await db.collection('totals').findOne({ _id: 'totals' })
      const { _id, ...t } = doc ?? {}
      return { ...EMPTY_TOTALS, ...t }
    },

    async close() {
      await client?.close().catch(() => {})
    },
  }
}
