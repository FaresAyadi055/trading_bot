// Bun Worker: the only place that talks to the Binance REST API. It fetches closed 4h candles for the symbols the
// main thread asks for (only symbols an active bot listens to — a bot that is in a trade asks for just its asset)
// and posts them back; the Hono app computes features, stores state and runs the bots. No websocket: one timer
// wakes the worker just after every 4h boundary, so it is idle in between.
declare const self: { postMessage(m: unknown): void; onmessage: ((e: { data: any }) => void) | null }
const BAR_MS = 4 * 3600_000
const GRACE_MS = 10 * 60_000 // keep retrying a lagging symbol this long after the bar closed
const CONCURRENCY = 4
let base = 'https://api.binance.com'
let delay = 5000
let symbols: { symbol: string; since: number | null }[] = []
let timer: ReturnType<typeof setTimeout> | null = null
let running = false
let dirty = false

const post = (m: unknown) => self.postMessage(m)

class FetchError extends Error { constructor(msg: string, public retryAfterMs: number | null, public permanent = false) { super(msg) } }

async function pool<T>(items: T[], n: number, fn: (x: T) => Promise<void>) {
  let i = 0
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) await fn(items[i++]!) }))
}

async function klines(symbol: string, since: number | null) {
  const stale = since == null || (Date.now() - since) / BAR_MS > 990 // too old -> just take the latest 1000
  const url = `${base}/api/v3/klines?symbol=${symbol}&interval=4h&limit=1000${stale ? '' : `&startTime=${since}`}`
  let lastErr: unknown
  for (let a = 0; a < 3; a++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(15_000) })
      if (res.status === 429 || res.status === 418) throw new FetchError(`HTTP ${res.status} (rate limited)`, (Number(res.headers.get('retry-after')) || 60) * 1000)
      if (res.status === 400) throw new FetchError(`HTTP 400 (symbol rejected by Binance)`, null, true) // invalid / delisted: not retried before the next bar
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const rows = (await res.json()) as any[][]
      const now = Date.now()
      // keep closed candles only (closeTime in the past)
      return rows.filter((r) => Number(r[6]) < now).map((r) => ({ t: Number(r[0]), o: +r[1], h: +r[2], l: +r[3], c: +r[4], v: +r[5] }))
    } catch (e) {
      lastErr = e
      if (e instanceof FetchError && (e.permanent || e.retryAfterMs)) throw e
      await Bun.sleep(1000 * 2 ** a)
    }
  }
  throw lastErr
}

async function cycle() {
  if (running) { dirty = true; return }
  running = true; dirty = false
  if (timer) clearTimeout(timer)
  let retryMs = 0
  let hadError = false
  const want = (ms: number) => { retryMs = retryMs ? Math.min(retryMs, ms) : ms }
  try {
    const expected = Math.floor(Date.now() / BAR_MS) * BAR_MS - BAR_MS
    // only symbols that are missing the latest closed candle need a request
    const todo = symbols.filter((s) => s.since == null || s.since < expected)
    await pool(todo, CONCURRENCY, async (s) => {
      try {
        const cs = await klines(s.symbol, s.since)
        if (cs.length) { s.since = cs[cs.length - 1]!.t; post({ type: 'candles', symbol: s.symbol, candles: cs }) }
        if ((!cs.length || s.since! < expected) && Date.now() < expected + BAR_MS + GRACE_MS) want(15_000) // newest candle not visible yet
      } catch (e) {
        hadError = true
        post({ type: 'error', symbol: s.symbol, message: String(e) })
        if (!(e instanceof FetchError && e.permanent)) want(e instanceof FetchError && e.retryAfterMs ? e.retryAfterMs : 30_000)
      }
    })
    post({ type: 'cycleDone', at: Date.now(), ok: !hadError })
  } finally {
    running = false
    const next = (Math.floor(Date.now() / BAR_MS) + 1) * BAR_MS + delay
    const wait = retryMs ? Math.min(retryMs, next - Date.now()) : next - Date.now()
    timer = setTimeout(cycle, Math.max(1000, wait))
    if (dirty) { clearTimeout(timer); void cycle() } // a config change arrived mid-cycle
  }
}

/** Tradability check (exchangeInfo) used when a bot is created / edited. */
async function validate(id: number, list: string[]) {
  const results: unknown[] = []
  await pool(list, CONCURRENCY, async (symbol) => {
    try {
      const res = await fetch(`${base}/api/v3/exchangeInfo?symbol=${symbol}`, { signal: AbortSignal.timeout(10_000) })
      if (res.status === 400) return void results.push({ symbol, ok: false, reason: 'unknown Binance symbol' })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const x = ((await res.json()) as any).symbols?.[0]
      if (!x) results.push({ symbol, ok: false, reason: 'unknown Binance symbol' })
      else if (x.quoteAsset !== 'USDT') results.push({ symbol, ok: false, reason: `quote asset is ${x.quoteAsset}, only USDT pairs are supported` })
      else if (x.status !== 'TRADING' || x.isSpotTradingAllowed === false) results.push({ symbol, ok: false, reason: `not tradable on spot (status ${x.status})` })
      else results.push({ symbol, ok: true })
    } catch (e) { results.push({ symbol, ok: false, unavailable: true, reason: String(e) }) }
  })
  post({ type: 'validated', id, results })
}

self.onmessage = (e) => {
  const m = e.data
  if (m.type === 'config') {
    base = m.base; delay = m.delay
    const had = new Set(symbols.map((s) => s.symbol))
    const changed = m.symbols.some((s: any) => !had.has(s.symbol))
    symbols = m.symbols
    if (changed || m.force || !timer) void cycle() // new symbols need their history right away
  } else if (m.type === 'validate') void validate(m.id, m.symbols)
}
