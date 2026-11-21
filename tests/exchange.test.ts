// SpotExchange parsing: a filled resting stop must book the real commission.
import { test, expect } from 'bun:test'
process.env.DB_PATH = ':memory:'
process.env.MODE = 'test'
process.env.NO_WORKER = '1'
process.env.ACCESS_TOKEN = 'test-token'

test('a filled resting stop reads its commission from myTrades', async () => {
  const { SpotExchange } = await import('../src/exchange')
  const ex = new SpotExchange()
  const calls: string[] = []
  // GET /api/v3/order has no fills array; the commission only exists in myTrades.
  ;(ex as any).c = {
    call: async (_method: string, path: string) => {
      calls.push(path)
      if (path === '/api/v3/order') {
        return { symbol: 'BTCUSDT', orderId: 7, status: 'FILLED', executedQty: '1', cummulativeQuoteQty: '100' }
      }
      if (path === '/api/v3/myTrades') return [{ commissionAsset: 'USDT', commission: '0.1' }]
      throw new Error(`unexpected ${path}`)
    },
  }

  const s = await ex.orderStatus('BTCUSDT', '7')
  expect(calls).toEqual(['/api/v3/order', '/api/v3/myTrades'])
  expect(s.status).toBe('FILLED')
  expect(s.fill!.qty).toBe(1)
  expect(s.fill!.usdt).toBeCloseTo(99.9, 10)
  expect(s.fill!.feeUsdt).toBeCloseTo(0.1, 10)
  expect(s.fill!.price).toBeCloseTo(99.9, 10)
})

test('a failed myTrades lookup still books the fill (fee unknown, never dropped)', async () => {
  const { SpotExchange } = await import('../src/exchange')
  const ex = new SpotExchange()
  ;(ex as any).c = {
    call: async (_method: string, path: string) => {
      if (path === '/api/v3/order') {
        return { symbol: 'BTCUSDT', orderId: 8, status: 'FILLED', executedQty: '2', cummulativeQuoteQty: '50' }
      }
      throw new Error('myTrades unavailable')
    },
  }

  const s = await ex.orderStatus('BTCUSDT', '8')
  expect(s.status).toBe('FILLED')
  expect(s.fill!.qty).toBe(2)
  expect(s.fill!.usdt).toBeCloseTo(50, 10)
  expect(s.fill!.feeUsdt).toBe(0)
})
