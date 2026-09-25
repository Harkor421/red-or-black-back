// ============================================================================
// game.js — the table.
//
//   open ──(5 min: paste a wallet, pick a colour)──► bell ──► beacon ──► spin
//                                                     │                   │
//                                                     ├─ claim fees ──────┤
//                                                     └─ read holdings ───┤
//                                                                         ├─ winners → equal shares, in SOL
//                                                                         └─ nobody  → the pot rolls over
//
// Rounds are aligned to the wall clock, so every viewer sees the same bell at
// the same instant and a restart does not shift the schedule. The next round
// opens the moment the previous one locks; its settlement runs beside it.
// ============================================================================

import crypto from 'crypto'
import { config, BRAND } from './config.js'
import { EMPTY_TOTALS } from './db.js'
import { beaconFor, beaconUrl, fetchBeacon, publishedAt } from './drand.js'
import { spin } from './wheel.js'
import { planPayout } from './payout.js'
import { createChain, isPubkey, isWallet, lamportsToSol, parseSecret, solToLamports } from './chain.js'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const errMsg = (e) => (e instanceof Error ? e.message : String(e))
const IP_SALT = crypto.randomBytes(16).toString('hex')

/** Picks are stored against a salted hash of the IP, never the address itself. */
export const ipTag = (ip) => crypto.createHash('sha256').update(`${IP_SALT}:${ip}`).digest('hex').slice(0, 16)
export const shortWallet = (w) => `${w.slice(0, 4)}…${w.slice(-4)}`

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

  /**
   * The pot ledger, lamports as plain numbers (a pump.fun pot never gets near
   * 2^53). `pendingPayout` is a payout that has left `carried` but whose
   * batches have not all been reconciled against the chain.
   */
  let ledger = { carried: 0, pendingPayout: null }
  let claimable = 0
  let walletLamports = null
  let totals = { ...EMPTY_TOTALS }
  const demo = { pot: Number(solToLamports(config.demoPotSol)), totals: { ...EMPTY_TOTALS }, history: [], payouts: [] }

  // One wallet, one transaction at a time: a claim racing a payout would each
  // read a balance the other is about to change.
  let walletQueue = Promise.resolve()
  function exclusive(fn) {
    const run = walletQueue.then(fn)
    walletQueue = run.catch(() => {})
    return run
  }

  const saveLedger = () => db.setState('ledger', ledger).catch((e) => console.error(`[game] ledger save failed: ${errMsg(e)}`))

  // ── holdings ─────────────────────────────────────────────────────────────

  /** MIN_HOLD_PCT of the supply, raw. Hundredths of a basis point kept, anything finer dropped. */
  const minHoldRaw = () => (coin ? (BigInt(coin.supplyRaw) * BigInt(Math.round(config.minHoldPct * 10_000))) / 1_000_000n : 0n)
  const toUi = (raw) => (raw == null ? null : Number(raw) / 10 ** (coin?.decimals ?? 6))
  const excluded = (w) => w === coin?.creator || config.exclude.has(w)

  /** `h` is `{ raw, payable }` from chain.holdings, or null when it could not be read. */
  function eligibleFor(wallet, h) {
    if (excluded(wallet)) return false
    if (mode === 'demo') return true
    if (h == null) return null
    return h.payable && h.raw > 0n && h.raw >= minHoldRaw()
  }

  const balCache = new Map()
  async function holdingOf(wallet) {
    if (mode === 'demo' || !coin) return null
    const hit = balCache.get(wallet)
    if (hit && Date.now() - hit.at < 20_000) return hit.h
    const h = (await chain.holdings([wallet], coin)).get(wallet) ?? { raw: 0n, payable: true }
    if (balCache.size > 5000) balCache.clear()
    balCache.set(wallet, { h, at: Date.now() })
    return h
  }

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
      eligibleCounts: { ...round.eligibleCounts },
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
      minHold: toUi(minHoldRaw()),
    }
  }

  function totalsPublic() {
    const t = mode === 'demo' ? demo.totals : totals
    let streak = { kind: null, n: 0 }
    for (const r of mode === 'demo' ? demo.history : history) {
      if (r.win === null || r.win === undefined) continue
      const kind = r.win ? 'paid' : 'rollover'
      if (streak.kind === null) streak = { kind, n: 1 }
      else if (streak.kind === kind) streak.n++
      else break
    }
    return {
      ...t,
      solPaidSol: lamportsToSol(t.solPaid),
      claimedSol: lamportsToSol(t.claimed),
      biggestShareSol: lamportsToSol(t.biggestShare),
      streak,
    }
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
        minHoldPct: config.minHoldPct,
        minShareSol: config.minShareSol,
        maxPayoutSol: config.maxPayoutSol,
        explorer: config.explorer,
        drand: { chainHash: config.drand.chainHash, genesis: config.drand.genesis, period: config.drand.period, url: config.drand.endpoints[0] },
      },
    }
  }

  /** What a settlement may spend: the ledger, never the wallet. */
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
      ipWallets: new Map(),
      counts: { red: 0, black: 0 },
      eligibleCounts: { red: 0, black: 0 },
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

  // ── picks ────────────────────────────────────────────────────────────────

  function tally(r, pick, sign) {
    r.counts[pick.side] += sign
    if (pick.eligible) r.eligibleCounts[pick.side] += sign
  }

  async function vote({ wallet, side, ip }) {
    if (!round) return { ok: false, error: 'no round open' }
    if (side !== 'red' && side !== 'black') return { ok: false, error: 'pick red or black' }
    wallet = String(wallet || '').trim()
    if (!isWallet(wallet)) return { ok: false, error: 'paste a valid Solana wallet address' }
    const r = round
    if (Date.now() >= r.endsAt) return { ok: false, error: 'no more bets' }

    const prev = r.votes.get(wallet)
    if (!prev) {
      const set = r.ipWallets.get(ip) ?? new Set()
      if (!set.has(wallet) && set.size >= config.maxWalletsPerIp) return { ok: false, error: 'too many wallets from this connection' }
    }

    // The holding is read now so the page can say whether this pick can win.
    // The bell reads it again, and that is the reading that pays.
    const h = await holdingOf(wallet).catch(() => null)
    const raw = h?.raw ?? prev?.raw ?? null
    const eligible = h ? eligibleFor(wallet, h) : prev?.eligible ?? eligibleFor(wallet, null)
    const info = { eligible, holding: toUi(raw), minHold: toUi(minHoldRaw()), excluded: excluded(wallet) || h?.payable === false }

    // The await above can cross the bell.
    if (round !== r || Date.now() >= r.endsAt) return { ok: false, error: 'no more bets' }

    const current = r.votes.get(wallet)
    if (current) tally(r, current, -1)
    else {
      const set = r.ipWallets.get(ip) ?? new Set()
      set.add(wallet)
      r.ipWallets.set(ip, set)
    }
    const pick = { side, eligible, raw, ip, at: current?.at ?? Date.now() }
    r.votes.set(wallet, pick)
    tally(r, pick, +1)
    if (current?.side === side) return { ok: true, side, roundId: r.id, ...info }

    db.savePick(r.id, wallet, pick).catch((e) => console.warn(`[game] pick save failed: ${errMsg(e)}`))
    emit({
      type: 'vote',
      roundId: r.id,
      side,
      prev: current?.side ?? null,
      wallet: shortWallet(wallet),
      eligible,
      counts: { ...r.counts },
      eligibleCounts: { ...r.eligibleCounts },
      voters: r.votes.size,
    })
    return { ok: true, side, roundId: r.id, ...info }
  }

  /** Everything the page shows about one wallet: this round's pick, whether it can win, and what it has won. */
  async function me(wallet) {
    wallet = String(wallet || '').trim()
    if (!isWallet(wallet)) return { roundId: round?.id ?? null, side: null, invalid: true }
    const pick = round?.votes.get(wallet) ?? null
    const h = await holdingOf(wallet).catch(() => null)
    let won
    if (mode === 'demo') {
      const rows = demo.payouts.filter((p) => p.wallet === wallet)
      won = { lamports: rows.reduce((a, p) => a + p.lamports, 0), wins: rows.length }
    } else {
      won = await db.walletStats(wallet).catch(() => ({ lamports: 0, wins: 0 }))
    }
    return {
      roundId: round?.id ?? null,
      side: pick?.side ?? null,
      eligible: eligibleFor(wallet, h),
      holding: toUi(h?.raw ?? null),
      minHold: toUi(minHoldRaw()),
      excluded: excluded(wallet) || h?.payable === false,
      won: { lamports: won.lamports, sol: lamportsToSol(won.lamports), wins: won.wins },
    }
  }

  async function restorePicks() {
    const rows = await db.loadPicks(round.id).catch(() => [])
    for (const p of rows) {
      if (round.votes.has(p.wallet) || (p.side !== 'red' && p.side !== 'black')) continue
      const pick = { side: p.side, eligible: p.eligible, raw: p.raw, ip: p.ip, at: p.at ?? Date.now() }
      round.votes.set(p.wallet, pick)
      tally(round, pick, +1)
      const set = round.ipWallets.get(p.ip) ?? new Set()
      set.add(p.wallet)
      round.ipWallets.set(p.ip, set)
    }
    if (rows.length) console.info(`[game] restored ${rows.length} pick(s) for round ${round.id}`)
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
      eligibleVotes: { ...r.eligibleCounts },
      voters: r.votes.size,
      beacon: r.beacon,
      beaconAt: publishedAt(r.beacon),
      beaconUrl: beaconUrl(r.beacon),
      drand: null,
      result: null,
      winners: 0,
      eligible: 0,
      shareLamports: 0,
      totalLamports: 0,
      payouts: [],
      win: null,
      stage: 'locked',
      status: null,
      potLamports: null,
      claim: null,
      note: null,
      settledAt: null,
    }
    const push = () => {
      settling = { ...s, payouts: s.payouts.map((p) => ({ ...p })) }
      emit({ type: 'settle', round: settling })
    }
    push()

    // While the beacon is being produced (a few seconds that would otherwise
    // be spent waiting): claim the fees, and read what every picker holds at
    // the bell — the reading that decides who is paid.
    const claimP =
      roundMode === 'live'
        ? exclusive(claimNow).catch((e) => ({ error: errMsg(e) }))
        : roundMode === 'dry' && coin?.creatorKind === 'wallet'
          ? chain
              .previewClaim(coin.creator)
              .then((p) => ({ dry: true, lamports: p.vaults?.total ?? 0, simulated: p.empty ? 'nothing to claim' : p.ok ? 'ok' : p.error }))
              .catch((e) => ({ dry: true, error: errMsg(e) }))
          : Promise.resolve(null)
    const holdP =
      roundMode === 'demo' || r.votes.size === 0 ? Promise.resolve(new Map()) : chain.holdings([...r.votes.keys()], coin).catch((e) => ({ error: errMsg(e) }))

    let beacon
    try {
      beacon = await fetchBeacon(r.beacon)
    } catch (e) {
      // Never fall back to local randomness. A spin nobody can verify is not a spin.
      s.claim = await claimP
      s.status = 'void'
      s.potLamports = currentPot()
      s.note = `${errMsg(e)} — round void, the pot rolls over`
      return finish(s, roundMode)
    }

    s.result = spin(beacon.randomness, r.id)
    s.drand = { round: beacon.round, randomness: beacon.randomness, signature: beacon.signature, url: beacon.url }
    s.stage = 'spinning'
    push()

    const color = s.result.color
    const picked = [...r.votes.entries()].filter(([, p]) => p.side === color).sort((a, b) => a[1].at - b[1].at)
    s.winners = picked.length

    const hold = await holdP
    s.claim = await claimP
    s.potLamports = currentPot()

    if (hold?.error) {
      s.win = false
      s.status = 'rollover'
      s.note = `could not read holdings at the bell (${hold.error}) — the pot rolls over`
      return finish(s, roundMode)
    }
    const winners = picked.map(([w]) => w).filter((w) => eligibleFor(w, roundMode === 'demo' ? null : hold.get(w) ?? { raw: 0n, payable: false }))
    s.eligible = winners.length

    if (winners.length === 0) {
      s.win = false
      s.status = 'rollover'
      s.note = picked.length
        ? `${picked.length} picked ${color}, but nobody held the minimum at the bell — the pot rolls over`
        : `nobody picked ${color} — the pot rolls over`
      return finish(s, roundMode)
    }

    const reserve = solToLamports(config.leaveSol)
    let spendable
    if (roundMode === 'demo') spendable = BigInt(Number.MAX_SAFE_INTEGER)
    else if (roundMode === 'live') spendable = BigInt(await chain.balance(kp.publicKey)) - reserve
    else spendable = BigInt(walletLamports ?? (await chain.balance(coin.creator).catch(() => 0))) - reserve

    const plan = planPayout({
      potLamports: BigInt(s.potLamports),
      spendableLamports: spendable,
      winners,
      minShare: solToLamports(config.minShareSol),
      maxPayout: config.maxPayoutSol != null ? solToLamports(config.maxPayoutSol) : null,
      perTx: config.perTx,
      txFee: chain.txFee,
    })

    if (!plan.ok) {
      s.win = false
      s.status = 'too_small'
      s.note = `the pot can't give ${winners.length} winner${winners.length === 1 ? '' : 's'} ${config.minShareSol} SOL each yet — it rolls over and grows`
      return finish(s, roundMode)
    }

    s.win = true
    s.shareLamports = Number(plan.share)
    s.totalLamports = Number(plan.total)
    s.payouts = plan.batches.flat().map((p) => ({ wallet: p.wallet, lamports: Number(p.lamports), sig: null }))

    if (roundMode === 'demo') {
      demo.pot = Math.max(0, demo.pot - s.totalLamports)
      demo.totals.solPaid += s.totalLamports
      demo.totals.walletsPaid += s.payouts.length
      demo.totals.biggestShare = Math.max(demo.totals.biggestShare, s.shareLamports)
      demo.payouts.push(...s.payouts.map((p) => ({ roundId: s.id, wallet: p.wallet, lamports: p.lamports })))
      if (demo.payouts.length > 5000) demo.payouts.splice(0, demo.payouts.length - 5000)
      s.status = 'paid'
      s.note = 'demo — nothing was sent'
      return finish(s, roundMode)
    }

    if (roundMode === 'dry') {
      let simulated = null
      if (coin?.creatorKind === 'wallet') {
        simulated = await chain
          .previewTransfer(coin.creator, plan.batches[0])
          .then((p) => (p.ok ? 'ok' : p.error))
          .catch((e) => errMsg(e))
      }
      s.status = 'dry'
      s.note =
        `dry run — would pay ${winners.length} wallet${winners.length === 1 ? '' : 's'} ${lamportsToSol(plan.share).toFixed(4)} SOL each` +
        (simulated ? ` (first batch simulated on mainnet as the creator: ${simulated})` : '')
      return finish(s, roundMode)
    }

    s.stage = 'paying'
    push()
    await exclusive(() => payOut(s, plan, push)).catch((e) => {
      s.status = s.status ?? 'pay_failed'
      s.note = errMsg(e)
    })
    return finish(s, roundMode)
  }

  async function finish(s, roundMode) {
    s.stage = 'done'
    s.settledAt = Date.now()
    settling = { ...s, payouts: s.payouts.map((p) => ({ ...p })) }
    emit({ type: 'settle', round: settling })

    const paidAny = roundMode === 'demo' ? s.status === 'paid' : s.payouts.some((p) => p.sig)
    const inc = {
      rounds: 1,
      paidRounds: paidAny ? 1 : 0,
      rollovers: s.status === 'rollover' || s.status === 'too_small' ? 1 : 0,
      voids: s.status === 'void' ? 1 : 0,
    }
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
      `[game] round ${s.id} ${s.mode}: ${s.votes.red}R/${s.votes.black}B · wheel ${s.result ? `${s.result.number} ${s.result.color}` : '—'} · ` +
        `${s.eligible}/${s.winners} winners eligible → ${s.status}${s.note ? ` (${s.note})` : ''}`
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
    // little more into the wallet; the pot counts it next time or never —
    // it errs low, never high.
    ledger.carried += v.total
    await saveLedger()
    await db.incTotals({ claimed: v.total }).catch(() => {})
    claimable = 0
    return { sig: res.signature, lamports: v.total }
  }

  /**
   * Wait until a signed transaction is settled either way: landed, or its
   * blockhash expired without it. Until then "not found" is not an answer,
   * and paying the same batch again would pay it twice.
   */
  async function outcome(sig, lastValid) {
    for (let i = 0; i < 120; i++) {
      const l = await chain.landed(sig).catch(() => null)
      if (l === true) return 'landed'
      if (l === false) return 'failed'
      const h = await chain.connection.getBlockHeight('confirmed').catch(() => 0)
      if (lastValid && h > lastValid + 10) return (await chain.landed(sig).catch(() => null)) === true ? 'landed' : 'expired'
      await sleep(2000)
    }
    return 'unknown'
  }

  /**
   * The payout, batch by batch. The whole total leaves the ledger BEFORE the
   * first batch is signed, and each batch's signature is saved before it is
   * broadcast. A batch that did not land is retried only once the chain has
   * said it never will; one that cannot be paid goes back into the pot. If the
   * process dies halfway, `reconcile` at boot finishes the bookkeeping.
   */
  async function payOut(s, plan, push) {
    const total = Number(plan.total)
    ledger.carried = Math.max(0, ledger.carried - total)
    ledger.pendingPayout = {
      roundId: s.id,
      batches: plan.batches.map((b) => ({
        recipients: b.map((p) => ({ wallet: p.wallet, lamports: Number(p.lamports) })),
        sig: null,
        lastValid: null,
        state: 'pending',
      })),
    }
    await saveLedger()

    let paidWallets = 0
    let paidLamports = 0
    for (const b of ledger.pendingPayout.batches) {
      let landedSig = null
      let lastErr = null
      let lastOutcome = null
      for (let attempt = 0; attempt < 3 && !landedSig; attempt++) {
        b.sig = null
        try {
          const res = await chain.transferMany(kp, b.recipients, {
            onSigned: async (sig, lastValid) => {
              b.sig = sig
              b.lastValid = lastValid
              await saveLedger()
            },
          })
          if (res.landed) landedSig = res.signature
        } catch (e) {
          lastErr = e
        }
        if (landedSig) break
        // Rejected in simulation: never signed, never sent, and the next
        // attempt would meet the same balance.
        if (!b.sig) break
        lastOutcome = await outcome(b.sig, b.lastValid)
        if (lastOutcome === 'landed') landedSig = b.sig
        else if (lastOutcome !== 'expired') break
      }

      const sum = b.recipients.reduce((a, p) => a + p.lamports, 0)
      if (landedSig) {
        b.state = 'paid'
        b.sig = landedSig
        paidWallets += b.recipients.length
        paidLamports += sum
        const inBatch = new Set(b.recipients.map((q) => q.wallet))
        for (const p of s.payouts) if (inBatch.has(p.wallet)) p.sig = landedSig
        await db.savePayouts(b.recipients.map((p) => ({ roundId: s.id, wallet: p.wallet, lamports: p.lamports, sig: landedSig }))).catch(() => {})
      } else if (lastOutcome === 'unknown') {
        // Signed, and the chain would not say either way. Left for the
        // reconcile rather than refunded: refunding a batch that landed would
        // let the pot pay it twice.
        b.state = 'unknown'
        console.error(`[game] batch ${b.sig} of round ${s.id} unresolved — left for reconcile`)
      } else {
        b.state = 'failed'
        ledger.carried += sum
        console.error(`[game] batch of ${b.recipients.length} in round ${s.id} not paid (${lastErr ? errMsg(lastErr) : 'expired'}) — back in the pot`)
      }
      await saveLedger()
      push()
    }

    const unresolved = ledger.pendingPayout.batches.some((b) => b.state === 'unknown')
    if (!unresolved) ledger.pendingPayout = null
    await saveLedger()
    await db.incTotals({ solPaid: paidLamports, walletsPaid: paidWallets }, paidWallets ? { biggestShare: s.shareLamports } : null).catch(() => {})

    s.status = paidWallets === s.payouts.length ? 'paid' : paidWallets > 0 ? 'partial' : 'pay_failed'
    if (s.status !== 'paid') s.note = `${paidWallets} of ${s.payouts.length} paid — the rest went back into the pot${unresolved ? ' (one batch is being reconciled)' : ''}`
  }

  /** A payout that was in flight when the process died: finish its books against the chain. */
  async function reconcile() {
    const pp = ledger.pendingPayout
    if (!pp) return
    console.warn(`[game] reconciling the payout of round ${pp.roundId}`)
    const paidRows = []
    for (const b of pp.batches) {
      if (b.state === 'paid' || b.state === 'failed') continue
      const o = b.sig ? await outcome(b.sig, b.lastValid) : 'expired'
      if (o === 'landed') {
        b.state = 'paid'
        paidRows.push(...b.recipients.map((p) => ({ roundId: pp.roundId, wallet: p.wallet, lamports: p.lamports, sig: b.sig })))
      } else if (o === 'unknown') {
        console.error(`[game] batch ${b.sig} still unresolved — keeping it out of the pot`)
      } else {
        b.state = 'failed'
        ledger.carried += b.recipients.reduce((a, p) => a + p.lamports, 0)
      }
    }
    await db.savePayouts(paidRows).catch(() => {})
    if (paidRows.length) await db.incTotals({ solPaid: paidRows.reduce((a, p) => a + p.lamports, 0), walletsPaid: paidRows.length }).catch(() => {})
    if (!pp.batches.some((b) => b.state === 'pending' || b.state === 'unknown')) ledger.pendingPayout = null
    await saveLedger()
  }

  // ── the pot, live ────────────────────────────────────────────────────────

  async function refreshPot() {
    try {
      if (mode === 'demo') {
        // As if people were trading: a few thousandths of a SOL every poll.
        demo.pot += Math.floor((0.002 + Math.random() * 0.02) * 1e9)
      } else if (coin?.creator) {
        const [v, bal, fresh] = await Promise.all([chain.vaults(coin.creator), chain.balance(coin.creator), chain.readCoin(coin.mint).catch(() => null)])
        claimable = v.total
        walletLamports = bal
        if (fresh) coin = { ...coin, venue: fresh.venue, mcapSol: fresh.mcapSol, supplyRaw: fresh.supplyRaw }
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
    balCache.clear()
    if (!token) {
      mode = 'demo'
      modeNote = 'no CA yet — the pot is simulated and every wallet counts'
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
      modeNote = modeNote || 'DRY_RUN — picks, spins and holdings are real, nothing is sent'
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
    me,
    get mode() {
      return mode
    },

    async start() {
      const saved = await db.getState('ledger').catch(() => null)
      if (saved) ledger = { carried: saved.carried ?? 0, pendingPayout: saved.pendingPayout ?? null }
      const token = (await db.getState('token').catch(() => null)) || config.token
      await configure(token)
      await loadHistory()
      if (mode === 'live' && ledger.pendingPayout) await exclusive(reconcile)

      open(Date.now())
      await restorePicks()
      schedule()
      await refreshPot()
      timers.push(setInterval(refreshPot, config.potPollMs))
      console.info(`[game] ${mode.toUpperCase()}${modeNote ? ` — ${modeNote}` : ''}${coin ? ` · mint ${coin.mint} · creator ${coin.creator} · ${coin.venue}` : ''}`)
    },

    stop() {
      clearTimeout(timer)
      for (const t of timers) clearInterval(t)
    },

    /** POST /set-ca. Refused while a payout is in flight: the ledger belongs to the coin it was claimed for. */
    async setToken(ca) {
      const next = String(ca || '').trim()
      if (next && !isPubkey(next)) throw Object.assign(new Error('not a valid Solana address'), { code: 400 })
      if (ledger.pendingPayout) throw Object.assign(new Error('a payout is in flight — try again in a minute'), { code: 409 })
      await db.setState('token', next || null)
      await configure(next)
      await loadHistory()
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
      return [...history, ...demo.history].find((r) => r.id === id) ?? (await db.getRound(id))
    },
  }
}
