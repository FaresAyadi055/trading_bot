import { test, expect, beforeAll, beforeEach } from 'bun:test'
process.env.DB_PATH = ':memory:'
process.env.MODE = 'test'
process.env.NO_WORKER = '1'
process.env.ACCESS_TOKEN = 'test-token'
process.env.TELEGRAM_BOT_TOKEN = 'x'
process.env.TELEGRAM_CHAT_ID = '1'

const BAR = 4 * 3600_000
// closed candles ending ~now so "fresh" notifications fire
const END = Math.floor(Date.now() / BAR) * BAR - BAR
function candles(n: number, crashAt: number, seed = 0) {
  const out = []
  let p = 100
  const T0 = END - (n - 1) * BAR
  for (let i = 0; i < n; i++) {
    const noise = Math.sin(i * 1.7 + seed) * 0.3
    const drift = i < crashAt ? 0.004 : -0.03
    const o = p
    p = Math.max(1, p * (1 + drift + noise * 0.01))
    const c = p
    out.push({ t: T0 + i * BAR, o, h: Math.max(o, c) * 1.003, l: Math.min(o, c) * 0.997, c, v: i % 5 === 0 ? 300 : 100 })
  }
  return out
}

let m: any
beforeAll(async () => {
  m = {
    bots: await import('../src/bots'), runner: await import('../src/runner'), db: (await import('../src/db')).db,
    ind: await import('../src/indicators'), strat: await import('../src/strategy'), v: await import('../src/validate'),
    sym: await import('../src/symbols'), feat: await import('../src/features'),
  }
})

/** Seed the dynamic universe (the only source of a bot's asset list now). */
function select(symbols: string[]) {
  m.db.query('DELETE FROM universe').run()
  const ins = m.db.query('INSERT INTO universe(symbol,selected,rank,metrics,reason,updated_at,added_at) VALUES(?,?,?,?,?,?,?)')
  const data = (i: number) => JSON.stringify({ quoteVolume24h: 1e9 - i, bars: 500, contiguous: true, historyOk: true, lastBar: 0 })
  symbols.forEach((s, i) => ins.run(s, 1, i + 1, data(i), '', Date.now(), Date.now()))
}
beforeEach(() => { for (const b of m.bots.listBots()) m.bots.deleteBot(b.id, 'now') })
const position = (symbol: string) => ({
  symbol, strategy: 'A', entryTs: 1, entryFill: 100, qty: 1, notional: 100, initialStop: 97, stop: 97, hardStop: 96,
  restingStop: 96, highestClose: 100, highestHigh: 100, ratcheted: false, barsHeld: 1, riskUsdt: 3, maxUnrealizedR: 0, slip: 0.001,
})

test('indicators: ema/er/quantile/population std/prior rank', () => {
  const c = Array.from({ length: 50 }, (_, i) => 100 + i)
  expect(m.ind.efficiencyRatio(c, 20)[30]).toBeCloseTo(1)
  expect(Number.isNaN(m.ind.efficiencyRatio(new Array(30).fill(5), 20)[25])).toBe(true) // zero denominator -> NaN
  expect(Number.isNaN(m.ind.ema(c, 20)[18])).toBe(true)
  expect(Number.isFinite(m.ind.ema(c, 20)[19])).toBe(true)
  expect(m.ind.quantile([1, 2, 3, 4, 5], 0.2)).toBeCloseTo(1.8)
  expect(m.ind.rollingStd0([1, 2, 3, 4], 4)[3]).toBeCloseTo(Math.sqrt(1.25)) // ddof=0
  const r = m.ind.priorRank(Array.from({ length: 310 }, (_, i) => i), 300)
  expect(Number.isNaN(r[300])).toBe(true) // reference starts at n+1
  expect(r[301]).toBe(1)
})

test('regime: needs 2 confirming bars, hysteresis, bear needs btc below', () => {
  const rg = { state: 1 as 0 | 1 | 2, pending: null, count: 0 }
  expect(m.strat.regimeUpdate(rg, true, 0.7)).toBe(false)
  expect(rg.state).toBe(1)
  expect(m.strat.regimeUpdate(rg, true, 0.7)).toBe(true)
  expect(rg.state).toBe(2)
  m.strat.regimeUpdate(rg, true, 0.5) // BULL stays while btc above and breadth >= 0.45
  expect(rg.state).toBe(2)
  m.strat.regimeUpdate(rg, false, 0.3); m.strat.regimeUpdate(rg, false, 0.3)
  expect(rg.state).toBe(0)
})

test('cross-section: percentile rank, 0.5 for a single symbol', () => {
  expect([...m.strat.crossSection(new Map([['A', 1]])).values()]).toEqual([0.5])
  const r = m.strat.crossSection(new Map([['A', 1], ['B', 2], ['C', 3]]))
  expect([r.get('A'), r.get('B'), r.get('C')]).toEqual([0, 0.5, 1])
})

test('validation: hand-written parsing, capital and universe config', () => {
  const c = m.v.parseCreate({ name: '  my bot  ', capital: 100 })
  expect(c.name).toBe('my bot')
  expect(c.capital).toBe(100)
  const e = (() => { try { m.v.parseCreate({ capital: -1 }) } catch (x) { return x } })() as any
  expect(e.status).toBe(400)
  expect(e.issues.length).toBeGreaterThanOrEqual(1)
  expect(m.v.parseUniverseConfig({ maxAssets: 25 })).toEqual({ maxAssets: 25 })
  expect(() => m.v.parseUniverseConfig({ maxAssets: 0 })).toThrow()
  expect(m.v.parseWhen(undefined)).toBe('after_exit')
  expect(() => m.v.parseWhen('later')).toThrow()
})

test('symbols: unknown pairs are rejected, valid ones accepted', async () => {
  for (const b of m.bots.listBots()) m.bots.deleteBot(b.id, 'now') // other test files may share the process
  const calls: string[][] = []
  m.sym.setSymbolValidator(async (s: string[]) => { calls.push(s); return s.map((x) => ({ symbol: x, ok: x !== 'FAKEUSDT', reason: 'unknown Binance symbol' })) })
  await expect(m.sym.assertTradable(['FAKEUSDT'])).rejects.toMatchObject({ status: 400 })
  await m.sym.assertTradable(['PEPEUSDT'])
  expect(calls.length).toBe(2)
})

test('any asset: buys the breakout, logs strategy + notifications, idempotent, rolling window constant', () => {
  select(['PEPEUSDT'])
  const bot = m.bots.createBot({ name: 't', capital: 1000 })
  expect(bot.assets).toEqual(['PEPEUSDT'])
  const cs = candles(520, 470)
  m.runner.upsertCandles('PEPEUSDT', cs.slice(0, 251))
  // pretend the bot was live since bar 250 and let time pass bar by bar (live mode never replays history)
  const { st } = m.bots.loadState(bot.id)
  m.bots.saveState(bot.id, st, cs[250].t)
  for (let i = 251; i < cs.length; i++) {
    m.runner.upsertCandles('PEPEUSDT', [cs[i]])
    m.runner.processAll(cs[i].t + BAR + 5000)
  }
  const txs = m.db.query('SELECT * FROM transactions WHERE bot_id=? ORDER BY id').all(bot.id) as any[]
  const buys = txs.filter((t) => t.action === 'BUY'), sells = txs.filter((t) => t.action === 'SELL')
  expect(buys.length).toBeGreaterThan(0)
  expect(sells.length).toBeGreaterThan(0)
  expect(buys[0].strategy).toBe('A')
  expect(sells[0].exit_reason).toBeTruthy()
  const v = m.bots.botView(m.bots.getBot(bot.id))
  if (!v.position) expect(v.cash).toBeCloseTo(txs[txs.length - 1].cash_after, 6)
  const notes = m.db.query('SELECT kind, strategy, text FROM notifications ORDER BY id').all() as any[]
  const buyNote = notes.find((n) => n.kind === 'buy')
  expect(buyNote.text).toContain('Donchian')
  expect(notes.some((n) => n.kind === 'sell')).toBe(true)
  const n = txs.length
  m.runner.processAll(cs[cs.length - 1].t + BAR + 5000)
  expect((m.db.query('SELECT COUNT(*) n FROM transactions WHERE bot_id=?').get(bot.id) as any).n).toBe(n)
  m.runner.upsertCandles('PEPEUSDT', cs)
  expect((m.db.query("SELECT COUNT(*) n FROM candles WHERE symbol='PEPEUSDT'").get() as any).n).toBeLessThanOrEqual(1000)
  m.bots.deleteBot(bot.id, 'now')
})

test('data pulling: only assets an active bot listens to; a bot in a trade needs only its asset', () => {
  for (const b of m.bots.listBots()) m.bots.deleteBot(b.id, 'now')
  select(['AAAUSDT', 'BBBUSDT'])
  expect(m.bots.neededSymbols()).toEqual([])
  const a = m.bots.createBot({ name: 'a', capital: 500 })
  expect(m.bots.neededSymbols()).toEqual(['AAAUSDT', 'BBBUSDT'])
  const b = m.bots.createBot({ name: 'b', capital: 500, active: false })
  b.assets = ['BBBUSDT', 'CCCUSDT']; m.bots.saveBot(b) // an inactive bot never contributes
  expect(m.bots.neededSymbols()).toEqual(['AAAUSDT', 'BBBUSDT'])
  // bot a enters AAA: BBB is no longer pulled for it (nobody else listens to BBB)
  const { st, last } = m.bots.loadState(a.id)
  st.position = position('AAAUSDT')
  m.bots.saveState(a.id, st, last)
  expect(m.bots.neededSymbols()).toEqual(['AAAUSDT'])
  // another active bot that also listens to BBB brings it back
  const c = m.bots.createBot({ name: 'c', capital: 500 })
  c.assets = ['BBBUSDT']; m.bots.saveBot(c)
  expect(m.bots.neededSymbols()).toEqual(['AAAUSDT', 'BBBUSDT'])
  m.bots.deleteBot(c.id, 'now')
  // exit -> BBB pulled again
  st.position = null; m.bots.saveState(a.id, st, last)
  expect(m.bots.neededSymbols()).toEqual(['AAAUSDT', 'BBBUSDT'])
  // storage: candles of symbols no active bot references are purged, paused-but-referenced ones are kept
  for (const s of ['AAAUSDT', 'BBBUSDT', 'CCCUSDT']) m.runner.upsertCandles(s, candles(5, 99))
  m.bots.gcMarketData()
  const have = (m.db.query('SELECT DISTINCT symbol s FROM candles').all() as any[]).map((r) => r.s).sort()
  expect(have).toEqual(['AAAUSDT', 'BBBUSDT'])
  m.bots.deleteBot(a.id, 'now'); m.bots.deleteBot(b.id, 'now')
})

test('lifecycle: after_exit waits for the trade, delete removes every footprint', () => {
  select(['ETHUSDT', 'SOLUSDT'])
  const bot = m.bots.createBot({ name: 'w', capital: 500 })
  const { st, last } = m.bots.loadState(bot.id)
  st.position = position('ETHUSDT')
  m.bots.saveState(bot.id, st, last)
  expect(m.bots.deleteBot(bot.id, 'after_exit')).toBe('scheduled')
  expect(m.bots.getBot(bot.id)).not.toBeNull()
  m.bots.deactivate(bot.id, 'after_exit')
  expect(m.bots.getBot(bot.id).pending_action.length).toBe(2)
  st.position = null
  m.bots.saveState(bot.id, st, last)
  expect(m.bots.applyPending(bot.id)).toBe(true)
  for (const t of ['bots', 'bot_state', 'transactions', 'events'])
    expect((m.db.query(`SELECT COUNT(*) n FROM ${t} WHERE ${t === 'bots' ? 'id' : 'bot_id'}=?`).get(bot.id) as any).n).toBe(0)
})

test('daily summary: built after the 20:00 bar, resets the day accumulator', async () => {
  const { buildDailySummary } = await import('../src/summary')
  const { newBotState } = await import('../src/engine')
  select(['DDDUSDT'])
  const bot = m.bots.createBot({ name: 'd', capital: 100 })
  const cs = candles(30, 99)
  m.runner.upsertCandles('DDDUSDT', cs)
  const S = m.runner.loadSeries('DDDUSDT')
  const t = cs[29].t
  const st = newBotState(100)
  st.day.lines.push('08:00 BUY X'); st.day.blocked.cooldown = 2; st.day.signals.A = 3
  const rows = new Map([['DDDUSDT', m.feat.rowAt('DDDUSDT', S, 29)]])
  const text = buildDailySummary(bot, st, rows, () => S, t, () => 1)
  expect(text).toContain('DAILY SUMMARY')
  expect(text).toContain('08:00 BUY X')
  expect(text).toContain('cooldown 2')
  expect(text).toContain('Universe filter')
  expect(text).toContain('selected 1/50')
  expect(text).toContain('full asset list on the dashboard')
  expect(text).toContain('Market (24h)')
  expect(st.day.lines.length).toBe(0)
  m.bots.deleteBot(bot.id, 'now')
})

test('blocked trades: cooldown and the score filter are reported once, with strategy names', async () => {
  const { stepBot, newBotState } = await import('../src/engine')
  const { newFx } = await import('../src/types')
  const row = (symbol: string, o: any = {}) => ({
    symbol, t: END, open: 100, high: 105, low: 99, close: 104, volume: 500, ema200: 90, atr14: 2, donchian40: 102,
    volRatio: 1.3, persistenceEr: 0.2, relReturn: 0.1, atrPctPctl: 0.5, volumeUsdMedian: 1e6,
    dataOk: true, signalA: false, ...o,
  })
  const bot: any = { id: 'bb', name: 'blk', assets: ['XUSDT'], initial_capital: 1000, cash: 1000, status: 'active', pending_action: [] }
  // 1. cooldown blocks a Donchian signal
  let st = newBotState(1000); st.cooldown = 5
  let fx = newFx()
  stepBot(bot, st, new Map([['XUSDT', row('XUSDT', { signalA: true })]]), END, fx, { now: Date.now(), fresh: true })
  expect(fx.notes.length).toBe(1)
  expect(fx.notes[0].text).toContain('TRADE BLOCKED')
  expect(fx.notes[0].text).toContain('Donchian (A)')
  expect(fx.notes[0].text).toContain('cooldown')
  // same alert is not repeated on the next bar (de-duplicated per 24h), but is still counted for the daily summary
  fx = newFx()
  stepBot(bot, st, new Map([['XUSDT', row('XUSDT', { signalA: true, t: END + BAR })]]), END + BAR, fx, { now: Date.now(), fresh: true })
  expect(fx.notes.length).toBe(0)
  expect(st.day.blocked.cooldown).toBe(2)
  // 2. weak signal filtered by the regime score threshold (NEUTRAL needs 0.60)
  st = newBotState(1000); fx = newFx()
  stepBot(bot, st, new Map([['XUSDT', row('XUSDT', { signalA: true, persistenceEr: 0.1, volRatio: 1.25 })]]), END, fx, { now: Date.now(), fresh: true })
  expect(st.pending).toBeNull()
  expect(fx.notes[0].text).toContain('score below regime minimum')
  // 3. a strong signal queues an entry and names the strategy
  st = newBotState(1000); fx = newFx()
  stepBot(bot, st, new Map([['XUSDT', row('XUSDT', { signalA: true, persistenceEr: 1, volRatio: 3, close: 106 })]]), END, fx, { now: Date.now(), fresh: true })
  expect(st.pending?.strategy).toBe('A')
  expect(fx.notes.find((n: any) => n.kind === 'entry_queued')!.text).toContain('Donchian (A)')
})
