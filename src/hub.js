// ============================================================================
// hub.js — one HTTP server, one WebSocket, everybody at the same table.
//
//   connect                         -> {type:'hello', ...snapshot}
//   {op:'hi',   voter}              -> {type:'me', roundId, side}
//   {op:'vote', voter, side}        -> {type:'voteAck', ok, side | error}
//   {op:'ping'}                     -> {type:'pong'}
//
//   broadcast: round · vote · settle · pot · totals · burn · tick · hello
//
// HTTP on the same port serves the same state as JSON, because a page that
// says it burned N tokens should let anyone check without a socket client.
// ============================================================================

import http from 'http'
import { WebSocketServer } from 'ws'
import { config, BRAND } from './config.js'
import { ipTag } from './game.js'

function readJsonBody(req, limit = 16 * 1024) {
  return new Promise((resolve) => {
    let raw = ''
    let over = false
    req.on('data', (chunk) => {
      if (over) return
      raw += chunk
      if (raw.length > limit) {
        over = true
        raw = ''
      }
    })
    req.on('end', () => {
      if (over) return resolve(null)
      try {
        resolve(raw ? JSON.parse(raw) : {})
      } catch {
        resolve(null)
      }
    })
    req.on('error', () => resolve(null))
  })
}

/**
 * FAILS CLOSED: with no ADMIN_PASSWORD the admin endpoints are off, not open.
 * Read from a header or the body, never the query string — URLs end up in logs.
 */
function checkAdmin(req, body) {
  const want = config.adminPassword
  if (!want) return false
  const got = req.headers['x-admin-password'] || body?.password
  return typeof got === 'string' && got.length === want.length && got === want
}

/** The caller's address. Railway's edge puts the real one first in x-forwarded-for. */
function clientIp(req) {
  const fwd = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim()
  return fwd || req.socket?.remoteAddress || 'unknown'
}

export function createHub({ port }) {
  const clients = new Set()
  let game = null

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost')
    const p = url.pathname

    const json = (body, code = 200) => {
      if (res.headersSent || res.writableEnded) return
      res.writeHead(code, {
        'content-type': 'application/json',
        'cache-control': 'no-store',
        'access-control-allow-origin': '*',
      })
      res.end(JSON.stringify(body))
    }

    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'GET,POST,OPTIONS',
        'access-control-allow-headers': '*',
      })
      return res.end()
    }

    if (!game) return json({ ok: false, error: 'starting' }, 503)

    if (req.method === 'POST' && (p === '/set-ca' || p === '/set-pot')) {
      const body = await readJsonBody(req)
      if (body === null) return json({ error: 'body must be JSON and under 16KB' }, 400)
      if (!checkAdmin(req, body)) {
        return json({ error: config.adminPassword ? 'unauthorized' : 'disabled until ADMIN_PASSWORD is set' }, 401)
      }
      try {
        if (p === '/set-ca') return json({ ok: true, ...(await game.setToken(body.ca ?? body.token ?? body.mint ?? '')) })
        return json({ ok: true, pot: await game.setPot(body.sol) })
      } catch (e) {
        return json({ error: e.message }, e.code ?? 500)
      }
    }

    if (p === '/health') return json({ ok: true, mode: game.mode, viewers: clients.size, ts: Date.now() })
    if (p === '/state') return json({ type: 'hello', ...game.snapshot(), viewers: clients.size })
    if (p === '/stats') return json(game.snapshot().totals)
    if (p === '/rounds') {
      const snap = game.snapshot()
      return json({ mode: snap.mode, rows: snap.history.slice(0, Number(url.searchParams.get('limit') || 60)) })
    }
    if (p.startsWith('/round/')) {
      const id = Number(p.slice('/round/'.length))
      const r = Number.isFinite(id) ? await game.round(id) : null
      return r ? json(r) : json({ error: 'no such round' }, 404)
    }

    const snap = game.snapshot()
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', 'access-control-allow-origin': '*' })
    res.end(
      `${BRAND.name} — ${snap.mode.toUpperCase()}${snap.modeNote ? ` (${snap.modeNote})` : ''}\n` +
        `round ${snap.round?.id} · bell in ${Math.ceil(Math.max(0, snap.round.endsAt - Date.now()) / 1000)}s · ` +
        `${snap.round.counts.red} red / ${snap.round.counts.black} black · pot ${snap.pot.sol.toFixed(4)} SOL · ${clients.size} watching\n\n` +
        'WebSocket on this same URL for the live table.\n' +
        'JSON: /state · /stats · /rounds · /round/<id> · /health\n' +
        `Admin (x-admin-password header): POST /set-ca {"ca":"<mint>"} · POST /set-pot {"sol":1.5}` +
        `${config.adminPassword ? '' : '  (DISABLED — set ADMIN_PASSWORD)'}\n`
    )
  })

  const wss = new WebSocketServer({ server, maxPayload: 4 * 1024 })

  wss.on('connection', (client, req) => {
    clients.add(client)
    const ip = ipTag(clientIp(req))
    let lastVoteAt = 0
    const send = (m) => {
      try {
        client.send(JSON.stringify(m))
      } catch {}
    }

    if (game) send({ type: 'hello', ...game.snapshot(), viewers: clients.size })

    client.on('message', (raw) => {
      let msg
      try {
        msg = JSON.parse(raw)
      } catch {
        return
      }
      if (!game) return
      if (msg.op === 'ping') return send({ type: 'pong', now: Date.now() })
      if (msg.op === 'hi') {
        const snap = game.snapshot()
        return send({ type: 'me', roundId: snap.round?.id, side: game.myVote(msg.voter) })
      }
      if (msg.op === 'vote') {
        // Four changes of mind a second is plenty for a human.
        if (Date.now() - lastVoteAt < 250) return send({ type: 'voteAck', ok: false, error: 'slow down' })
        lastVoteAt = Date.now()
        return send({ type: 'voteAck', ...game.vote({ voter: msg.voter, side: msg.side, ip }) })
      }
    })
    client.on('close', () => clients.delete(client))
    client.on('error', () => clients.delete(client))
  })

  function broadcast(event) {
    if (clients.size === 0) return
    const data = JSON.stringify(event)
    for (const c of clients) {
      if (c.readyState === 1) {
        try {
          c.send(data)
        } catch {}
      }
    }
  }

  // Keeps every countdown honest (a throttled background tab snaps back) and
  // carries the viewer count.
  const ticker = setInterval(() => broadcast({ type: 'tick', now: Date.now(), viewers: clients.size }), 5000)

  server.listen(port, () => console.info(`[hub] listening on :${port}`))

  return {
    broadcast,
    attach(g) {
      game = g
    },
    close() {
      clearInterval(ticker)
      for (const c of clients) {
        try {
          c.close()
        } catch {}
      }
      wss.close()
      server.close()
    },
  }
}
