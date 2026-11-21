// MODE=test is paper trading: no API keys, real mainnet prices, simulated fills against a fake account.
import { test, expect, beforeAll, beforeEach } from 'bun:test'
process.env.DB_PATH = ':memory:'
process.env.MODE = 'test'
process.env.NO_WORKER = '1'
process.env.ACCESS_TOKEN = 'test-token'
process.env.BINANCE_DATA_URL = 'https://paper.test'

let m: any
let ex: any

beforeAll(async () => {
  m = { db: (await import('../src/db')).db, exch: await import('../src/exchange') }
  ex = new m.exch.PaperExchange()
})
beforeEach(() => {
  m.db.query('DELETE FROM paper_account').run()
  m.db.query('DELETE FROM paper_orders').run()
  m.db.query('DELETE FROM bots').run()
})

/** Paper prices come from the public mainnet ticker; stub it so the test never touches the network. */
async function withPrice(price: number, fn: () => Promise<void>) {
  const orig = globalThis.fetch
  globalThis.fetch = (async () => Response.json([{ symbol: 'BTCUSDT', price: String(price) }])) as any
  try { await fn() } finally { globalThis.fetch = orig }
}

test('paper account starts with fake USDT and can be topped up', async () => {
  expect((await ex.balances()).free.USDT).toBe(10_000)
  expect(m.exch.addPaperCapital(2_500)).toBe(12_500)
  expect((await ex.balances()).free.USDT).toBe(12_500)
})

test('paper buy and sell move the fake balances with fees and slippage', async () => {
  await withPrice(100, async () => {
    const buy = await ex.buy('BTCUSDT', 1_000)
    expect(buy.qty).toBeGreaterThan(0)
    expect(buy.usdt).toBe(1_000)
    expect(buy.price).toBeGreaterThan(100) // adverse slippage + base-asset fee
    let bal = await ex.balances()
    expect(bal.free.USDT).toBeCloseTo(9_000, 6)
    expect(bal.free.BTC).toBeCloseTo(buy.qty, 10)

    const sell = await ex.sell('BTCUSDT', buy.qty)
    expect(sell.usdt).toBeLessThan(1_000) // fees + slippage on the way out
    bal = await ex.balances()
    expect(bal.free.BTC ?? 0).toBeCloseTo(0, 10)
    expect(bal.free.USDT).toBeCloseTo(9_000 + sell.usdt, 6)
  })
})

test('paper buy is refused when the fake account lacks USDT', async () => {
  await withPrice(100, async () => {
    await expect(ex.buy('BTCUSDT', 20_000)).rejects.toMatchObject({ code: -2010 })
    expect((await ex.balances()).free.USDT).toBe(10_000)
  })
})

test('simulated stop fills at its stop price and credits the paper account once', async () => {
  let order: any
  await withPrice(100, async () => {
    const buy = await ex.buy('BTCUSDT', 1_000)
    order = await ex.placeStop('BTCUSDT', buy.qty, 90)
  })
  await withPrice(89, async () => {
    ex.pricesCache.clear() // the 5s quote cache would otherwise hide the price move
    const s1 = await ex.orderStatus('BTCUSDT', order.orderRef)
    expect(s1.status).toBe('FILLED')
    expect(s1.fill!.price).toBeCloseTo(90 * 0.999, 6) // stop price minus the sell fee
    const s2 = await ex.orderStatus('BTCUSDT', order.orderRef)
    expect(s2.fill).toEqual(s1.fill) // idempotent: no double booking
    expect((await ex.balances()).free.BTC ?? 0).toBeCloseTo(0, 10)
  })
})
