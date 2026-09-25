// ============================================================================
// index.js — wiring. clock -> table -> hub -> browsers.
// ============================================================================

import { config, BRAND } from './config.js'
import { createDb } from './db.js'
import { createGame } from './game.js'
import { createHub } from './hub.js'
import { createPrice } from './price.js'

// The HTTP port opens first so Railway's health check sees a process, even
// while the chain reads at boot are still in flight.
const hub = createHub({ port: config.port })

const db = createDb()
await db.connect()

const price = createPrice()
price.start()

const game = createGame({ db, price, emit: (e) => hub.broadcast({ ...e, ts: Date.now() }) })
await game.start()
hub.attach(game)

console.info(`[index] ${BRAND.name} ready — a spin every ${config.roundMs / 1000}s`)

function shutdown() {
  console.info('\n[index] closing the table')
  game.stop()
  price.stop()
  hub.close()
  db.close().finally(() => process.exit(0))
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
