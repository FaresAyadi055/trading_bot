-- LOCKED DATABASE SCHEMA (version 2) -- bun:sqlite
-- Applied idempotently at startup (src/schema.ts). Do not change without a migration (src/migrate.ts).
-- v1 -> v2 (strategy rewrite: Donchian + VCEB spec, any Binance USDT asset):
--   + bot_state       one account/position/regime state row per bot (replaces bot_asset_state)
--   + notifications   Telegram outbox (replaces transactions.notified)
--   - bot_asset_state, transactions.notified, idx_tx_unnotified   (dropped by the migration)
-- Constant-size tables: candles (rolling window per symbol), symbol_features (1 row / symbol), meta.
-- Scaling tables: bots, bot_state (1 row / bot), transactions, events (capped per bot).
-- Every bot-owned table references bots(id) ON DELETE CASCADE, so deleting a bot removes its footprint.
-- Exception: notifications is a transient outbox (rows are deleted once delivered or after 24h).

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
) WITHOUT ROWID;

-- Rolling candle window (newest WINDOW rows kept per symbol; older rows are pruned on every insert).
-- Only symbols that at least one active bot may trade are ever fetched; a symbol nobody references is purged.
CREATE TABLE IF NOT EXISTS candles (
  symbol    TEXT    NOT NULL,           -- any Binance spot USDT pair, e.g. BTCUSDT, PEPEUSDT
  open_time INTEGER NOT NULL,           -- ms epoch, UTC 4h grid
  open      REAL    NOT NULL,
  high      REAL    NOT NULL,
  low       REAL    NOT NULL,
  close     REAL    NOT NULL,
  volume    REAL    NOT NULL,
  PRIMARY KEY (symbol, open_time)
) WITHOUT ROWID;

-- Latest computed market features, one row per symbol, overwritten every bar.
CREATE TABLE IF NOT EXISTS symbol_features (
  symbol     TEXT PRIMARY KEY,
  bar_time   INTEGER NOT NULL,
  features   TEXT    NOT NULL,          -- JSON (see src/features.ts latestMarket)
  updated_at INTEGER NOT NULL
) WITHOUT ROWID;

-- Bot instances. One portfolio (USDT cash) and ONE position slot per bot.
CREATE TABLE IF NOT EXISTS bots (
  id              TEXT PRIMARY KEY,
  name            TEXT    NOT NULL,
  assets          TEXT    NOT NULL,     -- JSON array of symbols, e.g. ["BTCUSDT","PEPEUSDT"] (the bot's universe)
  initial_capital REAL    NOT NULL,     -- USDT capital base (changed by capital updates)
  cash            REAL    NOT NULL,     -- free USDT
  status          TEXT    NOT NULL CHECK (status IN ('active','inactive')),
  pending_action  TEXT,                 -- JSON array of actions waiting for the trade to exit
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
) WITHOUT ROWID;

-- Everything a bot must remember between bars (position, pending order, regime, cooldown, pause,
-- degradation, rolling R, daily-summary accumulator, alert de-duplication). Rewritten atomically per bar.
CREATE TABLE IF NOT EXISTS bot_state (
  bot_id             TEXT PRIMARY KEY REFERENCES bots(id) ON DELETE CASCADE,
  last_processed_bar INTEGER,           -- open_time of the last evaluated closed candle
  state              TEXT    NOT NULL   -- JSON (see src/types.ts BotState)
) WITHOUT ROWID;

-- Transaction log (BUY / SELL / CAPITAL adjustments), one append-only log per bot.
CREATE TABLE IF NOT EXISTS transactions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  bot_id      TEXT    NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  ts          INTEGER NOT NULL,
  bar_time    INTEGER,
  symbol      TEXT,
  action      TEXT    NOT NULL CHECK (action IN ('BUY','SELL','CAPITAL')),
  strategy    TEXT,                     -- 'A' (Donchian) | 'C' (VCEB)
  price       REAL,
  qty         REAL,
  notional    REAL,
  fee         REAL,
  pnl         REAL,                     -- net USDT, SELL only
  pnl_pct     REAL,                     -- net % on cost basis, SELL only
  r_multiple  REAL,                     -- SELL only
  exit_reason TEXT,                     -- STOP|HARD_STOP|KILL|TIME|TRAIL|MANUAL
  cash_after  REAL    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tx_bot ON transactions (bot_id, id);

-- Lifecycle / signal / blocked-trade log (capped to the newest 200 rows per bot).
CREATE TABLE IF NOT EXISTS events (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  bot_id TEXT    NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  ts     INTEGER NOT NULL,
  kind   TEXT    NOT NULL,
  symbol TEXT,
  detail TEXT
);
CREATE INDEX IF NOT EXISTS idx_events_bot ON events (bot_id, id);

-- Telegram outbox. Messages are composed when the event happens and committed in the same SQLite
-- transaction as the bar that produced them, so a crash never loses or duplicates one. Delivered rows
-- are deleted; undelivered rows older than 24h are dropped. Nothing is queued when Telegram is not configured.
CREATE TABLE IF NOT EXISTS notifications (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  ts       INTEGER NOT NULL,
  bot_id   TEXT,                        -- informational only (no FK: a delivered-later SELL may outlive its bot)
  kind     TEXT    NOT NULL,            -- buy|sell|entry_queued|exit_queued|tighten|blocked|daily|lifecycle
  strategy TEXT,                        -- 'A' | 'C' | NULL
  text     TEXT    NOT NULL
);

INSERT OR IGNORE INTO meta (key, value) VALUES ('schema_version', '2');
