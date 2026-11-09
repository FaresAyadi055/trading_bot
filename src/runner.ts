import { db, tx, setMeta } from './db'
import { WINDOW, type Symbol } from './config'
import { buildSeries, latestMarket, type Series } from './features'
import { stepAsset } from './engine'
import { applyPending, gcMarketData, getBot, listBots, loadStates, lockedSymbol, saveBot, saveState, writeFx } from './bots'
import { params } from './tree'
import type { AssetState, BotRow, Candle, Fx } from './types'

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

export function processBot(botId: string, series: Map<string, Series>, now = Date.now()) {
  const bot = getBot(botId)
  if (!bot || bot.status !== 'active') return
  const states = loadStates(bot.id)
  const times = new Set<number>()
  for (const sym of bot.assets) {
    const S = series.get(sym)
    const last = states.get(sym)?.last ?? -Infinity
    if (S) for (const t of S.t) if (t > last) times.add(t)
  }
  for (const t of [...times].sort((a, b) => a - b)) {
    const fx: Fx = { tx: [], events: [] }
    const lock = lockedSymbol(states)
    const cands: { sym: string; strategy: 'A' | 'C'; signalAtr: number; expectedNetR: number }[] = []
    const touched: string[] = []
    for (const sym of bot.assets) {
      const s = states.get(sym)
      const S = series.get(sym)
      const i = S?.idx.get(t)
      if (!s || !S || i === undefined || (s.last != null && t <= s.last)) continue
      const r = stepAsset(bot, sym, s.st, S, i, fx, { entries: !lock || lock === sym, now })
      if (r) cands.push({ sym, ...r })
      s.last = t
      touched.push(sym)
    }
    // one trade at a time: best expected net R wins; the others are discarded
    const best = cands.sort((a, b) => b.expectedNetR - a.expectedNetR)[0]
    if (best) {
      states.get(best.sym)!.st.pendingOrder = { type: 'ENTRY', strategy: best.strategy, signalAtr: best.signalAtr, queuedBar: Math.floor(t / 14_400_000) }
      fx.events.push({ ts: now, kind: 'entry_queued', symbol: best.sym, detail: `strategy ${best.strategy}` })
    }
    // atomic per-bar persistence -> crash safe; lastProcessedBar prevents duplicate processing
    tx(() => {
      saveBot(bot)
      for (const sym of touched) saveState(bot.id, sym, states.get(sym)!.st, states.get(sym)!.last)
      writeFx(bot.id, fx)
    })
  }
  killCheck(botId, bot, states)
  applyPending(bot.id, now)
}

/** Minimum-capital kill switch: deactivates the bot when post-exit capital can no longer trade. */
export function killCheck(botId: string, bot: BotRow, states: Map<string, { st: AssetState; last: number | null }>) {
  const flat = ![...states.values()].some((s) => s.st.position || s.st.pendingOrder)
  if (bot.status !== 'active' || bot.cash >= params.risk.minimumNotional || !flat) return
  tx(() => {
    db.query("UPDATE bots SET status='inactive', pending_action=NULL, updated_at=? WHERE id=?").run(Date.now(), bot.id)
    db.query('INSERT INTO events(bot_id,ts,kind,symbol,detail) VALUES(?,?,?,NULL,?)')
      .run(bot.id, Date.now(), 'auto_stopped', `capital ${bot.cash.toFixed(2)} USDT < ${params.risk.minimumNotional} USDT minimum -> deactivated`)
  })
  console.log(`[runner] bot ${bot.id} auto-stopped: capital ${bot.cash.toFixed(2)} below ${params.risk.minimumNotional}`)
}

/** Evaluate every active bot against the latest closed candles (also used for crash catch-up). */
export function processAll(now = Date.now()) {
  const bots = listBots().filter((b) => b.status === 'active')
  const symbols = new Set(bots.flatMap((b) => b.assets))
  const series = new Map<string, Series>()
  for (const s of symbols) {
    const S = loadSeries(s)
    if (!S) continue
    series.set(s, S)
    // overwritten each bar: constant-size metrics store
    db.query('INSERT INTO symbol_features(symbol,bar_time,features,updated_at) VALUES(?,?,?,?) ON CONFLICT(symbol) DO UPDATE SET bar_time=excluded.bar_time, features=excluded.features, updated_at=excluded.updated_at')
      .run(s, S.t[S.t.length - 1]!, JSON.stringify(latestMarket(S)), now)
  }
  for (const b of bots) {
    try { processBot(b.id, series, now) } catch (e) { console.error(`[runner] bot ${b.id} failed`, e) }
  }
  for (const b of listBots()) if (b.status === 'inactive' && b.pending_action.length) applyPending(b.id, now)
  gcMarketData()
  setMeta('last_processed_at', String(now))
}
export type { Symbol }
