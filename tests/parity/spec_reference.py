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
