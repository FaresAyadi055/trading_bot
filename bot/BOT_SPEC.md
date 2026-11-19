# Generalist bot — strategy specification (A + C, locked configuration)

Status: **implementable specification.** This document defines the two strategies, every
input feature with its formula, the account machinery around them, and a complete
reference implementation. It is written so that an agent (or a human) can rebuild the bot
in any language without reading the decision-tree JSON.

The single intentional change from `decision_tree_v3_proto.json` is **Strategy C is
quality-gated and its volume confirmation is 1.5×**. Strategy A keeps its 1.2× volume
default and every other rule is unchanged.

Verified: the reference implementation in §12 reproduces the patched Python runner
**trade-for-trade** — 142/142 identical trades, max |ΔR| = 2·10⁻¹⁵ (§13).

---

## 0. Read this first

Two facts that matter more than the parameter table:

1. **The gates were validated on independent per-asset slots, not on this bot.** In the
   four-asset lab (one slot per asset, A and C both live) gated C earned +35.1 R over 28
   trades against +22.1 R over 39 for ungated C. On *this* bot — one shared slot for the
   whole universe — gating C reduces it from 12 trades to 4 and the point estimate goes
   from +9.8 R to −3.8 R; total R falls from 61.3 to 50.9 in the `proto` variant
   (§14). With four trades, C is statistically indistinguishable from zero in either
   direction, so this is not proof the gate is wrong — it is proof that **the gate has
   not been demonstrated on this bot.** Keep C on a small risk budget and re-measure.
2. **Strategy C is a minority leg.** In the lab it supplies 7–9% of trades; on this bot
   it is 3–8% depending on the variant. The bot's edge is Donchian. Do not let C's
   configuration churn move A's parameters.

---

## 1. What the bot is

- Long-only spot, 4-hour bars, UTC, closed candles only.
- Universe of symbols evaluated on the same bar; **one shared account, one position slot**
  (`maxConcurrentPositions = 1`).
- Two strategies are evaluated on **every** symbol of the universe:
  - **A — Donchian breakout** (40-bar channel), primary.
  - **C — VCEB volatility-compression breakout** (10-bar channel out of a Bollinger
    squeeze), secondary.
- Per symbol, the eligible strategy with the higher confidence **score** becomes that
  symbol's candidate. Candidates from all symbols are ranked by score; the single best
  one gets the slot.
- A BTC-trend + breadth **regime** modulates the score threshold and the risk multiplier.
- Long-only: the regime can only delay or shrink entries, never short.

Nothing in this document uses future information. All features read bars `≤ t`; entries
fill at the open of `t+1`.

---

## 2. Locked configuration (the only diff)

| item | current `decision_tree_v3_proto.json` | **locked value** |
|---|---|---|
| `strategyA.volumeMult` | 1.2 | **1.2 (unchanged)** |
| `strategyC.volumeMult` | 1.2 | **1.5** |
| C compression gate | `cBbWidth < cWidthThreshold` (1.0×) | **`cBbWidth ≤ 0.8 × cWidthThreshold`** |
| C breakout margin | none | **`close − donchian10 ≥ 0.1 × atr14`** |
| C avoid-A proximity | none | **`donchian40 − close ≥ 1.0 × atr14`** |
| everything else (A, score, regime, exits, risk, protections) | — | **unchanged** |

JSON patch:

```jsonc
"strategyC": {
  "volumeMult": 1.5,
  "gates": "gated: compressionRatio 0.8, breakoutMarginAtr 0.1, avoidAAtr 1.0",
  "qualityCompressionRatio": 0.8,
  "qualityBreakoutAtr": 0.1,
  "avoidABreakoutAtr": 1.0
}
```

Code patch in `generalist_prototype/run_v3_proto.py` (the volume multiplier is hard-coded
there, so editing the JSON alone is a no-op):

```python
vmult_a, vmult_c = 1.2, 1.5
f["signalA"] = ((c > f["ema200"]) & (c > f["donchian40"])
                & (v > vmult_a * f["volSma20"])
                & np.isfinite(f["ema200"]) & np.isfinite(f["donchian40"])
                & np.isfinite(f["atr14"]))
f["signalC"] = ((f["cBbWidth"] <= 0.8 * f["cWidthThreshold"])
                & (f["ema200"] > f["ema200"].shift(10))
                & (c > f["ema200"]) & (c > f["donchian10"])
                & (v > vmult_c * f["volSma20"])
                & ((c - f["donchian10"]) >= 0.1 * f["atr14"])
                & ((f["donchian40"] - c) >= 1.0 * f["atr14"]))
```

`decision_tree_v3_proto.json` in the repo is **deliberately left at the stock values**
(`gates: "none (unrestricted C)"`, both `volumeMult: 1.2`) so §14 has an A/B baseline.
The locked behaviour lives in the code patch above. If you want a single source of truth,
apply the JSON patch *and* remove the hard-coded `vmult` at `run_v3_proto.py:106` so the
runner reads `strategyA.volumeMult` / `strategyC.volumeMult` (and the three gate keys)
from `params` — otherwise the JSON change is inert.

---

## 3. Bar conventions and data requirements

| item | value |
|---|---|
| interval | 4 hours, bars aligned to 00:00 / 04:00 / 08:00 / 12:00 / 16:00 / 20:00 UTC |
| direction | long only, spot, no leverage |
| decision point | bar close of `t` |
| fill point | open of `t+1` |
| minimum history | 200 bars per symbol before `dataOk` can be 1 |
| contiguity | `t` and `t−1` must be exactly 4h apart; the bar before that must also exist |
| numeric type | float64, no rounding anywhere |

Bars where a symbol has no data are skipped for that symbol; the portfolio clock still
advances on the union of symbol timestamps.

---

## 4. Input features and their formulas

Every feature below is a function of bars `≤ t` on the same symbol. `C` = close, `O` = open,
`H` = high, `L` = low, `V` = volume.

### 4.1 Market features (per symbol, per bar)

| feature | formula | warm-up | notes |
|---|---|---|---|
| `ema200` | `E_t = α·C_t + (1−α)·E_{t−1}`, `α = 2/201`; `E_0 = C_0` | 200 | pandas `ewm(span=200, adjust=False, min_periods=200)` |
| `tr` | `max(H_t−L_t, |H_t−C_{t−1}|, |L_t−C_{t−1}|)` | 2 | first bar uses `H−L` |
| `atr14` | `ATR_t = ATR_{t−1} + (TR_t − ATR_{t−1})/14`; seeded at the first TR | 14 | Wilder recursion; see §15 note on seeds |
| `atrPct` | `atr14 / C` | 14 | |
| `donchian40` | `max(H[t−40 … t−1])` | 41 | **current bar excluded** |
| `donchian10` | `max(H[t−10 … t−1])` | 11 | **current bar excluded** |
| `volSma20` | `mean(V[t−19 … t])` | 20 | current bar **included** |
| `volRatio` | `V / volSma20` | 20 | |
| `cBbMid` | `mean(C[t−19 … t])` | 20 | Bollinger(20) middle |
| `cBbSd` | population std of `C[t−19 … t]` (`ddof=0`) | 20 | |
| `cBbWidth` | `4 · cBbSd / cBbMid` | 20 | equals `(upper−lower)/mid` with 2σ bands |
| `cWidthThreshold` | 20th percentile of `cBbWidth[t−100 … t−1]` | 120 | linear interpolation; **excludes current bar** |
| `persistenceEr` | `|C_t − C_{t−20}| / Σ_{k=t−19..t} |C_k − C_{k−1}|` | 21 | Kaufman efficiency ratio; NaN if the denominator is 0 |
| `relReturn` | `C_t / C_{t−60} − 1` | 61 | 60-bar relative strength input |
| `atrPctPctl` | `#(ATR_j ≤ ATR_t for j in t−300 … t−1) / 300` | 301 | fraction of finite prior ATRs; marks volatility spikes |
| `volumeUsdMedian` | `median(V·C over t−179 … t)` | 180 | liquidity, used for tie-breaks |
| `dataOk` | `bars_owned ≥ 200` **and** contiguous **and** all of `ema200, atr14, donchian40, donchian10, volSma20, volRatio, cBbWidth, cWidthThreshold, persistenceEr, relReturn` finite | 200 | gate for every evaluation |

### 4.2 Signals (the two strategies)

```text
signalA = (C > ema200)
        ∧ (C > donchian40)
        ∧ (V > 1.2 × volSma20)

signalC = (cBbWidth     ≤ 0.8 × cWidthThreshold)      # gate 1: real squeeze
        ∧ (C − donchian10 ≥ 0.1 × atr14)              # gate 2: breakout margin
        ∧ (donchian40 − C ≥ 1.0 × atr14)              # gate 3: away from A's channel
        ∧ (ema200 > ema200[t−10])                     # trend rising
        ∧ (C > ema200)
        ∧ (C > donchian10)
        ∧ (V > 1.5 × volSma20)
```

Both signals are additionally masked by `dataOk == 1`.

**Gate semantics** (why each exists, from the trade-level audit):

| gate | condition | effect |
|---|---|---|
| compression ratio | `cBbWidth ≤ 0.8 × threshold`, threshold = 20th pct of the prior 100 bars | requires width materially inside the 100-bar squeeze — stricter than merely being below the 20th percentile; this is what cuts C's signal supply by ~88% |
| breakout margin | `C ≥ donchian10 + 0.1·ATR` | rejects breaks that clear the 10-bar high by noise |
| avoid-A | `donchian40 − C ≥ 1.0·ATR` | C must sit at least one ATR **below** A's 40-bar level, so the two strategies never bet the same breakout |
| volume | `V > 1.5 × volSma20` | 1.5× rather than 1.2×; on gated C this removed 11 losers and 1 winner out of 12 |

Note: `cBbWidth < cWidthThreshold` is implied by gate 1 whenever the threshold is positive,
so it is not written separately in the reference code.

### 4.3 Cross-sectional features (same closed bar, `dataOk` symbols only)

```text
N         = number of symbols with dataOk == 1 on this bar
rsPct     = (count(relReturn_j ≤ relReturn_i) − 1) / (N − 1)     # 0.5 when N == 1
breadth   = share of those symbols with C > ema200
```

### 4.4 Derived (per candidate, computed on demand)

```text
channel       = donchian40 (A) | donchian10 (C)
breakoutAtr   = (C − channel) / atr14
stopDistance  = 3.0 (A) | 2.0 (C)          # in ATR
roundTrip     = 2·fee + slip·(1 + stopSlipMult) = 2·0.001 + 0.0005·3.5 = 0.00375
costInR       = roundTrip / stopDistance   # 0.00125 (A) | 0.001875 (C)
targetCostMul = 1 / costInR                # 800 (A) | 533 (C)
```

---

## 5. Strategy A — Donchian breakout

**Signal** (§4.2). **Entry:** next bar open + slippage, ATR frozen from the signal bar.

| element | rule |
|---|---|
| initial stop | `entry − 3.0 × ATR_signal` |
| hard stop | `entry − 4.0 × ATR_signal`, **resting intrabar** |
| trail | each closed bar: `highestClose = max(highestClose, close)`, then `stop = max(stop, highestClose − 3.0 × ATR_t)` |
| trail exit | if `close < stop` → exit at **next bar open** (normal slippage) |
| time stop | `barsHeld ≥ 180` → exit at this bar's close − slippage |
| kill switch | see §9 |
| risk multiplier | 1.0 × regime risk multiplier |

**Important asymmetry, easy to get wrong:** for A the 3-ATR stop is **close-based**, not a
resting order. Only the 4-ATR hard stop can trigger intrabar. The port must not place the
3-ATR stop as a live intrabar order — that changes results materially.

`highestClose` starts at the entry bar's close.

---

## 6. Strategy C — VCEB compression breakout

**Signal** (§4.2, with the three locked gates). **Entry:** next bar open + slippage, ATR
frozen from the signal bar.

| element | rule |
|---|---|
| initial stop | `entry − 2.0 × ATR_signal` |
| hard stop | `entry − 4.0 × ATR_signal`, resting intrabar |
| trail | each closed bar: `highestHigh = max(highestHigh, high)`, then `stop = max(stop, highestHigh − 3.0 × ATR_t)`; set `ratcheted = True` when the stop lifts |
| trail exit | the stop is a **resting intrabar order**: if `low ≤ stop` → fill at `stop` (or at `open` if the bar gaps through), with `slip × 2.5` extra slippage |
| exit label | `STOP` if never ratcheted, `TRAIL` if it was |
| time stop | `barsHeld ≥ 180` → exit at close − slippage |
| kill switch | see §9 |
| risk multiplier | 0.8 × regime risk multiplier |

`highestHigh` starts at the entry bar's high.

**C's 4-ATR hard stop is unreachable, by construction.** The initial 2-ATR stop sits
above it (`entry − 2·ATR > entry − 4·ATR`) and the trail only ratchets upward, so
`low ≤ hardStop` implies `low ≤ stop` and check 1 fires first. In the reference run C's
hard stop never triggers; every C loss is labelled `STOP` or `TRAIL`. Keep the field in the
model (it costs nothing and protects against a future stop-parameter change) but do not
write logic that assumes it can fire.

Order of checks on each bar, in this exact sequence:

1. `low ≤ stop` → stop/trail fill (C only; the resting order is resolved before anything else).
2. `low ≤ hardStop` → hard-stop fill.
3. ratchet the trail from this bar's close/high (**so the ratchet never protects the bar that created it**).
4. kill switch, time stop, regime tightening.
5. A's close-based trail signal (exit queued for next open).

---

## 7. Strategy selection: score, eligibility, slot

### 7.1 Score components (each clipped to 0…1)

| component | formula | weight A | weight C |
|---|---|---|---|
| `breakout` | `clip01(breakoutAtr / 1.0)` | 0.30 | 0.25 |
| `volume` | `clip01((volRatio − 1) / (3 − 1))` | 0.20 | 0.15 |
| `efficiency` | `clip01(persistenceEr)` | 0.25 | 0.15 |
| `relStrength` | `clip01(rsPct)` | 0.25 | 0.20 |
| `compression` | `clip01(1 − cBbWidth / cWidthThreshold)` | 0.00 | 0.25 |

```text
score = Σ(weight_k × component_k) / Σ(weight_k)
```

The score is `0` when the strategy has no signal. Gate 1 mechanically floors C's
`compression` component at `0.2`, and gate 2 floors its `breakout` component at `0.1`.

### 7.2 Eligibility and the per-symbol pick

```text
eligible(A) = signalA ∧ ¬degraded(A) ∧ score(A) ≥ minScore(regime)
eligible(C) = signalC ∧ ¬degraded(C) ∧ score(C) ≥ minScore(regime)

pick = A if eligible(A) ∧ (¬eligible(C) ∨ score(A) ≥ score(C))
     = C if eligible(C) ∧ (¬eligible(A) ∨ score(C) >  score(A))
     = none otherwise                                  # ties go to A
```

Then three cost/sanity gates on the pick (all computed from the **signal bar**):

```text
2.0 ≤ stopDistanceAtr ≤ 3.0        # both strategies are inside by construction
costInR ≤ 0.15                     # inert at these stop sizes
targetCostMultiple ≥ 4.0           # inert at these stop sizes
```

### 7.3 Slot allocation

```text
candidates = one per symbol with a valid pick and a free slot
winner     = sort by (−score, −volumeUsdMedian, symbol) → first
```

With `maxConcurrentPositions = 1` there is exactly one winner. While a position or a
pending order exists, no new candidate is evaluated.

---

## 8. Regime engine

Inputs: BTC (`regimeAnchor`) `close > ema200`, and `breadth` (§4.3). Updated on every bar,
including while a position is open. Requires `N ≥ 4` dataOk symbols; otherwise the state
is left unchanged.

Target state from the current state:

| current | becomes BULL when | becomes BEAR when | otherwise |
|---|---|---|---|
| BULL | stays if `btcAbove ∧ breadth ≥ 0.45` | `¬btcAbove ∧ breadth ≤ 0.35` | NEUTRAL |
| NEUTRAL | `btcAbove ∧ breadth ≥ 0.60` | `¬btcAbove ∧ breadth ≤ 0.35` | NEUTRAL |
| BEAR | `btcAbove ∧ breadth ≥ 0.60` | stays if `¬btcAbove ∧ breadth < 0.50` | NEUTRAL |

A switch is only applied after `confirmBars = 2` consecutive bars targeting the new state.

Per state:

| state | allowEntries | minScore | riskMult |
|---|---|---|---|
| BULL (2) | 1 | 0.45 | 1.00 |
| NEUTRAL (1) | 1 | 0.60 | 0.75 |
| BEAR (0) | 1 | 0.80 | 0.50 |

Optional (disabled): `universeSizeAdjust` adds
`min(0.15, 0.05·log2(N/4))` to `minScore`; `tightenOnBear` raises the stop to
`close − 1.5·ATR` in BEAR.

---

## 9. Per-bar pipeline, execution, risk

### 9.1 Pipeline (exact order)

```text
for each closed bar t on the union clock:
  1. build/lookup features for every symbol at t          -> dataOk, signals
  2. regime update (BTC above EMA200 + breadth)           -> state, minScore, riskMult
  3. pause expiry; cooldown decrement
  4. resolve pending order at this bar's OPEN             -> entry fill, or exit-at-open
  5. if a position exists: manage it (exits, §5/§6)
  6. if flat and nothing pending: scan every symbol
        a. account blocks: pause / rolling loss / cooldown / both strategies frozen
        b. regime allowEntries
        c. per symbol: signals -> score -> eligible -> pick -> stop band -> cost -> edge
        d. cross-section rank, best score wins the slot -> queue for t+1 open
  7. bookkeeping: equity/peak/drawdown on close
```

Step 3 runs before step 4, so the cooldown value applied to a bar's entry scan is the one
carried in from the previous bar. But an exit in step 5 sets a **fresh** cooldown that
applies immediately: the scan later in the same bar is already blocked, and stays blocked
until the counter is decremented to zero.

### 9.2 Execution and costs

| item | value |
|---|---|
| entry fill | `open_{t+1} × (1 + 0.0005)` |
| entry fee | `0.001 × notional` |
| exit fill (stop / hard stop) | `level × (1 − 0.0005×2.5)`; if the bar gaps through, `open × (1 − 0.0005×2.5)` |
| exit fill (trail-at-next-open, KILL, TIME, end of data) | `price × (1 − 0.0005)` |
| exit fee | `0.001 × qty × fill` |
| PnL | `(qty·fill − exit_fee) − notional` |
| R multiple | `PnL / (qty × (entry_fill − initial_stop))` |

### 9.3 Sizing

```text
stop_dist = entry_fill − initial_stop
mult      = strategyMultiplier(strategy) × regime.riskMult
notional  = min( cash × 0.0075 × mult × entry_fill / stop_dist,
                 cash × 1.0,
                 cash )
qty       = (notional − notional × fee) / entry_fill
cash     -= notional
reject if notional < 10.0
```

`strategyMultiplier`: A = 1.0, C = 0.8. With a 2–3 ATR stop this is roughly 0.75% of
equity at risk per trade before the regime multiplier.

### 9.4 Account protections

| protection | rule |
|---|---|
| drawdown pause | if `cash ≤ peak × 0.90` → no entries for 42 bars; when it expires, `peak ← cash` |
| rolling loss cap | `weekR` = sum of R of trades closed within the last 42 bars; block entries while `weekR ≤ −3.0` |
| cooldown | after every close: `cooldown = min(48, max(floor, 6 × consecutiveLosses))`, `floor` = 12 for STOP/HARD_STOP/KILL, 6 otherwise. `consecutiveLosses` resets on any non-loss |
| degradation (per strategy) | if the last 12 closed trades of that strategy sum to `≤ −6.0 R` → that strategy is ineligible for 180 bars |
| both frozen | if A and C are both frozen, all entries are blocked |
| kill switch | if `atrPctPctl > 0.99`: exit at close − slippage when `rNow < 0.5`; otherwise raise the stop to `close − 1.5·ATR` (never lower it) |

`rNow = (close − entry_fill) / (entry_fill − initial_stop)`.

Equity in this implementation is **realised cash** (no mark-to-market), so the drawdown
pause is measured on closed trades only.

---

## 10. Parameters (locked)

```yaml
data:      { warmup_bars: 200, min_symbols_cross_section: 4, regime_anchor: BTCUSDT }
cost:      { fee: 0.0010, slip: 0.0005, stop_slip_mult: 2.5 }
strategyA: { donchian: 40, ema: 200, volume_mult: 1.2, stop_atr: 3.0, trail_atr: 3.0 }
strategyC: { donchian: 10, ema_rise_lookback: 10, bb_period: 20, bb_std: 2.0,
             compression_lookback: 100, compression_pctile: 0.20,
             volume_mult: 1.5, stop_atr: 2.0, trail_atr: 3.0,
             gate_compression_ratio: 0.8, gate_breakout_margin_atr: 0.1,
             gate_avoid_a_atr: 1.0 }
exits:     { hard_stop_atr: 4.0, max_hold_bars: 180 }
score:     { breakout_cap_atr: 1.0, volume_cap_ratio: 3.0,
             weights_A: { breakout: 0.30, volume: 0.20, efficiency: 0.25, relStrength: 0.25, compression: 0.00 },
             weights_C: { breakout: 0.25, volume: 0.15, efficiency: 0.15, relStrength: 0.20, compression: 0.25 } }
regime:    { bull_enter: 0.60, bull_exit: 0.45, bear_enter: 0.35, bear_exit: 0.50,
             confirm_bars: 2,
             min_score: { BULL: 0.45, NEUTRAL: 0.60, BEAR: 0.80 },
             risk_mult: { BULL: 1.00, NEUTRAL: 0.75, BEAR: 0.50 },
             universe_size_adjust: off, tighten_on_bear: false }
risk:      { risk_per_trade: 0.0075, strategy_mult: { A: 1.0, C: 0.8 },
             max_position_fraction: 1.0, min_notional: 10.0 }
account:   { dd_pause: 0.10, dd_pause_bars: 42, loss_window_bars: 42, loss_floor_r: -3.0,
             cooldown_base: 6, cooldown_stop: 12, cooldown_max: 48, cooldown_step: 6,
             degrade_window: 12, degrade_min_sum_r: -6.0, degrade_bars: 180 }
kill:      { pctl_min: 0.99, r_now_min: 0.5, tighten_atr: 1.5 }
gates:     { stop_min_atr: 2.0, stop_max_atr: 3.0, max_cost_in_r: 0.15,
             min_target_cost_multiple: 4.0 }
```

---

## 11. Pseudocode for the two strategies

```python
def strategy_a(row, cfg):
    if not row.dataOk: return None
    if not (row.close > row.ema200 and row.close > row.donchian40): return None
    if not (row.volume > 1.2 * row.volSma20): return None
    return Entry(stop=row.atr14 * cfg.A.stop_atr,
                 trail=row.atr14 * cfg.A.trail_atr,
                 trail_reference="highest_close",
                 trail_is_intrabar=False)


def strategy_c(row, cfg):
    if not row.dataOk: return None
    thr = row.cWidthThreshold
    if not (row.cBbWidth <= 0.8 * thr):                 return None   # gate 1
    if not (row.close - row.donchian10 >= 0.1 * row.atr14):  return None   # gate 2
    if not (row.donchian40 - row.close >= 1.0 * row.atr14):  return None   # gate 3
    if not (row.ema200 > row.ema200_10_ago):            return None   # ema200 at t-10
    if not (row.close > row.ema200 and row.close > row.donchian10): return None
    if not (row.volume > 1.5 * row.volSma20):           return None
    return Entry(stop=row.atr14 * cfg.C.stop_atr,
                 trail=row.atr14 * cfg.C.trail_atr,
                 trail_reference="highest_high",
                 trail_is_intrabar=True)
```

---

## 12. Reference implementation (Python, complete)

Single file, `pandas` + `numpy` only, no decision tree. Save as `spec_reference.py` and run
with `--data-dir <dir containing 2017_<SYMBOL>_4h.csv>`.

```python
"""Reference implementation of the generalist A + C bot (locked config).

Single file, pandas + numpy only. Mirrors `generalist_prototype/run_v3_proto.py`
with the locked C configuration:

    Strategy A : Donchian-40 breakout, volume > 1.2 x SMA20      (unchanged)
    Strategy C : VCEB compression breakout, volume > 1.5 x SMA20, plus the
                 three quality gates (compression ratio 0.8, breakout margin
                 0.1 ATR, avoid-A 1.0 ATR)

Usage:
    python spec_reference.py --data-dir ../../data
"""
from __future__ import annotations

import argparse
import math
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Optional

import numpy as np
import pandas as pd

BULL, NEUTRAL, BEAR = 2, 1, 0
STATE_NAME = {BULL: "BULL", NEUTRAL: "NEUTRAL", BEAR: "BEAR"}
BAR = pd.Timedelta(hours=4)

# --------------------------------------------------------------------------- 1. parameters
P: Dict[str, Any] = {
    # data
    "warmup_bars": 200,
    "min_symbols_cross_section": 4,
    "regime_anchor": "BTCUSDT",
    # costs
    "fee": 0.0010,           # per side, fraction of notional
    "slip": 0.0005,          # per side, fraction of price
    "stop_slip_mult": 2.5,   # extra slippage multiple on stop fills
    # strategies
    "A": {
        "donchian": 40,
        "ema": 200,
        "volume_mult": 1.2,
        "stop_atr": 3.0,
        "trail_atr": 3.0,
    },
    "C": {
        "donchian": 10,
        "ema_rise_lookback": 10,
        "bb_period": 20,
        "bb_std": 2.0,
        "compression_lookback": 100,
        "compression_pctile": 0.20,
        "volume_mult": 1.5,
        "stop_atr": 2.0,
        "trail_atr": 3.0,
        # locked quality gates
        "gate_compression_ratio": 0.8,
        "gate_breakout_margin_atr": 0.1,
        "gate_avoid_a_atr": 1.0,
    },
    "hard_stop_atr": 4.0,
    "max_hold_bars": 180,
    # score
    "score": {
        "breakout_cap_atr": 1.0,
        "volume_cap_ratio": 3.0,
        "weights": {
            "A": {"breakout": 0.30, "volume": 0.20, "efficiency": 0.25,
                  "relStrength": 0.25, "compression": 0.00},
            "C": {"breakout": 0.25, "volume": 0.15, "efficiency": 0.15,
                  "relStrength": 0.20, "compression": 0.25},
        },
    },
    # regime
    "regime": {
        "bull_enter": 0.60, "bull_exit": 0.45,
        "bear_enter": 0.35, "bear_exit": 0.50,
        "confirm_bars": 2,
        "table": {
            "BULL": {"allow_entries": 1, "min_score": 0.45, "risk_mult": 1.0},
            "NEUTRAL": {"allow_entries": 1, "min_score": 0.60, "risk_mult": 0.75},
            "BEAR": {"allow_entries": 1, "min_score": 0.80, "risk_mult": 0.50},
        },
        "universe_size_adjust": {"enabled": False, "reference": 4,
                                 "add_per_doubling": 0.05, "max_add": 0.15},
        "tighten_on_bear": False,
        "tighten_atr_mult": 1.5,
    },
    # portfolio
    "max_positions": 1,
    "risk_per_trade": 0.0075,
    "strategy_mult": {"A": 1.0, "C": 0.8},
    "max_position_fraction": 1.0,
    "min_notional": 10.0,
    # account protections
    "dd_pause": 0.10,
    "dd_pause_bars": 42,
    "loss_window_bars": 42,
    "loss_floor_r": -3.0,
    "cooldown_base": 6,
    "cooldown_stop": 12,
    "cooldown_max": 48,
    "cooldown_step": 6,
    "degrade_window": 12,
    "degrade_min_sum_r": -6.0,
    "degrade_bars": 180,
    # exits
    "kill": {"pctl_min": 0.99, "r_now_min": 0.5, "tighten_atr": 1.5},
    "gates": {"stop_min_atr": 2.0, "stop_max_atr": 3.0},
    "max_cost_in_r": 0.15,
    "min_target_cost_multiple": 4.0,
}


# --------------------------------------------------------------------------- 2. features
def wilder(x: pd.Series, n: int) -> pd.Series:
    return x.ewm(alpha=1.0 / n, adjust=False, min_periods=n).mean()


def kaufman_er(close: np.ndarray, window: int = 20) -> np.ndarray:
    """Kaufman efficiency ratio: |net move| / sum|bar moves| over `window`."""
    n = len(close)
    er = np.full(n, np.nan)
    if n <= window:
        return er
    view = np.lib.stride_tricks.sliding_window_view(close, window + 1)
    finite = np.isfinite(view).all(axis=1)
    denom = np.abs(np.diff(view, axis=1)).sum(axis=1)
    net = view[:, -1] - view[:, 0]
    ok = finite & (denom > 0.0)
    er[window:][ok] = np.abs(net[ok]) / denom[ok]
    return er


def atr_pct_rank(atr: np.ndarray, window: int = 300) -> np.ndarray:
    """Share of the prior `window` ATR values that are <= today's ATR."""
    out = np.full(len(atr), np.nan)
    for i in range(window + 1, len(atr)):
        prior = atr[i - window:i]
        fin = np.isfinite(prior)
        if fin.any():
            out[i] = float((prior[fin] <= atr[i]).sum()) / float(fin.sum())
    return out


def build_features(df: pd.DataFrame, p: Dict[str, Any] = P) -> pd.DataFrame:
    """All indicators and signals for one symbol. Index = bar open time, UTC."""
    c = df["close"].astype(float)
    o = df["open"].astype(float)
    h = df["high"].astype(float)
    l = df["low"].astype(float)
    v = df["volume"].astype(float)
    f = pd.DataFrame(index=df.index)
    f["open"], f["high"], f["low"], f["close"], f["volume"] = o, h, l, c, v

    f["ema200"] = c.ewm(span=p["A"]["ema"], adjust=False,
                        min_periods=p["A"]["ema"]).mean()
    prev_c = c.shift(1)
    tr = pd.concat([h - l, (h - prev_c).abs(), (l - prev_c).abs()], axis=1).max(axis=1)
    f["atr14"] = wilder(tr, 14)
    f["atrPct"] = f["atr14"] / c

    f["donchian40"] = h.shift(1).rolling(p["A"]["donchian"]).max()
    f["donchian10"] = h.shift(1).rolling(p["C"]["donchian"]).max()
    f["volSma20"] = v.rolling(20).mean()
    f["volRatio"] = v / f["volSma20"]

    mid = c.rolling(p["C"]["bb_period"]).mean()
    sd = c.rolling(p["C"]["bb_period"]).std(ddof=0)   # population std
    f["cBbWidth"] = (2.0 * p["C"]["bb_std"] * sd) / mid
    f["cWidthThreshold"] = (f["cBbWidth"].shift(1)
                            .rolling(p["C"]["compression_lookback"])
                            .quantile(p["C"]["compression_pctile"]))

    f["persistenceEr"] = kaufman_er(c.to_numpy(float), 20)
    f["relReturn"] = c / c.shift(60) - 1.0
    f["atrPctPctl"] = atr_pct_rank(f["atr14"].to_numpy(float))
    f["volumeUsdMedian"] = (v * c).rolling(180).median()

    # ---- signals -----------------------------------------------------------
    a = p["A"]
    sig_a = ((c > f["ema200"]) & (c > f["donchian40"])
             & (v > a["volume_mult"] * f["volSma20"]))

    cc = p["C"]
    rise = f["ema200"] > f["ema200"].shift(cc["ema_rise_lookback"])
    compression = f["cBbWidth"] <= cc["gate_compression_ratio"] * f["cWidthThreshold"]
    margin = (c - f["donchian10"]) >= cc["gate_breakout_margin_atr"] * f["atr14"]
    avoid_a = (f["donchian40"] - c) >= cc["gate_avoid_a_atr"] * f["atr14"]
    sig_c = (compression & rise & (c > f["ema200"]) & (c > f["donchian10"])
             & (v > cc["volume_mult"] * f["volSma20"]) & margin & avoid_a)

    need = ["ema200", "atr14", "donchian40", "donchian10", "volSma20",
            "volRatio", "cBbWidth", "cWidthThreshold", "persistenceEr",
            "relReturn"]
    finite = f[need].notna().all(axis=1)
    ts = pd.Series(f.index, index=f.index)
    contiguous = (((ts.diff() == BAR) & (ts.diff(2) == 2 * BAR))
                  .fillna(False).astype(bool))
    bars_owned = pd.Series(np.isfinite(c.to_numpy()), index=f.index).cumsum()
    f["dataOk"] = ((bars_owned >= p["warmup_bars"]) & contiguous & finite).astype(int)

    f["signalA"] = (sig_a & (f["dataOk"] == 1)).astype(int)
    f["signalC"] = (sig_c & (f["dataOk"] == 1)).astype(int)
    return f


# --------------------------------------------------------------------------- 3. score + pick
def clip01(x: float) -> float:
    return 0.0 if not np.isfinite(x) else max(0.0, min(1.0, float(x)))


def score_strategy(strategy: str, row: pd.Series, rs_pct: float,
                   p: Dict[str, Any] = P) -> float:
    channel = row["donchian40"] if strategy == "A" else row["donchian10"]
    breakout_atr = (row["close"] - channel) / row["atr14"]
    s = p["score"]
    comp = {
        "breakout": clip01(breakout_atr / s["breakout_cap_atr"]),
        "volume": clip01((row["volRatio"] - 1.0) / (s["volume_cap_ratio"] - 1.0)),
        "efficiency": clip01(row["persistenceEr"]),
        "relStrength": clip01(rs_pct),
        "compression": clip01(1.0 - row["cBbWidth"] / row["cWidthThreshold"]),
    }
    w = s["weights"][strategy]
    return sum(w[k] * comp[k] for k in w) / sum(w.values())


def effective_min_score(state: int, universe_size: int,
                        p: Dict[str, Any] = P) -> float:
    base = p["regime"]["table"][STATE_NAME[state]]["min_score"]
    adj = p["regime"]["universe_size_adjust"]
    if adj["enabled"] and universe_size > adj["reference"]:
        base += min(adj["max_add"],
                    adj["add_per_doubling"] * math.log2(universe_size / adj["reference"]))
    return min(1.0, base)


def make_pick(row: pd.Series, rs_pct: float, min_score: float,
              degraded: Dict[str, bool], p: Dict[str, Any] = P) -> Optional[dict]:
    """Best eligible strategy for one symbol, or None."""
    cand: Dict[str, dict] = {}
    for s, key, ch in (("A", "signalA", "donchian40"),
                       ("C", "signalC", "donchian10")):
        signal = int(row[key])
        sc = score_strategy(s, row, rs_pct, p) if signal else 0.0
        cand[s] = {"signal": signal, "score": sc,
                   "eligible": bool(signal) and not degraded[s] and sc >= min_score}
    if not (cand["A"]["eligible"] or cand["C"]["eligible"]):
        return None
    if cand["A"]["eligible"] and (not cand["C"]["eligible"]
                                 or cand["A"]["score"] >= cand["C"]["score"]):
        s = "A"
    else:
        s = "C"
    stop_atr = p[s]["stop_atr"]
    round_trip = 2 * p["fee"] + p["slip"] * (1 + p["stop_slip_mult"])
    cost_in_r = round_trip / stop_atr
    return {"strategy": s, "score": cand[s]["score"], "stop_atr": stop_atr,
            "stop_distance_atr": stop_atr, "cost_in_r": cost_in_r,
            "target_cost_multiple": 1.0 / cost_in_r}


# --------------------------------------------------------------------------- 4. regime
class Regime:
    def __init__(self, p: Dict[str, Any] = P):
        self.full = p
        self.p = p["regime"]
        self.state = NEUTRAL
        self.pending: Optional[int] = None
        self.count = 0

    def target(self, btc_above: bool, breadth: float) -> int:
        p, cur = self.p, self.state
        if cur == BULL:
            if btc_above and breadth >= p["bull_exit"]:
                return BULL
            return BEAR if (not btc_above and breadth <= p["bear_enter"]) else NEUTRAL
        if cur == BEAR:
            if not btc_above and breadth < p["bear_exit"]:
                return BEAR
            return BULL if (btc_above and breadth >= p["bull_enter"]) else NEUTRAL
        if btc_above and breadth >= p["bull_enter"]:
            return BULL
        if not btc_above and breadth <= p["bear_enter"]:
            return BEAR
        return NEUTRAL

    def update(self, btc_above: bool, breadth: float) -> int:
        t = self.target(btc_above, breadth)
        if t == self.state:
            self.pending, self.count = None, 0
        else:
            self.count = self.count + 1 if t == self.pending else 1
            self.pending = t
            if self.count >= self.p["confirm_bars"]:
                self.state, self.pending, self.count = t, None, 0
        return self.state

    def row(self, universe_size: int) -> dict:
        t = self.p["table"][STATE_NAME[self.state]]
        return {"allow_entries": t["allow_entries"],
                "min_score": effective_min_score(self.state, universe_size, {"regime": self.p, "score": P["score"]}),
                "risk_mult": t["risk_mult"],
                "tighten_signal": int(bool(self.p["tighten_on_bear"]) and self.state == BEAR)}


# --------------------------------------------------------------------------- 5. portfolio engine
@dataclass
class Position:
    symbol: str
    strategy: str
    entry_ts: pd.Timestamp
    entry_fill: float
    qty: float
    notional: float
    initial_stop: float
    stop: float
    hard_stop: float
    highest_close: float
    highest_high: float
    ratcheted: bool
    bars_held: int
    risk_usdt: float


@dataclass
class State:
    cash: float
    peak: float
    position: Optional[Position] = None
    pending: Optional[dict] = None
    pause_until: Optional[int] = None
    cooldown: int = 0
    consecutive_losses: int = 0
    frozen_until: Dict[str, int] = field(default_factory=lambda: {"A": -10**9, "C": -10**9})
    r_history: Dict[str, List[float]] = field(default_factory=lambda: {"A": [], "C": []})
    closed: List[dict] = field(default_factory=list)


def simulate(feats: Dict[str, pd.DataFrame], symbols: List[str],
             p: Dict[str, Any] = P, capital: float = 10_000.0,
             start: Optional[pd.Timestamp] = None,
             end: Optional[pd.Timestamp] = None) -> dict:
    index = sorted(set().union(*[set(f.index) for f in feats.values()]))
    if start is not None:
        index = [t for t in index if t >= start]
    if end is not None:
        index = [t for t in index if t <= end]
    bar_no = {t: i for i, t in enumerate(index)}
    st = State(cash=capital, peak=capital)
    regime = Regime(p)

    def loc(symbol: str, t: pd.Timestamp) -> Optional[pd.Series]:
        f = feats[symbol]
        if t not in f.index:
            return None
        return f.loc[t]

    def cooldown_bars(reason: str, losses: int) -> int:
        floor = p["cooldown_stop"] if reason in ("STOP", "HARD_STOP", "KILL") else p["cooldown_base"]
        return min(p["cooldown_max"], max(floor, p["cooldown_step"] * losses))

    def close_position(i: int, t: pd.Timestamp, fill: float, reason: str) -> None:
        pos = st.position
        assert pos is not None
        gross = pos.qty * fill
        cash_in = gross - gross * p["fee"]
        st.cash += cash_in
        pnl = cash_in - pos.notional
        r = pnl / pos.risk_usdt if pos.risk_usdt > 0 else 0.0
        st.closed.append({"symbol": pos.symbol, "strategy": pos.strategy,
                          "exit_bar": i, "entry_ts": pos.entry_ts, "exit_ts": t,
                          "bars_held": pos.bars_held, "entry_price": pos.entry_fill,
                          "exit_price": fill, "qty": pos.qty, "notional": pos.notional,
                          "pnl_usdt": pnl, "r_multiple": r, "reason": reason})
        if reason != "OPEN_AT_END":
            st.consecutive_losses = st.consecutive_losses + 1 if r < 0 else 0
            st.cooldown = cooldown_bars(reason, st.consecutive_losses)
            st.r_history[pos.strategy].append(r)
            hist = st.r_history[pos.strategy][-p["degrade_window"]:]
            if len(hist) >= p["degrade_window"] and sum(hist) <= p["degrade_min_sum_r"]:
                st.frozen_until[pos.strategy] = max(st.frozen_until[pos.strategy],
                                                    i + p["degrade_bars"])
            if st.cash > st.peak:
                st.peak = st.cash
            elif st.cash <= st.peak * (1.0 - p["dd_pause"]):
                st.pause_until = i + p["dd_pause_bars"]
        st.position = None

    def fill_pending(i: int, t: pd.Timestamp) -> None:
        pend = st.pending
        assert pend is not None
        st.pending = None
        row = loc(pend["symbol"], t)
        if row is None or not np.isfinite(row["open"]) or row["open"] <= 0:
            return
        fill = float(row["open"]) * (1.0 + p["slip"])
        stop = fill - pend["stop_atr"] * pend["atr"]
        hard = fill - p["hard_stop_atr"] * pend["atr"]
        stop_dist = fill - stop
        if stop_dist <= 0 or st.cash <= 0:
            return
        notional = min(st.cash * p["risk_per_trade"] * pend["risk_mult"] * fill / stop_dist,
                       st.cash * p["max_position_fraction"], st.cash)
        if notional < p["min_notional"]:
            return
        qty = (notional - notional * p["fee"]) / fill
        st.cash -= notional
        st.position = Position(
            symbol=pend["symbol"], strategy=pend["strategy"], entry_ts=t,
            entry_fill=fill, qty=qty, notional=notional,
            initial_stop=stop, stop=stop, hard_stop=hard,
            highest_close=float(row["close"]), highest_high=float(row["high"]),
            ratcheted=False, bars_held=1, risk_usdt=qty * stop_dist)

    def manage(i: int, t: pd.Timestamp) -> None:
        pos = st.position
        assert pos is not None
        row = loc(pos.symbol, t)
        if row is None or row["dataOk"] != 1:
            pos.bars_held += 1
            return
        o, h, l, c = (float(row[k]) for k in ("open", "high", "low", "close"))
        atr = float(row["atr14"])
        slip_stop = p["slip"] * p["stop_slip_mult"]

        # 1. resting intrabar stops (C trail, both hard stops)
        if pos.strategy == "C" and l <= pos.stop:
            raw = o if o <= pos.stop else pos.stop
            close_position(i, t, raw * (1.0 - slip_stop),
                           "TRAIL" if pos.ratcheted else "STOP")
            return
        if l <= pos.hard_stop:
            raw = o if o <= pos.hard_stop else pos.hard_stop
            close_position(i, t, raw * (1.0 - slip_stop), "HARD_STOP")
            return

        # 2. ratchet the trail from this bar's close/high
        if pos.strategy == "A":
            pos.highest_close = max(pos.highest_close, c)
            cand = pos.highest_close - p["A"]["trail_atr"] * atr
            if np.isfinite(cand):
                pos.stop = max(pos.stop, cand)
            trail_signal = c < pos.stop
        else:
            pos.highest_high = max(pos.highest_high, h)
            cand = pos.highest_high - p["C"]["trail_atr"] * atr
            if np.isfinite(cand) and cand > pos.stop:
                pos.stop = cand
                pos.ratcheted = True
            trail_signal = False

        # 3. kill switch, time cap, regime tightening, trail exit
        r_now = (c - pos.entry_fill) / (pos.entry_fill - pos.initial_stop)
        pctl = float(row["atrPctPctl"])
        if np.isfinite(pctl) and pctl > p["kill"]["pctl_min"]:
            if r_now < p["kill"]["r_now_min"]:
                close_position(i, t, c * (1.0 - p["slip"]), "KILL")
                return
            kill_stop = c - p["kill"]["tighten_atr"] * atr
            if np.isfinite(kill_stop) and kill_stop > pos.stop:
                pos.stop = kill_stop
        if pos.bars_held >= p["max_hold_bars"]:
            close_position(i, t, c * (1.0 - p["slip"]), "TIME")
            return
        if p["regime"]["tighten_on_bear"] and regime.state == BEAR:
            reg_stop = c - p["regime"]["tighten_atr_mult"] * atr
            if np.isfinite(reg_stop) and reg_stop > pos.stop:
                pos.stop = reg_stop
        if trail_signal:
            st.pending = {"kind": "exit", "symbol": pos.symbol}
            return
        pos.bars_held += 1

    for i, t in enumerate(index):
        # ---- rows available on this bar
        rows = {s: loc(s, t) for s in symbols}
        live = {s: r for s, r in rows.items() if r is not None and r["dataOk"] == 1}
        n_live = len(live)

        # ---- regime (every bar, in or out of a position)
        if n_live >= p["min_symbols_cross_section"]:
            anchor = rows.get(p["regime_anchor"])
            if anchor is not None and anchor["dataOk"] == 1:
                breadth = float(np.mean([r["close"] > r["ema200"] for r in live.values()]))
                regime.update(bool(anchor["close"] > anchor["ema200"]), breadth)

        if st.pause_until is not None and i >= st.pause_until:
            st.pause_until = None
            st.peak = st.cash
        if st.cooldown > 0:
            st.cooldown -= 1

        # ---- resolve the pending order at this bar's open
        if st.pending is not None:
            if st.pending["kind"] == "entry":
                fill_pending(i, t)
            else:
                row = loc(st.pending["symbol"], t)
                if row is not None and np.isfinite(row["open"]) and st.position is not None:
                    close_position(i, t, float(row["open"]) * (1.0 - p["slip"]), "TRAIL")
                st.pending = None

        # ---- manage the open position on its own symbol
        if st.position is not None:
            manage(i, t)

        # ---- otherwise scan for entries
        if st.position is not None or st.pending is not None:
            continue
        blocked = (st.pause_until is not None
                   or st.cooldown > 0
                   or sum(r for _, r in _window(st.closed, i, p["loss_window_bars"])) <= p["loss_floor_r"]
                   or all(st.frozen_until[s] > i for s in ("A", "C")))
        if blocked:
            continue

        reg = regime.row(n_live)
        if not reg["allow_entries"]:
            continue

        rs = cross_section({s: float(r["relReturn"]) for s, r in live.items()})
        degraded = {s: st.frozen_until[s] > i for s in ("A", "C")}
        best = None
        for s, r in live.items():
            pick = make_pick(r, rs[s], reg["min_score"], degraded, p)
            if pick is None:
                continue
            if not (p["gates"]["stop_min_atr"] <= pick["stop_distance_atr"] <= p["gates"]["stop_max_atr"]):
                continue
            if not (pick["cost_in_r"] <= p["max_cost_in_r"]):
                continue
            if not (pick["target_cost_multiple"] >= p["min_target_cost_multiple"]):
                continue
            cand = {"symbol": s, "score": pick["score"], "strategy": pick["strategy"],
                    "atr": float(r["atr14"]), "stop_atr": pick["stop_atr"],
                    "risk_mult": p["strategy_mult"][pick["strategy"]] * reg["risk_mult"],
                    "volumeUsdMedian": float(r["volumeUsdMedian"])}
            if best is None or (-cand["score"], -cand["volumeUsdMedian"], s) < \
                    (-best["score"], -best["volumeUsdMedian"], best["symbol"]):
                best = cand
        if best is not None:
            st.pending = {"kind": "entry", **best}

    # ---- close anything left at the end
    if st.position is not None and index:
        last = index[-1]
        row = loc(st.position.symbol, last)
        if row is not None:
            close_position(len(index) - 1, last,
                           float(row["close"]) * (1.0 - p["slip"]), "OPEN_AT_END")

    return {"trades": pd.DataFrame(st.closed), "cash": st.cash}


def _window(closed: List[dict], i: int, window: int):
    """(exit_bar, R) for trades closed inside the last `window` bars."""
    return [(tr["exit_bar"], tr["r_multiple"])
            for tr in closed if tr["exit_bar"] > i - window]


def cross_section(rel_returns: Dict[str, float]) -> Dict[str, float]:
    vals = {k: v for k, v in rel_returns.items() if np.isfinite(v)}
    n = len(vals)
    if n < 2:
        return {k: 0.5 for k in rel_returns}
    return {k: (sum(1 for o in vals.values() if o <= v) - 1) / (n - 1)
            for k, v in rel_returns.items()}


# --------------------------------------------------------------------------- 6. CLI
def load(data_dir: Path, symbol: str) -> pd.DataFrame:
    df = pd.read_csv(data_dir / f"2017_{symbol}_4h.csv")
    df["timestamp"] = pd.to_datetime(df["timestamp"])
    return (df.set_index("timestamp").sort_index()
            .loc[lambda d: ~d.index.duplicated(keep="last")])


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--data-dir", default=str(Path(__file__).resolve().parent.parent / "data"))
    ap.add_argument("--symbols", nargs="+",
                    default=["BTCUSDT", "ETHUSDT", "BNBUSDT", "SOLUSDT"])
    ap.add_argument("--capital", type=float, default=10_000.0)
    args = ap.parse_args()

    data_dir = Path(args.data_dir)
    feats = {s: build_features(load(data_dir, s)) for s in args.symbols}
    start = max(f.index[0] for f in feats.values())
    end = min(f.index[-1] for f in feats.values())
    out = simulate(feats, args.symbols, P, args.capital, start, end)
    tr = out["trades"]

    print(f"window {start} -> {end}")
    print(f"signals A/C: "
          + ", ".join(f"{s}={int(f['signalA'].sum())}/{int(f['signalC'].sum())}"
                      for s, f in feats.items()))
    if len(tr):
        r = tr["r_multiple"]
        print(f"trades {len(tr)}  PnL {100*(out['cash']/args.capital-1):+.2f}%  "
              f"total R {r.sum():+.2f}  avg R {r.mean():+.3f}  "
              f"win {100*(r>0).mean():.1f}%")
        print(tr.groupby(["strategy"])["r_multiple"]
              .agg(["count", "sum", "mean"]).round(3).to_string())
    else:
        print("no trades")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
```

---

## 13. Validation

Parity test against the production runner with the §2 code patch applied
(`generalist_prototype/run_v3_proto.py`, `proto` variant, 2020-08-11 → 2026-11-03, 13,655 bars):

| check | result |
|---|---|
| trades | 142 vs 142 |
| matching (symbol, strategy, entry ts, exit ts, reason) | **142 / 142** |
| max |ΔR| per trade | **2·10⁻¹⁵** |
| PnL | +40.57% both |
| total R | +50.91 both |
| A leg | 138 trades, +54.76 R both |
| C leg | 4 trades, −3.84 R both |

Signal counts with the lock (4 symbols, full history; the run window starts 2020-08, so the
in-window totals are lower):

| symbol | signalA bars | signalC bars |
|---|---|---|
| BTCUSDT | 534 | 13 |
| ETHUSDT | 524 | 11 |
| BNBUSDT | 529 | 12 |
| SOLUSDT | 370 | 8 |
| **in-window total** | **1465** | **33** |

---

## 14. Measured effect of the lock on this bot

`generalist_prototype/run_v3_proto.py` runs two variants. Both are reported because the
sign of the change flips between them — the reason is slot path dependence, not selection.

| variant | config | trades | PnL % | total R | max DD % | A trades / R | C trades / R |
|---|---|---|---|---|---|---|---|
| `proto` (regime + score on) | stock (C 1.2, ungated) | 145 | +48.62 | 61.33 | −7.11 | 133 / +51.56 | 12 / +9.77 |
| `proto` | **locked** | 142 | **+40.57** | **50.91** | −7.43 | 138 / +54.76 | **4 / −3.84** |
| `baseline_equivalent` (minScore 0) | stock | 189 | +51.03 | 58.95 | −9.28 | 149 / +54.53 | 40 / +4.42 |
| `baseline_equivalent` | **locked** | 169 | **+58.05** | **62.58** | −8.84 | 155 / +68.71 | 14 / −6.13 |

What happened:

- Signal supply collapses: C signal-bars fall from 279 to 33 across the four symbols
  (episodes 259 → 32). The gate does not "improve" C so much as **almost remove it**.
- C's own leg turns negative in both variants (12 → 4 trades, +9.77 → −3.84 R; and
  40 → 14, +4.42 → −6.13 R). With 4 and 14 trades these are not measurable edges.
- A's leg changes because C no longer occupies the slot: +51.56 → +54.76 R in `proto`,
  +54.53 → +68.71 R in `baseline_equivalent`. That is path dependence — the same A rules
  taking different trades — not an A improvement.

So on this bot: −10.4 R in `proto`, +3.6 R in `baseline_equivalent`, drawdown roughly
unchanged. The independent-slot lab evidence that motivated the lock does **not** transfer
automatically to a one-slot book.

**Practical reading:** the lock is defensible as "make C rare and high-conviction", not as
"this raises PnL on the generalist bot". If C's contribution matters, the honest options
are (a) keep the lock and give C the 0.8 risk multiplier (current), accepting it is a small
satellite; (b) leave C ungated in the one-slot bot, where the point estimate is ~+4 to
+10 R; (c) give C its own slot, which is the configuration the lab validated. Do not
conclude anything from the 4-trade C leg.

---

## 15. Porting checklist

Things that silently break parity if you get them wrong:

1. **`adjust=False` EMAs.** `E_0 = C_0` and then recurse; do not seed with an SMA. For
   ATR the reference also seeds from the first TR. Textbook Wilder (SMA-seeded) ATR
   converges to the same values within ~100 bars, and `dataOk` hides the difference
   (200-bar warm-up), but do not switch seeds mid-series.
2. **Donchian excludes the current bar**: `max(high[t−N … t−1])`. Using `t−N+1 … t` is a
   different strategy.
3. **`volSma20` includes the current bar**; `cWidthThreshold` excludes it (shifted).
4. **Population std (`ddof=0`)** in the Bollinger width, and width defined as
   `(upper−lower)/mid = 4σ/mid`.
5. **Percentile method.** `cWidthThreshold` is pandas' `quantile(0.2)` (linear
   interpolation) over 100 values — i.e. index 19.8. Nearest-rank or lower-interpolation
   variants shift a handful of gate decisions.
6. **Comparisons are strict** where written (`>` for A's price and volume conditions,
   `≥` for the C gates and score thresholds).
7. **Fail closed:** any NaN in a comparison makes the condition false. Never treat NaN as
   "pass".
8. **`dataOk` requires the *current* bar's features to be finite** — so the first 200
   bars per symbol are never tradeable, and a data gap resets readiness for two bars.
9. **A's 3-ATR stop is close-based; C's is intrabar.** Placing A's stop as a resting
   order changes the strategy.
10. **Ratchet after the stop check** — the stop set on bar `t` only protects from `t+1`.
11. **Slippage asymmetry:** stops pay `slip × 2.5`; entries and close-based exits pay
    `slip × 1`.
12. **R denominator** uses the *initial* stop distance and the *entry fill*, not the
    current stop.
13. **Management runs before the entry scan**, so the position is technically free on the
    bar it closes. In practice every close also sets a cooldown of at least 6 bars
    (12 after a stop-family exit), so entries resume ≥6 bars later. Do not add a further
    bar of delay on top of that.
14. **One pending order at a time**, filled at the next available bar for that symbol.

---

## 16. Known deviations and open questions

- **ETH persistence gate:** production v1.2 applied `persistenceEr ≥ 0.30` as a hard gate
  on ETH only. This bot uses ER as a *score component* for everyone. That is a deliberate
  v3 change, not an oversight.
- **Per-asset C modes:** production disables C on BTC and gates it on ETH. The bot applies
  one C configuration to the whole universe.
- **Equity is realised cash**, so the 10% drawdown pause reacts later than a
  mark-to-market version would.
- **`cWidthThreshold` warm-up:** 120 bars after the Bollinger warm-up; before that
  `dataOk` is 0 anyway (200-bar rule), so this never binds.
- **`atrPctPctl` costs 300 iterations per symbol per bar** in the reference; precompute it
  vectorised in a production port.
- **Universe is fixed to four symbols in the reference.** The v3 tree supports a dynamic
  universe with liquidity filters and periodic rebalancing; that machinery is orthogonal
  to the strategies and is not specified here.
- **The regime freezes when fewer than 4 symbols have `dataOk == 1`** on a bar
  (`minSymbolsForCrossSection = 4`). With a four-symbol universe, one symbol's data gap
  stops regime updates until it recovers. Keep the last state; do not reset to NEUTRAL.
- **The score, the regime thresholds and `minScore` have never been calibrated.** They are
  phase-1 guesses in the source tree. The A/C signal definitions are the validated part.

---

## 17. Appendix — mapping the decision tree to this document

The tree in `decision_tree_v3_proto.json` is equivalent to the code above, node by node:

| tree node | code equivalent |
|---|---|
| `r_data` | `if not dataOk: NO_TRADE("data_not_ready")` |
| `r_pending` | `if pending is not None: HOLD` |
| `r_pos` | `if position is not None: manage(...)` |
| `x_stop`, `x_hard_stop` | §6 step 1–2 (the runner resolves these intrabar *before* walking) |
| `x_kill_vol`, `x_kill_r`, `x_kill_tighten` | §9.4 kill switch |
| `x_time_cap` | `barsHeld ≥ 180` |
| `x_regime`, `x_regime_stop` | `tighten_on_bear` (disabled) |
| `x_trail` | A: `close < stop` → exit next open; C: handled as a resting order |
| `e_pause` | `pause_until is not None` |
| `e_weekly` | `weekR ≤ −3.0` |
| `e_cooldown` | `cooldown > 0` |
| `e_degrade` | both strategies frozen |
| `e_regime` | `allowEntries == 0` |
| `e_pick` | `pick is None` |
| `e_stop_band`, `e_cost`, `e_edge` | §7.2 sanity gates |
| `a_enter` | `pending = {kind: "entry", ...}` |

Change log:

| version | change |
|---|---|
| v3.0-proto | one shared slot, cross-symbol selection, regime, score; C ungated at 1.2× |
| **this spec** | **C gated (0.8 / 0.1 ATR / 1.0 ATR) and 1.5× volume; A unchanged at 1.2×** |
