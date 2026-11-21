import { test, expect } from 'bun:test'
import { eligibleSymbol, historyCheck, selectUniverse, type UniverseCandidate } from '../src/universe'
import { BAR_MS } from '../src/time'
import type { Candle } from '../src/types'

const candles = (n: number): Candle[] =>
  Array.from({ length: n }, (_, i) => ({ t: i * BAR_MS, o: 1, h: 1, l: 1, c: 1, v: 1 }))
const candidate = (symbol: string, quoteVolume24h: number, historyOk = true): UniverseCandidate => ({
  symbol, quoteVolume24h, bars: historyOk ? 500 : 100, contiguous: historyOk, historyOk, lastBar: 0,
})

test('eligibility: USDT spot pairs only, no stablecoins / leveraged / wrapped assets', () => {
  const row = (symbol: string, over: Partial<{ status: string; quoteAsset: string; isSpotTradingAllowed: boolean }> = {}) =>
    ({ symbol, status: 'TRADING', quoteAsset: 'USDT', isSpotTradingAllowed: true, ...over })
  expect(eligibleSymbol(row('BTCUSDT'))).toBe(true)
  expect(eligibleSymbol(row('PEPEUSDT'))).toBe(true)
  expect(eligibleSymbol(row('BTCUSDC', { quoteAsset: 'USDC' }))).toBe(false)
  expect(eligibleSymbol(row('BTCUSDT', { status: 'BREAK' }))).toBe(false)
  expect(eligibleSymbol(row('BTCUSDT', { isSpotTradingAllowed: false }))).toBe(false)
  expect(eligibleSymbol(row('USDCUSDT'))).toBe(false)
  expect(eligibleSymbol(row('RLUSDUSDT'))).toBe(false)
  expect(eligibleSymbol(row('BFUSDUSDT'))).toBe(false)
  expect(eligibleSymbol(row('ETHUPUSDT'))).toBe(false)
  expect(eligibleSymbol(row('WBTCUSDT'))).toBe(false)
})

test('eligibility: newer stablecoins and gold-backed tokens are excluded', () => {
  const row = (symbol: string) => ({ symbol, status: 'TRADING', quoteAsset: 'USDT', isSpotTradingAllowed: true })
  // These passed the old list and were selected by the 2026-11-21 scan.
  expect(eligibleSymbol(row('UUSDT'))).toBe(false)
  expect(eligibleSymbol(row('RWUSDUSDT'))).toBe(false)
  expect(eligibleSymbol(row('KGSTUSDT'))).toBe(false)
  expect(eligibleSymbol(row('XAUTUSDT'))).toBe(false)
  expect(eligibleSymbol(row('PAXGUSDT'))).toBe(false)
})

test('eligibility: crypto bases ending in B and tokenized stocks stay eligible', () => {
  const row = (symbol: string) => ({ symbol, status: 'TRADING', quoteAsset: 'USDT', isSpotTradingAllowed: true })
  for (const s of ['BNBUSDT', 'ARBUSDT', 'SHIBUSDT', 'TRBUSDT', 'CKBUSDT', 'DGBUSDT', 'BBUSDT']) {
    expect(eligibleSymbol(row(s))).toBe(true)
  }
  // Tokenized stocks are intentionally kept in the universe.
  for (const s of ['NVDABUSDT', 'SOXLBUSDT', 'MSTRBUSDT', 'MUBUSDT']) {
    expect(eligibleSymbol(row(s))).toBe(true)
  }
})

test('history: 450 bars and no gap in the window', () => {
  expect(historyCheck(candles(449)).historyOk).toBe(false)
  expect(historyCheck(candles(450)).historyOk).toBe(true)
  const gap = candles(451)
  gap[100] = { ...gap[100]!, t: gap[100]!.t + BAR_MS }
  expect(historyCheck(gap).historyOk).toBe(false)
})

test('selection: history failures drop out, survivors rank by 24h volume, cap applies', () => {
  const { rows, selected } = selectUniverse(
    [candidate('AAAUSDT', 5), candidate('BBBUSDT', 10), candidate('CCCUSDT', 7, false), candidate('DDDUSDT', 8)],
    { maxAssets: 2 },
  )
  expect(selected).toEqual(['BBBUSDT', 'DDDUSDT'])
  const by = new Map(rows.map((r) => [r.symbol, r]))
  expect(by.get('BBBUSDT')!.rank).toBe(1)
  expect(by.get('DDDUSDT')!.rank).toBe(2)
  expect(by.get('AAAUSDT')!.selected).toBe(false)
  expect(by.get('AAAUSDT')!.reason).toContain('rank')
  expect(by.get('CCCUSDT')!.reason).toBe('history')
  expect(by.get('CCCUSDT')!.rank).toBeNull()
})
