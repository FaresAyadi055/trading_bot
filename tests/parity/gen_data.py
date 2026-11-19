"""Synthetic 4h OHLCV with regimes, volatility compression/expansion and volume bursts (deterministic)."""
import sys
from pathlib import Path
import numpy as np, pandas as pd

def gen(seed: int, n: int, drift_bias: float, gap_at=None):
    rng = np.random.default_rng(seed)
    t0 = pd.Timestamp("2020-01-01", tz="UTC")
    ts = [t0 + pd.Timedelta(hours=4 * i) for i in range(n)]
    regime = np.zeros(n)
    i = 0
    while i < n:
        L = int(rng.integers(60, 260)); regime[i:i + L] = rng.choice([-0.0015, 0.0, 0.0012, 0.003]) + drift_bias; i += L
    vol = np.zeros(n); i = 0
    while i < n:
        L = int(rng.integers(15, 90)); vol[i:i + L] = rng.choice([0.0025, 0.006, 0.012, 0.02]); i += L
    price = 100.0; rows = []
    for k in range(n):
        o = price
        r = regime[k] + vol[k] * rng.standard_normal()
        c = max(0.01, o * (1 + r))
        hi = max(o, c) * (1 + abs(rng.standard_normal()) * vol[k] * 0.6)
        lo = min(o, c) * (1 - abs(rng.standard_normal()) * vol[k] * 0.6)
        v = 1000 * (1 + 0.3 * rng.standard_normal() ** 2) * (3.5 if rng.random() < 0.06 else 1.0) * (1 + 40 * vol[k])
        rows.append((ts[k], o, hi, lo, c, v)); price = c
    df = pd.DataFrame(rows, columns=["timestamp", "open", "high", "low", "close", "volume"])
    if gap_at is not None:
        df = df.drop(index=range(gap_at, gap_at + 3)).reset_index(drop=True)
    return df

if __name__ == "__main__":
    out = Path(sys.argv[1]); out.mkdir(parents=True, exist_ok=True)
    n = int(sys.argv[2]) if len(sys.argv) > 2 else 6000
    for j, (sym, bias, gap) in enumerate([("BTCUSDT", 0.0004, None), ("ETHUSDT", 0.0003, None), ("BNBUSDT", 0.0002, 2500), ("SOLUSDT", 0.0006, None), ("ADAUSDT", 0.0001, None)]):
        gen(int(__import__("os").environ.get("SEED", "100")) + j, n, bias, gap).to_csv(out / f"2017_{sym}_4h.csv", index=False)
