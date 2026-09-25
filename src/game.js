// ============================================================================
// game.js — the table.
//
//   open ──(5 min of votes)──► bell ──► locked ──► beacon ──► spin ──► result
//                                          │                           │
//                                          └── claim creator fees ─────┤
//                                                                      ├─ lost:  the pot rolls over
//                                                                      └─ won:   buy back ──► burn
//
// Rounds are aligned to the wall clock, so every viewer sees the same bell at
// the same instant and a restart does not shift the schedule. The next round
// opens the moment the previous one locks; its settlement runs beside it.
// ============================================================================

import crypto from 'crypto'
import { config, BRAND } from './config.js'
import { beaconFor, beaconUrl, fetchBeacon, publishedAt } from './drand.js'
import { communityPick, spin, tieBreak } from './wheel.js'
import { createChain, isPubkey, lamportsToSol, parseSecret, solToLamports } from './chain.js'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const errMsg = (e) => (e instanceof Error ? e.message : String(e))
const EMPTY_TOTALS = { rounds: 0, wins: 0, losses: 0, voids: 0, burnedRaw: 0, solSpent: 0, claimed: 0, buybacks: 0 }
const VOTER_RE = /^[A-Za-z0-9_-]{8,64}$/
const IP_SALT = crypto.randomBytes(16).toString('hex')

/** Votes are stored against a salted hash of the IP, never the address itself. */
export const ipTag = (ip) => crypto.createHash('sha256').update(`${IP_SALT}:${ip}`).digest('hex').slice(0, 16)
/** A voter's public handle: four hex characters, stable for that browser. */
const voterTag = (voter) => crypto.createHash('sha256').update(voter).digest('hex').slice(0, 4)

export function createGame({ db, price, emit }) {
  const chain = createChain()
  const slotStart = (ts) => Math.floor(ts / config.roundMs) * config.roundMs

  let mode = 'demo'
  let modeNote = ''
  let coin = null
  let kp = null

  let round = null
  let history = []
  let settling = null
  let timer = null
  const timers = []

  /** The pot ledger. Lamports as plain numbers: a pump.fun pot never gets near 2^53. */
  let ledger = { carried: 0, pendingBurnRaw: 0, pendingBuy: null }
  let claimable = 0
  let walletLamports = null
  let totals = { ...EMPTY_TOTALS }
  const demo = { pot: Number(solToLamports(config.demoPotSol)), totals: { ...EMPTY_TOTALS }, history: [] }

  // One wallet, one transaction at a time: a claim racing a buy would each
  // read a balance the other is about to change.
  let walletQueue = Promise.resolve()
  function exclusive(fn) {
    const run = walletQueue.then(fn)
    walletQueue = run.catch(() => {})
    return run
  }

  const saveLedger = () => db.setState('ledger', ledger).catch((e) => console.error(`[game] ledger save failed: ${errMsg(e)}`))

  // ── public shapes ────────────────────────────────────────────────────────

  function roundPublic() {
    if (!round) return null
    return {
      id: round.id,
      startedAt: round.startedAt,
      endsAt: round.endsAt,
      lengthMs: config.roundMs,
      beacon: round.beacon,
      beaconAt: publishedAt(round.beacon),
      counts: { ...round.counts },
      voters: round.votes.size,
    }
  }

  function potPublic() {
    // What the page shows is what will be in play at the next bell: the
    // ledger plus what the vaults hold now, which the bell claims.
    const lamports = mode === 'demo' ? demo.pot : ledger.carried + claimable
    const usd = price.solUsd
    return {
      lamports,
      sol: lamportsToSol(lamports),
      usd: usd ? lamportsToSol(lamports) * usd : null,
      carried: mode === 'demo' ? demo.pot : ledger.carried,
      claimable: mode === 'demo' ? 0 : claimable,
      pendingBurnRaw: ledger.pendingBurnRaw,
      wallet: walletLamports,
      solUsd: usd,
      at: Date.now(),
    }
  }

  function coinPublic() {
    if (!coin) return null
    return {
      mint: coin.mint,
      creator: coin.creator,
      venue: coin.venue,
      decimals: coin.decimals,
      mcapSol: coin.mcapSol,
      mcapUsd: coin.mcapSol != null && price.solUsd ? coin.mcapSol * price.solUsd : null,
    }
  }

  function totalsPublic() {
    const t = mode === 'demo' ? demo.totals : totals
    const decimals = coin?.decimals ?? 6
    let streak = { kind: null, n: 0 }
    const h = mode === 'demo' ? demo.history : history
    for (const r of h) {
      if (r.win === null || r.win === undefined) continue
      const kind = r.win ? 'win' : 'loss'
      if (streak.kind === null) streak = { kind, n: 1 }
      else if (streak.kind === kind) streak.n++
      else break
    }
    return { ...t, burned: t.burnedRaw / 10 ** decimals, solSpentSol: lamportsToSol(t.solSpent), claimedSol: lamportsToSol(t.claimed), streak }
  }

  function snapshot() {
    return {
      now: Date.now(),
      brand: BRAND,
      mode,
      modeNote,
      coin: coinPublic(),
      round: roundPublic(),
      pot: potPublic(),
      history: (mode === 'demo' ? demo.history : history).slice(0, config.historyLen),
      settling,
      totals: totalsPublic(),
      rules: {
        roundMs: config.roundMs,
        minBuySol: config.minBuySol,
        burnMode: config.burnMode,
        explorer: config.explorer,
        drand: { chainHash: config.drand.chainHash, genesis: config.drand.genesis, period: config.drand.period, url: config.drand.endpoints[0] },
      },
    }
  }

  function currentPot() {
    if (mode === 'demo') return demo.pot
    if (mode === 'dry') return ledger.carried + claimable
    return ledger.carried
  }

  // ── the clock ────────────────────────────────────────────────────────────

  function open(at = Date.now()) {
    const startedAt = slotStart(at)
    const endsAt = startedAt + config.roundMs
    round = {
      id: startedAt / config.roundMs,
      startedAt,
      endsAt,
      beacon: beaconFor(endsAt),
      votes: new Map(),
      ipVoters: new Map(),
      counts: { red: 0, black: 0 },
    }
    emit({ type: 'round', round: roundPublic() })
  }

  function close() {
    const done = round
    open(Date.now())
    settle(done).catch((e) => console.error(`[game] settle ${done.id} crashed: ${errMsg(e)}`))
  }

  /** Re-aimed at the wall clock every time: setInterval drifts, and a sleeping laptop would wake up on its own schedule. */
  function schedule() {
    clearTimeout(timer)
    timer = setTimeout(() => {
      close()
      schedule()
    }, Math.max(50, round.endsAt - Date.now()))
  }

  // ── votes ────────────────────────────────────────────────────────────────

  function vote({ voter, side, ip }) {
    if (!round) return { ok: false, error: 'no round open' }
    if (side !== 'red' && side !== 'black') return { ok: false, error: 'pick red or black' }
    if (typeof voter !== 'string' || !VOTER_RE.test(voter)) return { ok: false, error: 'bad voter id' }
    if (Date.now() >= round.endsAt) return { ok: false, error: 'no more bets' }

    const prev = round.votes.get(voter)
    if (prev === side) return { ok: true, side, roundId: round.id, counts: { ...round.counts } }
    if (!prev) {
      const set = round.ipVoters.get(ip) ?? new Set()
      if (!set.has(voter) && set.size >= config.maxVotersPerIp) return { ok: false, error: 'too many voters from this connection' }
      set.add(voter)
      round.ipVoters.set(ip, set)
    } else {
      round.counts[prev]--
    }
    round.votes.set(voter, side)
    round.counts[side]++
    db.saveVote(round.id, voter, side, ip).catch((e) => console.warn(`[game] vote save failed: ${errMsg(e)}`))
    emit({ type: 'vote', roundId: round.id, side, prev: prev ?? null, who: voterTag(voter), counts: { ...round.counts }, voters: round.votes.size })
    return { ok: true, side, roundId: round.id, counts: { ...round.counts } }
  }

  const myVote = (voter) => (round && typeof voter === 'string' ? round.votes.get(voter) ?? null : null)

  async function restoreVotes() {
    const rows = await db.loadVotes(round.id).catch(() => [])
    for (const r of rows) {
      if (round.votes.has(r.voter) || (r.side !== 'red' && r.side !== 'black')) continue
      round.votes.set(r.voter, r.side)
      round.counts[r.side]++
      const set = round.ipVoters.get(r.ip) ?? new Set()
      set.add(r.voter)
      round.ipVoters.set(r.ip, set)
    }
    if (rows.length) console.info(`[game] restored ${rows.length} vote(s) for round ${round.id}`)
  }

  // ── settlement ───────────────────────────────────────────────────────────

  async function settle(r) {
    const roundMode = mode
    const s = {
      id: r.id,
      startedAt: r.startedAt,
      endsAt: r.endsAt,
      mode: roundMode,
      votes: { ...r.counts },
      voters: r.votes.size,
      pick: communityPick(r.counts),
      tie: communityPick(r.counts) === null,
      beacon: r.beacon,
      beaconAt: publishedAt(r.beacon),
      beaconUrl: beaconUrl(r.beacon),
      drand: null,
      result: null,
      win: null,
      stage: 'locked',
      status: null,
      potLamports: null,
      claim: null,
      buy: null,
      burn: null,
      note: null,
      settledAt: null,
    }
    const push = () => {
      settling = { ...s }
      emit({ type: 'settle', round: { ...s } })
    }
    push()

    // The claim runs while the beacon is still being produced: a few seconds
    // that would otherwise be spent waiting.
    const claimP =
      roundMode === 'live'
        ? exclusive(claimNow).catch((e) => ({ error: errMsg(e) }))
        : roundMode === 'dry' && coin?.creatorKind === 'wallet'
          ? chain
              .previewClaim(coin.creator)
              .then((p) => ({ dry: true, lamports: p.vaults?.total ?? 0, simulated: p.empty ? 'nothing to claim' : p.ok ? 'ok' : p.error }))
              .catch((e) => ({ dry: true, error: errMsg(e) }))
          : Promise.resolve(null)

    let beacon
    try {
      beacon = await fetchBeacon(r.beacon)
    } catch (e) {
      // Never fall back to local randomness. A spin nobody can verify is not a spin.
      s.claim = await claimP
      s.stage = 'done'
      s.status = 'void'
      s.potLamports = currentPot()
      s.note = `${errMsg(e)} — round void, the pot rolls over`
      return finish(s, roundMode)
    }

    s.result = spin(beacon.randomness, r.id)
    if (s.pick === null) s.pick = tieBreak(beacon.randomness, r.id)
    s.win = s.result.color === s.pick
    s.drand = { round: beacon.round, randomness: beacon.randomness, signature: beacon.signature, url: beacon.url }
    s.stage = 'spinning'
    push()

    s.claim = await claimP
    s.potLamports = currentPot()

    if (!s.win) {
      s.stage = 'done'
      s.status = 'lost'
      s.note = 'the pot rolls over to the next spin'
      return finish(s, roundMode)
    }

    if (roundMode === 'demo') {
      // A fake coin at a fake 60 SOL market cap, so the numbers look like numbers.
      const spent = demo.pot
      const tokens = Math.floor((lamportsToSol(spent) / 60) * 1e9 * 1e6)
      s.buy = { lamports: spent, tokensRaw: tokens, sig: null, demo: true }
      s.burn = { raw: tokens, sig: null, demo: true }
      demo.pot = 0
      demo.totals.solSpent += spent
      demo.totals.burnedRaw += tokens
      demo.totals.buybacks++
      s.stage = 'done'
      s.status = 'burned'
      s.note = 'demo — nothing was sent'
      return finish(s, roundMode)
    }

    if (roundMode === 'dry') {
      // The same sizing a live win uses, capped by what the creator wallet
      // really holds, and the buy it would send simulated against mainnet.
      let order = (BigInt(s.potLamports) * 10_000n) / (10_000n + BigInt(config.slippageBps))
      if (config.maxBuySol != null && order > solToLamports(config.maxBuySol)) order = solToLamports(config.maxBuySol)
      let simulated = null
      if (coin?.creatorKind === 'wallet' && order > 0n) {
        simulated = await chain
          .previewBuy(coin.creator, coin, order)
          .then((p) => (p.ok ? 'ok' : p.error))
          .catch((e) => errMsg(e))
      }
      s.buy = { lamports: Number(order), sig: null, dry: true, simulated }
      s.stage = 'done'
      s.status = 'dry_win'
      s.note =
        `dry run — would have bought ${lamportsToSol(order).toFixed(4)} SOL of the coin and burned it` +
        (simulated ? ` (buy simulated on mainnet: ${simulated})` : '')
      return finish(s, roundMode)
    }

    await exclusive(() => buyAndBurn(s, push)).catch((e) => {
      s.stage = 'done'
      s.status = s.status ?? 'buy_failed'
      s.note = errMsg(e)
    })
    return finish(s, roundMode)
  }

  async function finish(s, roundMode) {
    s.settledAt = Date.now()
    if (s.stage !== 'done') s.stage = 'done'
    settling = { ...s }
    emit({ type: 'settle', round: { ...s } })

    const inc = { rounds: 1, wins: s.win === true ? 1 : 0, losses: s.win === false ? 1 : 0, voids: s.status === 'void' ? 1 : 0 }
    if (roundMode === 'demo') {
      for (const [k, v] of Object.entries(inc)) demo.totals[k] += v
      demo.history.unshift({ ...s })
      demo.history.length = Math.min(demo.history.length, config.historyLen)
    } else {
      history.unshift({ ...s })
      history.length = Math.min(history.length, config.historyLen)
      await db.saveRound({ ...s }).catch((e) => console.error(`[game] round save failed: ${errMsg(e)}`))
      await db.incTotals(inc).catch(() => {})
      totals = await db.totals().catch(() => totals)
    }
    emit({ type: 'totals', totals: totalsPublic() })
    emit({ type: 'pot', pot: potPublic() })
    console.info(
      `[game] round ${s.id} ${s.mode}: votes ${s.votes.red}R/${s.votes.black}B → pick ${s.pick}${s.tie ? ' (tie)' : ''}, ` +
        `wheel ${s.result ? `${s.result.number} ${s.result.color}` : '—'} → ${s.status}${s.note ? ` (${s.note})` : ''}`
    )
  }

  // ── money (live only) ────────────────────────────────────────────────────

  async function claimNow() {
    if (mode !== 'live' || !kp || !coin?.creator) return null
    const v = await chain.vaults(coin.creator)
    if (v.total < Number(solToLamports(config.claimMinSol))) return { lamports: 0, skipped: true }
    const res = await chain.claim(kp, v)
    if (!res) return { lamports: 0, skipped: true }
    if (!res.landed) return { error: 'claim did not land before its blockhash expired', sig: res.signature }
    // What the vaults held BEFORE the claim. A trade landing mid-claim pays a
    // little more than this into the wallet; the pot counts it next time, or
    // never — it errs low, never high.
    ledger.carried += v.total
    await saveLedger()
    await db.incTotals({ claimed: v.total }).catch(() => {})
    claimable = 0
    return { sig: res.signature, lamports: v.total }
  }

  async function buyAndBurn(s, push) {
    const pot = BigInt(ledger.carried)
    const { order } = await chain.buyBudget(kp, pot)
    if (order < solToLamports(config.minBuySol)) {
      s.stage = 'done'
      s.status = 'won_small'
      s.note = `the spendable pot (${lamportsToSol(order).toFixed(4)} SOL) is below MIN_BUY_SOL — it rolls over`
      return
    }

    const owner = kp.publicKey.toBase58()
    const before = await chain.tokenBalance(owner, coin.mint, coin.tokenProgram).catch(() => null)

    // Pessimistic: the pot leaves the ledger BEFORE the buy is signed. If the
    // process dies mid-flight, the reconcile at boot looks the signature up
    // and either keeps it spent or puts it back — it can never be spent twice.
    ledger.pendingBuy = { roundId: s.id, potLamports: Number(pot), sig: null, lastValid: null }
    ledger.carried = 0
    await saveLedger()

    s.stage = 'buying'
    s.buy = { lamports: Number(order), sig: null, venue: null }
    push()

    let res
    try {
      res = await chain.buy(kp, coin, order, {
        onSigned: async (sig, lastValid) => {
          ledger.pendingBuy.sig = sig
          ledger.pendingBuy.lastValid = lastValid
          await saveLedger()
          s.buy.sig = sig
          push()
        },
      })
    } catch (e) {
      res = { landed: false, error: errMsg(e), signature: ledger.pendingBuy?.sig ?? null }
    }

    if (!res.landed) {
      ledger.carried += ledger.pendingBuy.potLamports
      ledger.pendingBuy = null
      await saveLedger()
      s.stage = 'done'
      s.status = 'buy_failed'
      s.note = `${res.error ?? 'the buy did not land before its blockhash expired'} — the pot rolls over`
      return
    }

    const fx = await chain.effects(res.signature, owner, coin.mint)
    let bought = fx?.tokensIn ?? null
    if (bought === null && before) {
      const after = await chain.tokenBalance(owner, coin.mint, coin.tokenProgram).catch(() => null)
      if (after) bought = after.raw - before.raw
    }
    const spent = fx ? Number(fx.solOut) : Number(order)
    ledger.carried += Math.max(0, ledger.pendingBuy.potLamports - spent)
    ledger.pendingBurnRaw += Number(bought ?? 0n)
    ledger.pendingBuy = null
    await saveLedger()
    await db.incTotals({ solSpent: spent, buybacks: 1 }).catch(() => {})

    s.buy = { lamports: spent, sig: res.signature, venue: res.venue, tokensRaw: Number(bought ?? 0n) }
    s.stage = 'burning'
    push()

    const burned = await burnPending(s, push).catch((e) => {
      console.warn(`[game] burn after round ${s.id} failed: ${errMsg(e)}`)
      return false
    })
    s.stage = 'done'
    s.status = burned ? 'burned' : 'burn_pending'
    if (!burned) s.note = 'bought — the burn will be retried every minute until it lands'
  }

  async function burnPending(s = null, push = null) {
    if (mode !== 'live' || !kp || !coin) return false
    const owner = kp.publicKey.toBase58()
    const bal = await chain.tokenBalance(owner, coin.mint, coin.tokenProgram)
    let amount = config.burnMode === 'all' ? bal.raw : BigInt(ledger.pendingBurnRaw)
    if (amount > bal.raw) amount = bal.raw
    if (amount <= 0n) {
      if (ledger.pendingBurnRaw) {
        ledger.pendingBurnRaw = 0
        await saveLedger()
      }
      return !s || !s.buy?.tokensRaw
    }
    const res = await chain.burn(kp, coin, amount, {
      onSigned: (sig) => {
        if (s) {
          s.burn = { raw: Number(amount), sig }
          push?.()
        }
      },
    })
    if (!res.landed) return false
    ledger.pendingBurnRaw = Math.max(0, ledger.pendingBurnRaw - Number(amount))
    if (config.burnMode === 'all') ledger.pendingBurnRaw = 0
    await saveLedger()
    await db.incTotals({ burnedRaw: Number(amount) }).catch(() => {})
    totals = await db.totals().catch(() => totals)
    if (s) s.burn = { raw: Number(amount), sig: res.signature }
    emit({ type: 'burn', raw: Number(amount), sig: res.signature, totals: totalsPublic() })
    return true
  }

  /**
   * A buy that was signed when the process died. Its signature is in the
   * ledger; the chain says whether it landed. Until the blockhash has expired,
   * "not found" is not an answer, so this waits for one.
   */
  async function reconcile() {
    const pb = ledger.pendingBuy
    if (!pb) return
    console.warn(`[game] reconciling a buy from round ${pb.roundId} (${pb.sig ?? 'never signed'})`)
    if (!pb.sig) {
      ledger.carried += pb.potLamports
      ledger.pendingBuy = null
      return saveLedger()
    }
    for (let i = 0; i < 100; i++) {
      const l = await chain.landed(pb.sig).catch(() => null)
      if (l === true) {
        const fx = await chain.effects(pb.sig, kp.publicKey.toBase58(), coin.mint)
        const spent = fx ? Number(fx.solOut) : pb.potLamports
        ledger.carried += Math.max(0, pb.potLamports - spent)
        ledger.pendingBurnRaw += Number(fx?.tokensIn ?? 0n)
        ledger.pendingBuy = null
        return saveLedger()
      }
      const height = await chain.connection.getBlockHeight('confirmed').catch(() => 0)
      if (l === false || (pb.lastValid && height > pb.lastValid + 10)) {
        ledger.carried += pb.potLamports
        ledger.pendingBuy = null
        return saveLedger()
      }
      await sleep(3000)
    }
  }

  // ── the pot, live ────────────────────────────────────────────────────────

  async function refreshPot() {
    try {
      if (mode === 'demo') {
        // As if people were trading: a few thousandths of a SOL every poll.
        demo.pot += Math.floor((0.002 + Math.random() * 0.02) * 1e9)
      } else if (coin?.creator) {
        const [v, bal, fresh] = await Promise.all([
          chain.vaults(coin.creator),
          chain.balance(coin.creator),
          chain.readCoin(coin.mint).catch(() => null),
        ])
        claimable = v.total
        walletLamports = bal
        if (fresh) coin = { ...coin, venue: fresh.venue, mcapSol: fresh.mcapSol }
      }
      emit({ type: 'pot', pot: potPublic(), coin: coinPublic() })
    } catch (e) {
      console.warn(`[game] pot refresh failed: ${errMsg(e)}`)
    }
  }

  // ── configuration ────────────────────────────────────────────────────────

  async function configure(token) {
    coin = null
    kp = null
    modeNote = ''
    claimable = 0
    walletLamports = null
    if (!token) {
      mode = 'demo'
      modeNote = 'no CA yet — the pot is simulated'
      return
    }
    try {
      coin = await chain.readCoin(token)
    } catch (e) {
      mode = 'dry'
      modeNote = `could not read the coin: ${errMsg(e)}`
      return
    }
    let key = null
    try {
      key = parseSecret(config.treasurySecret)
    } catch (e) {
      modeNote = `TREASURY_SECRET: ${errMsg(e)}`
    }
    if (!coin.creator) {
      mode = 'dry'
      modeNote = 'could not find the coin creator — is this a pump.fun coin?'
      return
    }
    if (coin.creatorKind === 'program') {
      mode = 'dry'
      modeNote = `this coin's creator rewards go to a fee-sharing account (${coin.creator}), not a wallet — launch it without fee sharing so the creator wallet can claim`
      return
    }
    if (key && key.publicKey.toBase58() !== coin.creator) {
      mode = 'dry'
      modeNote = `TREASURY_SECRET is ${key.publicKey.toBase58()}, but the coin was created by ${coin.creator} — refusing to go live`
      return
    }
    kp = key
    if (config.dryRun) {
      mode = 'dry'
      modeNote = modeNote || 'DRY_RUN — votes and spins are real, nothing is sent'
      return
    }
    if (!key) {
      mode = 'dry'
      modeNote = modeNote || 'no TREASURY_SECRET — nothing is sent'
      return
    }
    mode = 'live'
  }

  async function loadHistory() {
    if (mode === 'demo') return
    history = await db.recentRounds(config.historyLen).catch(() => [])
    totals = await db.totals().catch(() => ({ ...EMPTY_TOTALS }))
  }

  return {
    snapshot,
    vote,
    myVote,
    get mode() {
      return mode
    },

    async start() {
      const saved = await db.getState('ledger').catch(() => null)
      if (saved) ledger = { ...ledger, ...saved }
      const token = (await db.getState('token').catch(() => null)) || config.token
      await configure(token)
      await loadHistory()
      if (mode === 'live') {
        await exclusive(reconcile)
        if (ledger.pendingBurnRaw > 0) exclusive(() => burnPending()).catch(() => {})
      }

      open(Date.now())
      await restoreVotes()
      schedule()
      await refreshPot()

      timers.push(setInterval(refreshPot, config.potPollMs))
      timers.push(
        setInterval(() => {
          if (mode === 'live' && ledger.pendingBurnRaw > 0) exclusive(() => burnPending()).catch(() => {})
        }, 60_000)
      )
      console.info(`[game] ${mode.toUpperCase()}${modeNote ? ` — ${modeNote}` : ''}${coin ? ` · mint ${coin.mint} · creator ${coin.creator} · ${coin.venue}` : ''}`)
    },

    stop() {
      clearTimeout(timer)
      for (const t of timers) clearInterval(t)
    },

    /** POST /set-ca. Refused while a buy is in flight: the ledger belongs to the coin it was bought for. */
    async setToken(ca) {
      const next = String(ca || '').trim()
      if (next && !isPubkey(next)) throw Object.assign(new Error('not a valid Solana address'), { code: 400 })
      if (ledger.pendingBuy) throw Object.assign(new Error('a buyback is in flight — try again in a minute'), { code: 409 })
      await db.setState('token', next || null)
      await configure(next)
      await loadHistory()
      if (mode === 'live') await exclusive(reconcile)
      await refreshPot()
      emit({ type: 'hello', ...snapshot() })
      return { mode, modeNote, coin: coinPublic() }
    },

    /** POST /set-pot. Sets what the ledger says is carried — for seeding a pot or correcting one. */
    async setPot(sol) {
      const lamports = Number(solToLamports(sol))
      if (!Number.isFinite(lamports) || lamports < 0) throw Object.assign(new Error('sol must be a non-negative number'), { code: 400 })
      if (mode === 'demo') demo.pot = lamports
      else {
        ledger.carried = lamports
        await saveLedger()
      }
      emit({ type: 'pot', pot: potPublic() })
      return potPublic()
    },

    async round(id) {
      const inMemory = [...history, ...demo.history].find((r) => r.id === id)
      return inMemory ?? (await db.getRound(id))
    },
  }
}
