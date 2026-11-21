// Pure dynamic-universe logic. The filter is deliberately limited to three layers:
//   1. eligibility (exchangeInfo: TRADING, USDT quote, spot, no stable/leveraged/wrapped)
//   2. 24h quote volume >= P.universe.volume24hMinUsd
//   3. at least P.universe.historyBars contiguous 4h bars
// Survivors are ranked by 24h quote volume and capped at `maxAssets`.
// No DB / env access, so the worker can import it.
import { P } from './params'
import { BAR_MS } from './time'
import type { Candle } from './types'

export interface UniverseCandidate {
  symbol: string
  /** 24h quote volume (USDT) from the single ticker/24hr call. */
  quoteVolume24h: number
  bars: number
  contiguous: boolean
  historyOk: boolean
  lastBar: number
}

export interface UniverseRow extends UniverseCandidate {
  rank: number | null
  selected: boolean
  reason: string
  updatedAt: number
}

/** Layer 3: at least `historyBars` candles and no gap over that window. */
export function historyCheck(candles: Candle[]): { bars: number; contiguous: boolean; historyOk: boolean; lastBar: number } {
  const n = candles.length
  const lastBar = n ? candles[n - 1]!.t : 0
  if (n < P.universe.historyBars) return { bars: n, contiguous: false, historyOk: false, lastBar }
  const checkFrom = n - P.universe.historyBars
  let contiguous = true
  for (let i = Math.max(1, checkFrom); i < n; i++) {
    if (candles[i]!.t - candles[i - 1]!.t !== BAR_MS) { contiguous = false; break }
  }
  return { bars: n, contiguous, historyOk: contiguous, lastBar }
}

export interface SelectOpts {
  maxAssets: number
}

export interface SelectResult {
  rows: UniverseRow[]
  selected: string[]
}

/** Rank history-ok candidates by 24h quote volume and keep the top `maxAssets`. */
export function selectUniverse(candidates: UniverseCandidate[], opts: SelectOpts): SelectResult {
  const max = Math.max(1, Math.floor(opts.maxAssets))
  const pass = candidates
    .filter((c) => c.historyOk)
    .sort((a, b) => b.quoteVolume24h - a.quoteVolume24h || (a.symbol < b.symbol ? -1 : 1))
  const rankOf = new Map(pass.map((c, i) => [c.symbol, i + 1]))
  const selected = new Set(pass.slice(0, max).map((c) => c.symbol))
  const now = Date.now()
  const rows: UniverseRow[] = candidates.map((c) => {
    const rank = rankOf.get(c.symbol) ?? null
    const sel = selected.has(c.symbol)
    const reason = !c.historyOk ? 'history' : sel ? '' : 'rank outside the cap'
    return { ...c, rank, selected: sel, reason, updatedAt: now }
  }).sort((a, b) => (a.rank ?? 1e9) - (b.rank ?? 1e9) || b.quoteVolume24h - a.quoteVolume24h || (a.symbol < b.symbol ? -1 : 1))
  return { rows, selected: pass.slice(0, max).map((c) => c.symbol) }
}

/** Eligibility heuristic for exchangeInfo rows (layer 1). */
export function eligibleSymbol(s: { symbol: string; status: string; quoteAsset: string; isSpotTradingAllowed?: boolean }): boolean {
  if (s.quoteAsset !== 'USDT' || s.status !== 'TRADING' || s.isSpotTradingAllowed === false) return false
  const base = s.symbol.slice(0, -4)
  // stablecoins / fiat pegs, leveraged tokens, wrapped & pegged assets
  if (/^(USDC|FDUSD|TUSD|BUSD|DAI|USDP|USDD|EUR|GBP|AEUR|BIDR|IDRT|TRY|RUB|UAH|BRL|ARS|JPY|ZAR|PLN|RON|MXN|CZK|NGN|XUSD|USD1|PYUSD|RLUSD|BFUSD|USDE|SUSDE|USDS|LUSD|GUSD|FRAX|CRVUSD|USDF|USDG|AUSD|EURC|EURI|EURS)$/.test(base)) return false
  if (/(UP|DOWN|BULL|BEAR|3L|3S|5L|5S)$/.test(base)) return false
  if (/^(WBTC|WBETH|WBNB|WETH|WMATIC|WAVAX|WSOL|WFTM|WONE|WCELO|WROSE|WZEC|WXRP)$/.test(base)) return false
  return true
}
