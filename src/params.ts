// Locked strategy configuration (Donchian-only). Source of truth: bot/BOT_SPEC.md.
// No decision tree and no runtime schema: these are plain constants, so a typo is a compile error.
export type Strat = 'A'
export const STRATEGY_NAME: Record<Strat, string> = { A: 'Donchian' }

export const BULL = 2, NEUTRAL = 1, BEAR = 0
export type RegimeState = 0 | 1 | 2
export const STATE_NAME: Record<number, string> = { [BULL]: 'BULL', [NEUTRAL]: 'NEUTRAL', [BEAR]: 'BEAR' }

export const P = {
  /** EMA200 with min_periods=400: 400 closed bars are required before any signal is evaluated. */
  warmupBars: 400,
  minSymbolsCrossSection: 4,
  regimeAnchor: 'BTCUSDT',

  // ---- costs (BOT_SPEC: fee 0.001/side, tiered slip, stop slip stress-tested at 5x) ----
  fee: 0.001,
  slip: { major: 0.0005, mid: 0.001, alt: 0.0015, illiquid: 0.002 },
  stopSlipMult: 5.0,

  // ---- Donchian-40 / EMA200 / 4h long-only ----
  A: {
    donchian: 40,
    ema: 200,
    emaMinPeriods: 400,
    volumeMult: 1.5,
    volumeCeilMult: 5.0,
    extensionAtr: 2.0,
    stopAtr: 3.0,
    hardStopAtr: 3.5,
    trailAtr: 3.0,
    /** Resting stop = max(hardStop, trailStop - 0.75 ATR), refreshed every scan. */
    restingTrailAtr: 0.75,
    /** Safety valve: free the slot if the trade never reached +1R by this bar. */
    stagnationBars: 36,
    stagnationMinR: 1.0,
  },
  maxHoldBars: 180,

  score: {
    breakoutCapAtr: 1.0,
    volumeCapRatio: 3.0,
    weights: {
      A: { breakout: 0.30, volume: 0.20, efficiency: 0.25, relStrength: 0.25 },
    } as Record<Strat, Record<string, number>>,
  },

  regime: {
    bullEnter: 0.60, bullExit: 0.45, bearEnter: 0.35, bearExit: 0.50, confirmBars: 2,
    table: {
      [BULL]: { allowEntries: true, minScore: 0.45, riskMult: 1.0 },
      [NEUTRAL]: { allowEntries: true, minScore: 0.60, riskMult: 0.75 },
      [BEAR]: { allowEntries: true, minScore: 0.80, riskMult: 0.50 },
    } as Record<number, { allowEntries: boolean; minScore: number; riskMult: number }>,
    universeSizeAdjust: { enabled: false, reference: 4, addPerDoubling: 0.05, maxAdd: 0.15 },
    tightenOnBear: false, tightenAtrMult: 1.5,
  },

  maxPositions: 1,
  riskPerTrade: 0.0075,
  strategyMult: { A: 1.0 } as Record<Strat, number>,
  /** Position cap: never more than 30% of equity in one trade. */
  maxPositionFraction: 0.30,
  minNotional: 10.0,

  ddPause: 0.10, ddPauseBars: 42, lossWindowBars: 42, lossFloorR: -3.0,
  cooldownBase: 6, cooldownStop: 12, cooldownMax: 48, cooldownStep: 6,
  degradeWindow: 12, degradeMinSumR: -6.0, degradeBars: 180,
  kill: { pctlMin: 0.99, rNowMin: 0.5, tightenAtr: 1.5 },

  /** Cost gate only; the old fixed stop-band gate is gone (the stop is always exactly 3 ATR). */
  maxCostInR: 0.15,
  minTargetCostMultiple: 4.0,

  // ---- dynamic universe filter (refreshed every 6 closed 4h bars = 24h) ----
  // Deliberately limited to three layers: eligibility, 24h volume, and history.
  universe: {
    /** Default maximum; the live value is stored in meta.universe_max_assets and is API-editable. */
    maxDefault: 60,
    /** Layer 2: minimum 24h quote volume (USDT). */
    volume24hMinUsd: 10_000_000,
    /** Layer 3: minimum contiguous 4h bars (matches the EMA warmup plus a buffer). */
    historyBars: 450,
    refreshBars: 6,
  },
}

/** Tiered entry/exit slippage (BOT_SPEC costs): majors 5 bps, mid-caps 10-20 bps by liquidity. */
export function slipFor(symbol: string, volumeUsdMedian: number): number {
  if (symbol === 'BTCUSDT' || symbol === 'ETHUSDT') return P.slip.major
  if (volumeUsdMedian >= 100_000_000) return P.slip.mid
  if (volumeUsdMedian >= 25_000_000) return P.slip.alt
  return P.slip.illiquid
}

export const STRATEGY_VERSION = 'Donchian-40 / EMA200 / 4h long-only (BOT_SPEC)'
