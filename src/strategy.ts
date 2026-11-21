// Pure strategy logic: score, per-symbol pick, cross-section and the regime engine (BOT_SPEC §7, §8).
import { BEAR, BULL, NEUTRAL, P, STATE_NAME, slipFor, type Strat } from './params'
import type { Row } from './features'
import type { RegimeRec } from './types'

export const clip01 = (x: number) => (Number.isFinite(x) ? Math.max(0, Math.min(1, x)) : 0)

/** rsPct = (count(rel_j <= rel_i) - 1) / (N - 1); 0.5 when N == 1. Non-finite returns are ignored. */
export function crossSection(rel: Map<string, number>): Map<string, number> {
  const vals = [...rel.entries()].filter(([, v]) => Number.isFinite(v))
  const n = vals.length
  const out = new Map<string, number>()
  for (const [k, v] of rel) out.set(k, n < 2 ? 0.5 : (vals.filter(([, o]) => o <= v).length - 1) / (n - 1))
  return out
}

/** Donchian score. The breakout term peaks at ~1 ATR and then declines (cap + the 2 ATR gate). */
export function scoreStrategy(strategy: Strat, row: Row, rsPct: number): number {
  const s = P.score
  const over = ((row.close - row.donchian40) / row.atr14) / s.breakoutCapAtr
  const comp: Record<string, number> = {
    breakout: clip01(over) * (over > 1 ? Math.max(0, 1 - (over - 1) * 0.35) : 1),
    volume: clip01((row.volRatio - 1) / (s.volumeCapRatio - 1)),
    efficiency: clip01(row.persistenceEr),
    relStrength: clip01(rsPct),
  }
  const w = s.weights[strategy]
  let num = 0, den = 0
  for (const k of Object.keys(w)) { num += w[k]! * comp[k]!; den += w[k]! }
  return num / den
}

export function effectiveMinScore(state: number, universeSize: number): number {
  let base = P.regime.table[state]!.minScore
  const adj = P.regime.universeSizeAdjust
  if (adj.enabled && universeSize > adj.reference) base += Math.min(adj.maxAdd, adj.addPerDoubling * Math.log2(universeSize / adj.reference))
  return Math.min(1, base)
}

export type BlockReason =
  | 'score_below_min' | 'strategy_degraded' | 'cost_gate' | 'edge_gate'
  | 'slot_taken' | 'min_notional' | 'drawdown_pause' | 'cooldown' | 'rolling_loss_cap'
  | 'entry_expired' | 'capital_guard' | 'exec_failed'
export interface Blocked { symbol: string; strategy: Strat; reason: BlockReason; detail: string }
export interface Pick {
  symbol: string; strategy: Strat; score: number; stopAtr: number; costInR: number; targetCostMultiple: number
  atr: number; volumeUsdMedian: number; slip: number
}

const f2 = (x: number) => (Number.isFinite(x) ? x.toFixed(2) : 'n/a')

/** Best eligible strategy for one symbol (or none) plus every signal that a filter rejected. */
export function evaluateSymbol(row: Row, rsPct: number, minScore: number, degraded: Record<Strat, boolean>): { pick: Pick | null; blocked: Blocked[] } {
  const blocked: Blocked[] = []
  if (!row.signalA) return { pick: null, blocked }
  const score = scoreStrategy('A', row, rsPct)
  if (degraded.A) {
    blocked.push({ symbol: row.symbol, strategy: 'A', reason: 'strategy_degraded', detail: 'Donchian is frozen after a losing streak' })
    return { pick: null, blocked }
  }
  if (!(score >= minScore)) {
    blocked.push({ symbol: row.symbol, strategy: 'A', reason: 'score_below_min', detail: `score ${f2(score)} < min ${f2(minScore)}` })
    return { pick: null, blocked }
  }
  const stopAtr = P.A.stopAtr
  const slip = slipFor(row.symbol, Number.isFinite(row.volumeUsdMedian) ? row.volumeUsdMedian : 0)
  const roundTrip = 2 * P.fee + slip * (1 + P.stopSlipMult)
  const costInR = roundTrip / stopAtr
  const targetCostMultiple = 1 / costInR
  if (!(costInR <= P.maxCostInR)) {
    blocked.push({ symbol: row.symbol, strategy: 'A', reason: 'cost_gate', detail: `cost ${costInR.toFixed(4)}R > ${P.maxCostInR}R` })
    return { pick: null, blocked }
  }
  if (!(targetCostMultiple >= P.minTargetCostMultiple)) {
    blocked.push({ symbol: row.symbol, strategy: 'A', reason: 'edge_gate', detail: `target/cost ${f2(targetCostMultiple)} < ${P.minTargetCostMultiple}` })
    return { pick: null, blocked }
  }
  return { pick: { symbol: row.symbol, strategy: 'A', score, stopAtr, costInR, targetCostMultiple, atr: row.atr14, volumeUsdMedian: Number.isFinite(row.volumeUsdMedian) ? row.volumeUsdMedian : 0, slip }, blocked }
}

/** Slot ranking: sort by (-score, -volumeUsdMedian, symbol). */
export const rankCmp = (a: Pick, b: Pick) => b.score - a.score || b.volumeUsdMedian - a.volumeUsdMedian || (a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0)

// ---------------------------------------------------------------- regime
export function regimeTarget(cur: number, btcAbove: boolean, breadth: number): number {
  const r = P.regime
  if (cur === BULL) {
    if (btcAbove && breadth >= r.bullExit) return BULL
    return !btcAbove && breadth <= r.bearEnter ? BEAR : NEUTRAL
  }
  if (cur === BEAR) {
    if (!btcAbove && breadth < r.bearExit) return BEAR
    return btcAbove && breadth >= r.bullEnter ? BULL : NEUTRAL
  }
  if (btcAbove && breadth >= r.bullEnter) return BULL
  if (!btcAbove && breadth <= r.bearEnter) return BEAR
  return NEUTRAL
}

/** Applies one bar's evidence; a switch needs `confirmBars` consecutive bars. Returns true if the state changed. */
export function regimeUpdate(rg: RegimeRec, btcAbove: boolean, breadth: number): boolean {
  const target = regimeTarget(rg.state, btcAbove, breadth)
  if (target === rg.state) { rg.pending = null; rg.count = 0; return false }
  rg.count = rg.pending === target ? rg.count + 1 : 1
  rg.pending = target
  if (rg.count >= P.regime.confirmBars) { rg.state = target as 0 | 1 | 2; rg.pending = null; rg.count = 0; return true }
  return false
}
export const regimeName = (s: number) => STATE_NAME[s] ?? '?'
export { NEUTRAL }
