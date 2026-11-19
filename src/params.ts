// Locked strategy configuration (A + C). Source of truth: bot/BOT_SPEC.md §10.
// No decision tree and no runtime schema: these are plain constants, so a typo is a compile error.
export type Strat = 'A' | 'C'
export const STRATEGY_NAME: Record<Strat, string> = { A: 'Donchian', C: 'VCEB' }

export const BULL = 2, NEUTRAL = 1, BEAR = 0
export type RegimeState = 0 | 1 | 2
export const STATE_NAME: Record<number, string> = { [BULL]: 'BULL', [NEUTRAL]: 'NEUTRAL', [BEAR]: 'BEAR' }

export const P = {
  warmupBars: 200,
  minSymbolsCrossSection: 4,
  regimeAnchor: 'BTCUSDT',
  fee: 0.001, slip: 0.0005, stopSlipMult: 2.5,
  A: { donchian: 40, ema: 200, volumeMult: 1.2, stopAtr: 3.0, trailAtr: 3.0 },
  C: {
    donchian: 10, emaRiseLookback: 10, bbPeriod: 20, bbStd: 2.0, compressionLookback: 100, compressionPctile: 0.2,
    volumeMult: 1.5, stopAtr: 2.0, trailAtr: 3.0,
    gateCompressionRatio: 0.8, gateBreakoutMarginAtr: 0.1, gateAvoidAAtr: 1.0,
    /** Pre-gate (stock) volume multiple, used only to detect "raw" C setups that the locked gates rejected. */
    rawVolumeMult: 1.2,
  },
  hardStopAtr: 4.0, maxHoldBars: 180,
  score: {
    breakoutCapAtr: 1.0, volumeCapRatio: 3.0,
    weights: {
      A: { breakout: 0.30, volume: 0.20, efficiency: 0.25, relStrength: 0.25, compression: 0.00 },
      C: { breakout: 0.25, volume: 0.15, efficiency: 0.15, relStrength: 0.20, compression: 0.25 },
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
  riskPerTrade: 0.0075, strategyMult: { A: 1.0, C: 0.8 } as Record<Strat, number>, maxPositionFraction: 1.0, minNotional: 10.0,
  ddPause: 0.10, ddPauseBars: 42, lossWindowBars: 42, lossFloorR: -3.0,
  cooldownBase: 6, cooldownStop: 12, cooldownMax: 48, cooldownStep: 6,
  degradeWindow: 12, degradeMinSumR: -6.0, degradeBars: 180,
  kill: { pctlMin: 0.99, rNowMin: 0.5, tightenAtr: 1.5 },
  gates: { stopMinAtr: 2.0, stopMaxAtr: 3.0 }, maxCostInR: 0.15, minTargetCostMultiple: 4.0,
}
export const STRATEGY_VERSION = 'A+C locked (BOT_SPEC)'
