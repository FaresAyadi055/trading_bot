import { BAR_MS } from './time'
import { P } from './params'
import * as ind from './indicators'
import type { Candle } from './types'

/** All indicators + signals for one symbol, index-aligned with its candle window. */
export interface Series {
  t: number[]; o: number[]; h: number[]; l: number[]; c: number[]; v: number[]
  ema200: number[]; atr14: number[]; donchian40: number[]
  volSma20: number[]; volRatio: number[]
  persistenceEr: number[]; relReturn: number[]; atrPctPctl: number[]; volumeUsdMedian: number[]
  dataOk: Uint8Array; signalA: Uint8Array
  idx: Map<number, number>
}

/** Feature snapshot of one symbol on one closed bar (what the strategy code reads). */
export interface Row {
  symbol: string; t: number
  open: number; high: number; low: number; close: number; volume: number
  ema200: number; atr14: number; donchian40: number; volRatio: number
  persistenceEr: number; relReturn: number
  atrPctPctl: number; volumeUsdMedian: number
  dataOk: boolean; signalA: boolean
}

/** Compute every market feature for the whole rolling window once; callers index by bar. */
export function buildSeries(candles: Candle[]): Series {
  const n = candles.length
  const t = candles.map((x) => x.t), o = candles.map((x) => x.o), h = candles.map((x) => x.h)
  const l = candles.map((x) => x.l), c = candles.map((x) => x.c), v = candles.map((x) => x.v)

  // EMA200 seeded with adjust=False and min_periods=400 (the seed weight is ~2% at bar 400).
  const ema200 = ind.ema(c, P.A.ema, P.A.emaMinPeriods)
  const atr14 = ind.atr(h, l, c, 14)
  const donchian40 = ind.donchian(h, P.A.donchian)
  const volSma20 = ind.sma(v, 20)
  const volRatio = v.map((x, i) => x / volSma20[i]!)

  const persistenceEr = ind.efficiencyRatio(c, 20)
  const relReturn = c.map((x, i) => (i >= 60 ? x / c[i - 60]! - 1 : NaN))
  const atrPctPctl = ind.priorRank(atr14, 300)
  const volumeUsdMedian = ind.rollingMedian(v.map((x, i) => x * c[i]!), 180)

  const dataOk = new Uint8Array(n), signalA = new Uint8Array(n)
  for (let i = 0; i < n; i++) {
    const finite = [ema200[i], atr14[i], donchian40[i], volSma20[i], volRatio[i], persistenceEr[i], relReturn[i]]
      .every((x) => Number.isFinite(x))
    // contiguity: t, t-1 exactly 4h apart and the bar before that present (spec §3)
    const contiguous = i >= 2 && t[i]! - t[i - 1]! === BAR_MS && t[i]! - t[i - 2]! === 2 * BAR_MS
    const ok = i + 1 >= P.warmupBars && contiguous && finite
    dataOk[i] = ok ? 1 : 0
    if (!ok) continue
    const cl = c[i]!, atr = atr14[i]!, level = donchian40[i]!
    // Donchian-40 breakout, volume floor + ceiling, and the 2 ATR extension gate.
    const volumeOk = volRatio[i]! > P.A.volumeMult && volRatio[i]! <= P.A.volumeCeilMult
    const extensionOk = cl <= level + P.A.extensionAtr * atr
    signalA[i] = Number(cl > ema200[i]! && cl > level && volumeOk && extensionOk)
  }
  return {
    t, o, h, l, c, v, ema200, atr14, donchian40, volSma20, volRatio,
    persistenceEr, relReturn, atrPctPctl, volumeUsdMedian, dataOk, signalA,
    idx: new Map(t.map((ti, i) => [ti, i])),
  }
}

export function rowAt(symbol: string, S: Series, i: number): Row {
  return {
    symbol, t: S.t[i]!, open: S.o[i]!, high: S.h[i]!, low: S.l[i]!, close: S.c[i]!, volume: S.v[i]!,
    ema200: S.ema200[i]!, atr14: S.atr14[i]!, donchian40: S.donchian40[i]!, volRatio: S.volRatio[i]!,
    persistenceEr: S.persistenceEr[i]!, relReturn: S.relReturn[i]!,
    atrPctPctl: S.atrPctPctl[i]!, volumeUsdMedian: S.volumeUsdMedian[i]!,
    dataOk: S.dataOk[i] === 1, signalA: S.signalA[i] === 1,
  }
}

/** Latest market features, persisted (overwritten) in symbol_features. */
export function latestMarket(S: Series) {
  const i = S.t.length - 1
  const r = rowAt('', S, i)
  const { symbol: _s, t: _t, ...rest } = r
  return { barTime: S.t[i]!, ...rest }
}
