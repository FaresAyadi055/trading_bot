# Lightweight Binance spot trading bot (live version)

Trades a single **Donchian-40 / EMA200** breakout strategy ([`bot/BOT_SPEC.md`](bot/BOT_SPEC.md)) on 4-hour Binance
spot candles with **real orders and a resting stop-loss on the exchange**. REST only (no websocket), state /
persistence / transaction logs in `bun:sqlite`, Hono API + a client-side rendered dashboard. Designed to run on a
Raspberry Pi Zero 2W (about 35 MB RSS).

| `MODE` | Execution | Funds |
|---|---|---|
| `live` | Binance **spot** (`/api/v3/*`) on `api.binance.com` | **real** |
| `test` | **paper trading**: real mainnet prices, simulated fills, fake USDT | none |

```sh
bun install
cp .env.example .env        # set ACCESS_TOKEN and MODE; live also needs BINANCE_API_KEY/SECRET (Telegram optional)
bun run dev                 # http://localhost:3000/bot
bun test                    # unit + lifecycle + capital + live-execution + paper + security tests (mock exchange)
bun run smoke               # end-to-end: app + worker against a mock Binance and a mock account
```

> **Start with `MODE=test`.** It needs no Binance keys: it reads real mainnet prices but keeps the books in a
> separate `data-test/trading.sqlite` copy, so nothing it does can reach the real account. Switching to `MODE=live`
> spends real money.

## Paper trading (`MODE=test`)
- **No API keys.** The exchange is a local simulator (`PaperExchange` in `src/exchange.ts`): fills happen at the real
  public ticker price with 10 bps slippage and 0.1% fee per side, and resting stops are simulated too.
- **Its own database.** On first boot the live database (`DB_PATH`, or `TEST_DB_SOURCE`) is copied with `VACUUM INTO`
  to `data-test/trading.sqlite` (`TEST_DB_PATH`); the app then only ever opens the copy. Delete the folder or set
  `TEST_DB_RESET=1` to start over from the current live books. `DB_PATH` is never used as the working database in
  test mode, so a paper run cannot touch the live account.
- **Fake capital.** A new paper account starts with `PAPER_START_USDT` (default 10,000), or enough to back the copied
  bots. Use **“+ add test capital”** in the dashboard capital panel (or `POST /api/paper/capital`) to credit more.
- The worker still fetches real mainnet candles/universe, so the strategy is evaluated on live data.

## Live version: what is different
- **Spot API key.** Create the key with *Reading* + *Spot trading*, **no withdrawals**, and whitelist the server IP.
- **Real fills are booked.** The engine only *decides*; `src/live.ts` places the order right after each 4h bar closes
  and books the actual fill (price, quantity, fee, exchange order id → `transactions.order_ref`). Nothing is simulated
  on the live path.
- **The stop-loss rests on Binance.** Right after a BUY the bot places a `STOP_LOSS` sell order (falling back to
  `STOP_LOSS_LIMIT` when the symbol rejects it) at `max(hardStop, trailStop − 0.75 ATR)`. It is cancelled and
  re-placed whenever the trail ratchets. A price monitor (`STOP_POLL_SECONDS`) reconciles the order — it books an
  exchange fill, recreates a missing stop, and keeps a market-sell backstop if the order could not be placed.
- **Capital ledger** (`src/capital.ts`, `GET /api/capital`, dashboard panel). The bots are sub-allocations of the real
  account: `unallocated = free USDT − Σ bot cash`, `allocated = Σ (bot cash + open position cost)`,
  `actual capital = free USDT + open position cost`. Creating a bot, raising its capital or activating it is refused
  (**409 `over_allocation` / `capital_shortfall`**) when it does not fit; the check runs on a fresh balance and the
  insert is synchronous, so two concurrent requests cannot both claim the same USDT. If the balance cannot be read the
  request fails closed (503). Before every buy the real balances are compared with the books again.
- **No playback after an interruption.** There is no periodic connectivity probe. If 4h bars close while the process
  was down or offline, `skipStaleBars` drops them: those bars are **skipped, never replayed**, and time-based state
  (bars held, cooldown) still advances. Telegram messages are sent only when a real Binance request fails (candles,
  universe scan, balances, prices) or an order is rejected — never for connectivity or heartbeats.
- **Safe order handling.** Buys are never retried (a missed trade is cheap, a double buy is not); a buy whose fill is
  more than `MAX_ENTRY_SLIPPAGE_PCT` above the reference price is refused. Sells are retried with back-off until they
  go through, and every order carries a client order id so an ambiguous failure is resolved before retrying.

## Strategy and dynamic universe
- **One strategy: Donchian-40 / EMA200, 4h long-only.** Entry on a 40-bar breakout above the prior 40 highs, close
  above EMA200 (`min_periods=400`), volume between 1.5× and 5× its 20-bar average, and no entry more than 2 ATR above
  the channel. Initial stop 3 ATR, hard stop 3.5 ATR (resting), trail 3 ATR, stagnation exit at bar 36 if the trade
  never reached +1R, time stop at 180 bars. Sizing uses the worst-case stop distance (hard stop + 5× stop slippage)
  and caps a position at 30% of equity.
- **No manual asset selection.** A dynamic universe filter (`src/universe.ts`) is rebuilt every 24h (6 closed 4h
  bars) using three layers: (1) eligibility from `exchangeInfo` (TRADING, USDT quote, spot, no stable/leveraged/wrapped
  assets), (2) 24h quote volume ≥ $10M, (3) at least 450 contiguous 4h bars. Survivors are ranked by 24h volume and
  capped at the configured maximum. The maximum number of assets is stored in the database and editable from the
  API/dashboard.
- **Bot instances** follow the global universe. They have their own USDT portfolio (a slice of the account, see the
  capital ledger), state and transaction log. Activate / deactivate, change capital, delete: each either immediately
  or **after the current trade exits**. Download all bot data as JSON. A held symbol stays in the bot's list until the
  trade exits even if it drops out of the universe.
- **REST budget.** The worker is the only process that fetches candles / universe data (the paper exchange also reads
  the public ticker). It spaces requests, keeps a conservative
  weight limiter (≤1200/min vs Binance's 6000), honours 429/418 `Retry-After`, uses one `exchangeInfo` /
  `ticker/24hr` call for the whole market, and requests only 452 klines per candidate that already passed the
  $10M/24h volume pre-filter.
- **Data is pulled only when needed.** An asset is fetched only if at least one *active* bot follows it. While a bot is
  in a trade it needs only the asset it is trading. Stored candles of assets nobody references are purged.
- **State always lives in SQLite**: positions, pending orders, regime, cooldown, drawdown pause, degradation, rolling R,
  the daily accumulator and the last processed bar are committed atomically per bar. Schema upgrades run automatically
  (`src/migrate.ts`).
- **Telegram notifications** (set `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID`), each naming the bot and the strategy:
  entry signal queued, **BUY**, exit signal queued, **SELL** (P/L, R, reason), stop placed/tightened, bot lifecycle,
  failed orders with the Binance API error reason, failed functional API requests (candles, universe, balances,
  prices), blocked signals (at most once per 24h per symbol/reason), and a daily summary every 6th candle (including
  the universe filter funnel; the full asset list is on the dashboard). Messages are queued in SQLite (outbox) and
  retried.

## Dashboard
`/bot` (alias `/bot/dashboard`): sign in with the access token (exchanged for an HttpOnly session cookie). A **LIVE**
(red) / **TEST** (amber, paper trading) badge shows the mode. The **universe panel** shows the selected assets, the
candidate count, the last refresh and the configurable maximum (with a manual refresh button). The **capital panel**
shows actual capital, allocated, unallocated, USDT free / locked, drift warnings and each bot's share; in test mode it
also has **+ add test capital** to credit fake USDT. Per bot: equity / P/L, position and strategy, regime and
protections, analytics and the transaction log.

## Security
- Plaintext API traffic is refused (`FORCE_HTTPS`, loopback exempt) and page requests redirect to HTTPS. Behind
  Cloudflare Tunnel set `TRUST_PROXY=1` so the forwarded scheme/host and client IP are trusted.
- The access token is exchanged for a signed, HttpOnly, Secure, SameSite=Strict session cookie; scripts can keep using
  `Authorization: Bearer <token>`.
- Per-IP failed-auth lockout and a per-IP API request budget. Security headers (CSP, HSTS, nosniff, frame deny) are set
  on every response.

## Configuration (`.env`)
| Variable | Default | |
|---|---|---|
| `ACCESS_TOKEN` | — | required (dashboard / API token) |
| `MODE` | — | **required**: `live` (spot, real funds) or `test` (paper trading) |
| `BINANCE_API_KEY`, `BINANCE_API_SECRET` | — | **required in live mode**; spot key, no withdrawals. Ignored in test mode |
| `PORT` | 3000 | |
| `DB_PATH` | `data/trading.sqlite` | live database; in test mode it is the copy source (the paper DB is always separate) |
| `PAPER_START_USDT` | 10000 | fake USDT seeded into a new paper account (test mode) |
| `TEST_DB_PATH` | `data-test/trading.sqlite` | paper database file (test mode) |
| `TEST_DB_SOURCE` | `DB_PATH` or `data/trading.sqlite` | live database copied into the paper DB on first boot (test mode) |
| `TEST_DB_RESET` | 0 | `1` = re-copy the live database and reset the paper account on boot (test mode) |
| `BINANCE_BASE_URL` | `https://api.binance.com` | execution + account endpoint (live mode only) |
| `BINANCE_DATA_URL` | `https://api.binance.com` | public candles / universe / paper prices (mainnet in both modes) |
| `FETCH_DELAY_MS` | 5000 | wait after each 4h boundary before fetching |
| `STOP_POLL_SECONDS` | 15 | resting-stop reconciliation + backstop period (min 5) |
| `MAX_ENTRY_SLIPPAGE_PCT` | 1 | refuse a buy priced more than this above the reference |
| `BALANCE_TTL_SECONDS` | 10 | balance cache for the dashboard / ledger view |
| `TRUST_PROXY` | 0 | honour `X-Forwarded-*` / `CF-Connecting-IP` (Cloudflare Tunnel / reverse proxy) |
| `FORCE_HTTPS` | 1 | set `0` only on a trusted LAN |
| `SESSION_SECRET` | access token | optional separate key for session cookies |
| `SESSION_TTL_SECONDS` | 43200 | session cookie lifetime |
| `AUTH_RATE_LIMIT_MAX` / `AUTH_RATE_LIMIT_WINDOW_SECONDS` / `AUTH_RATE_LIMIT_BLOCK_SECONDS` | 5 / 300 / 900 | failed-login budget and lockout |
| `API_RATE_LIMIT_MAX` / `API_RATE_LIMIT_WINDOW_SECONDS` | 240 / 60 | per-IP API budget |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` | — | optional, but strongly recommended in live mode |

The app refuses to start when `ACCESS_TOKEN` or `MODE` is missing, `MODE` is not `live|test`, or live-mode API
credentials are absent. `MODE=test` never reads `BINANCE_API_KEY` / `BINANCE_API_SECRET`.

## Behaviour worth knowing
- **Regime needs ≥ 4 assets including `BTCUSDT`** in the bot's tracked set (spec §8); otherwise it stays NEUTRAL.
  While a bot holds a position only the held asset is pulled, so the regime is frozen (kept, not reset) until it exits.
- A bar is evaluated once every asset the bot tracks has it (or 10 minutes after it closed, so a halted pair cannot stall
  a bot).
- Sizing follows the spec (0.75% risk, position ≤ 30% of equity, rejects notional < 10 USDT).
- Live fills differ from the 4h open used by the signal; P/L is booked from the real fill. Stop slippage is stress-tested
  at 5× in the risk budget.
- After downtime a position is not checked against its close-based trail for the skipped bars (no replay); the
  resting hard stop and the 180-bar time cap still apply.
- Deactivating / deleting a bot "now" sells the position for real first; if that sell fails the request errors and the
  position stays managed (the sell is retried automatically).

## Documentation
`AGENT.md` architecture and remaining tasks · `schema.sql` locked DB schema (v4) · `openapi.yml` HTTP API ·
`bot/BOT_SPEC.md` strategy and universe specification.
