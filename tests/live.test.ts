import { test, expect, beforeAll, beforeEach, afterAll } from 'bun:test'
process.env.DB_PATH = ':memory:'
process.env.MODE = 'test'
process.env.NO_WORKER = '1'
process.env.ACCESS_TOKEN = 'test-token'
process.env.TELEGRAM_BOT_TOKEN = 'x'
process.env.TELEGRAM_CHAT_ID = '1'

const BAR = 4 * 3600_000
let m: any
let ex: any
beforeAll(async () => {
  const exch = await import('../src/exchange')
  const { MockExchange } = await import('./mock_exchange')
  ex = new MockExchange(1000, { BTCUSDT: 100, ETHUSDT: 50 })
  exch.setExchange(ex)
  m = {
    bots: await import('../src/bots'), live: await import('../src/live'), cap: await import('../src/capital'), rt: (await import('../src/runtime')).rt,
    db: (await import('../src/db')).db, runner: await import('../src/runner'), engine: await import('../src/engine'),
    time: await import('../src/time'),
  }
  m.rt.live = true // live execution + capital enforcement (index.ts does this at boot)
})
beforeEach(() => {
  m.db.query('DELETE FROM bots').run()
  m.db.query('DELETE FROM notifications').run()
  ex.free = { USDT: 1000 }; ex.calls = []; ex.failNext = []
  ex.price = { BTCUSDT: 100, ETHUSDT: 50 }
  m.cap.resetCapitalCache()
})

const create = async (capital: number, assets = ['BTCUSDT']) => {
  const b = m.bots.createBot({ name: 't', capital }, await m.cap.fetchFree())
  b.assets = assets; m.bots.saveBot(b) // bypass the dynamic universe: these tests drive the execution layer directly
  return b
}
/** 5s after the open of the current bar: the moment a live entry decided on the previous bar is executed. */
const T = () => m.time.barOpen(Date.now()) + 5000
const pendingEntry = (id: string, symbol = 'BTCUSDT') => {
  const { st, last } = m.bots.loadState(id)
  st.pending = { kind: 'entry', symbol, strategy: 'A', queuedBar: m.time.barIndex(Date.now() - BAR), score: 0.7, atr: 2, stopAtr: 3, riskMult: 1 }
  m.bots.saveState(id, st, last)
}

test('capital: bots can never allocate more than the account holds', async () => {
  const a = await create(600)
  let s = await m.cap.snapshot(true)
  expect(s.allocated).toBe(600); expect(s.unallocated).toBe(400); expect(s.actualCapital).toBe(1000); expect(s.ok).toBe(true)
  await expect(create(401)).rejects.toMatchObject({ status: 409 })           // would over-allocate
  const b = await create(400)                                                   // exactly the rest fits
  expect((await m.cap.snapshot(true)).unallocated).toBe(0)
  await expect(create(1)).rejects.toMatchObject({ status: 409 })
  // growing a bot is an allocation too
  expect(() => m.bots.updateBot(a.id, { capital: 700 }, 1000)).toThrow(/over_allocation/)
  // shrinking frees capital
  m.bots.updateBot(a.id, { capital: 500 }, 1000)
  expect((await m.cap.snapshot(true)).unallocated).toBe(100)
  m.bots.updateBot(a.id, { capital: 600 }, 1000)                                // back up: fits again
  m.bots.deleteBot(b.id, 'now')
  expect((await m.cap.snapshot(true)).unallocated).toBe(400)
})

test('capital: concurrent creates cannot both pass the check', async () => {
  const free = await m.cap.fetchFree()
  const r = await Promise.allSettled([
    (async () => m.bots.createBot({ name: 'x', assets: ['BTCUSDT'], capital: 700 }, free))(),
    (async () => m.bots.createBot({ name: 'y', assets: ['BTCUSDT'], capital: 700 }, free))(),
  ])
  expect(r.filter((x) => x.status === 'fulfilled').length).toBe(1)
  expect(m.bots.listBots().length).toBe(1)
})

test('capital: drift (account lost USDT) is reported and blocks growth / activation', async () => {
  const a = await create(800)
  ex.free.USDT = 500                                                            // user moved money out
  const s = await m.cap.snapshot(true)
  expect(s.ok).toBe(false); expect(s.shortfall).toBeCloseTo(300); expect(s.drift[0]).toMatch(/USDT shortfall/)
  await expect(create(1)).rejects.toMatchObject({ status: 409 })
  m.bots.deactivate(a.id, 'now')
  expect(() => m.bots.activate(a.id, 500)).toThrow(/capital_shortfall/)
})

test('live entry: pending entry is bought for real, fill is booked with order ref, cash and exchange agree', async () => {
  const bot = await create(1000)
  pendingEntry(bot.id)
  await m.live.executeBot(bot.id, T())
  const buy = ex.calls.find((c: any) => c.op === 'buy')
  expect(buy.symbol).toBe('BTCUSDT')
  const { st } = m.bots.loadState(bot.id)
  expect(st.pending).toBeNull()
  expect(st.position.symbol).toBe('BTCUSDT')
  expect(st.position.qty).toBeCloseTo(ex.free.BTC, 8)                           // bot position == real balance
  const b = m.bots.getBot(bot.id)
  expect(b.cash).toBeCloseTo(ex.free.USDT, 6)                                   // bot cash == real free USDT (only bot)
  const tx = m.db.query("SELECT * FROM transactions WHERE bot_id=? AND action='BUY'").get(bot.id) as any
  expect(tx.order_ref).toBe('m1')
  expect(st.position.stop).toBeLessThan(st.position.entryFill)
  const s = await m.cap.snapshot(true)
  expect(s.ok).toBe(true)
  expect(s.inPositions).toBeCloseTo(st.position.notional, 6)
  expect(s.holdings[0]).toMatchObject({ asset: 'BTC', ok: true })
})

test('live entry: capital guard refuses to buy when the account no longer backs the bots', async () => {
  const bot = await create(1000)
  pendingEntry(bot.id)
  ex.free.USDT = 400
  await m.live.executeBot(bot.id, T())
  expect(ex.calls.some((c: any) => c.op === 'buy')).toBe(false)
  expect(m.bots.loadState(bot.id).st.pending).toBeNull()
  expect(m.bots.loadState(bot.id).st.position).toBeNull()
  expect((m.db.query("SELECT detail FROM events WHERE kind='entry_rejected'").get() as any).detail).toMatch(/account has/)
})

test('live entry: a failed buy is dropped and never retried; stale entries expire', async () => {
  const bot = await create(500)
  pendingEntry(bot.id)
  ex.failNext.push({ op: 'buy', err: new Error('boom') })
  await m.live.executeBot(bot.id, T())
  expect(m.bots.loadState(bot.id).st.pending).toBeNull()
  await m.live.executeBot(bot.id, T())
  expect(ex.calls.filter((c: any) => c.op === 'buy').length).toBe(1)
  // an entry decided 20 minutes ago is no longer executed
  const { st, last } = m.bots.loadState(bot.id)
  st.pending = { kind: 'entry', symbol: 'BTCUSDT', strategy: 'A', queuedBar: m.time.barIndex(Date.now() - BAR), score: 0.7, atr: 2, stopAtr: 3, riskMult: 1 }
  m.bots.saveState(bot.id, st, last)
  await m.live.executeBot(bot.id, (st.pending.queuedBar + 1) * BAR + 20 * 60_000)
  expect(ex.calls.filter((c: any) => c.op === 'buy').length).toBe(1)
})

test('live failure: rejected BUY / SELL queue a Telegram alert with the Binance error reason', async () => {
  const buyBot = await create(500)
  pendingEntry(buyBot.id)
  ex.failNext.push({ op: 'buy', err: new Error('insufficient balance (code -2010)') })
  await m.live.executeBot(buyBot.id, T())                                       // BUY fails: entry is dropped, no retry
  const buyNote = m.db.query("SELECT text FROM notifications WHERE kind='lifecycle' ORDER BY id DESC LIMIT 1").get() as any
  expect(buyNote.text).toContain('ORDER FAILED (BUY)')
  expect(buyNote.text).toContain('BTCUSDT')
  expect(buyNote.text).toContain('insufficient balance (code -2010)')

  const sellBot = await create(500)
  pendingEntry(sellBot.id)
  await m.live.executeBot(sellBot.id, T())                                       // real (mock) fill, then force a failed exit
  const { st, last } = m.bots.loadState(sellBot.id)
  st.exitNow = { reason: 'KILL', bar: 1, t: 1 }; m.bots.saveState(sellBot.id, st, last)
  ex.failNext.push({ op: 'sell', err: new Error('market closed (code -1013)') })
  await m.live.executeBot(sellBot.id, T())
  const sellNote = m.db.query("SELECT text FROM notifications WHERE kind='lifecycle' ORDER BY id DESC LIMIT 1").get() as any
  expect(sellNote.text).toContain('ORDER FAILED (SELL)')
  expect(sellNote.text).toContain('BTCUSDT')
  expect(sellNote.text).toContain('market closed (code -1013)')
  expect(sellNote.text).toContain('retried automatically')
  expect(m.bots.loadState(sellBot.id).st.position).not.toBeNull()                // the position is kept until the retry succeeds
})

test('stop monitor: resting hard stop fills on the exchange and books real P/L; other bots untouched', async () => {
  const bot = await create(1000)
  pendingEntry(bot.id)
  await m.live.executeBot(bot.id, T())
  const { st } = m.bots.loadState(bot.id)
  expect(st.position.strategy).toBe('A')
  expect(st.position.stopOrderId).toBeTruthy()                                  // the stop rests on Binance
  ex.price.BTCUSDT = st.position.stop - 0.01                                    // above the resting hard stop: no trigger
  await m.live.monitorTick(T())
  expect(m.bots.loadState(bot.id).st.position).not.toBeNull()
  ex.price.BTCUSDT = st.position.hardStop - 0.5                                 // hard stop breached -> exchange stop fills
  await m.live.monitorTick(T())
  const after = m.bots.loadState(bot.id)
  expect(after.st.position).toBeNull()
  expect(after.st.exitNow).toBeUndefined()
  const sell = m.db.query("SELECT * FROM transactions WHERE bot_id=? AND action='SELL'").get(bot.id) as any
  expect(sell.exit_reason).toBe('HARD_STOP'); expect(sell.pnl).toBeLessThan(0); expect(sell.order_ref).toBeTruthy()
  expect(m.bots.getBot(bot.id).cash).toBeCloseTo(ex.free.USDT, 6)               // books == exchange
  expect(ex.free.BTC).toBeCloseTo(0, 8)
})

test('stop monitor: a bar committed while a stop call is in flight is not overwritten', async () => {
  const bot = await create(1000)
  pendingEntry(bot.id)
  await m.live.executeBot(bot.id, T())
  const { st: s0, last } = m.bots.loadState(bot.id)
  s0.position!.restingStop = s0.position!.stopOrderPlaced! * 1.01 // force a cancel + replace
  m.bots.saveState(bot.id, s0, last)

  const orig = ex.orderStatus.bind(ex)
  let release!: () => void
  const gate = new Promise<void>((r) => { release = r })
  let gated = false
  ex.orderStatus = async (...args: any[]) => {
    if (!gated) { gated = true; await gate }
    return orig(...args)
  }
  try {
    const p = m.live.executeBot(bot.id, T())
    await Bun.sleep(10)
    // the runner commits a new bar while the exchange call is in flight
    const { st, last: l2 } = m.bots.loadState(bot.id)
    st.position!.barsHeld = 42
    st.exitNow = { reason: 'TIME', bar: 1, t: 1 }
    m.bots.saveState(bot.id, st, l2)
    release()
    await p
  } finally { ex.orderStatus = orig }

  const after = m.bots.loadState(bot.id)
  expect(after.st.position!.barsHeld).toBe(42)   // the in-flight stop write did not resurrect stale state
  expect(after.st.exitNow?.reason).toBe('TIME')
  expect(after.st.position!.stopOrderId).toBeTruthy()
})

test('sell failure keeps the position, retries with back-off and eventually books', async () => {
  const bot = await create(1000)
  pendingEntry(bot.id)
  await m.live.executeBot(bot.id, T())
  const { st, last } = m.bots.loadState(bot.id)
  st.exitNow = { reason: 'KILL', bar: 1, t: 1 }; m.bots.saveState(bot.id, st, last)
  ex.failNext.push({ op: 'sell', err: new Error('net down') })
  const t0 = T()
  await m.live.executeBot(bot.id, t0)
  expect(m.bots.loadState(bot.id).st.position).not.toBeNull()
  expect(ex.calls.filter((c: any) => c.op === 'sell').length).toBe(1)           // the failed attempt
  await m.live.executeBot(bot.id, t0 + 1000)                                    // inside back-off: no new call
  expect(ex.calls.filter((c: any) => c.op === 'sell').length).toBe(1)
  await m.live.executeBot(bot.id, t0 + 61_000)
  expect(m.bots.loadState(bot.id).st.position).toBeNull()
  expect((m.db.query("SELECT exit_reason FROM transactions WHERE action='SELL'").get() as any).exit_reason).toBe('KILL')
})

test('closeBotNow sells for real; forceClose refuses to fake a live sale', async () => {
  const bot = await create(1000)
  pendingEntry(bot.id)
  await m.live.executeBot(bot.id, T())
  expect(() => m.bots.deactivate(bot.id, 'now')).toThrow(/sold on the exchange/)
  await m.live.closeBotNow(bot.id)
  expect(m.bots.loadState(bot.id).st.position).toBeNull()
  expect((m.db.query("SELECT exit_reason FROM transactions WHERE action='SELL'").get() as any).exit_reason).toBe('MANUAL')
  expect(m.bots.deactivate(bot.id, 'now').status).toBe('inactive')
})

test('no replay: stale bars are skipped, time-based state advances, nothing is traded', async () => {
  const bot = await create(500)
  const now = Date.now()
  const lastClosed = m.time.lastClosedBar(now)
  const { st } = m.bots.loadState(bot.id)
  st.position = { symbol: 'BTCUSDT', strategy: 'A', entryTs: 1, entryFill: 100, qty: 1, notional: 100, initialStop: 97, stop: 97, hardStop: 96, restingStop: 96, highestClose: 100, highestHigh: 100, ratcheted: false, barsHeld: 5, riskUsdt: 3, maxUnrealizedR: 0, slip: 0.001 }
  st.cooldown = 10
  m.bots.saveState(bot.id, st, lastClosed - 10 * BAR)                           // 10 bars behind
  ex.free.BTC = 1
  const skipped = m.runner.skipStaleBars(bot.id, now)
  const after = m.bots.loadState(bot.id)
  const fresh = now - (lastClosed + BAR) <= m.time.LIVE_BAR_MAX_AGE_MS
  const expected = fresh ? 9 : 10
  expect(skipped).toBe(expected)
  expect(after.st.counters.skipped_bars).toBe(expected)
  expect(after.st.position.barsHeld).toBe(5 + expected)
  expect(after.st.cooldown).toBe(Math.max(0, 10 - expected)) // the cooldown ticks down with the skipped bars
  expect(after.last).toBe(lastClosed - (fresh ? BAR : 0))
  expect((m.db.query("SELECT COUNT(*) c FROM notifications WHERE kind IN ('interrupt','api_error')").get() as any).c).toBe(0) // no connectivity alert
  expect(m.db.query("SELECT COUNT(*) c FROM transactions WHERE bot_id=?").get(bot.id)).toEqual({ c: 0 }) // nothing was traded by the skipped bars
})

test('telegram: only failed functional API requests are queued, rate-limited per key', async () => {
  const { notifyApiFailure } = await import('../src/notify')
  notifyApiFailure('test:candles', 'msg one')
  notifyApiFailure('test:candles', 'msg two') // same key inside the window: dropped
  notifyApiFailure('test:universe', 'msg three')
  const rows = m.db.query("SELECT text FROM notifications WHERE kind='api_error' ORDER BY id").all() as any[]
  expect(rows.map((r) => r.text)).toEqual(['msg one', 'msg three'])
})

afterAll(() => { m.rt.live = false })

function series(n: number, crashAt: number) {
  const END = Math.floor(Date.now() / BAR) * BAR - BAR
  const out = []
  let p = 100
  const T0 = END - (n - 1) * BAR
  for (let i = 0; i < n; i++) {
    const noise = Math.sin(i * 1.7) * 0.3
    const o = p
    p = Math.max(1, p * (1 + (i < crashAt ? 0.004 : -0.03) + noise * 0.01))
    out.push({ t: T0 + i * BAR, o, h: Math.max(o, p) * 1.003, l: Math.min(o, p) * 0.997, c: p, v: i % 5 === 0 ? 300 : 100 })
  }
  return out
}

test('pipeline: engine decides bar by bar, real orders are placed at the open, books == exchange, no simulated fills', async () => {
  const bot = await create(1000, ['PEPEUSDT'])
  const cs = series(520, 470)
  m.runner.upsertCandles('PEPEUSDT', cs.slice(0, 251))
  const { st: s0 } = m.bots.loadState(bot.id)
  m.bots.saveState(bot.id, s0, cs[250].t)
  for (let i = 251; i < cs.length; i++) {
    m.runner.upsertCandles('PEPEUSDT', [cs[i]])
    const now = cs[i].t + BAR + 5000
    ex.price.PEPEUSDT = cs[i].c
    m.runner.processAll(now)
    await m.live.executeAll(now)
  }
  const txs = m.db.query('SELECT * FROM transactions WHERE bot_id=? ORDER BY id').all(bot.id) as any[]
  const buys = txs.filter((t) => t.action === 'BUY'), sells = txs.filter((t) => t.action === 'SELL')
  expect(buys.length).toBeGreaterThan(0)
  expect(sells.length).toBeGreaterThan(0)
  expect(txs.every((t) => t.order_ref)).toBe(true)                               // every fill came from the exchange
  expect(ex.calls.filter((c: any) => c.op === 'buy').length).toBe(buys.length)
  expect(ex.calls.filter((c: any) => c.op === 'sell').length).toBe(sells.length)
  const { st } = m.bots.loadState(bot.id)
  expect(st.exitNow).toBeUndefined()
  if (!st.position) {
    expect(m.bots.getBot(bot.id).cash).toBeCloseTo(ex.free.USDT, 6)              // flat: bot cash is exactly the account's USDT
    expect(ex.free.PEPE ?? 0).toBeCloseTo(0, 8)
  } else expect(st.position.qty).toBeCloseTo(ex.free.PEPE, 8)
  expect((await m.cap.snapshot(true)).ok).toBe(true)
})
