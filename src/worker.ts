// Bun Worker: the only place that talks to the Binance REST API. It fetches closed 4h candles and
// posts them to the main thread (Hono app), which computes features, stores state and runs the bot tree.
// No websocket: one timer wakes the worker just after every 4h boundary, so it is idle in between.
declare const self: { postMessage(m: unknown): void; onmessage: ((e: { data: any }) => void) | null }
const BAR_MS = 4 * 3600_000
let base = 'https://api.binance.com'
let delay = 5000
let symbols: { symbol: string; since: number | null }[] = []
let timer: ReturnType<typeof setTimeout> | null = null
let running = false

const post = (m: unknown) => self.postMessage(m)

async function klines(symbol: string, since: number | null) {
  const stale = since == null || (Date.now() - since) / BAR_MS > 990 // too old -> just take the latest 1000
  const url = `${base}/api/v3/klines?symbol=${symbol}&interval=4h&limit=1000${stale ? '' : `&startTime=${since}`}`
  let lastErr: unknown
  for (let a = 0; a < 3; a++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(15_000) })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const rows = (await res.json()) as any[][]
      const now = Date.now()
      // keep closed candles only (closeTime in the past)
      return rows.filter((r) => Number(r[6]) < now).map((r) => ({ t: Number(r[0]), o: +r[1], h: +r[2], l: +r[3], c: +r[4], v: +r[5] }))
    } catch (e) { lastErr = e; await Bun.sleep(1000 * 2 ** a) }
  }
  throw lastErr
}

async function cycle() {
  if (running) return
  running = true
  if (timer) clearTimeout(timer)
  let retryMs = 0
  try {
    const expected = Math.floor(Date.now() / BAR_MS) * BAR_MS - BAR_MS
    for (const s of symbols) {
      try {
        const cs = await klines(s.symbol, s.since)
        if (cs.length) { s.since = cs[cs.length - 1]!.t; post({ type: 'candles', symbol: s.symbol, candles: cs }) }
        if (!cs.length || s.since! < expected) retryMs = 15_000 // newest candle not visible yet
      } catch (e) { retryMs = 30_000; post({ type: 'error', symbol: s.symbol, message: String(e) }) }
    }
    post({ type: 'cycleDone', at: Date.now() })
  } finally {
    running = false
    const next = (Math.floor(Date.now() / BAR_MS) + 1) * BAR_MS + delay
    timer = setTimeout(cycle, retryMs ? Math.min(retryMs, next - Date.now()) : next - Date.now())
  }
}

self.onmessage = (e) => {
  const m = e.data
  if (m.type === 'config') {
    base = m.base; delay = m.delay
    const had = new Set(symbols.map((s) => s.symbol))
    const changed = m.symbols.some((s: any) => !had.has(s.symbol)) || had.size !== m.symbols.length
    symbols = m.symbols
    if (changed || m.force) void cycle() // new symbols need their history right away
    else if (!timer) void cycle()
  }
}
