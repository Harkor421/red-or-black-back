// ============================================================================
// config.js — every tunable in one place.
//
// RED OR BLACK: every five minutes the community picks a colour. When the bell
// rings a public drand beacon spins the wheel. If the wheel lands on the
// community's colour, the whole creator-reward pot buys the coin back and
// burns it. If it lands on the other one, the pot rolls over to the next spin.
//
// Three modes, and the page always says which one it is looking at:
//
//   demo  no TOKEN yet. The whole show runs on a simulated pot so the site can
//         be built, streamed and rehearsed before the coin exists.
//   dry   TOKEN set. Real votes, real beacon, real pot read off the chain —
//         but no claim, no buy and no burn is ever sent.
//   live  TOKEN + TREASURY_SECRET (the coin's creator wallet) + DRY_RUN=false.
// ============================================================================

import 'dotenv/config'

const num = (v, d) => (v === undefined || v === '' ? d : Number(v))
const bool = (v, d) => (v === undefined || v === '' ? d : String(v) === 'true' || String(v) === '1')

export const config = {
  port: num(process.env.PORT, 8080),

  /** Round length. Rounds are aligned to the wall clock (…:00, :05, :10). */
  roundMs: num(process.env.ROUND_MS, 5 * 60 * 1000),
  /** How many settled rounds the page gets on connect. */
  historyLen: num(process.env.HISTORY_LEN, 60),

  /**
   * The mint. `CA` and `MINT` are accepted as aliases. Can also be set live
   * with POST /set-ca, which is what you do right after launching on pump.fun.
   */
  token: (process.env.TOKEN || process.env.CA || process.env.MINT || '').trim(),

  /** Nothing is sent to the chain until this is explicitly false. */
  dryRun: bool(process.env.DRY_RUN, true),

  /**
   * The coin's CREATOR wallet — the one that launched it on pump.fun, because
   * that is where pump.fun pays creator rewards. Base58 64-byte secret or a
   * JSON byte array. The server refuses to go live if this key is not the
   * coin's creator: claiming for somebody else's coin fails on chain anyway,
   * and buying with a wallet that never gets refilled would spend whatever
   * happens to be in it.
   */
  treasurySecret: process.env.TREASURY_SECRET || process.env.CREATOR_SECRET || '',

  rpcUrl: process.env.RPC_URL || 'https://api.mainnet-beta.solana.com',
  explorer: (process.env.EXPLORER_URL || 'https://solscan.io').replace(/\/$/, ''),

  /**
   * ---- THE POT ----
   *
   * The pot is NOT the wallet balance. The creator wallet is usually somebody's
   * real wallet, with their own SOL in it, and a win that spent "everything
   * above a reserve" would spend that too. So the pot is a ledger:
   *
   *   pot = what was carried over + what this round claimed from the vaults
   *
   * A win spends the pot and nothing else. A loss carries it. Without a
   * database the carried figure starts at zero on every boot, which errs on
   * the side of spending LESS, never more.
   */
  /** SOL that always stays in the wallet for fees and rent, whatever the pot says. */
  leaveSol: num(process.env.LEAVE_SOL, 0.01),
  /** A win below this does not buy: the fees would eat it. It rolls over instead. */
  minBuySol: num(process.env.MIN_BUY_SOL, 0.01),
  /** Hard ceiling on a single buyback, if you want one. Empty = no ceiling. */
  maxBuySol: process.env.MAX_BUY_SOL ? Number(process.env.MAX_BUY_SOL) : null,
  /** Vault balance below which a claim is not worth a transaction. */
  claimMinSol: num(process.env.CLAIM_MIN_SOL, 0.0005),
  slippageBps: num(process.env.SLIPPAGE_BPS, 1500),
  priorityFeeMicroLamports: num(process.env.PRIORITY_FEE_MICROLAMPORTS, 200_000),

  /**
   * `bought` burns exactly what the buyback bought. `all` burns every token
   * the creator wallet holds, which would include the dev's own bag.
   */
  burnMode: (process.env.BURN_MODE || 'bought').toLowerCase(),

  /** How often the live pot (carried + claimable in the vaults) is re-read. */
  potPollMs: num(process.env.POT_POLL_MS, 15_000),

  /**
   * ---- THE WHEEL ----
   * drand quicknet: a public randomness beacon, one value every 3 seconds,
   * signed by a threshold network nobody here controls. The round used for a
   * spin is fixed by the clock before anybody votes, so neither the server nor
   * a voter can know or choose the result. Anyone can re-derive it.
   */
  drand: {
    chainHash: process.env.DRAND_CHAIN || '52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971',
    genesis: num(process.env.DRAND_GENESIS, 1692803367),
    period: num(process.env.DRAND_PERIOD, 3),
    /** The beacon used is the first one published at least this long after the bell. */
    marginMs: num(process.env.DRAND_MARGIN_MS, 1000),
    endpoints: (process.env.DRAND_URLS || 'https://api.drand.sh,https://api2.drand.sh,https://api3.drand.sh,https://drand.cloudflare.com')
      .split(',')
      .map((s) => s.trim().replace(/\/$/, ''))
      .filter(Boolean),
    /** Give up and void the round after this long without a beacon. Never fall back to local randomness. */
    timeoutMs: num(process.env.DRAND_TIMEOUT_MS, 60_000),
  },

  /** Distinct voters one IP may register per round. Votes are free, so this only keeps it honest-looking. */
  maxVotersPerIp: num(process.env.MAX_VOTERS_PER_IP, 4),

  /** Demo pot: starts here and grows as if trades were happening. */
  demoPotSol: num(process.env.DEMO_POT_SOL, 1.2),

  /** Guards POST /set-ca and POST /set-pot. FAILS CLOSED: empty = disabled. */
  adminPassword: process.env.ADMIN_PASSWORD || '',

  mongoUrl:
    process.env.MONGO_URL ||
    process.env.MONGODB_URI ||
    process.env.MONGO_PUBLIC_URL ||
    process.env.DATABASE_URL ||
    '',
  mongoDb: process.env.MONGO_DB || 'redorblack',
}

export const BRAND = Object.freeze({
  name: process.env.SITE_NAME || 'RED OR BLACK',
  ticker: process.env.COIN_TICKER || 'ROB',
  twitter: process.env.TWITTER_URL || '',
  site: process.env.SITE_URL || '',
})

if (!['bought', 'all'].includes(config.burnMode)) {
  console.error('[config] BURN_MODE must be "bought" or "all"')
  process.exit(1)
}
if (config.roundMs < 20_000) {
  console.error('[config] ROUND_MS below 20s leaves no room for the spin')
  process.exit(1)
}
