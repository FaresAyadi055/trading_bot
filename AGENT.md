# AGENTS.md — project status, architecture and remaining tasks (Donchian-only, schema v5)

Read `README.md` first. Strategy + universe source of truth: `bot/BOT_SPEC.md` (Donchian-40 / EMA200, locked
configuration). Keep this file current when you change anything.

## Commands
```sh
bun install
cp .env.example .env     # set ACCESS_TOKEN, MODE=live|test; live also needs BINANCE_API_KEY/SECRET (Telegram optional)
bun run dev              # http://localhost:3000/bot  (hot reload; dashboard also at /bot/dashboard)
bun test                 # unit + lifecycle + notification + migration + capital + live-execution + security tests (in-memory sqlite, MockExchange)
bun run smoke            # end-to-end: app + worker against a mock Binance server and a mock account (no credentials needed)
bun run tunnel           # standalone tunnel (the app starts it automatically when TUNNEL=true)
```
`bun run parity` is a legacy no-op: the Python reference implements the retired A+C strategy.

## Architecture
| Piece | File | Role |
|---|---|---|
| Hono app | `src/index.ts` | Security middleware, REST API, streams `public/index.html`; starts the worker, syncs the pulled-symbol list after every state change. No in-memory caches. |
| Security | `src/security.ts` | HTTPS enforcement (loopback exempt), signed HttpOnly session cookie, Bearer tokens, per-IP auth lockout + API budget, security headers. |
| Config | `src/config.ts` | `MODE` (`live`\|`test`), keys, execution base (`BINANCE_BASE_URL`) vs data base (`BINANCE_DATA_URL`, mainnet), paper-account settings, poll / slippage / HTTP-hardening settings. Fails fast on missing `ACCESS_TOKEN` / `MODE`; API keys are required in live mode only (`NODE_ENV=test`, `NO_EXCHANGE=1` and paper mode inject a simulated exchange). |
| Tunnel | `src/tunnel.ts` | `TUNNEL=true` starts a temporary Cloudflare quick tunnel on boot and sends the public URL to Telegram once connected. `TUNNEL_QUICK=false` uses a named tunnel (`TUNNEL_CONFIG`). `TRUST_PROXY` defaults to 1 while the tunnel is on. A tunnel failure is logged and never stops the app. |
| Exchange | `src/exchange.ts` | `Exchange` interface (`balances`, `prices`, `buy`, `sell`, `placeStop`, `cancelOrder`, `orderStatus`, `tradable`). `SpotExchange` is the live mainnet venue: MARKET orders, LOT_SIZE rounding, client order ids, `STOP_LOSS` with a `STOP_LOSS_LIMIT` fallback; signed requests percent-encode the query *before* signing. `PaperExchange` (`MODE=test`) uses real mainnet prices but simulated fills and a fake `paper_account` balance in `data-test/`. `setExchange()` injects a mock. |
| Paper account | `src/exchange.ts`, `data-test/trading.sqlite` | `MODE=test` copies the live DB once (`VACUUM INTO`) into `data-test/`, seeds fake USDT (`PAPER_START_USDT`, or enough to back the copied bots) plus the base assets of copied open positions, and simulates buys/sells/stops. `POST /api/paper/capital` / dashboard **+ add test capital** credits more. Live mode never reads these tables. |
| Capital ledger | `src/capital.ts` | Real balances vs the bots' sub-allocations: `unallocated = free USDT − Σ bot cash`, `allocated = Σ(cash + position cost)`. `assertAllocatable` / `assertBacked` guard create, capital increase (request *and* apply time) and activate; `snapshot()` feeds `GET /api/capital` and detects drift (USDT and held-asset shortfalls). |
| Live executor | `src/live.ts` | Turns the engine's decisions into real orders right after each bar: per-bot lock, fresh-balance capital guard before every buy, sell retries with back-off, **resting stop placement/ratchet/reconciliation**, market-sell backstop (`monitorTick`), `closeBotNow` for `when=now` API actions. Books the actual fill (`order_ref`). |
| Worker | `src/worker.ts` | The only code calling the *public* candle/universe REST (the paper exchange additionally reads `ticker/price`). One timer wakes ~5s after each 4h boundary; rate limiter (≤1200 weight/min, request spacing, 429/418 `Retry-After`), skips symbols that already have the latest closed candle, retries lagging symbols for 10 min. Also runs the daily **universe scan**: one `exchangeInfo` + `ticker/24hr`, the $10M/24h volume pre-filter, then 452 klines per survivor and `selectUniverse()`. |
| Universe | `src/universe.ts`, `src/universe_store.ts` | Three-layer filter (`eligibleSymbol`, 24h volume ≥ $10M, `historyCheck` ≥450 contiguous bars), then `selectUniverse()` ranks by 24h volume and applies `maxAssets`; persistence of every candidate and the selected list in `meta.universe_max_assets`. |
| Runner | `src/runner.ts` | On `cycleDone`: upsert candles (rolling window), per bot evaluate the live bar(s) (`processBot`; bars older than `LIVE_BAR_MAX_AGE_MS` = 15 min are dropped by `skipStaleBars`, never replayed), persist atomically per bar, refresh `symbol_features`, GC. On `cycleDone` the app then calls `executeAll()`. |
| Features | `src/features.ts`, `src/indicators.ts` | EMA200 (`adjust=False`, `min_periods=400`), Wilder ATR14, Donchian-40 (current bar excluded, O(n) deque), vol SMA20, Kaufman ER-20, rel. return 60, ATR percentile, median USD volume, `dataOk` (≥400 contiguous finite bars), Donchian signal (breakout + EMA + volume 1.5–5× + 2 ATR extension gate). |
| Strategy | `src/strategy.ts`, `src/params.ts` | Score (breakout capped at ~1 ATR), cost/edge gates, cross-section rank, regime engine. All constants in `params.ts` (locked values from BOT_SPEC). |
| Engine | `src/engine.ts` | `stepBot`: pipeline (regime → pause/cooldown → pending order at the open → manage position → scan → bookkeeping). Sizing with the worst-case stop distance (hard stop + 5× stop slippage), 30% position cap, fees, R accounting, protections, resting-stop ratchet, stagnation exit, time stop. Pure function of (bot, state, rows). Two paths: **simulated** (unit tests) and `live` (`StepOpts.live`): the engine only decides; `applyLiveEntry` / `closePosition(..., real fill)` book what `live.ts` actually got from the exchange. |
| Bot service | `src/bots.ts`, `src/validate.ts` | Create/edit/activate/deactivate/delete, wait-for-exit pending actions, views, JSON export, `neededSymbols()`, universe→bot snapshot sync, GC; hand-written request validation. Assets are no longer user-editable. |
| Notifications | `src/messages.ts`, `src/summary.ts`, `src/notify.ts` | Messages are composed when the event happens and written to the `notifications` outbox in the same transaction as the bar; `flushNotifications` delivers and deletes them. Daily summary builder. |
| Schema | `schema.sql`, `src/schema.ts`, `src/migrate.ts` | Locked schema v5 (`universe` table, new position fields, `paper_account` / `paper_orders`), applied idempotently; v1–v4 databases are upgraded in place. |
| Dashboard | `public/index.html` | Vanilla client-side rendering; Bearer token in localStorage; LIVE/TEST badge, dynamic-universe panel (selection, max size, refresh), capital panel (`/api/capital`), live prices fetched directly from Binance. No manual asset picker. |

Recovery: all state is in SQLite (WAL). Every processed bar commits bot cash + `bot_state` + transactions + events +
outbox rows in one transaction and advances `bot_state.last_processed_bar`, so a crash re-processes at most the bar that
was in flight, never twice. **There is no catch-up replay.** On restart, bars that closed while the process was down are
skipped (`skipStaleBars`: `barsHeld` / cooldown advance, `skipped_bars` counter, `bars_skipped` event). There is no
connectivity heartbeat and no interrupt alert: Telegram messages come only from failed functional API requests or
rejected orders. Execution intents are persisted *before* the order is
sent (`exitNow`, `pending`); a buy is never re-sent, a sell is retried. Pending Telegram messages are re-sent (dropped
after 24h). An order that was executed but whose booking crashed is **not** auto-reconciled: the capital check reports
the drift and blocks entries until the books match the account.

Storage: candles are a rolling `WINDOW`=1000 rows/symbol; `symbol_features` is one row/symbol (overwritten each bar);
`universe` is one row/candidate (replaced per scan, small); candles/features of symbols nobody references are purged.
Growing tables: `bots`, `bot_state` (1 row/bot), `transactions`, `events` (capped at 200/bot). Deleting a bot cascades
everything it owns. `notifications` is a transient outbox.

## Data pulling and universe rules
- `neededSymbols()` = for each **active** bot: the symbol it holds / has an order pending on, else its whole `assets`
  list. `bots.assets` is a snapshot of the global selected universe, refreshed by `syncUniverseToBots()` (a held symbol
  is always kept). The worker fetches exactly that set.
- The universe is global, not per bot. It is rebuilt every 6 closed 4h bars (24h) or on `POST /api/universe/refresh`,
  and its maximum size lives in `meta.universe_max_assets` (API-editable, default 50).
- Between scans the worker only fetches the 4h candle tails for the selected symbols; a delisted / non-trading symbol is
  deselected by the next scan (never a symbol with an open position).
- Referenced-but-not-pulled symbols keep their stored candles; on resume the worker fetches forward from the newest
  stored candle (or the latest 1000 if the gap is > 990 bars), so series stay contiguous.

## Live-version decisions
- `MODE=live` → Binance spot on `api.binance.com`. `MODE=test` → paper trading: real mainnet prices, simulated fills,
  fake USDT, own database copy under `data-test/`, no API keys. Candles always from mainnet public data.
- Spot key with *Reading* + *Spot trading*, no withdrawals, IP whitelist.
- **Resting stop on the exchange** (`STOP_LOSS`, `STOP_LOSS_LIMIT` fallback) at `max(hardStop, trailStop − 0.75 ATR)`.
  The monitor reconciles fills/cancels, recreates a missing order and keeps a market-sell backstop.
- Capital ledger invariant: `Σ bot cash ≤ free USDT` at all times; every allocation increase is checked against a fresh
  balance and inserted synchronously (no await between check and write). Inactive bots keep their cash reserved.
  Fail closed when the balance is unreadable.
- Order safety: buys once (a failed/ambiguous buy drops the entry), sells retried; a buy whose fill is more than
  `MAX_ENTRY_SLIPPAGE_PCT` above the reference is refused; entries older than 15 min are dropped; client order ids
  resolve ambiguous failures before a retry.
- Telegram alerts are emitted only for failed functional API requests (candles, universe, balances, prices) and
  rejected orders, rate-limited per key. There is no connectivity probe / heartbeat message.

## Product semantics
- **One slot per bot**: when flat the bot scans its whole tracked set each bar and the best score wins; while a
  position or pending order exists nothing else is evaluated.
- **Regime** uses the symbols the bot can see on the bar. It needs ≥ 4 `dataOk` symbols and `BTCUSDT` among them, else
  the state is kept (initially NEUTRAL). While in a trade only the held asset is visible → regime frozen.
- **Bar completeness**: a bar is evaluated when all tracked symbols have it, or `BAR_GRACE_MS` (10 min) after it closed.
- **Capital**: one USDT portfolio per bot. Capital updates apply only when flat; the drawdown peak is rescaled
  proportionally so a capital move never triggers / hides a drawdown pause.
- **New / reactivated bots start live from the next closed candle** (no historical backfill of decisions).
- **Wait-for-exit actions** (`when=after_exit`, default) are stored in `bots.pending_action` and applied the moment the
  bot is flat: deactivate, delete, capital updates.
- **Equity for the drawdown pause is realised cash**; the dashboard marks open positions to live prices.
- Account protections are per **bot**: cooldown, drawdown pause, rolling loss cap, Donchian degradation.
- Simulated fills (tests only): entry at next bar open × (1+slip); resting-stop fills at the level (or open if gapped)
  with `slip × 5`; KILL / TIME / stagnation / trail exits at the decision-bar close × (1 − slip).
  **Live path: every fill is the real exchange fill.**

## Notifications (Telegram)
Kinds: `buy`, `sell`, `entry_queued`, `exit_queued`, `tighten`, `blocked`, `daily`, `lifecycle`; every trading message
carries `Strategy: Donchian (A)`.
- **Blocked** reasons: `score_below_min`, `strategy_degraded`, `cost_gate`, `edge_gate`, `slot_taken`,
  `min_notional`, `drawdown_pause`, `cooldown`, `rolling_loss_cap`, `entry_expired`, `capital_guard`, `exec_failed`.
  One message per bar per bot; each (symbol, strategy, reason) is alerted at most once per 6 bars; all occurrences are
  counted for the daily summary.
- **Daily summary** after the 20:00 UTC bar (6th candle of the day): `buildDailySummary` uses `BotState.day`
  (actions, signals, blocked counts), bot status, 24h stats from the stored candles, and the global universe-filter
  funnel (symbols → eligible → volume → history, selected/cap, last scan). The full asset list is on the dashboard.
  Reset after each day end.
- `api_error`: one message per failed functional Binance request (candles, universe, balances, prices), rate-limited
  30 min per key. Also `lifecycle` messages for `ORDER FAILED` (with the Binance API error reason; rate-limited 30 min
  per bot+side) and `CAPITAL INCREASE REJECTED`.

## Status
- [x] Donchian-only rewrite (A+C removed): EMA `min_periods=400`, hard stop 3.5 ATR resting, resting-stop ratchet,
      stagnation exit, worst-case stop distance sizing, 30% position cap, 5× stop-slip stress, volume 1.5–5×,
      2 ATR extension gate, `dataOk` ≥ 400 contiguous bars.
- [x] Dynamic universe filter (3 layers: eligibility, 24h volume ≥ $10M, ≥450 contiguous bars), ranked by 24h
      volume with a configurable cap; global and database-backed, refreshed every 24h / 6 bars.
- [x] Manual asset selection removed (API, validation, dashboard); bots follow the universe, a held symbol is kept.
- [x] REST optimisation: weight limiter, request spacing, 429/418 handling, batched market calls, volume pre-filter,
      and only 452 klines per surviving candidate.
- [x] Spot execution with exchange-side stop-loss orders (`STOP_LOSS` / `STOP_LOSS_LIMIT`), fill reconciliation and a
      market-sell backstop; Convert removed.
- [x] Schema v5 + v4 → v5 migration (paper tables); README / AGENT / schema.sql / openapi.yml updated.
- [x] HTTP hardening (HTTPS guard, session cookie, rate limits, security headers) wired into the app.

## Remaining tasks
- [ ] **Exercise paper mode end to end** (`MODE=test`): copied database, fake capital, simulated buy/sell/stop fills,
      dashboard **+ add test capital**.
- [ ] **Run `MODE=live` with the smallest possible capital first** and verify stop placement / ratchet / fill
      reconciliation against the real exchange.
- [ ] **Auto-reconcile a crash between "order executed" and "booked".** Today the ledger reports the drift and blocks
      entries; the order is findable by its client id. A `reconcile` pass should adopt or unwind it.
- [ ] Withdraw / unrelated balances: the ledger counts the *whole* free USDT of the account.
- [ ] Score / regime thresholds are uncalibrated phase-1 guesses (spec §16); run ablations.
- [ ] Consider a websocket ticker if stop slippage between `STOP_POLL_SECONDS` checks matters.
- [ ] Dashboard: pagination for very long transaction logs; per-bot candle/feature inspector; an events view
      (`GET /api/bots/:id/events` already serves it).
- [ ] Optional: per-bot Telegram toggles, token rotation endpoint.
- [ ] Deployment notes (systemd/Docker volume for `data/`), HTTPS termination in front of the token.
