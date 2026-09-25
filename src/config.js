// ============================================================================
// config.js — every tunable in one place.
//
// RED OR BLACK: every five minutes people paste their wallet and pick a colour.
// When the bell rings a public drand beacon spins the wheel, and everybody who
// picked the colour it lands on — and holds enough of the coin — splits the
// whole creator-reward pot in equal parts, paid in SOL. If nobody eligible
// called it, the pot rolls over to the next spin.
//
// Three modes, and the page always says which one it is looking at:
//
//   demo  no TOKEN yet. The whole show runs on a simulated pot and every wallet
//         counts as eligible, so the site can be built and streamed first.
//   dry   TOKEN set. Real votes, real beacon, real holdings, real pot read off
//         the chain — the payout is simulated on mainnet, nothing is sent.
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
   * that is where pump.fun pays creator rewards, and the wallet the winners
   * are paid from. Base58 64-byte secret or a JSON byte array. The server
   * refuses to go live if this key is not the coin's creator.
   */
  treasurySecret: process.env.TREASURY_SECRET || process.env.CREATOR_SECRET || '',

  rpcUrl: process.env.RPC_URL || 'https://api.mainnet-beta.solana.com',
  explorer: (process.env.EXPLORER_URL || 'https://solscan.io').replace(/\/$/, ''),

  /**
   * ---- THE POT ----
   *
   * The pot is NOT the wallet balance. The creator wallet is usually somebody's
   * real wallet, with their own SOL in it, and a payout of "everything above a
   * reserve" would hand that out too. So the pot is a ledger:
   *
   *   pot = what was carried over + what the bells claimed from the vaults
   *
   * A payout spends the pot and nothing else. A rollover carries it. Without a
   * database the carried figure starts at zero on every boot, which errs on
   * the side of paying LESS, never more.
   */
  /** SOL that always stays in the wallet for fees and rent, whatever the pot says. */
  leaveSol: num(process.env.LEAVE_SOL, 0.01),
  /** Vault balance below which a claim is not worth a transaction. */
  claimMinSol: num(process.env.CLAIM_MIN_SOL, 0.0005),
  priorityFeeMicroLamports: num(process.env.PRIORITY_FEE_MICROLAMPORTS, 200_000),

  /**
   * ---- WHO GETS PAID ----
   *
   * Equal parts per wallet is farmable: a wallet costs nothing to make. The
   * floor is what prices that attack — to take two shares you have to hold
   * the minimum twice. It is checked when you pick (so the page can tell you)
   * and again at the bell, which is the one that counts.
   */
  minHoldPct: num(process.env.MIN_HOLD_PCT, 0.05),
  /**
   * The smallest share worth sending. Also the floor that keeps a transfer to a
   * brand-new wallet valid: an account below rent-exemption (0.00089 SOL)
   * cannot be created, and one bad recipient reverts a whole batch. When the
   * pot cannot give every winner this much, it rolls over and grows instead.
   */
  minShareSol: num(process.env.MIN_SHARE_SOL, 0.001),
  /** Ceiling on what one round pays out in total, if you want one. Empty = the whole pot. */
  maxPayoutSol: process.env.MAX_PAYOUT_SOL ? Number(process.env.MAX_PAYOUT_SOL) : null,
  /** SystemProgram transfers per transaction. */
  perTx: num(process.env.MAX_RECIPIENTS_PER_TX, 16),
  /** Case-sensitive base58, comma separated. The creator wallet is always excluded. */
  exclude: new Set((process.env.EXCLUDE_ADDRESSES || '').split(',').map((x) => x.trim()).filter(Boolean)),

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

  /**
   * Distinct wallets one IP may enter per round. A second line behind the
   * holding floor, kept loose: phone carriers put thousands of people behind
   * one address.
   */
  maxWalletsPerIp: num(process.env.MAX_WALLETS_PER_IP, 8),

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

if (config.minShareSol < 0.00089088) {
  console.error('[config] MIN_SHARE_SOL below 0.00089088 would revert payouts to brand-new wallets (rent exemption)')
  process.exit(1)
}
if (config.perTx < 1 || config.perTx > 20) {
  console.error('[config] MAX_RECIPIENTS_PER_TX must be between 1 and 20 — a Solana transaction has a size limit')
  process.exit(1)
}
if (config.roundMs < 20_000) {
  console.error('[config] ROUND_MS below 20s leaves no room for the spin')
  process.exit(1)
}
