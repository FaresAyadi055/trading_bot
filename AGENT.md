# AGENTS.md — project status, architecture and remaining tasks (live version, schema v3)

Read `README.md` first. Strategy source of truth: `bot/BOT_SPEC.md` (Donchian A + VCEB C, locked configuration).
Keep this file current when you change anything.

## Commands
```sh
bun install
cp .env.example .env     # set ACCESS_TOKEN, MODE=live|test, BINANCE_API_KEY/SECRET (and optionally Telegram)
bun run dev              # http://localhost:3000/bot  (hot reload; dashboard also at /bot/dashboard)
bun test                 # unit + lifecycle + notification + migration + capital + live-execution + interrupt tests (in-memory sqlite, MockExchange)
bun run smoke            # end-to-end: app + worker against a mock Binance server and a mock account (no credentials needed)
bun run parity           # TS engine vs the spec's Python reference, trade for trade (python3 + pandas + numpy)
```
Parity knobs: `SEED=<n> BARS=<n>`, `PARITY_LOOSE_C=1` (open C's gates), `PARITY_ONLY_C=1` (switch A off) to stress C's
stop / trail paths.

## Architecture
| Piece | File | Role |
|---|---|---|
| Hono app | `src/index.ts` | Auth, REST API, streams `public/index.html`; starts the worker, syncs the pulled-symbol list after every state change. No in-memory caches. |
| Config | `src/config.ts` | `MODE` (`live`\|`test`), keys, execution base (`BINANCE_BASE_URL`) vs data base (`BINANCE_DATA_URL`, mainnet), poll / interrupt / slippage settings. Fails fast on missing `ACCESS_TOKEN`, `MODE`, keys (`NODE_ENV=test` or `NO_EXCHANGE=1` skip the key check: tests inject a mock). |
| Exchange | `src/exchange.ts` | `Exchange` interface (`balances`, `prices`, `buy`, `sell`, `tradable`, `ping`). `ConvertExchange` (live: getQuote → acceptQuote → orderStatus, buys never retried, price guard on the quote) and `TestnetExchange` (test: spot MARKET orders, LOT_SIZE rounding, client order ids). Signed requests percent-encode the query *before* signing. `setExchange()` injects a mock. |
| Capital ledger | `src/capital.ts` | Real balances vs the bots' sub-allocations: `unallocated = free USDT − Σ bot cash`, `allocated = Σ(cash + position cost)`. `assertAllocatable` / `assertBacked` guard create, capital increase (request *and* apply time) and activate; `snapshot()` feeds `GET /api/capital` and detects drift (USDT and held-asset shortfalls). |
| Live executor | `src/live.ts` | Turns the engine's decisions into real orders right after each bar: per-bot lock, fresh-balance capital guard before every buy, sell retries with back-off, stop monitor (`monitorTick`, polls prices, sells on a stop breach), `closeBotNow` for `when=now` API actions. Books the actual fill (`order_ref`). |
| Interrupt | `src/interrupt.ts` | Heartbeat (`heartbeat_at` only advanced while Binance answers). Gap > `INTERRUPT_MIN_SECONDS` → `skipStaleBars` for active bots, one Telegram `interrupt` alert (offline window, skipped bars, positions + stops, capital check), forces a data refresh and a stop re-check. **No replay.** |
| Worker | `src/worker.ts` | Only code calling the *public* Binance data REST (`/api/v3/klines` 4h, `/api/v3/exchangeInfo` for symbol validation) on `dataBase`. One timer, wakes ~5s after each 4h boundary, retries only lagging symbols for 10 min, honours 429 `Retry-After`, skips symbols that already have the latest closed candle, 4 requests in parallel. |
| Runner | `src/runner.ts` | On `cycleDone`: upsert candles (rolling window), per bot evaluate the live bar(s) (`processBot`; bars older than `LIVE_BAR_MAX_AGE_MS` = 15 min are dropped by `skipStaleBars`, never replayed), persist atomically per bar, refresh `symbol_features`, GC. On `cycleDone` the app then calls `executeAll()`. |
| Features | `src/features.ts`, `src/indicators.ts` | BOT_SPEC §4: EMA200, Wilder ATR14, Donchian 40/10 (shifted), vol SMA20, BB(20) width with **population** std, shifted 20th pct over 100 bars, Kaufman ER-20, rel. return 60, ATR percentile, median USD volume, `dataOk` (3-bar contiguity), signals A / C (+ `rawC`, the pre-gate C setup used to report gate rejections). |
| Strategy | `src/strategy.ts`, `src/params.ts` | Score, per-symbol pick, cost/stop-band gates, cross-section rank, regime engine. All constants in `params.ts` (locked values from §10). |
| Engine | `src/engine.ts` | `stepBot`: §9.1 pipeline (regime → pause/cooldown → pending order at the open → manage position → scan → bookkeeping). Sizing, fees, slippage, R accounting, protections. Pure function of (bot, state, rows). Two paths: **simulated** (unit tests, parity) and `live` (`StepOpts.live`): the engine only decides (pending entry/exit, `exitNow`, unexecuted entries expire); `applyLiveEntry` / `closePosition(..., real fill)` book what `live.ts` actually got from the exchange. |
| Bot service | `src/bots.ts`, `src/validate.ts`, `src/symbols.ts` | Create/edit/activate/deactivate/delete, wait-for-exit pending actions, views, JSON export, `neededSymbols()`, GC; hand-written request validation; Binance tradability check (done by the worker). |
| Notifications | `src/messages.ts`, `src/summary.ts`, `src/notify.ts` | Messages are composed when the event happens and written to the `notifications` outbox in the same transaction as the bar; `flushNotifications` delivers and deletes them. Daily summary builder. |
| Schema | `schema.sql`, `src/schema.ts`, `src/migrate.ts` | Locked schema v3 (v2 + `transactions.order_ref`), applied idempotently; v1 / v2 databases are upgraded in place. |
| Dashboard | `public/index.html` | Vanilla client-side rendering; Bearer token in localStorage; LIVE/TEST badge, capital panel (`/api/capital`), live prices **and the asset list** fetched directly from Binance by the browser. Searchable multi-select asset picker. |

Recovery: all state is in SQLite (WAL). Every processed bar commits bot cash + `bot_state` + transactions + events +
outbox rows in one transaction and advances `bot_state.last_processed_bar`, so a crash re-processes at most the bar that
was in flight, never twice. **There is no catch-up replay.** On restart, bars that closed while the process was down are
skipped (`skipStaleBars`: `barsHeld` / cooldown advance, `skipped_bars` counter, `bars_skipped` event), the heartbeat
detects the gap, and a single Telegram interrupt alert is sent. The worker still re-fetches from the newest stored candle
so the series stays contiguous for the indicators. Execution intents are persisted *before* the order is sent
(`exitNow`, `pending`); a buy is never re-sent, a sell is retried. Pending Telegram messages are re-sent (dropped after 24h).
An order that was executed but whose booking crashed is **not** auto-reconciled: the capital check reports the drift and
blocks entries until the books match the account (see Remaining tasks).

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

## Live-version decisions
- `MODE=live` → Convert on `api.binance.com`; `MODE=test` → testnet spot market orders (no Convert on the testnet). Candles always from mainnet public data. Use a separate `DB_PATH` per mode.
- Convert-only key: it can read balances and convert, nothing else. Convert has no resting stops → the stop monitor polls (`STOP_POLL_SECONDS`), so a stop is a market sell *after* the price crosses, not a resting order; gaps and the 15 s poll add slippage vs the backtest.
- Capital ledger invariant: `Σ bot cash ≤ free USDT` at all times; every allocation increase is checked against a fresh balance and inserted synchronously (no await between check and write). Inactive bots keep their cash reserved. Fail closed when the balance is unreadable.
- Order safety: buys once (a failed/ambiguous buy drops the entry), sells retried; a buy with a Convert quote > `MAX_ENTRY_SLIPPAGE_PCT` above the reference is refused before accepting; entries older than 15 min are dropped.
- Interrupt alert is built from live state (skipped bars, positions with stop / hard stop, capital snapshot) and queued in the same outbox as the other messages (`kind=interrupt`).

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
- Fills (simulated path only: tests / parity): entry at next bar open × (1+slip); C stops / hard stops at the level (or open if gapped) with
  `slip × 2.5`; A's 3-ATR stop is close-based (exit at next open); KILL / TIME at the decision-bar close × (1 − slip).
  **Live path: every fill is the real exchange fill** (entry right after the bar closes, stops by the price monitor, KILL / TIME / A-trail exits at market when the bar is processed).

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
- `interrupt`: one message per detected interruption (offline window, bars skipped, per-bot position / stops, capital reconciliation). Also `lifecycle` messages for `ORDER FAILED` (rate-limited 30 min per bot+side) and `CAPITAL INCREASE REJECTED`.
- No replay exists any more, so there is no suppression of replayed alerts.

## Status
- [x] Zod and the JSON decision tree removed; strategy implemented from `bot/BOT_SPEC.md`; parity-tested (≈1100 trades incl. 150+ C-only trades, 0 mismatches, max |ΔR| ≈ 5e-13)
- [x] Any Binance USDT asset: validation, searchable dashboard picker, per-bot universe
- [x] Demand-driven data pulling; GC of unreferenced symbols
- [x] Schema v2 + automatic v1 → v2 migration (open positions preserved, unfilled entries dropped); v3 adds `transactions.order_ref`
- [x] Live version: `MODE=live|test`, Convert / testnet execution, real-fill bookkeeping, stop monitor, capital ledger + over-allocation guards, interrupt alert (replay removed), dashboard capital panel (tests 24/24, smoke 21/21, parity unchanged)
- [x] Telegram: all actions + strategy name, blocked trades, daily summary; SQLite outbox
- [x] Tests, smoke, parity harness; README / AGENT / schema.sql / openapi.yml updated

## Remaining tasks
- [ ] **Run on the real Binance testnet end to end** (sandbox had no access to Binance; everything was verified against mocks and against Binance's documentation): check `MODE=test` fills, LOT_SIZE rounding, balance parsing.
- [ ] **Run `MODE=live` with the smallest possible capital first** and verify the Convert flow (quote validity, `orderStatus` fields, `assetInfo` fraction digits, minimum / maximum amounts per pair via `exchangeInfo`).
- [ ] **Auto-reconcile a crash between "order executed" and "booked".** Today the ledger reports the drift and blocks entries; the order is findable by its client id (testnet) / `orderStatus` list (Convert). A `reconcile` pass should adopt or unwind it.
- [ ] Withdraw / unrelated balances: the ledger counts the *whole* free USDT of the account. If you trade other things by hand in the same account, move that USDT to another account / sub-account.
- [ ] Stops are polled, not resting: consider a shorter `STOP_POLL_SECONDS` or a websocket ticker if the slippage on stop exits matters.
- [ ] Decide on C: spec §14 shows the lock leaves C with ~4 trades on a one-slot book; re-measure before trusting it.
- [ ] Score / regime thresholds are uncalibrated phase-1 guesses (spec §16).
- [ ] Regime for bots with < 4 assets or without BTC stays NEUTRAL; consider a global regime feed (would need BTC + breadth data pulled for it).
- [ ] Dashboard: pagination for very long transaction logs; per-bot candle/feature inspector; an events/blocked-trades view (`GET /api/bots/:id/events` already serves it).
- [ ] Optional: per-bot Telegram toggles, token rotation endpoint.
- [ ] Deployment notes (systemd/Docker volume for `data/`), HTTPS termination in front of the bearer token.
