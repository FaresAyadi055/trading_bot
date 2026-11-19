# Lightweight Binance spot trading bot (live version)

Trades the **Donchian + VCEB** strategy ([`bot/BOT_SPEC.md`](bot/BOT_SPEC.md)) on 4-hour Binance spot candles with
**real orders**. REST only (no websocket), state / persistence / transaction logs in `bun:sqlite`, Hono API + a
client-side rendered dashboard.

| `MODE` | Execution | Funds |
|---|---|---|
| `live` | **Binance Convert** (`/sapi/v1/convert/*`) on `api.binance.com` | **real** |
| `test` | spot **market orders** on `testnet.binance.vision` (the testnet has no Convert endpoints) | play money |

```sh
bun install
cp .env.example .env        # set ACCESS_TOKEN, MODE, BINANCE_API_KEY, BINANCE_API_SECRET (and optionally Telegram)
bun run dev                 # http://localhost:3000/bot
bun test                    # unit + lifecycle + capital + live-execution + interrupt tests (mock exchange)
bun run smoke               # end-to-end: app + worker against a mock Binance and a mock account
bun run parity              # engine vs the spec's Python reference (needs python3 + pandas + numpy)
```

> **Start with `MODE=test`.** Switching to `MODE=live` spends real money. The two modes should use different
> `DB_PATH`s: the books of a testnet run must never be mixed with a real account.

## Live version: what is different
- **API key = Convert only.** Create the key with *Reading* + the Convert/trade permission, **no withdrawals**, and
  whitelist the server IP. In `MODE=test` use the keys from <https://testnet.binance.vision>.
- **Real fills are booked.** The engine only *decides*; `src/live.ts` places the order right after each 4h bar closes
  and books the actual fill (price, quantity, fee, exchange order id → `transactions.order_ref`). Nothing is simulated
  on the live path.
- **Capital ledger** (`src/capital.ts`, `GET /api/capital`, dashboard panel). The bots are sub-allocations of the real
  account: `unallocated = free USDT − Σ bot cash`, `allocated = Σ (bot cash + open position cost)`,
  `actual capital = free USDT + open position cost`. Creating a bot, raising its capital or activating it is refused
  (**409 `over_allocation` / `capital_shortfall`**) when it does not fit; the check runs on a fresh balance and the
  insert is synchronous, so two concurrent requests cannot both claim the same USDT. If the balance cannot be read the
  request fails closed (503). A scheduled capital increase is re-checked when it is applied. Before every buy the real
  balances are compared with the books again; on drift (account holds less than the bots claim) entries are blocked.
- **No playback after an interruption.** The old catch-up replay of missed bars is gone. A heartbeat probes Binance
  every `HEARTBEAT_SECONDS` and stores `heartbeat_at` only while it is reachable. When the first successful probe after
  a gap longer than `INTERRUPT_MIN_SECONDS` happens (process restart *or* network / Binance outage), the bars that
  closed meanwhile are **skipped, never replayed**, open positions are re-checked against their stops immediately, and
  **one Telegram alert** is sent: offline window, number of skipped bars, per-bot position / stop levels and the
  capital reconciliation.
- **Stops are enforced by a price monitor.** Convert has no resting stop orders, so every `STOP_POLL_SECONDS` the last
  price of each held asset is compared with the position's stop levels (VCEB stop / trail, hard stop of both
  strategies); a breach sells at market. Donchian's close-based 3 ATR trail is still evaluated on closed bars.
- **Safe order handling.** Buys are never retried (a missed trade is cheap, a double buy is not); a buy whose Convert
  quote is more than `MAX_ENTRY_SLIPPAGE_PCT` above the reference price is refused before it is accepted. Sells are
  retried with back-off until they go through, an ambiguous Convert accept is resolved by quote id, and the testnet
  orders carry a client order id.

## What it does
- **Any Binance spot USDT pair.** The dashboard has a searchable dropdown (fed straight from the Binance API, most
  liquid first). The server verifies a pair is a `TRADING` spot `…USDT` symbol before a bot may use it.
- **Two strategies, evaluated on every asset of a bot, one position slot per bot**
  - **A — Donchian** (40-bar channel breakout, trend + volume filter, close-based 3 ATR trail), primary.
  - **C — VCEB** (10-bar breakout out of a Bollinger squeeze, quality-gated, 1.5x volume, resting trail), secondary.
  - Per asset the higher-scoring eligible strategy is the candidate; the best candidate across the bot's assets takes
    the slot. A BTC-trend + breadth regime (BULL / NEUTRAL / BEAR) sets the minimum score and risk multiplier.
  - No decision tree and no runtime schema library (Zod is removed): the rules are plain TypeScript
    (`src/features.ts`, `src/strategy.ts`, `src/engine.ts`, constants in `src/params.ts`) and are parity-tested
    trade-for-trade against the spec's reference implementation.
- **Bot instances** with their own USDT portfolio (a slice of the account, see the capital ledger), state and transaction log. Activate / deactivate, edit assets, change
  capital, delete: each either immediately or **after the current trade exits**. Download all bot data as JSON.
- **Data is pulled only when needed.** An asset is fetched from Binance only if at least one *active* bot listens to it.
  While a bot is in a trade (or has an order pending) it needs only the asset it is trading, so the other assets of that
  bot stop being pulled until it exits (unless another bot still listens to them). Stored candles of assets no active bot
  references are purged.
- **State always lives in SQLite**: positions, pending orders, regime, cooldown, drawdown pause, degradation, rolling R,
  the daily accumulator and the last processed bar are committed atomically per bar, so a crash or restart resumes
  exactly where it stopped. Bars missed while offline are skipped (not replayed) and reported by Telegram. Schema upgrades run automatically (`src/migrate.ts`).
- **Telegram notifications** (set `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID`), each naming the bot and the strategy used
  (*Donchian (A)* or *VCEB (C)*):
  - every bot action: entry signal queued, **BUY**, exit signal queued, **SELL** (P/L, R, reason), kill-switch stop
    tightening, bot started / activated / deactivated / auto-stopped, failed orders (BUY / SELL with the Binance API error reason), rejected capital increases;
  - the **interrupt alert** after a reconnect (see above);
  - **trades blocked by a filter** — one message per bar listing each blocked signal and why (C quality gate, score below
    the regime minimum, strategy degraded, stop-band / cost gates, slot taken by a better candidate, cooldown, drawdown
    pause, rolling-loss cap, minimum notional). The same blocked signal is alerted at most once per 24h;
  - a **daily summary** after every 6th candle (the 20:00 UTC bar, i.e. at 00:00 UTC): actions of the day, bot status
    (position, equity, P/L, regime, protections) and generic 24h market stats of the assets the bot can see.
  Messages are queued in SQLite (outbox) and retried, so outages never lose them.

## Dashboard
`/bot` (alias `/bot/dashboard`): sign in with the access token. A **LIVE** (red) / **TEST** (amber) badge shows the mode.
The **capital panel** shows actual capital, allocated, unallocated, USDT free / locked, a positions / bot cash /
unallocated bar, drift warnings and each bot's share; the create / edit dialogs show the unallocated amount. Per bot:
equity / P/L, position and strategy, regime and protections, analytics and the transaction log. Live prices and the asset list are
requested by the browser directly from Binance, never through the Hono server.

## Configuration (`.env`)
| Variable | Default | |
|---|---|---|
| `ACCESS_TOKEN` | — | required (dashboard / API bearer token) |
| `MODE` | — | **required**: `live` (Binance Convert, real funds) or `test` (spot testnet) |
| `BINANCE_API_KEY`, `BINANCE_API_SECRET` | — | **required**; Convert-only key, no withdrawals |
| `PORT` | 3000 | |
| `DB_PATH` | `data/trading.sqlite` | use a different file per mode |
| `BINANCE_BASE_URL` | mainnet (live) / testnet (test) | execution + account endpoint |
| `BINANCE_DATA_URL` | `https://api.binance.com` | public candles + asset list (mainnet in both modes: testnet candles are sparse) |
| `FETCH_DELAY_MS` | 5000 | wait after each 4h boundary before fetching |
| `STOP_POLL_SECONDS` | 15 | price-monitor period for stops (min 5) |
| `HEARTBEAT_SECONDS` | 15 | connectivity probe period (min 5) |
| `INTERRUPT_MIN_SECONDS` | 120 | gap that counts as an interruption (min 30) |
| `MAX_ENTRY_SLIPPAGE_PCT` | 1 | refuse a buy priced more than this above the reference |
| `BALANCE_TTL_SECONDS` | 10 | balance cache for the dashboard / ledger view (order guards always read fresh) |
| `MAX_ASSETS_PER_BOT` | 50 | |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` | — | optional, but strongly recommended in live mode |

The app refuses to start when `ACCESS_TOKEN`, `MODE` or the API credentials are missing or `MODE` is not `live|test`.

## Behaviour worth knowing
- **Regime needs ≥ 4 assets including `BTCUSDT`** in the bot's universe (spec §8, §16); otherwise it stays NEUTRAL
  (min score 0.60, risk x0.75). While a bot holds a position only the held asset is pulled, so the regime is frozen
  (kept, not reset) until it exits.
- A bar is evaluated once every asset the bot tracks has it (or 10 minutes after it closed, so a halted pair cannot stall
  a bot).
- Sizing follows the spec (0.75% risk, rejects notional < 10 USDT); the old "small account all-in" rule is gone.
- Only assets Binance Convert can convert with USDT are accepted in live mode. Convert quotes include the spread, so
  live fills differ from the 4h open used by the signal; P/L is booked from the real fill.
- After an interruption a Donchian position is not checked against its close-based trail for the skipped bars (no
  replay); the hard stop (price monitor) and the 180-bar time cap still apply (the time cap counts the skipped bars).
- Deactivating / deleting / editing "now" sells the position for real first; if that sell fails the request errors and
  the position stays managed (the sell is retried automatically).
- Strategy C is deliberately rare (gated). See `bot/BOT_SPEC.md` §0 and §14 before judging it.

## Documentation
`AGENT.md` architecture, decisions and remaining tasks · `schema.sql` locked DB schema (v2) · `openapi.yml` HTTP API ·
`bot/BOT_SPEC.md` strategy specification.
