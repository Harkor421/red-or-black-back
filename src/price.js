// ============================================================================
// price.js — SOL in dollars, for the page only. Nothing is sized in dollars:
// the pot is SOL in, SOL spent. A missing rate hides the dollar figure; it
// never stops a round.
// ============================================================================

const SOL_MINT = 'So11111111111111111111111111111111111111112'
const URL = `https://lite-api.jup.ag/price/v3?ids=${SOL_MINT}`

export function createPrice() {
  let usd = null
  let at = 0

  async function poll() {
    try {
      const res = await fetch(URL, { signal: AbortSignal.timeout(6000) })
      const j = res.ok ? await res.json() : null
      const v = Number(j?.[SOL_MINT]?.usdPrice)
      if (Number.isFinite(v) && v > 0) {
        usd = v
        at = Date.now()
      }
    } catch {
      /* keep the last rate */
    }
  }

  let timer = null
  return {
    start() {
      poll()
      timer = setInterval(poll, 60_000)
    },
    stop() {
      clearInterval(timer)
    },
    /** Null when the last good rate is older than 10 minutes. */
    get solUsd() {
      return usd && Date.now() - at < 10 * 60_000 ? usd : null
    },
  }
}
