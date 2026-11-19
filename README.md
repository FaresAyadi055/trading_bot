# Lightweight Binance spot trading bot (live simulation)

Live paper-trading of the **Donchian + VCEB** strategy ([`bot/BOT_SPEC.md`](bot/BOT_SPEC.md)) on 4-hour Binance spot
candles. REST only (no websocket), state / persistence / transaction logs in `bun:sqlite`, Hono API + a client-side
rendered dashboard.

```sh
bun install
cp .env.example .env        # set ACCESS_TOKEN (and optionally Telegram)
bun run dev                 # http://localhost:3000/bot
bun test                    # unit + lifecycle + migration tests
bun run smoke               # end-to-end against a mock Binance
bun run parity              # engine vs the spec's Python reference (needs python3 + pandas + numpy)
```

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
- **Bot instances** with their own USDT portfolio, state and transaction log. Activate / deactivate, edit assets, change
  capital, delete: each either immediately or **after the current trade exits**. Download all bot data as JSON.
- **Data is pulled only when needed.** An asset is fetched from Binance only if at least one *active* bot listens to it.
  While a bot is in a trade (or has an order pending) it needs only the asset it is trading, so the other assets of that
  bot stop being pulled until it exits (unless another bot still listens to them). Stored candles of assets no active bot
  references are purged.
- **State always lives in SQLite**: positions, pending orders, regime, cooldown, drawdown pause, degradation, rolling R,
  the daily accumulator and the last processed bar are committed atomically per bar, so a crash or restart resumes
  exactly where it stopped. Missed bars are replayed on restart. Schema upgrades run automatically (`src/migrate.ts`).
- **Telegram notifications** (set `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID`), each naming the bot and the strategy used
  (*Donchian (A)* or *VCEB (C)*):
  - every bot action: entry signal queued, **BUY**, exit signal queued, **SELL** (P/L, R, reason), kill-switch stop
    tightening, bot started / activated / deactivated / auto-stopped;
  - **trades blocked by a filter** — one message per bar listing each blocked signal and why (C quality gate, score below
    the regime minimum, strategy degraded, stop-band / cost gates, slot taken by a better candidate, cooldown, drawdown
    pause, rolling-loss cap, minimum notional). The same blocked signal is alerted at most once per 24h;
  - a **daily summary** after every 6th candle (the 20:00 UTC bar, i.e. at 00:00 UTC): actions of the day, bot status
    (position, equity, P/L, regime, protections) and generic 24h market stats of the assets the bot can see.
  Messages are queued in SQLite (outbox) and retried, so outages never lose them.

## Dashboard
`/bot` (alias `/bot/dashboard`): sign in with the access token, create bots from the asset picker, see equity / P/L,
position and strategy, regime and protections, analytics and the transaction log. Live prices and the asset list are
requested by the browser directly from Binance, never through the Hono server.

## Configuration (`.env`)
| Variable | Default | |
|---|---|---|
| `ACCESS_TOKEN` | — | required |
| `PORT` | 3000 | |
| `DB_PATH` | `data/trading.sqlite` | |
| `BINANCE_BASE_URL` | `https://api.binance.com` | also used by the dashboard for the asset list |
| `FETCH_DELAY_MS` | 5000 | wait after each 4h boundary before fetching |
| `MAX_ASSETS_PER_BOT` | 50 | |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` | — | optional |

## Behaviour worth knowing
- **Regime needs ≥ 4 assets including `BTCUSDT`** in the bot's universe (spec §8, §16); otherwise it stays NEUTRAL
  (min score 0.60, risk x0.75). While a bot holds a position only the held asset is pulled, so the regime is frozen
  (kept, not reset) until it exits.
- A bar is evaluated once every asset the bot tracks has it (or 10 minutes after it closed, so a halted pair cannot stall
  a bot).
- Sizing follows the spec (0.75% risk, rejects notional < 10 USDT); the old "small account all-in" rule is gone.
- Strategy C is deliberately rare (gated). See `bot/BOT_SPEC.md` §0 and §14 before judging it.

## Documentation
`AGENT.md` architecture, decisions and remaining tasks · `schema.sql` locked DB schema (v2) · `openapi.yml` HTTP API ·
`bot/BOT_SPEC.md` strategy specification.
