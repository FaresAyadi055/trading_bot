import { params, assetCfg } from './tree'
import type { Candle } from './types'
import { BAR_MS } from './config'
import * as ind from './indicators'

export interface Series {
  t: number[]; o: number[]; h: number[]; l: number[]; c: number[]; v: number[]
  ema200: number[]; atr14: number[]; donchian40: number[]; volSma20: number[]
  bbMid: number[]; bbUpper: number[]; bbLower: number[]; cBbWidth: number[]; cWidthThreshold: number[]
  cDonchian10: number[]; emaRise: number[]; persistenceEr: number[]; atrPctPctl: number[]
  gapRun: number[]
  idx: Map<number, number>
}

const ATR_PCTL_LOOKBACK = 300 // atr14 ranked against the prior 300 bars (current bar is the compared value)

/** Compute every market indicator for the whole rolling window once; callers index by bar. */
export function buildSeries(candles: Candle[]): Series {
  const t = candles.map((x) => x.t), o = candles.map((x) => x.o), h = candles.map((x) => x.h)
  const l = candles.map((x) => x.l), c = candles.map((x) => x.c), v = candles.map((x) => x.v)
  const ix = params.indicators
  const bbMid = ind.sma(c, ix.bb)
  const sd = ind.rollingStd(c, ix.bb)
  const bbUpper = bbMid.map((m, i) => m + ix.bbStd * sd[i]!)
  const bbLower = bbMid.map((m, i) => m - ix.bbStd * sd[i]!)
  const cBbWidth = bbMid.map((m, i) => (bbUpper[i]! - bbLower[i]!) / m)
  // shifted 20th percentile of the width over the prior 100 bars
  const cWidthThreshold = ind.shift(ind.rollingQuantile(cBbWidth, ix.compressionLookback, ix.compressionPercentile), 1)
  const ema200 = ind.ema(c, ix.emaTrend)
  const atr14 = ind.atr(h, l, c, ix.atr)
  const gapRun: number[] = []
  t.forEach((ti, i) => gapRun.push(i > 0 && ti - t[i - 1]! === BAR_MS ? gapRun[i - 1]! + 1 : 0))
  return {
    t, o, h, l, c, v, ema200, atr14,
    donchian40: ind.donchian(h, ix.donchianA),
    volSma20: ind.sma(v, 20),
    bbMid, bbUpper, bbLower, cBbWidth, cWidthThreshold,
    cDonchian10: ind.donchian(h, ix.donchianC),
    emaRise: ema200.map((e, i) => (i >= ix.emaRiseLookback ? Number(e > ema200[i - ix.emaRiseLookback]!) : NaN)),
    persistenceEr: ind.efficiencyRatio(c, ix.persistenceErWindow),
    atrPctPctl: ind.priorRank(atr14, ATR_PCTL_LOOKBACK),
    gapRun,
    idx: new Map(t.map((ti, i) => [ti, i])),
  }
}

const r9 = (x: number) => Math.round(x * 1e9) / 1e9
const FEE = params.cost.feeRatePerSide
const SLIP = params.cost.slipRatePerSide

/**
 * Declared cost features: conservative upper-bound convention (ATR% <= 1).
 * roundTrip = 2*fee + slip*(1+stopSlipMult); costInR = roundTrip/stopDistanceAtr;
 * targetCostMultiple = 1/costInR; expectedNetR = 1 - costInR.
 */
const ROUND_TRIP = 2 * FEE + SLIP * (1 + params.cost.stopSlipMult)
function costBlock(close: number, atr: number, stopAtr: number) {
  const entry = close * (1 + SLIP)
  const stopDistance = stopAtr * atr
  const costInR = ROUND_TRIP / stopAtr
  return {
    stop: entry - stopDistance,
    stopDistance,
    stopDistanceAtr: r9(stopDistance / atr),
    costInR,
    expectedNetR: 1 - costInR,
    targetCostMultiple: 1 / costInR,
  }
}

export function dataOk(S: Series, i: number, symbol: string): boolean {
  const cfg = assetCfg(symbol)
  if (i < params.data.warmupBars) return false
  if (S.gapRun[i]! < 1) return false // >=2-bar contiguous 4h run ending at this bar
  const need: number[] = []
  if (cfg.A.enabled) need.push(S.ema200[i]!, S.donchian40[i]!, S.atr14[i]!)
  if (cfg.C.enabled) need.push(S.cBbWidth[i]!, S.cWidthThreshold[i]!, S.cDonchian10[i]!, S.emaRise[i]!, S.ema200[i]!, S.atr14[i]!)
  return need.every(Number.isFinite)
}

/** Candidate features for strategies A and C at bar i for one asset (strategy masks = degradation pause). */
export function candidates(S: Series, i: number, symbol: string, mask: { A: boolean; C: boolean }) {
  const cfg = assetCfg(symbol)
  const close = S.c[i]!, atr = S.atr14[i]!, vol = S.v[i]!, vs = S.volSma20[i]!
  const volOk = (m: number | null) => m == null || vol > m * vs
  const aOn = cfg.A.enabled && mask.A
  const cOn = cfg.C.enabled && mask.C
  const aSignal =
    aOn && [S.ema200[i]!, S.donchian40[i]!, atr].every(Number.isFinite) &&
    close > S.ema200[i]! && close > S.donchian40[i]! && volOk(params.strategyA.volumeMult)

  const er = S.persistenceEr[i]!
  const erMin = cfg.A.persistenceErMin
  const persistencePass = erMin == null ? 1 : Number.isFinite(er) && er >= erMin ? 1 : 0 // fail-closed

  const cRaw =
    cOn && S.cBbWidth[i]! < S.cWidthThreshold[i]! && S.emaRise[i]! === 1 &&
    close > S.ema200[i]! && close > S.cDonchian10[i]! && volOk(params.strategyC.volumeMult)
  const q = cfg.C
  const compressionRatioPass = q.qualityCompressionRatio == null || S.cBbWidth[i]! <= q.qualityCompressionRatio * S.cWidthThreshold[i]!
  const breakoutMarginPass = q.qualityBreakoutAtr <= 0 || close >= S.cDonchian10[i]! + q.qualityBreakoutAtr * atr
  const avoidABreakoutPass =
    q.avoidABreakoutAtr == null || !cfg.A.enabled || close <= S.ema200[i]! || close < S.donchian40[i]! - q.avoidABreakoutAtr * atr
  const b = (x: boolean) => (x ? 1 : 0)
  return {
    A: {
      enabled: b(aOn), signal: b(aSignal), persistenceEr: er, persistencePass,
      ...costBlock(close, atr, params.strategyA.initialStopAtr),
    },
    C: {
      enabled: b(cOn), rawSignal: b(cRaw),
      compressionRatioPass: b(compressionRatioPass), breakoutMarginPass: b(breakoutMarginPass), avoidABreakoutPass: b(avoidABreakoutPass),
      gateRejected: b(cRaw && !(compressionRatioPass && breakoutMarginPass && avoidABreakoutPass)),
      ...costBlock(close, atr, params.strategyC.initialStopAtr),
    },
  }
}

/** Latest market features, persisted (overwritten) in symbol_features. */
export function latestMarket(S: Series) {
  const i = S.t.length - 1
  return {
    barTime: S.t[i]!, open: S.o[i], high: S.h[i], low: S.l[i], close: S.c[i], volume: S.v[i],
    ema200: S.ema200[i], atr14: S.atr14[i], donchian40: S.donchian40[i], volSma20: S.volSma20[i],
    bbMid: S.bbMid[i], bbUpper: S.bbUpper[i], bbLower: S.bbLower[i], cBbWidth: S.cBbWidth[i],
    cWidthThreshold: S.cWidthThreshold[i], cDonchian10: S.cDonchian10[i], persistenceEr: S.persistenceEr[i],
    atrPctPctl: S.atrPctPctl[i],
  }
}
