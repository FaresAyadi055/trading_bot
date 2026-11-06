# Asset-Aware Donchian + VCEB Decision Tree

**Document:** `doc.md`  
**Decision-tree file:** `decision_tree_v1.json`  
**Schema:** `decision-tree/v2`  
**Tree version:** `v1.0`  
**Market:** Binance Spot, USDT quote, 4-hour candles, long-only, no leverage

---

## 1. Purpose and scope

This document describes the JSON-based decision engine for three independently managed spot assets:

- **BTCUSDT:** Strategy A (Donchian) only.
- **ETHUSDT:** Strategy A primary, Strategy C (VCEB) secondary with quality gates.
- **BNBUSDT:** Strategy A primary, Strategy C secondary without the optional quality gates.

The same decision tree is interpreted for all three symbols. The effective strategy configuration, capital, account state, positions, orders, counters, and risk controls remain isolated by symbol.

The tree evaluates only completed 4-hour candles. It does not use future candles or future fills.

### Responsibilities outside the tree

The external runtime is responsible for:

1. Supplying each asset's capital input.
2. Maintaining a separate account and broker state for each asset.
3. Restoring the asset's previous state before each evaluation.
4. Calculating market and candidate features.
5. Executing queued orders and reporting fills.
6. Persisting updated state after each evaluation.

The decision tree must not pool balances, allocate capital, rebalance between symbols, or transfer capital between assets.

---

## 2. Asset configuration

| Symbol | Strategy A | Strategy C | C mode |
|---|---:|---:|---|
| BTCUSDT | Enabled | Disabled | Disabled |
| ETHUSDT | Enabled | Enabled | Gated |
| BNBUSDT | Enabled | Enabled | Unrestricted |

### 2.1 BTCUSDT

- A: enabled.
- C: disabled.
- Only Donchian breakout candidates can be entered.

### 2.2 ETHUSDT

- A: enabled.
- C: enabled.
- C compression quality ratio: `0.8`.
- C breakout margin: `0.10 ATR`.
- C avoid-A proximity: `1.0 ATR`.

### 2.3 BNBUSDT

- A: enabled.
- C: enabled.
- C mode: unrestricted.
- Compression quality ratio: `null`.
- Breakout margin: `0.0 ATR`.
- Avoid-A proximity: `null`.

“Unrestricted” means the three optional C quality gates are inactive. It does **not** disable the shared stop-distance, cost, expected-edge, account-risk, or execution checks.

---

## 3. Capital and account isolation

Capital is an external runtime input, not a value allocated by this decision tree.

| Symbol | Runtime capital input |
|---|---|
| BTCUSDT | `runtime.capital.BTCUSDT` |
| ETHUSDT | `runtime.capital.ETHUSDT` |
| BNBUSDT | `runtime.capital.BNBUSDT` |

Requirements:

- Each supplied capital value must be positive.
- Capital is required at runtime.
- Each asset sizes positions against its own `assetState.cash`.
- Balances are never pooled.
- No cross-asset transfers or rebalancing are performed.
- External logic decides how much capital to supply to each asset.

The initial capital value is not hard-coded in the JSON. The `null` values under `runtime.capital` are placeholders to be populated by the runtime.

---

## 4. Evaluation lifecycle and decision order

The tree is evaluated once per closed 4-hour candle, separately for each asset.

The configured execution order is:

1. Restore the asset's previous state.
2. Resolve pending entry or exit orders at the current bar open.
3. Manage an open position and its resting stops.
4. Evaluate drawdown pause and account-level entry blocks.
5. Evaluate Strategy A and Strategy C signals on the closed candle.
6. Apply the A-over-C priority rule.
7. Apply strategy eligibility, stop-distance, cost, and edge gates.
8. Queue an accepted entry for the next bar open.
9. Mark the asset account to market and persist its updated state.

### 4.1 High-level tree

```text
r_data
 ├─ data not ready ───────────────────────────────> NO_TRADE
 └─ data ready
     └─ r_pending
         ├─ pending order exists ─────────────────> HOLD
         └─ no pending order
             └─ r_pos
                 ├─ position exists
                 │   └─ stop / hard stop / kill / time / trail checks
                 │       ├─ exit condition ───────> EXIT
                 │       ├─ kill stop tighter ────> TIGHTEN_STOP
                 │       └─ otherwise ────────────> HOLD
                 └─ flat
                     └─ drawdown pause
                         └─ rolling loss cap
                             └─ cooldown
                                 └─ degradation pause
                                     └─ Strategy A signal and gates
                                         ├─ accepted ─> QUEUE_ENTRY A
                                         └─ not selected
                                             └─ Strategy C signal and gates
                                                 ├─ accepted ─> QUEUE_ENTRY C
                                                 └─ rejected ─> NO_TRADE
```

The JSON node IDs are the authoritative executable structure. This diagram is a readable summary of their intended path.

### 4.2 Data readiness

The `dataOk` input must represent all required readiness checks:

- Candle is closed.
- Warm-up requirements are satisfied.
- Gap checks are satisfied.
- All enabled-strategy features referenced for the decision are finite.
- Required runtime and restored state are available.

Configured values:

- Warm-up: `200` bars.
- Gap-check lookback: `300` bars.
- `requireFiniteEnabledFeatures`: `true`.

If data is not ready, the output is `NO_TRADE` with reason `data_not_ready`.

### 4.3 Pending orders and open positions

- If a pending order exists, the tree returns `HOLD` with reason `pending_order`.
- If a position is open, position management takes precedence over new-entry evaluation.
- A new entry is not evaluated while an order is pending or a position is open.

---

## 5. Input features

The runtime supplies a structured input for the current asset and closed candle. The JSON declares the following feature groups.

### 5.1 Required top-level runtime inputs

| Input | Meaning |
|---|---|
| `symbol` | Asset being evaluated: BTCUSDT, ETHUSDT, or BNBUSDT |
| `closedBar` | Completed 4-hour candle |
| `features` | Calculated market, candidate, account, position, and execution features |
| `capital` | External capital supplied for this asset |
| `previousState` | Persisted state restored for this asset |

### 5.2 Raw market data

| Feature | Meaning |
|---|---|
| `open` | Current candle open |
| `high` | Current candle high |
| `low` | Current candle low |
| `close` | Current candle close |
| `volume` | Current candle volume |

### 5.3 Indicator and market features

| Feature | Definition |
|---|---|
| `ema200` | EMA of close over 200 periods |
| `atr14` | Wilder ATR(14), using RMA of true range |
| `donchian40` | Highest high over the preceding 40 bars; current bar excluded |
| `volSma20` | 20-bar volume SMA, including the current completed bar |
| `bbMid` | 20-bar Bollinger middle band |
| `bbUpper` | Upper Bollinger band using 2 standard deviations |
| `bbLower` | Lower Bollinger band using 2 standard deviations |
| `cBbWidth` | `(bbUpper - bbLower) / bbMid` |
| `cWidthThreshold` | Shifted 20th percentile of `cBbWidth` over the preceding 100 bars |
| `cDonchian10` | Highest high over the preceding 10 bars; current bar excluded |

The Donchian channels exclude the current candle so that the candle being tested cannot change its own breakout threshold.

### 5.4 Candidate features

The runtime or feature layer provides candidate-specific values.

**Strategy A**

- `A.signal`
- `A.stop`
- `A.stopDistance`
- `A.stopDistanceAtr`
- `A.costInR`
- `A.expectedNetR`
- `A.targetCostMultiple`

**Strategy C**

- `C.rawSignal`
- `C.signalAfterGates`
- `C.stop`
- `C.stopDistance`
- `C.stopDistanceAtr`
- `C.costInR`
- `C.expectedNetR`
- `C.targetCostMultiple`
- `C.gateRejected`

The tree's conditions explicitly consume `A.signal`, `C.rawSignal`, `C.enabled`, the C gate pass flags, stop-distance-in-ATR, cost-in-R, and target-cost multiple. The other listed candidate fields are available for runtime calculations, logging, and diagnostics.

### 5.5 Account features

| Feature | Meaning |
|---|---|
| `assetState.cash` | Available cash for this asset |
| `assetState.equity` | Current marked-to-market equity |
| `assetState.peakEquity` | Highest tracked equity for this asset |
| `assetState.drawdownPct` | Current drawdown percentage |
| `assetState.paused` | Whether the drawdown pause is active |
| `assetState.pauseUntilBar` | Bar index at which the pause expires |
| `assetState.cooldownLeft` | Remaining cooldown bars |
| `assetState.weekR` | Rolling 42-bar realized R measure |
| `assetState.consecutiveLosses` | Consecutive losing trades |
| `assetState.degradationState` | Persisted strategy degradation state |
| `assetState.degradationActive` | Whether degradation pause is active |

### 5.6 Position features

| Feature | Meaning |
|---|---|
| `position.exists` | Whether this asset has an open position |
| `position.strategy` | Strategy that opened the position |
| `position.entryFill` | Actual entry fill |
| `position.qty` | Current position quantity |
| `position.stop` | Current trailing or initial stop |
| `position.hardStop` | Global hard-stop level |
| `position.highestClose` | Highest close since entry |
| `position.highestHigh` | Highest high since entry |
| `position.barsHeld` | Number of bars held |
| `position.rNow` | Current unrealized R |
| `position.mfeR` | Maximum favorable excursion in R |
| `position.maeR` | Maximum adverse excursion in R |
| `position.stopHit` | Whether the position stop was hit |
| `position.hardStopHit` | Whether the hard stop was hit |
| `position.trailExitSignal` | Whether the strategy's trailing exit condition fired |
| `position.killStop` | Proposed volatility kill-switch stop |

### 5.7 Execution features

| Feature | Meaning |
|---|---|
| `pendingOrder.exists` | Whether an order is pending |
| `pendingOrder.type` | Pending order type |
| `pendingOrder.signalAtr` | ATR frozen from the signal candle |
| `pendingOrder.strategy` | Strategy associated with the pending order |

### 5.8 Additional decision inputs

The tree also references:

- `atrPctPctl`: current ATR percentile used by the volatility kill switch.
- `dataOk`: combined data readiness flag.
- `A.stopDistanceAtr`, `C.stopDistanceAtr`: stop distance normalized by ATR.
- `A.costInR`, `C.costInR`: estimated round-trip cost expressed in initial-risk units.
- `A.targetCostMultiple`, `C.targetCostMultiple`: expected target move relative to estimated round-trip cost.
- `C.compressionRatioPass`, `C.breakoutMarginPass`, `C.avoidABreakoutPass`: precomputed C quality-gate results.

---

## 6. Strategy definitions

### 6.1 Strategy A — Donchian breakout (primary)

A is enabled for all three assets.

A raw signal is true when all of the following hold:

1. Strategy A is enabled for the asset.
2. `ema200`, `donchian40`, and `atr14` are finite.
3. `close > ema200`.
4. `close > donchian40`.
5. Volume confirmation passes: `volume > 1.2 * volSma20`.

A candidate must also pass the shared entry eligibility checks:

- Stop distance is between `1.0` and `3.0 ATR`.
- `costInR <= 0.15`.
- `targetCostMultiple >= 4.0`.

A entry settings:

| Parameter | Value |
|---|---:|
| Donchian lookback | 40 bars |
| Trend EMA | 200 |
| Volume multiplier | 1.2 |
| Initial stop | 3.0 ATR below fill |
| Trailing stop | 3.0 ATR |
| Trailing reference | Highest close since entry |
| Trailing exit | Close below trailing stop |
| Trailing execution | Next bar open |

### 6.2 Strategy C — VCEB (secondary)

C is the volatility-compression breakout strategy.

A raw C signal requires:

1. C is enabled for the asset.
2. `cBbWidth < cWidthThreshold`.
3. `ema200 > ema200[i-10]`.
4. `close > ema200`.
5. `close > cDonchian10`.
6. Volume confirmation: `volume > 1.2 * volSma20`.

C uses a 20-period Bollinger calculation with 2 standard deviations, a 100-bar compression threshold lookback, the 20th percentile, and a 10-bar Donchian breakout channel.

C entry settings:

| Parameter | Value |
|---|---:|
| Bollinger period | 20 |
| Bollinger standard deviations | 2.0 |
| Compression lookback | 100 bars |
| Compression percentile | 0.20 |
| Compression offset | 0 |
| EMA rise lookback | 10 bars |
| Breakout lookback | 10 bars |
| Volume multiplier | 1.2 |
| Initial stop | 2.0 ATR below fill |
| Trailing stop | 3.0 ATR |
| Trailing reference | Highest high since entry |
| Trailing execution | Resting intrabar stop |

### 6.3 C quality gates

The three optional C gates are applied after the raw C signal.

**Gate 1 — Compression quality**

- If `qualityCompressionRatio` is null, pass.
- Otherwise require `cBbWidth <= qualityCompressionRatio * cWidthThreshold`.

ETH uses `0.8`; BTC has C disabled; BNB has this gate off.

**Gate 2 — Breakout margin**

- If `qualityBreakoutAtr <= 0`, pass.
- Otherwise require `close >= cDonchian10 + qualityBreakoutAtr * atr14`.

ETH uses `0.10 ATR`; BNB has this gate off.

**Gate 3 — Avoid A proximity**

The gate is inactive when `avoidABreakoutAtr` is null, A is disabled, or price is not above EMA200. Otherwise C is rejected when price is too close to A's 40-bar breakout threshold:

`close >= donchian40 - avoidABreakoutAtr * atr14`

ETH uses `1.0 ATR`; BNB has this gate off.

### 6.4 Strategy priority

A has strict priority over C.

If both raw signals are true on the same closed candle, A is selected. The conflict is counted for diagnostics. The engine must not fall through to C on that candle if A is later rejected by its own stop-distance, cost, or edge gate.

The conflict counter is defined from the raw A and C signals before priority and eligibility gates. The runtime should calculate this diagnostic independently of the selected path through the decision nodes.

---

## 7. Cost awareness

Both strategies must pass the same cost-aware entry checks.

### 7.1 Cost assumptions

| Parameter | Value |
|---|---:|
| Fee per side | `0.001` (0.10%) |
| Slippage per side | `0.0005` (5 bps) |
| Stop slippage multiplier | `2.5` |
| Maximum cost in R | `0.15` |
| Minimum target/cost multiple | `4.0` |

Round-trip cost includes:

- Entry fee.
- Exit fee.
- Entry slippage.
- Exit slippage.

### 7.2 Required candidate cost features

For each candidate, the feature layer must estimate:

- `costInR`
- `expectedNetR`
- `targetCostMultiple`

The JSON specifies that cost inputs must be estimated before entry. If there is no defensible expected-move estimate, the candidate must fail the cost gate; the runtime must not assume an edge.

The explicit tree checks are:

```text
candidate.costInR <= 0.15
candidate.targetCostMultiple >= 4.0
```

The `expectedNetR` field is part of the declared candidate output/features contract, but is not itself a direct comparison node in the current tree.

---

## 8. Risk management and sizing

### 8.1 Position sizing

Configured risk parameters:

| Parameter | Value |
|---|---:|
| Base risk per trade | `0.0075` (0.75%) |
| A risk multiplier | `1.0` |
| C risk multiplier | `0.8` |
| Maximum position fraction | `1.0` |
| Maximum allocation | `1.0` |
| Minimum notional | `10.0 USDT` |
| Global hard stop | `4.0 ATR` |

Sizing uses the asset's own cash balance.

```text
riskCash = cash * riskPerTrade * strategyMultiplier
riskNotional = riskCash * fill / stopDistance
notional = min(riskNotional, cash * maxPositionFraction, cash)
```

The entry is rejected when:

- Stop distance is not positive.
- Notional is below the minimum notional.

Quantity is fee-adjusted according to the execution implementation. The tree does not use another asset's cash for sizing.

### 8.2 Initial and hard stops

| Strategy | Initial stop | Global hard stop |
|---|---:|---:|
| A | Fill − 3.0 × signal-bar ATR | Fill − 4.0 × signal-bar ATR |
| C | Fill − 2.0 × signal-bar ATR | Fill − 4.0 × signal-bar ATR |

The ATR used for the initial stop is frozen from the signal candle, not recalculated from the fill candle.

### 8.3 Trailing stops

**A**

```text
highestClose = max(highestClose, close)
stop = max(previousStop, highestClose - 3.0 * ATR)
```

If the close is below the trailing stop, queue an exit for the next bar open.

**C**

```text
highestHigh = max(highestHigh, high)
stop = max(previousStop, highestHigh - 3.0 * ATR)
```

C's trailing stop is a resting intrabar stop.

Stops must never be loosened.

### 8.4 Volatility kill switch

Configured parameters:

- `atrPercentileMin = 0.99`
- `rNowMin = 0.5`
- `tightenAtrMult = 1.5`

The position-management path checks whether `atrPctPctl` exceeds `0.99`. If it does, the current position R is checked:

- If `position.rNow < 0.5`, exit with reason `KILL`.
- Otherwise, if `position.killStop > position.stop`, tighten the stop to `position.killStop`.
- Otherwise continue to the time and trailing checks.

### 8.5 Maximum holding time

`maxHoldBars = 180`.

If `position.barsHeld >= 180`, the tree exits with reason `TIME`.

---

## 9. Account-level protections

All protections are maintained independently for each asset.

### 9.1 Drawdown pause

- Trigger: `equity <= peakEquity * (1 - 0.10)`.
- Duration: 42 bars (7 days on 4-hour candles).
- Effect: blocks new entries.
- Existing positions continue to be managed.
- On expiry, clear the pause and reset `peakEquity` to equity at expiry.

### 9.2 Rolling loss cap

- Window: 42 bars.
- Block new entries when `assetState.weekR <= -3.0`.

The `weekR` input is a rolling R measure over the configured 42-bar window, despite the field's `weekR` name.

### 9.3 Cooldown

| Parameter | Value |
|---|---:|
| Base cooldown | 6 bars |
| Cooldown after stop | 12 bars |
| Maximum cooldown | 48 bars |

Cooldown escalates with consecutive losses. The exact escalation function is not specified in this JSON and must be implemented consistently by the runtime.

### 9.4 Strategy degradation pause

Enabled independently per strategy and asset.

- Trade window: 12 trades.
- Pause threshold: rolling sum of R at or below `-6.0`.
- Resume after: 180 bars.
- Scope: per strategy and per asset.

---

## 10. Previous state and persistence

Previous state is required and must be restored before evaluation. It is stored externally and scoped per asset.

Persist these fields:

- `position`
- `pendingOrder`
- `cash`
- `equity`
- `peakEquity`
- `drawdownPct`
- `pauseUntilBar`
- `cooldownLeft`
- `consecutiveLosses`
- `rollingWindowR`
- `recentTradeR`
- `degradationState`
- `lastProcessedBar`
- `tradeCounters`
- `rejectionCounters`

If state is missing or stale, the specified policy is:

`NO_TRADE_STATE_NOT_READY`

State must be persisted after each evaluation. The runtime should use `lastProcessedBar` to prevent duplicate processing of the same candle.

---

## 11. Outputs

The decision tree returns a decision/action for the current asset evaluation. The declared decision enum is:

| Decision | Value | Meaning |
|---|---:|---|
| `NO_TRADE` | 0 | Do not open a position |
| `HOLD` | 1 | Maintain current pending/order or position state |
| `ENTER` | 2 | Entry intent enum value; actual entry actions are queued |
| `EXIT` | 3 | Exit intent |
| `TIGHTEN_STOP` | 4 | Move the stop to a tighter level |

The concrete action nodes currently emit:

| Action | When used | Important fields |
|---|---|---|
| `NO_TRADE` | Data not ready or entry blocked/rejected | `reason` |
| `HOLD` | Pending order or open position with no exit | `reason` |
| `QUEUE_ENTRY` | Accepted A or C candidate | `strategy`, `stopFrom`, `stopAtrMult`, `riskMultiplier`, `fill` |
| `EXIT` | Stop, hard stop, kill, time, or trailing exit | `exitReason` |
| `TIGHTEN_STOP` | Kill-switch stop is tighter | `newStopFrom` |

### 11.1 Entry output

A queued A entry includes:

- `strategy: "A"`
- `stopFrom: "A.stop"`
- A initial stop multiplier.
- A risk multiplier.
- `fill: "next_bar_open"`.

A queued C entry includes the corresponding C fields.

The queue is an instruction to the execution layer. It is not a confirmation that an exchange order has filled.

### 11.2 Exit reasons

| Reason | Meaning |
|---|---|
| `STOP` | Strategy stop was hit |
| `HARD_STOP` | Global hard stop was hit |
| `KILL` | Volatility kill switch exited the position |
| `TIME` | Maximum holding period reached |
| `TRAIL` | Strategy trailing exit triggered |

The JSON enum also reserves `NONE` and `DRAWDOWN`; the current action nodes do not define a direct position exit action for those enum values. Drawdown pause blocks new entries rather than forcing an exit.

### 11.3 No-trade reason tags

- `data_not_ready`
- `pending_order`
- `drawdown_pause`
- `rolling_loss_cap`
- `cooldown`
- `strategy_degradation_pause`
- `cost_gate`
- `stop_band`
- `no_eligible_signal`

---

## 12. Diagnostics and monitoring outputs

Diagnostics are tracked per asset:

- `signalsA`
- `signalsC`
- `executedA`
- `executedC`
- `cGateRejections`
- `sameBarConflicts`
- `blockedByPause`
- `blockedByCost`
- `blockedByCooldown`
- `trades`
- `fees`
- `slippage`
- `realizedPnl`
- `equity`
- `drawdown`
- `pauseState`

The runtime should also retain the reason tag and the relevant feature values for each rejected candidate. Diagnostics must not alter trading decisions.

---

## 13. Execution and accounting contract

### 13.1 Entry timing

- Signal evaluation: closed candle.
- Fill timing: next candle open.
- Simulated buy fill: `next_open * (1 + slipRatePerSide)`.
- Initial stop uses ATR frozen from the signal candle.
- Sizing uses the asset's own cash balance.

### 13.2 Stop execution

For a resting stop:

- If the candle opens through the stop, use the open as the raw fill level.
- Otherwise use the stop level.
- Apply adverse exit slippage.

### 13.3 Fees and realized R

- Entry fee: `notional * feeRatePerSide`.
- Exit fee: `exitProceeds * feeRatePerSide`.
- Entry and exit slippage are reflected in fill prices.
- `rMultiple = net realized PnL / fee-adjusted initial risk cash`.

The execution layer is responsible for reporting actual fills and accounting updates to the asset state.

---

## 14. Important implementation notes

1. **One tree, three isolated accounts.** Do not share positions, pending orders, cash, equity, drawdown, pauses, cooldowns, or degradation state between symbols.
2. **External capital input.** The tree reads capital; it does not allocate capital.
3. **Closed candles only.** Signals must be based on completed 4-hour candles.
4. **No lookahead.** Donchian channels and compression thresholds use prior observations as specified.
5. **A priority is strict.** If A and C both signal, A wins. A failing its later eligibility checks must not cause a same-candle C fallback.
6. **Cost gates apply to both strategies.** BNB's unrestricted C mode only disables C's three optional quality gates.
7. **State is mandatory.** Missing or stale state must fail closed with `NO_TRADE_STATE_NOT_READY`.
8. **Queue is not fill.** `QUEUE_ENTRY` must be executed no earlier than the next bar open.
9. **Diagnostics are observational.** Counters and logs do not change strategy decisions.
10. **External logic owns capital allocation.** Any portfolio-level capital distribution must remain outside this tree.

---

## 15. Validation checklist

Before running a simulation or live paper account, verify:

- [ ] JSON parses as valid JSON without comments or trailing commas.
- [ ] BTC has A enabled and C disabled.
- [ ] ETH has A enabled and C enabled with gates `0.8`, `0.10 ATR`, and `1.0 ATR`.
- [ ] BNB has A enabled and C enabled with optional C gates off.
- [ ] Each asset receives a positive, independent runtime capital input.
- [ ] No capital pooling or cross-asset transfers occur.
- [ ] Previous state is restored before evaluation and persisted afterward.
- [ ] Missing/stale state results in `NO_TRADE_STATE_NOT_READY`.
- [ ] Signals use closed candles and shifted Donchian channels.
- [ ] A wins same-bar A/C conflicts without fallback to C.
- [ ] Pending entries fill no earlier than the next bar open.
- [ ] Cost estimates include fees and slippage.
- [ ] Stop-distance and target/cost gates are enforced for A and C.
- [ ] Drawdown pause, rolling loss cap, cooldown, and degradation pause are per asset.
- [ ] Open positions continue to be managed while new entries are paused.
- [ ] Position sizing uses only the relevant asset's cash.
- [ ] Fees, slippage, realized PnL, R multiples, and diagnostics reconcile with execution records.

---

## 16. Research reference figures

The JSON records the following out-of-sample reference PnL figures:

| Asset configuration | OOS PnL reference |
|---|---:|
| BTC — A only | +82.98% |
| ETH — A + gated C | +81.95% |
| BNB — A + unrestricted C | +77.89% |

These are research reference values recorded in the configuration, not a promise of future performance or a live result.

---

## 17. Configuration source of truth

`decision_tree_v1.json` is the machine-readable source of truth for:

- Asset enablement and strategy modes.
- Runtime capital paths and account isolation.
- Strategy parameters and risk parameters.
- Input feature names.
- Decision node IDs, conditions, and action outputs.
- Execution semantics, state transitions, diagnostics, and validation requirements.

If this document and the JSON ever differ, the JSON defines the configured behavior. Changes to the decision logic should be made in the JSON and reflected in this document.
