// Pure strategy logic: score, per-symbol pick, cross-section and the regime engine (BOT_SPEC §7, §8).
import { BEAR, BULL, NEUTRAL, P, STATE_NAME, type Strat } from './params'
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

export function scoreStrategy(strategy: Strat, row: Row, rsPct: number): number {
  const channel = strategy === 'A' ? row.donchian40 : row.donchian10
  const s = P.score
  const comp: Record<string, number> = {
    breakout: clip01(((row.close - channel) / row.atr14) / s.breakoutCapAtr),
    volume: clip01((row.volRatio - 1) / (s.volumeCapRatio - 1)),
    efficiency: clip01(row.persistenceEr),
    relStrength: clip01(rsPct),
    compression: clip01(1 - row.cBbWidth / row.cWidthThreshold),
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
  | 'c_quality_gate' | 'score_below_min' | 'strategy_degraded' | 'stop_band' | 'cost_gate' | 'edge_gate'
  | 'slot_taken' | 'min_notional' | 'drawdown_pause' | 'cooldown' | 'rolling_loss_cap' | 'all_strategies_degraded'
  | 'entry_expired' | 'capital_guard' | 'exec_failed'
export interface Blocked { symbol: string; strategy: Strat; reason: BlockReason; detail: string }
export interface Pick {
  symbol: string; strategy: Strat; score: number; stopAtr: number; costInR: number; targetCostMultiple: number
  atr: number; volumeUsdMedian: number
}

const ROUND_TRIP = 2 * P.fee + P.slip * (1 + P.stopSlipMult)
const f2 = (x: number) => (Number.isFinite(x) ? x.toFixed(2) : 'n/a')

/** Which of the locked C gates failed on a row whose raw (stock) C setup was present. */
export function failedCGates(r: Row): string[] {
  const out: string[] = []
  if (!(r.cBbWidth <= P.C.gateCompressionRatio * r.cWidthThreshold)) out.push(`compression ${f2(r.cBbWidth / r.cWidthThreshold)}x > ${P.C.gateCompressionRatio}x`)
  if (!(r.close - r.donchian10 >= P.C.gateBreakoutMarginAtr * r.atr14)) out.push(`breakout margin ${f2((r.close - r.donchian10) / r.atr14)} ATR < ${P.C.gateBreakoutMarginAtr}`)
  if (!(r.donchian40 - r.close >= P.C.gateAvoidAAtr * r.atr14)) out.push(`too close to Donchian-40 (${f2((r.donchian40 - r.close) / r.atr14)} ATR < ${P.C.gateAvoidAAtr})`)
  if (!(r.volRatio > P.C.volumeMult)) out.push(`volume ${f2(r.volRatio)}x < ${P.C.volumeMult}x`)
  return out
}

/** Best eligible strategy for one symbol (or none) plus every signal that a filter rejected (spec §7.2). */
export function evaluateSymbol(row: Row, rsPct: number, minScore: number, degraded: Record<Strat, boolean>): { pick: Pick | null; blocked: Blocked[] } {
  const blocked: Blocked[] = []
  const cand: Record<Strat, { signal: boolean; score: number; eligible: boolean }> = {
    A: { signal: row.signalA, score: 0, eligible: false }, C: { signal: row.signalC, score: 0, eligible: false },
  }
  for (const s of ['A', 'C'] as const) {
    const c = cand[s]
    if (!c.signal) continue
    c.score = scoreStrategy(s, row, rsPct)
    c.eligible = !degraded[s] && c.score >= minScore
    if (degraded[s]) blocked.push({ symbol: row.symbol, strategy: s, reason: 'strategy_degraded', detail: `${s} is frozen after a losing streak` })
    else if (!(c.score >= minScore)) blocked.push({ symbol: row.symbol, strategy: s, reason: 'score_below_min', detail: `score ${f2(c.score)} < min ${f2(minScore)}` })
  }
  if (!row.signalC && row.rawC) blocked.push({ symbol: row.symbol, strategy: 'C', reason: 'c_quality_gate', detail: failedCGates(row).join('; ') || 'quality gate' })
  if (!cand.A.eligible && !cand.C.eligible) return { pick: null, blocked }
  const s: Strat = cand.A.eligible && (!cand.C.eligible || cand.A.score >= cand.C.score) ? 'A' : 'C'
  const stopAtr = P[s].stopAtr
  const costInR = ROUND_TRIP / stopAtr
  const targetCostMultiple = 1 / costInR
  const fail = (reason: BlockReason, detail: string) => { blocked.push({ symbol: row.symbol, strategy: s, reason, detail }); return { pick: null, blocked } }
  if (!(P.gates.stopMinAtr <= stopAtr && stopAtr <= P.gates.stopMaxAtr)) return fail('stop_band', `stop ${stopAtr} ATR outside ${P.gates.stopMinAtr}-${P.gates.stopMaxAtr}`)
  if (!(costInR <= P.maxCostInR)) return fail('cost_gate', `cost ${costInR.toFixed(4)}R > ${P.maxCostInR}R`)
  if (!(targetCostMultiple >= P.minTargetCostMultiple)) return fail('edge_gate', `target/cost ${f2(targetCostMultiple)} < ${P.minTargetCostMultiple}`)
  return { pick: { symbol: row.symbol, strategy: s, score: cand[s].score, stopAtr, costInR, targetCostMultiple, atr: row.atr14, volumeUsdMedian: Number.isFinite(row.volumeUsdMedian) ? row.volumeUsdMedian : 0 }, blocked }
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
