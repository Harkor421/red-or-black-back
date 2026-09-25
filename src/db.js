// ============================================================================
// db.js — the receipt book. MongoDB when MONGO_URL is set, memory otherwise.
//
//   rounds    one document per settled round: votes, beacon, pocket, and the
//             claim / buy / burn signatures when there were any
//   votes     the open round's votes, so a restart mid-round keeps them
//   state     the pot ledger (what is carried, what is waiting to be burned,
//             a buy that was signed but not yet reconciled) and the live CA
//   totals    running sums for the headline numbers
//
// The ledger is what makes the pot safe to spend, so it lives here and not in
// a variable: without it, a restart forgets what was carried (errs low — the
// SOL stays in the wallet, uncounted) and forgets a buy that was in flight
// (the reconcile at boot is what catches that).
// ============================================================================

import { MongoClient } from 'mongodb'
import { config } from './config.js'

const EMPTY_TOTALS = { rounds: 0, wins: 0, losses: 0, voids: 0, burnedRaw: 0, solSpent: 0, claimed: 0, buybacks: 0 }

export function createDb() {
  let client = null
  let db = null

  // Memory fallback. Same shapes as the collections.
  const mem = { rounds: new Map(), votes: new Map(), state: new Map(), totals: { ...EMPTY_TOTALS } }

  const api = {
    get ready() {
      return !!db
    },

    async connect() {
      if (!config.mongoUrl) {
        console.warn('[db] no MONGO_URL — rounds, votes and the pot ledger live in memory and reset on restart')
        return
      }
      try {
        client = new MongoClient(config.mongoUrl, { serverSelectionTimeoutMS: 8000 })
        await client.connect()
        db = client.db(config.mongoDb)
        await Promise.all([
          db.collection('votes').createIndex({ roundId: 1, voter: 1 }, { unique: true }),
          db.collection('votes').createIndex({ at: 1 }, { expireAfterSeconds: 2 * 24 * 3600 }),
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

    async saveVote(roundId, voter, side, ip) {
      if (!db) {
        if (!mem.votes.has(roundId)) {
          mem.votes.clear()
          mem.votes.set(roundId, new Map())
        }
        mem.votes.get(roundId).set(voter, { voter, side, ip })
        return
      }
      await db
        .collection('votes')
        .updateOne({ roundId, voter }, { $set: { side, ip, at: new Date() } }, { upsert: true })
    },

    async loadVotes(roundId) {
      if (!db) return [...(mem.votes.get(roundId)?.values() ?? [])]
      return db.collection('votes').find({ roundId }, { projection: { _id: 0, voter: 1, side: 1, ip: 1 } }).toArray()
    },

    async saveRound(doc) {
      if (!db) {
        mem.rounds.set(doc.id, doc)
        if (mem.rounds.size > 500) mem.rounds.delete(mem.rounds.keys().next().value)
        return
      }
      await db.collection('rounds').updateOne({ _id: doc.id }, { $set: { ...doc, updatedAt: new Date() } }, { upsert: true })
    },

    async recentRounds(limit = 60, mode = null) {
      const n = Math.max(1, Math.min(500, Number(limit) || 60))
      if (!db) {
        return [...mem.rounds.values()]
          .filter((r) => !mode || r.mode === mode)
          .sort((a, b) => b.id - a.id)
          .slice(0, n)
      }
      const q = mode ? { mode } : { mode: { $ne: 'demo' } }
      const rows = await db.collection('rounds').find(q).sort({ _id: -1 }).limit(n).toArray()
      return rows.map(({ _id, updatedAt, ...r }) => r)
    },

    async getRound(id) {
      if (!db) return mem.rounds.get(id) ?? null
      const doc = await db.collection('rounds').findOne({ _id: id })
      if (!doc) return null
      const { _id, updatedAt, ...r } = doc
      return r
    },

    async incTotals(inc) {
      if (!db) {
        for (const [k, v] of Object.entries(inc)) mem.totals[k] = (mem.totals[k] ?? 0) + v
        return
      }
      await db.collection('totals').updateOne({ _id: 'totals' }, { $inc: inc }, { upsert: true })
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
  return api
}
