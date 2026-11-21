## Donchian parameters 4H:
| element | suggested | reason |
|---|---|---|
| `donchian` | **40, current bar excluded** | Keep |
| `ema` | **200, `adjust=False`, `min_periods=400`** (or SMA-seeded) | Seed weight is still about 13% at bar 200; 400 bars cuts it to about 2% and screens out young listings |
| `volume_mult` | **1.5 × `volSma20`**, plus **ceiling 5×** | 1.2x passes about 35-45% of bars; the ceiling rejects blow-off candles |
| extension gate | **skip if close > level + 2.0 ATR** | Late entries have poor stop-to-reward |
| initial stop | **`entry − 3.0 × ATR14`** | Keep |
| hard stop | **`entry − 3.5 × ATR14`**, resting intrabar | Closer to the sizing distance, so realized risk matches the budget |
| resting stop ratchet | **`max(hardStop, trailStop − 0.75 ATR)`**, updated each scan | Locks in gains against flash crashes between closes |
| trail | **same**, sweep 2.5-4.0 | Look for a plateau, not a peak |
| trail exit | **same** | Keep |
| time stop | **`barsHeld ≥ 180`** (keep) | Safety valve only |
| stagnation exit | **exit at bar 30-40 if max unrealized < +1R** | Frees capital under one-trade-at-a-time |
| risk multiplier | **1.0 × regimeMult, regimeMult ∈ [0, 1]** | Regime may only scale risk down |
| sizing | **same formula, `stopDist` = worst-case distance** (hard stop + stop slippage) | Budgeted risk equals the loss you can actually take |
| position cap | **≤ 25-30% of equity** | Prevents oversized positions on tight stops |
| stop band gate | **drop**, or make the stop structure-based so it varies | Redundant when the stop is always exactly 3.0 ATR |
| score weights (A) | **same starting weights**, run ablations | Confirm each term adds value and isn't correlated with another |
| caps | **breakout term peaks at ~1.0 ATR then declines** (or keep cap plus the 2 ATR gate); volume cap 3.0× | A 3 ATR breakout shouldn't score the same as a 1 ATR one |
| dataOk | **≥ 400 bars**, contiguous, finite | Matches the EMA warmup |
| costs: fee | **0.001/side** (0.00075 with BNB) | Keep |
| costs: slip | **0.001-0.002 for alts**, tiered by volume/spread (0.0005 for BTC/ETH) | Mid-cap alts at breakout opens cost more |
| costs: stop slip | **stress test at 5×** | Stops fill in the worst conditions |

## Universe Filter Conditions 24H:
## Universe filter for Donchian-40 / EMA200 / 4h long-only

These filters select assets where this specific setup has structural reasons to work: enough liquidity to enter and exit cleanly, enough volatility to pay for costs, and a tendency to trend rather than chop. All are computed on closed 4h data and refreshed daily.

| # | filter | condition | why |
|---|---|---|---|
| 1 | **Eligibility** | status TRADING, quote = USDT, spot allowed, no monitoring/seed tag, not a stablecoin, leveraged token, or wrapped/pegged asset (WBTC, WBETH, etc.) | Pegged and leveraged assets have no real breakouts and distort rankings |
| 2 | **History** | at least 450 contiguous 4h bars (about 75 days), no gaps | Matches `dataOk` at 400 bars, plus a buffer for the Donchian-40 and ATR warmup |
| 3 | **Liquidity** | median daily quote volume (7d) of at least $15-25M, and the 7d/30d volume ratio above 0.5 | Median resists one-day spikes, and the ratio screens out coins whose interest is dying |
| 4 | **Spread** | median spread of at most 5-8 bps (sampled from book ticker snapshots) | Spread is paid on entry and again on exit, and a 2.5x stop slip magnifies it |
| 5 | **Depth** | at least about 10x your intended position within 0.5% of mid, on both sides | Your entry and stop fills must not move the price |
| 6 | **Volatility floor** | median ATR14/close (4h, last 30d) at least 1.2%, and `round-trip cost / (3 × ATR%) ≤ 10%` | A 3 ATR stop on a 0.6% ATR coin means costs eat the edge. This test uses your own cost model |
| 7 | **Volatility ceiling** | median ATR% at most 6% | Above this, 3 ATR stops are enormous, position sizes shrink, and gap risk dominates |
| 8 | **Trendiness** | Kaufman efficiency ratio over 120 bars (net move / sum of absolute moves) above the universe median, or the fraction of the last 180 bars with close above EMA200 between 25% and 85% | Prefers assets that trend in legs and avoids pure chop. The upper bound drops assets in a one-way melt-up that may be exhausted |
| 9 | **Range structure** | at least 1 Donchian-40 breakout (even a failed one) in the last 90 days, and the current close within 15% of the 40-bar high | Keeps assets that are near a trigger, so the scan covers candidates rather than dead names |
| 10 | **Overextension** | exclude if the 7d return exceeds +40%, or the close is more than 6 ATR above EMA200 | A breakout after a parabolic run is usually an exhaustion trap |
| 11 | **Ranking and cap** | rank survivors by 7d median quote volume, keep the top 40-60 | A manageable scan with the best fills |
| 12 | **Hysteresis** | add at rank ≤ 50, remove only at rank > 80 or when a hard filter (1-5) fails | Prevents boundary flapping |

> **Implemented subset (decision, Nov 2026).** The bot ships with three layers only: **eligibility** (row 1),
> **24h quote volume ≥ $10M**, and **≥450 contiguous 4h bars** (row 2). Survivors are ranked by 24h quote volume and
> capped at `universe_max_assets`. Rows 3-12 are kept as design reference for a possible future expansion.

**Notes**
- **Use structural properties, not strategy results.** Don't select pairs by how well this strategy backtested on them, since that is in-sample selection and will overfit. Filters 6-8 are properties of the price series, not of the strategy's P&L.
- **Cross-asset correlation.** Many alts move with BTC, so one-trade-at-a-time matters here. If the top-ranked candidates are all alts in the same sector, the score ranking is picking essentially the same bet. Optionally cap the universe at 3-5 names per sector or a high-correlation cluster.
- **Stale-pair check each scan.** Between daily refreshes, re-verify status and spread, and drop a pair on a delisting or monitoring announcement. Never drop the symbol of an open position.
- **Backtest it point-in-time.** Rebuild the universe daily using only data available that day, including delisted pairs. Otherwise filters 3 and 9 leak look-ahead information.
- **Check filter value individually.** As with the entry filters, remove each one and compare expectancy and drawdown. Filters 6, 8, and 10 are the most likely to matter, and 9 is the most likely to be redundant with the entry rules.
- **Thresholds are starting points.** Liquidity and spread levels depend on your account size. Scale 3-5 to your position size, and if you trade a small account, you can relax them.
