# AGENTS.md — project status, architecture and remaining tasks

Read `README.md` first. Strategy source of truth: `bot/BOT_SPEC.md` (Donchian A + VCEB C, locked configuration).
Keep this file current when you change anything.

## Commands
```sh
bun install
cp .env.example .env     # set ACCESS_TOKEN (and optionally Telegram)
bun run dev              # http://localhost:3000/bot  (hot reload; dashboard also at /bot/dashboard)
bun test                 # unit + lifecycle + notification + migration tests (in-memory sqlite)
bun run smoke            # end-to-end: app + worker against a mock Binance server
bun run parity           # TS engine vs the spec's Python reference, trade for trade (python3 + pandas + numpy)
```
Parity knobs: `SEED=<n> BARS=<n>`, `PARITY_LOOSE_C=1` (open C's gates), `PARITY_ONLY_C=1` (switch A off) to stress C's
stop / trail paths.

## Architecture
| Piece | File | Role |
|---|---|---|
| Hono app | `src/index.ts` | Auth, REST API, streams `public/index.html`; starts the worker, syncs the pulled-symbol list after every state change. No in-memory caches. |
| Worker | `src/worker.ts` | Only code calling Binance REST (`/api/v3/klines` 4h, `/api/v3/exchangeInfo` for symbol validation). One timer, wakes ~5s after each 4h boundary, retries only lagging symbols for 10 min, honours 429 `Retry-After`, skips symbols that already have the latest closed candle, 4 requests in parallel. |
| Runner | `src/runner.ts` | On `cycleDone`: upsert candles (rolling window), per bot replay every unprocessed closed bar in order (`processBot`), persist atomically per bar, refresh `symbol_features`, GC. Also the crash catch-up path (same code). |
| Features | `src/features.ts`, `src/indicators.ts` | BOT_SPEC §4: EMA200, Wilder ATR14, Donchian 40/10 (shifted), vol SMA20, BB(20) width with **population** std, shifted 20th pct over 100 bars, Kaufman ER-20, rel. return 60, ATR percentile, median USD volume, `dataOk` (3-bar contiguity), signals A / C (+ `rawC`, the pre-gate C setup used to report gate rejections). |
| Strategy | `src/strategy.ts`, `src/params.ts` | Score, per-symbol pick, cost/stop-band gates, cross-section rank, regime engine. All constants in `params.ts` (locked values from §10). |
| Engine | `src/engine.ts` | `stepBot`: §9.1 pipeline (regime → pause/cooldown → pending order at the open → manage position → scan → bookkeeping). Sizing, fees, slippage, R accounting, protections. Pure function of (bot, state, rows). |
| Bot service | `src/bots.ts`, `src/validate.ts`, `src/symbols.ts` | Create/edit/activate/deactivate/delete, wait-for-exit pending actions, views, JSON export, `neededSymbols()`, GC; hand-written request validation; Binance tradability check (done by the worker). |
| Notifications | `src/messages.ts`, `src/summary.ts`, `src/notify.ts` | Messages are composed when the event happens and written to the `notifications` outbox in the same transaction as the bar; `flushNotifications` delivers and deletes them. Daily summary builder. |
| Schema | `schema.sql`, `src/schema.ts`, `src/migrate.ts` | Locked schema v2, applied idempotently; v1 databases are upgraded in place. |
| Dashboard | `public/index.html` | Vanilla client-side rendering; Bearer token in localStorage; live prices **and the asset list** fetched directly from Binance by the browser. Searchable multi-select asset picker. |

Recovery: all state is in SQLite (WAL). Every processed bar commits bot cash + `bot_state` + transactions + events +
outbox rows in one transaction and advances `bot_state.last_processed_bar`, so a crash re-processes at most the bar that
was in flight, never twice. On restart the worker re-fetches from the newest stored candle of each needed symbol and the
runner replays every unprocessed closed bar in order. Pending Telegram messages are re-sent (dropped after 24h).

Storage: candles are a rolling `WINDOW`=1000 rows/symbol; `symbol_features` is one row/symbol (overwritten each bar);
candles/features of symbols no active bot references are purged. Growing tables: `bots`, `bot_state` (1 row/bot),
`transactions`, `events` (capped at 200/bot). Deleting a bot cascades everything it owns. `notifications` is a transient
outbox.

## Data pulling rule
`neededSymbols()` = for each **active** bot: the symbol it holds / has an order pending on, else its whole `assets` list.
The worker fetches exactly that set. Effects: nobody listens → not pulled; one bot listens and it entered another asset →
not pulled until it exits; another active bot still lists it → pulled. Referenced-but-not-pulled symbols keep their
stored candles; on resume the worker fetches forward from the newest stored candle (or the latest 1000 if the gap is
> 990 bars), so series stay contiguous.

## Product semantics (decisions where the spec / README are open)
- **One slot per bot** (spec §1): when flat the bot scans its whole universe each bar and the best score wins; while a
  position or pending order exists nothing else is evaluated. A bot's behaviour depends only on its own assets, never on
  other bots.
- **Universe = the bot's assets.** Regime / cross-section use the symbols the bot can see on the bar. Regime needs
  ≥ 4 `dataOk` symbols and `BTCUSDT` among them, else the state is kept (initially NEUTRAL). While in a trade only the held
  asset is visible → regime frozen (spec §16 "keep the last state").
- **Bar completeness**: a bar is evaluated when all tracked symbols have it, or `BAR_GRACE_MS` (10 min) after it closed.
- **Capital**: one USDT portfolio per bot. Capital updates apply only when flat; the drawdown peak is rescaled
  proportionally so a capital move never triggers / hides a drawdown pause.
- **New / reactivated bots start live from the next closed candle** (no historical backfill of decisions).
- **Wait-for-exit actions** (`when=after_exit`, default) are stored in `bots.pending_action` and applied the moment the
  bot is flat: deactivate, delete, asset edits that drop the held asset, capital updates. `when=now` closes the position
  at the last stored close × (1 − slip) with exit reason `MANUAL` (also on `DELETE ?when=now`, new in v2).
- **Equity for the drawdown pause is realised cash** (spec §9.4); the dashboard marks open positions to live prices.
- Account protections are per **bot** (spec), no longer per bot × asset: cooldown, drawdown pause, rolling loss cap,
  per-strategy degradation.
- Fills are simulated: entry at next bar open × (1+slip); C stops / hard stops at the level (or open if gapped) with
  `slip × 2.5`; A's 3-ATR stop is close-based (exit at next open); KILL / TIME at the decision-bar close × (1 − slip).

## Deviations from the reference implementation (deliberate)
- **Unmanaged-position safety**: if the held symbol's features are not finite on a bar, the resting stops and the time cap
  still run (the reference skips the bar). No effect on clean data (parity-verified).
- Indicators run on the 1000-bar rolling window, not the full history (EMA seed effect ≈ 3e-4 after 800 bars).
- Bar clock is the absolute 4h index, not the index in the union of symbol timestamps (identical on contiguous data).
- `OPEN_AT_END` does not exist (live bot).

## Notifications (Telegram)
Kinds: `buy`, `sell`, `entry_queued`, `exit_queued`, `tighten`, `blocked`, `daily`, `lifecycle`; every trading message
carries `Strategy: Donchian (A)` / `VCEB (C)`.
- **Blocked** = a locked signal (or a raw VCEB setup) that did not become a trade, with the reason: `c_quality_gate`,
  `score_below_min`, `strategy_degraded`, `stop_band`, `cost_gate`, `edge_gate`, `slot_taken`, `min_notional`,
  `drawdown_pause`, `cooldown`, `rolling_loss_cap`, `all_strategies_degraded`. One message per bar per bot; each
  (symbol, strategy, reason) is alerted at most once per 6 bars; all occurrences are counted for the daily summary.
- **Daily summary** after the 20:00 UTC bar (6th candle of the day): `buildDailySummary` uses `BotState.day`
  (actions, signals, blocked counts), bot status, and 24h stats from the stored candles. Reset after each day end.
- Replayed history (catch-up after downtime) only reports BUY / SELL; other alerts are for the last two bars only.

## Status
- [x] Zod and the JSON decision tree removed; strategy implemented from `bot/BOT_SPEC.md`; parity-tested (≈1100 trades incl. 150+ C-only trades, 0 mismatches, max |ΔR| ≈ 5e-13)
- [x] Any Binance USDT asset: validation, searchable dashboard picker, per-bot universe
- [x] Demand-driven data pulling; GC of unreferenced symbols
- [x] Schema v2 + automatic v1 → v2 migration (open positions preserved, unfilled entries dropped)
- [x] Telegram: all actions + strategy name, blocked trades, daily summary; SQLite outbox
- [x] Tests, smoke, parity harness; README / AGENT / schema.sql / openapi.yml updated

## Remaining tasks
- [ ] **Verify against live Binance** (sandbox had no access to api.binance.com; a mock was used) and run a forward paper test.
- [ ] Decide on C: spec §14 shows the lock leaves C with ~4 trades on a one-slot book; re-measure before trusting it.
- [ ] Score / regime thresholds are uncalibrated phase-1 guesses (spec §16).
- [ ] Regime for bots with < 4 assets or without BTC stays NEUTRAL; consider a global regime feed (would need BTC + breadth data pulled for it).
- [ ] Dashboard: pagination for very long transaction logs; per-bot candle/feature inspector; an events/blocked-trades view (`GET /api/bots/:id/events` already serves it).
- [ ] Optional: per-bot Telegram toggles, token rotation endpoint.
- [ ] Deployment notes (systemd/Docker volume for `data/`), HTTPS termination in front of the bearer token.
