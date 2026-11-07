# AGENTS.md — project status, architecture and remaining tasks

Read `README.md` first (the spec). This file tracks what is built, the decisions taken where the spec was
silent, and what is left. Keep it current when you change anything.

## Commands
```sh
bun install
cp .env.example .env     # set ACCESS_TOKEN (and optionally Telegram)
bun run dev              # http://localhost:3000/bot  (hot reload; dashboard also at /bot/dashboard)
bun test                 # unit + lifecycle tests (in-memory sqlite)
bun run smoke            # end-to-end: app + worker against a mock Binance server
```

## Architecture
| Piece | File | Role |
|---|---|---|
| Hono app | `src/index.ts` | Auth, REST API, streams `public/index.html`; starts the worker. No in-memory caches. |
| Worker | `src/worker.ts` | Only code calling Binance REST (`/api/v3/klines`, 4h). One timer, wakes ~5s after each 4h boundary, retries if the newest candle is not visible yet. Posts closed candles to the main thread. |
| Runner | `src/runner.ts` | On `cycleDone`: upsert candles (rolling window), compute features once per symbol, evaluate every active bot per unprocessed closed bar, persist atomically per bar. Also the crash catch-up path (same code). |
| Features | `src/features.ts`, `src/indicators.ts` | EMA200, Wilder ATR14, Donchian 40/10 (shifted), BB(20,2) width + shifted 20th pct over 100 bars, Kaufman ER-20, ATR percentile, A/C candidate features and cost estimates. |
| Tree | `src/tree.ts` | Validates `bot/decision_tree.json` with the zod schema at boot (fail closed) and interprets it (`@param` refs, `between`, NaN ⇒ branch `no`). |
| Engine | `src/engine.ts` | Contract bar order: pending orders at bar open → position management → drawdown/cooldown/degradation → tree → action (queue entry/exit, stop fills, tighten). Sizing, fees, slippage, R accounting. |
| Bot service | `src/bots.ts` | Create/edit/activate/deactivate/delete, wait-for-exit pending actions, views, JSON export. |
| Notifications | `src/notify.ts` | Telegram outbox (`transactions.notified`) → survives restarts/outages. |
| Dashboard | `public/index.html` | Vanilla client-side rendering; Bearer token in localStorage; live prices fetched **directly from Binance** in the browser. |

Recovery: all state is in SQLite (WAL). Every processed bar commits bot cash + per-asset state + transactions
in one transaction and advances `bot_asset_state.last_processed_bar`, so a crash re-processes at most the
bar that was in flight, and never twice. On restart the worker re-fetches from the newest stored candle and
the runner replays every unprocessed closed bar in order. Pending Telegram messages are re-sent.

Storage: candles are a rolling `WINDOW`=1000 rows/symbol (overwrite, constant); `symbol_features` is one
row/symbol (overwritten each bar); symbols no bot uses are purged. Growing tables: `bots`, `bot_asset_state`,
`transactions` (events capped at 200/bot). Deleting a bot cascades everything it owns.

## Product semantics (decisions where the README is open)
- **One trade at a time per bot**: when a bot holds a position or has a pending order on symbol X, only X
  is evaluated until it exits. When flat and several assets queue an entry on the same bar, the one with
  the highest `expectedNetR` wins; others are dropped.
- **Capital**: one USDT portfolio per bot (shared by its assets; only one is ever held). Per-asset account
  state (cooldown, drawdown pause, degradation, rolling R) is isolated per `bot × symbol`, as the tree requires.
- **New / reactivated bots start live from the next closed candle** (no historical backfill).
- **Wait-for-exit actions** (`when=after_exit`, the default) are stored in `bots.pending_action` and applied
  the moment the bot is flat: deactivate, delete, asset edits that drop the held asset, capital updates
  (capital is never changed mid-trade). `when=now` closes the position at the last stored close (minus
  slippage, exit reason `MANUAL`). Activating cancels a scheduled deactivation.
- Fills are simulated: entry at next bar open × (1+slip); stops at stop level (or open if gapped) with
  `slip × stopSlipMult`; market exits (A trail, KILL, TIME) at next bar open × (1−slip); fee 0.1%/side.
- Trailing: A = close-based (stop checked on close, exit next open; initial/kill stop rests intrabar);
  C = resting intrabar stop on the trailing level. Stops never loosen.

## Declared choices (JSON leaves these open; aligned with the research runtime)
- **Cost features**: `roundTrip = 2·fee + slip·(1+stopSlipMult)` = 0.375%; `costInR = roundTrip / stopDistanceAtr`;
  `targetCostMultiple = 1/costInR`; `expectedNetR = 1 − costInR`. Conservative upper bound (ATR% ≤ 1). A: 0.00125, C: 0.001875,
  so the 0.15 / 4.0 gates are guards, not binders, at 4h stop distances.
- **`atrPctPctl`**: `atr14[i]` ranked against the prior 300 `atr14` values (current bar is the compared value).
- **Cooldown**: `min(48, max(base 6 | afterStop 12, 6 × consecutiveLosses))`; STOP / HARD_STOP / KILL use the 12-bar floor.
- **`weekR`**: sum of realized R of trades closed within the last 42 bars, per asset.
- **`dataOk`**: bar index ≥ 200, ≥ 2-bar contiguous 4h run ending at the bar, all enabled-strategy features finite.
- **KILL / TIME exits**: fill at the decision-bar close × (1 − slip), no next-open delay. STOP/HARD_STOP per JSON; A's TRAIL exits at next open.
- **`degradationActive`**: tree flag only when both strategies are frozen; otherwise the runtime blocks the selected
  strategy after the tree for its own pause (no fallback to the other), counted in `blockedByDegradation`.
- **`rMultiple`** = `pnl / (qty × (fill − initialStop))`, risk fixed at entry.
- Backtest-harness artifacts (`OPEN_AT_END`, Sharpe annualization, fresh capital per fold) are intentionally not implemented.
- Our own: indicators use the 1000-bar rolling window (negligible EMA seed effect vs full history).

## Status
- [x] Spec read; zod-validated tree interpreter; features/indicators; engine; SQLite schema locked (`schema.sql`)
- [x] Worker (REST only), recovery/catch-up, Telegram outbox, API (`openapi.yml`), dashboard, tests + smoke
- [x] README documentation files: `AGENTS.md`, `schema.sql`, `openapi.yml`

## Remaining tasks
- [ ] **Verify against live Binance** (sandbox had no access to api.binance.com; only a mock was used) and
      run a forward paper test — the SOL/ETH gates are marked tentative in `bot/tree_doc.md`.
- [ ] Parity test of indicators/signals against the research Python engine (EMA/ATR/percentile edge cases,
      `scripts/*.py` are not in this repo).
- [ ] Dashboard: pagination for very long transaction logs; per-bot candle/feature inspector.
- [ ] Optional: Telegram messages for lifecycle events (activate/deactivate/forced close); rate-limit handling
      beyond simple retry; token rotation endpoint.
- [ ] Deployment notes (systemd/Docker volume for `data/`), HTTPS termination in front of the bearer token.
