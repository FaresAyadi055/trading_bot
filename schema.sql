-- LOCKED DATABASE SCHEMA (version 1) -- bun:sqlite
-- Applied idempotently at startup (src/db.ts). Do not change without a migration.
-- Constant-size tables: candles (rolling window per symbol), symbol_features (1 row / symbol),
-- meta. Scaling tables: bots, bot_asset_state, transactions, events (events capped per bot).
-- Every bot-owned table references bots(id) ON DELETE CASCADE, so deleting a bot removes its footprint.

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
) WITHOUT ROWID;

-- Rolling candle window (newest WINDOW rows kept per symbol; older rows are pruned on every insert).
CREATE TABLE IF NOT EXISTS candles (
  symbol    TEXT    NOT NULL,
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
  features   TEXT    NOT NULL,          -- JSON
  updated_at INTEGER NOT NULL
) WITHOUT ROWID;

-- Bot instances. One portfolio (USDT cash) per bot.
CREATE TABLE IF NOT EXISTS bots (
  id              TEXT PRIMARY KEY,
  name            TEXT    NOT NULL,
  assets          TEXT    NOT NULL,     -- JSON array of symbols, e.g. ["BTCUSDT","ETHUSDT"]
  initial_capital REAL    NOT NULL,     -- USDT capital base (changed by capital updates)
  cash            REAL    NOT NULL,     -- free USDT
  status          TEXT    NOT NULL CHECK (status IN ('active','inactive')),
  pending_action  TEXT,                 -- JSON array of actions waiting for the trade to exit
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
) WITHOUT ROWID;

-- Per-bot, per-asset persisted decision state (position, pending order, cooldowns, counters...).
CREATE TABLE IF NOT EXISTS bot_asset_state (
  bot_id             TEXT    NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  symbol             TEXT    NOT NULL,
  last_processed_bar INTEGER,           -- open_time of the last evaluated closed candle
  state              TEXT    NOT NULL,  -- JSON (see src/types.ts AssetState)
  PRIMARY KEY (bot_id, symbol)
) WITHOUT ROWID;

-- Transaction log (BUY / SELL / CAPITAL adjustments), one append-only log per bot.
CREATE TABLE IF NOT EXISTS transactions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  bot_id      TEXT    NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  ts          INTEGER NOT NULL,
  bar_time    INTEGER,
  symbol      TEXT,
  action      TEXT    NOT NULL CHECK (action IN ('BUY','SELL','CAPITAL')),
  strategy    TEXT,                     -- 'A' | 'C'
  price       REAL,
  qty         REAL,
  notional    REAL,
  fee         REAL,
  pnl         REAL,                     -- net USDT, SELL only
  pnl_pct     REAL,                     -- net % on cost basis, SELL only
  r_multiple  REAL,                     -- SELL only
  exit_reason TEXT,                     -- STOP|HARD_STOP|KILL|TIME|TRAIL|MANUAL
  cash_after  REAL    NOT NULL,
  notified    INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_tx_bot ON transactions (bot_id, id);
CREATE INDEX IF NOT EXISTS idx_tx_unnotified ON transactions (id) WHERE notified = 0;

-- Lifecycle / rejection log (capped to the newest 200 rows per bot).
CREATE TABLE IF NOT EXISTS events (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  bot_id TEXT    NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  ts     INTEGER NOT NULL,
  kind   TEXT    NOT NULL,
  symbol TEXT,
  detail TEXT
);
CREATE INDEX IF NOT EXISTS idx_events_bot ON events (bot_id, id);

INSERT OR IGNORE INTO meta (key, value) VALUES ('schema_version', '1');
