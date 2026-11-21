// Bun Worker: the only place that talks to the Binance public REST API. It fetches closed 4h candles for the
// symbols the main thread asks for, refreshes the dynamic universe daily, and posts the results back.
// No websocket: one timer wakes the worker just after every 4h boundary, so it is idle in between.
//
// REST budget (important on a Pi Zero 2W): a conservative weight limiter (<=1200 weight/min, Binance allows 6000),
// request spacing, 429/418 Retry-After handling, one exchangeInfo / ticker call for the whole market, a 24h-volume
// pre-filter, and only 452 klines per surviving candidate (the 450-bar history check).
import { P } from './params'
import { BAR_MS } from './time'
import { historyCheck, eligibleSymbol, selectUniverse, type UniverseCandidate } from './universe'
import type { Candle } from './types'

declare const self: { postMessage(m: unknown): void; onmessage: ((e: { data: any }) => void) | null }
const GRACE_MS = 10 * 60_000 // keep retrying a lagging symbol this long after the bar closed
const MAX_WEIGHT_PER_MIN = 1200 // Binance's IP limit is 6000/min; stay far below it
const MIN_GAP_MS = 40

let base = 'https://api.binance.com'
let delay = 5000
let symbols: { symbol: string; since: number | null }[] = []
let timer: ReturnType<typeof setTimeout> | null = null
let running = false
let dirty = false
let universeRunning = false
let exchangeInfoCache: { at: number; list: any[] } | null = null

const post = (m: unknown) => self.postMessage(m)
const sleep = (ms: number) => Bun.sleep(Math.max(0, ms))

// ---------------------------------------------------------------- rate limiter
let weightUsed = 0
let windowStart = 0
let blockedUntil = 0
let lastStart = 0

async function acquire(weight: number) {
  for (;;) {
    const now = Date.now()
    if (now < blockedUntil) { await sleep(blockedUntil - now); continue }
    if (now - windowStart >= 60_000) { windowStart = now; weightUsed = 0 }
    if (weightUsed + weight <= MAX_WEIGHT_PER_MIN) { weightUsed += weight; break }
    await sleep(windowStart + 60_000 - now + 50)
  }
  const wait = lastStart + MIN_GAP_MS - Date.now()
  if (wait > 0) await sleep(wait)
  lastStart = Date.now()
}

class FetchError extends Error { constructor(msg: string, public retryAfterMs: number | null, public permanent = false) { super(msg) } }

async function getJson(url: string, weight: number): Promise<any> {
  await acquire(weight)
  let res: Response
  try { res = await fetch(url, { signal: AbortSignal.timeout(20_000) }) }
  catch (e) { throw new FetchError(`network error: ${String(e)}`, null) }
  if (res.status === 429 || res.status === 418) {
    const ms = (Number(res.headers.get('retry-after')) || 60) * 1000
    blockedUntil = Math.max(blockedUntil, Date.now() + ms)
    throw new FetchError(`HTTP ${res.status} (rate limited)`, ms)
  }
  if (res.status === 400) throw new FetchError(`HTTP 400 (symbol rejected by Binance)`, null, true)
  if (!res.ok) throw new FetchError(`HTTP ${res.status}`, null)
  try { return await res.json() } catch { throw new FetchError('invalid JSON', null) }
}

async function pool<T>(items: T[], n: number, fn: (x: T) => Promise<void>) {
  let i = 0
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) await fn(items[i++]!) }))
}

// ---------------------------------------------------------------- public endpoints
async function exchangeInfo(): Promise<any[]> {
  if (exchangeInfoCache && Date.now() - exchangeInfoCache.at < 6 * 3600_000) return exchangeInfoCache.list
  const j = await getJson(`${base}/api/v3/exchangeInfo`, 20)
  const list = (j.symbols ?? []) as any[]
  exchangeInfoCache = { at: Date.now(), list }
  return list
}

async function ticker24h(): Promise<Map<string, { quoteVolume: number }>> {
  const rows = (await getJson(`${base}/api/v3/ticker/24hr`, 40)) as any[]
  return new Map(rows.map((r) => [r.symbol, { quoteVolume: Number(r.quoteVolume) }]))
}

/** Binance klines request weight by `limit`: 1–100 → 1, 101–500 → 2, 501–1000 → 5, 1001–1500 → 10. */
const klineWeight = (limit: number) => (limit <= 100 ? 1 : limit <= 500 ? 2 : limit <= 1000 ? 5 : 10)

/** Klines. `since` null = newest `bars` candles; otherwise only the missing tail. */
async function klines(symbol: string, since: number | null, bars = 1000): Promise<Candle[]> {
  const now = Date.now()
  const stale = since == null || (now - since) / BAR_MS > 990
  const limit = stale ? bars : Math.min(bars, Math.max(2, Math.ceil((now - since) / BAR_MS) + 2))
  const url = `${base}/api/v3/klines?symbol=${symbol}&interval=4h&limit=${limit}${stale ? '' : `&startTime=${since}`}`
  const rows = (await getJson(url, klineWeight(limit))) as any[][]
  return rows.filter((r) => Number(r[6]) < now).map((r) => ({ t: Number(r[0]), o: +r[1], h: +r[2], l: +r[3], c: +r[4], v: +r[5] }))
}

// ---------------------------------------------------------------- 4h candle cycle
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
    await pool(todo, 2, async (s) => {
      try {
        const cs = await klines(s.symbol, s.since)
        if (cs.length) { s.since = cs[cs.length - 1]!.t; post({ type: 'candles', symbol: s.symbol, candles: cs }) }
        if ((!cs.length || s.since! < expected) && Date.now() < expected + BAR_MS + GRACE_MS) want(15_000) // newest candle not visible yet
      } catch (e) {
        hadError = true
        post({ type: 'error', symbol: s.symbol, message: String(e), permanent: e instanceof FetchError && e.permanent })
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

// ---------------------------------------------------------------- dynamic universe scan
// Three layers only: eligibility (exchangeInfo), 24h quote volume, >=450 contiguous bars.
// Survivors are ranked by 24h volume and capped at `maxAssets`.
interface UniverseReq { id: number; maxAssets: number }

async function scanUniverse(req: UniverseReq) {
  if (universeRunning) { post({ type: 'universeError', id: req.id, message: 'a universe scan is already running' }); return }
  universeRunning = true
  const started = Date.now()
  try {
    const info = await exchangeInfo()
    const eligible = info.filter((s) => eligibleSymbol(s))
    const ticker = await ticker24h()
    const pre = eligible
      .filter((s) => (ticker.get(s.symbol)?.quoteVolume ?? 0) >= P.universe.volume24hMinUsd)
      .sort((a, b) => (ticker.get(b.symbol)?.quoteVolume ?? 0) - (ticker.get(a.symbol)?.quoteVolume ?? 0))

    const candidates: UniverseCandidate[] = []
    let done = 0
    for (const s of pre) {
      try {
        // 452 bars leave one bar of margin after dropping the still-open candle (need 450 closed).
        const cs = await klines(s.symbol, null, P.universe.historyBars + 2)
        candidates.push({
          symbol: s.symbol,
          quoteVolume24h: ticker.get(s.symbol)?.quoteVolume ?? 0,
          ...historyCheck(cs),
        })
      } catch (e) {
        if (!(e instanceof FetchError && e.permanent)) post({ type: 'error', symbol: s.symbol, message: String(e) })
      }
      if (++done % 20 === 0) post({ type: 'universeProgress', id: req.id, done, total: pre.length })
    }

    const { rows, selected } = selectUniverse(candidates, { maxAssets: req.maxAssets })
    post({
      type: 'universeResult', id: req.id, at: Date.now(), startedAt: started, rows, selected,
      counts: { total: info.length, eligible: eligible.length, volumeOk: pre.length },
    })
  } catch (e) {
    post({ type: 'universeError', id: req.id, message: String(e) })
  } finally {
    universeRunning = false
  }
}

self.onmessage = (e) => {
  const m = e.data
  if (m.type === 'config') {
    base = m.base; delay = m.delay
    const had = new Set(symbols.map((s) => s.symbol))
    const changed = m.symbols.some((s: any) => !had.has(s.symbol))
    symbols = m.symbols
    if (changed || m.force || !timer) void cycle() // new symbols need their history right away
  } else if (m.type === 'universe') {
    void scanUniverse(m as UniverseReq)
  }
}
