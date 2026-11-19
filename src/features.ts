import { BAR_MS } from './time'
import { P } from './params'
import * as ind from './indicators'
import type { Candle } from './types'

/** All indicators + signals for one symbol, index-aligned with its candle window. */
export interface Series {
  t: number[]; o: number[]; h: number[]; l: number[]; c: number[]; v: number[]
  ema200: number[]; ema200Lag: number[]; atr14: number[]; donchian40: number[]; donchian10: number[]
  volSma20: number[]; volRatio: number[]; cBbWidth: number[]; cWidthThreshold: number[]
  persistenceEr: number[]; relReturn: number[]; atrPctPctl: number[]; volumeUsdMedian: number[]
  dataOk: Uint8Array; signalA: Uint8Array; signalC: Uint8Array
  /** C setup with the stock (pre-gate) conditions; used to report trades the locked gates rejected. */
  rawC: Uint8Array
  idx: Map<number, number>
}

/** Feature snapshot of one symbol on one closed bar (what the strategy code reads). */
export interface Row {
  symbol: string; t: number
  open: number; high: number; low: number; close: number; volume: number
  ema200: number; atr14: number; donchian40: number; donchian10: number; volRatio: number
  cBbWidth: number; cWidthThreshold: number; persistenceEr: number; relReturn: number
  atrPctPctl: number; volumeUsdMedian: number
  dataOk: boolean; signalA: boolean; signalC: boolean; rawC: boolean
}

/** Compute every market feature for the whole rolling window once; callers index by bar. */
export function buildSeries(candles: Candle[]): Series {
  const n = candles.length
  const t = candles.map((x) => x.t), o = candles.map((x) => x.o), h = candles.map((x) => x.h)
  const l = candles.map((x) => x.l), c = candles.map((x) => x.c), v = candles.map((x) => x.v)

  const ema200 = ind.ema(c, P.A.ema)
  const atr14 = ind.atr(h, l, c, 14)
  const donchian40 = ind.donchian(h, P.A.donchian)
  const donchian10 = ind.donchian(h, P.C.donchian)
  const volSma20 = ind.sma(v, 20)
  const volRatio = v.map((x, i) => x / volSma20[i]!)

  const mid = ind.sma(c, P.C.bbPeriod)
  const sd = ind.rollingStd0(c, P.C.bbPeriod)
  const cBbWidth = mid.map((m, i) => (2 * P.C.bbStd * sd[i]!) / m) // (upper-lower)/mid = 4σ/mid
  const cWidthThreshold = ind.shift(ind.rollingQuantile(cBbWidth, P.C.compressionLookback, P.C.compressionPctile), 1)

  const persistenceEr = ind.efficiencyRatio(c, 20)
  const relReturn = c.map((x, i) => (i >= 60 ? x / c[i - 60]! - 1 : NaN))
  const atrPctPctl = ind.priorRank(atr14, 300)
  const volumeUsdMedian = ind.rollingMedian(v.map((x, i) => x * c[i]!), 180)
  const ema200Lag = ind.shift(ema200, P.C.emaRiseLookback)

  const dataOk = new Uint8Array(n), signalA = new Uint8Array(n), signalC = new Uint8Array(n), rawC = new Uint8Array(n)
  for (let i = 0; i < n; i++) {
    const finite = [ema200[i], atr14[i], donchian40[i], donchian10[i], volSma20[i], volRatio[i], cBbWidth[i], cWidthThreshold[i], persistenceEr[i], relReturn[i]]
      .every((x) => Number.isFinite(x))
    // contiguity: t, t-1 exactly 4h apart and the bar before that present (spec §3)
    const contiguous = i >= 2 && t[i]! - t[i - 1]! === BAR_MS && t[i]! - t[i - 2]! === 2 * BAR_MS
    const ok = i + 1 >= P.warmupBars && contiguous && finite
    dataOk[i] = ok ? 1 : 0
    if (!ok) continue
    const cl = c[i]!, vo = v[i]!, atr = atr14[i]!
    // strict `>` / `>=` exactly as written in the spec; NaN comparisons are false (fail closed)
    signalA[i] = Number(cl > ema200[i]! && cl > donchian40[i]! && vo > P.A.volumeMult * volSma20[i]!)
    const rise = ema200[i]! > ema200Lag[i]!
    const base = rise && cl > ema200[i]! && cl > donchian10[i]!
    const compression = cBbWidth[i]! <= P.C.gateCompressionRatio * cWidthThreshold[i]!
    const margin = cl - donchian10[i]! >= P.C.gateBreakoutMarginAtr * atr
    const avoidA = donchian40[i]! - cl >= P.C.gateAvoidAAtr * atr
    signalC[i] = Number(compression && base && vo > P.C.volumeMult * volSma20[i]! && margin && avoidA)
    rawC[i] = Number(cBbWidth[i]! < cWidthThreshold[i]! && base && vo > P.C.rawVolumeMult * volSma20[i]!)
  }
  return {
    t, o, h, l, c, v, ema200, ema200Lag, atr14, donchian40, donchian10, volSma20, volRatio, cBbWidth, cWidthThreshold,
    persistenceEr, relReturn, atrPctPctl, volumeUsdMedian, dataOk, signalA, signalC, rawC,
    idx: new Map(t.map((ti, i) => [ti, i])),
  }
}

export function rowAt(symbol: string, S: Series, i: number): Row {
  return {
    symbol, t: S.t[i]!, open: S.o[i]!, high: S.h[i]!, low: S.l[i]!, close: S.c[i]!, volume: S.v[i]!,
    ema200: S.ema200[i]!, atr14: S.atr14[i]!, donchian40: S.donchian40[i]!, donchian10: S.donchian10[i]!, volRatio: S.volRatio[i]!,
    cBbWidth: S.cBbWidth[i]!, cWidthThreshold: S.cWidthThreshold[i]!, persistenceEr: S.persistenceEr[i]!, relReturn: S.relReturn[i]!,
    atrPctPctl: S.atrPctPctl[i]!, volumeUsdMedian: S.volumeUsdMedian[i]!,
    dataOk: S.dataOk[i] === 1, signalA: S.signalA[i] === 1, signalC: S.signalC[i] === 1, rawC: S.rawC[i] === 1,
  }
}

/** Latest market features, persisted (overwritten) in symbol_features. */
export function latestMarket(S: Series) {
  const i = S.t.length - 1
  const r = rowAt('', S, i)
  const { symbol: _s, t: _t, ...rest } = r
  return { barTime: S.t[i]!, ...rest }
}
