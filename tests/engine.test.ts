import { test, expect, beforeAll } from 'bun:test'
process.env.DB_PATH = ':memory:'
process.env.NO_WORKER = '1'
process.env.ACCESS_TOKEN = 'test-token'

const BAR = 4 * 3600_000
const T0 = Date.UTC(2025, 0, 1)
// deterministic synthetic market: steady uptrend with volume spikes, then a crash
function candles(n: number, crashAt: number) {
  const out = []
  let p = 100
  for (let i = 0; i < n; i++) {
    const noise = Math.sin(i * 1.7) * 0.3
    const drift = i < crashAt ? 0.004 : -0.03 // % per bar
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
    ind: await import('../src/indicators'), tree: await import('../src/tree'),
  }
})

test('indicators: ema/atr/er sanity', () => {
  const c = Array.from({ length: 50 }, (_, i) => 100 + i)
  expect(m.ind.efficiencyRatio(c, 20)[30]).toBeCloseTo(1)
  expect(Number.isNaN(m.ind.ema(c, 20)[18])).toBe(true)
  expect(Number.isFinite(m.ind.ema(c, 20)[19])).toBe(true)
  expect(m.ind.quantile([1, 2, 3, 4, 5], 0.2)).toBeCloseTo(1.8)
})

test('tree: walks to the expected actions and fails closed on missing inputs', () => {
  const base = {
    dataOk: 1, pendingOrder: { exists: 0 }, position: { exists: 0 },
    assetState: { paused: 0, weekR: 0, cooldownLeft: 0, degradationActive: 0 },
    A: { signal: 1, persistencePass: 1, stopDistanceAtr: 3, costInR: 0.1, targetCostMultiple: 10 }, C: { rawSignal: 0 },
  }
  const r = m.tree.runTree(base)
  expect(r.node.action).toBe('QUEUE_ENTRY')
  expect(m.tree.runTree({ ...base, dataOk: 0 }).node.reason).toBe('data_not_ready')
  expect(m.tree.runTree({ ...base, A: { ...base.A, persistencePass: 0 } }).node.reason).toBe('A_persistence_blocked')
  expect(m.tree.runTree({ ...base, A: { ...base.A, costInR: NaN } }).node.reason).toBe('no_eligible_signal')
})

test('engine: buys the breakout, exits on the crash, logs P/L, survives restart-style re-processing', () => {
  const bot = m.bots.createBot({ name: 't', assets: ['BTCUSDT'], capital: 1000 })
  const cs = candles(420, 330)
  m.runner.upsertCandles('BTCUSDT', cs)
  // pretend the bot was already live at bar 250
  const states = m.bots.loadStates(bot.id)
  m.bots.saveState(bot.id, 'BTCUSDT', states.get('BTCUSDT').st, cs[250].t)
  m.runner.processAll(Date.now())
  const txs = m.db.query('SELECT * FROM transactions WHERE bot_id=? ORDER BY id').all(bot.id) as any[]
  const buys = txs.filter((t) => t.action === 'BUY')
  const sells = txs.filter((t) => t.action === 'SELL')
  expect(buys.length).toBeGreaterThan(0)
  expect(sells.length).toBeGreaterThan(0)
  expect(sells[0].exit_reason).toBeTruthy()
  expect(typeof sells[0].pnl).toBe('number')
  // cash reconciles with the log
  const v = m.bots.botView(m.bots.getBot(bot.id))
  const last = txs[txs.length - 1]
  if (!v.position) expect(v.cash).toBeCloseTo(last.cash_after, 6)
  // idempotent: re-processing the same candles never duplicates trades
  const n = txs.length
  m.runner.processAll(Date.now())
  expect((m.db.query('SELECT COUNT(*) n FROM transactions WHERE bot_id=?').get(bot.id) as any).n).toBe(n)
  // rolling candle window is constant
  m.runner.upsertCandles('BTCUSDT', cs)
  expect((m.db.query("SELECT COUNT(*) n FROM candles WHERE symbol='BTCUSDT'").get() as any).n).toBeLessThanOrEqual(1000)
})

test('lifecycle: after_exit waits for the trade, delete removes every footprint', () => {
  const bot = m.bots.createBot({ name: 'w', assets: ['ETHUSDT', 'SOLUSDT'], capital: 500 })
  const st = m.bots.loadStates(bot.id).get('ETHUSDT')
  st.st.position = { strategy: 'A', entryTime: 1, entryFill: 100, qty: 1, entryFee: 0.1, signalAtr: 1, initialStop: 97, stop: 97, restStop: 97, hardStop: 96, highestClose: 100, highestHigh: 100, lowestLow: 100, barsHeld: 1, initialRisk: 3, initialRiskCash: 3.1 }
  m.bots.saveState(bot.id, 'ETHUSDT', st.st, st.last)
  expect(m.bots.deleteBot(bot.id, 'after_exit')).toBe('scheduled')
  expect(m.bots.getBot(bot.id)).not.toBeNull()
  m.bots.deactivate(bot.id, 'after_exit')
  expect(m.bots.getBot(bot.id).pending_action.length).toBe(2)
  // trade exits -> pending delete applies
  st.st.position = null
  m.bots.saveState(bot.id, 'ETHUSDT', st.st, st.last)
  expect(m.bots.applyPending(bot.id)).toBe(true)
  for (const t of ['bots', 'bot_asset_state', 'transactions', 'events'])
    expect((m.db.query(`SELECT COUNT(*) n FROM ${t} WHERE ${t === 'bots' ? 'id' : 'bot_id'}=?`).get(bot.id) as any).n).toBe(0)
})
