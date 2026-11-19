import { db, tx, setMeta } from './db'
import { BAR_GRACE_MS, BAR_MS, WINDOW, isDayEndBar, lastClosedBar } from './time'
import { buildSeries, latestMarket, rowAt, type Row, type Series } from './features'
import { stepBot } from './engine'
import { applyPending, gcMarketData, getBot, listBots, loadState, neededSymbols, saveBot, saveState, trackSet, writeFx } from './bots'
import { buildDailySummary } from './summary'
import { newFx, type Candle } from './types'

export function upsertCandles(symbol: string, cs: Candle[]) {
  if (!cs.length) return
  tx(() => {
    const ins = db.query('INSERT OR REPLACE INTO candles(symbol,open_time,open,high,low,close,volume) VALUES(?,?,?,?,?,?,?)')
    for (const c of cs) ins.run(symbol, c.t, c.o, c.h, c.l, c.c, c.v)
    // overwrite-in-place semantics: keep only the newest WINDOW rows
    db.query('DELETE FROM candles WHERE symbol=? AND open_time < (SELECT open_time FROM candles WHERE symbol=? ORDER BY open_time DESC LIMIT 1 OFFSET ?)')
      .run(symbol, symbol, WINDOW - 1)
  })
}

export function loadSeries(symbol: string): Series | null {
  const rows = db.query('SELECT open_time t, open o, high h, low l, close c, volume v FROM candles WHERE symbol=? ORDER BY open_time').all(symbol) as Candle[]
  return rows.length ? buildSeries(rows) : null
}
const newestCandle = (symbol: string) => (db.query('SELECT MAX(open_time) m FROM candles WHERE symbol=?').get(symbol) as { m: number | null }).m
const lastClose = (symbol: string): number | null =>
  (db.query('SELECT close FROM candles WHERE symbol=? ORDER BY open_time DESC LIMIT 1').get(symbol) as { close: number } | null)?.close ?? null

type SeriesGetter = (symbol: string) => Series | null
/** Memoised per processAll call: features of a symbol are computed once, however many bots use it. */
function seriesCache(now: number): SeriesGetter {
  const cache = new Map<string, Series | null>()
  return (symbol) => {
    if (!cache.has(symbol)) {
      const S = loadSeries(symbol)
      cache.set(symbol, S)
      if (S) // overwritten each bar: constant-size metrics store
        db.query('INSERT INTO symbol_features(symbol,bar_time,features,updated_at) VALUES(?,?,?,?) ON CONFLICT(symbol) DO UPDATE SET bar_time=excluded.bar_time, features=excluded.features, updated_at=excluded.updated_at')
          .run(symbol, S.t[S.t.length - 1]!, JSON.stringify(latestMarket(S)), now)
    }
    return cache.get(symbol) ?? null
  }
}

/** First index with t > after (series are sorted). */
function firstAfter(S: Series, after: number): number {
  let lo = 0, hi = S.t.length
  while (lo < hi) { const m = (lo + hi) >> 1; if (S.t[m]! > after) hi = m; else lo = m + 1 }
  return lo
}

/**
 * Replay every unprocessed closed bar of one bot, in order. Each bar is evaluated only on the symbols the bot
 * may see (its whole universe when flat, only the held asset while in a trade), and is held back until all of
 * them have the bar (or BAR_GRACE_MS has passed since it closed, so one halted pair cannot stall a bot).
 */
export function processBot(botId: string, getSeries: SeriesGetter, now = Date.now()) {
  const bot = getBot(botId)
  if (!bot || bot.status !== 'active') return
  let { st, last } = loadState(botId)
  for (let guard = 0; guard < 5000; guard++) {
    const track = trackSet(bot, st)
    let next = Infinity
    for (const sym of track) {
      const S = getSeries(sym)
      if (!S) continue
      const k = firstAfter(S, last ?? -Infinity)
      if (k < S.t.length) next = Math.min(next, S.t[k]!)
    }
    if (next === Infinity) break
    const lagging = track.some((sym) => { const S = getSeries(sym); return !S || S.t[S.t.length - 1]! < next })
    if (lagging && now < next + BAR_MS + BAR_GRACE_MS) break // wait for the stragglers

    const rows = new Map<string, Row>()
    for (const sym of track) { const S = getSeries(sym); const i = S?.idx.get(next); if (S && i !== undefined) rows.set(sym, rowAt(sym, S, i)) }
    const fx = newFx()
    const fresh = next >= lastClosedBar(now) - BAR_MS // replayed history never raises alerts, only trades are reported
    stepBot(bot, st, rows, next, fx, { now, fresh })
    if (isDayEndBar(next)) {
      const text = buildDailySummary(bot, st, rows, getSeries, next, lastClose)
      if (fresh) fx.notes.push({ kind: 'daily', text })
    }
    last = next
    // atomic per-bar persistence -> crash safe; last_processed_bar prevents duplicate processing
    tx(() => { saveBot(bot); saveState(bot.id, st, last); writeFx(bot.id, fx) })
  }
  killCheck(botId)
  applyPending(botId, now)
}

/** Minimum-capital kill switch: deactivates the bot when post-exit capital can no longer open a trade. */
export function killCheck(botId: string) {
  const bot = getBot(botId)
  if (!bot || bot.status !== 'active') return
  const { st } = loadState(botId)
  if (st.position || st.pending || bot.cash >= 10) return // P.minNotional
  tx(() => {
    db.query("UPDATE bots SET status='inactive', pending_action=NULL, updated_at=? WHERE id=?").run(Date.now(), bot.id)
    const fx = newFx()
    fx.events.push({ ts: Date.now(), kind: 'auto_stopped', symbol: null, detail: `capital ${bot.cash.toFixed(2)} USDT < 10 USDT minimum -> deactivated` })
    fx.notes.push({ kind: 'lifecycle', text: `🛑 BOT AUTO-STOPPED | bot ${bot.id} (${bot.name})\nCash ${bot.cash.toFixed(2)} USDT is below the 10 USDT minimum order size.` })
    writeFx(bot.id, fx)
  })
  console.log(`[runner] bot ${bot.id} auto-stopped: capital ${bot.cash.toFixed(2)} below minimum`)
}

/** Evaluate every active bot against the latest closed candles (also the crash catch-up path). */
export function processAll(now = Date.now()) {
  const getSeries = seriesCache(now)
  for (const b of listBots()) {
    if (b.status !== 'active') continue
    // cheap pre-check: skip the (CPU heavy) feature build when no tracked symbol has a bar this bot has not seen
    const { st, last } = loadState(b.id)
    const fresh = trackSet(b, st).some((s) => (newestCandle(s) ?? -Infinity) > (last ?? -Infinity))
    if (!fresh) continue
    try { processBot(b.id, getSeries, now) } catch (e) { console.error(`[runner] bot ${b.id} failed`, e) }
  }
  // keep /api/market current for every pulled symbol, even when no bot had a new bar to process
  for (const sym of neededSymbols()) {
    const f = db.query('SELECT bar_time FROM symbol_features WHERE symbol=?').get(sym) as { bar_time: number } | null
    if ((newestCandle(sym) ?? -Infinity) > (f?.bar_time ?? -Infinity)) getSeries(sym)
  }
  for (const b of listBots()) if (b.status === 'inactive' && b.pending_action.length) applyPending(b.id, now)
  gcMarketData()
  setMeta('last_processed_at', String(now))
  return neededSymbols()
}
export { neededSymbols }
