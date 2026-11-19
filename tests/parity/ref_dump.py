"""Run the spec reference implementation and dump its trades as JSON."""
import json, sys
from pathlib import Path
import pandas as pd
sys.path.insert(0, str(Path(__file__).parent))
import spec_reference as R

data_dir, symbols, out = Path(sys.argv[1]), sys.argv[2].split(","), sys.argv[3]
import os
if os.environ.get("PARITY_LOOSE_C"):  # stress mode: open C's gates so its stop/trail/hard-stop paths get exercised
    R.P["C"].update(gate_compression_ratio=1.0, gate_breakout_margin_atr=0.0, gate_avoid_a_atr=-1000.0, volume_mult=1.2)
if os.environ.get("PARITY_ONLY_C"):  # switch A off (volume never satisfied) so the slot is C's
    R.P["A"]["volume_mult"] = 1e12
feats = {s: R.build_features(R.load(data_dir, s)) for s in symbols}
start = max(f.index[0] for f in feats.values()); end = min(f.index[-1] for f in feats.values())
res = R.simulate(feats, symbols, R.P, 10_000.0, start, end)
tr = res["trades"]
rows = [] if not len(tr) else [{"symbol": r.symbol, "strategy": r.strategy, "entry": int(r.entry_ts.value // 10**6), "exit": int(r.exit_ts.value // 10**6),
         "reason": r.reason, "r": float(r.r_multiple), "pnl": float(r.pnl_usdt), "entryPrice": float(r.entry_price), "exitPrice": float(r.exit_price)} for r in tr.itertuples()]
json.dump({"trades": rows, "cash": res["cash"], "signals": {s: [int(f.signalA.sum()), int(f.signalC.sum())] for s, f in feats.items()}}, open(out, "w"))
