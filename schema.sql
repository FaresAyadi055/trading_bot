-- LOCKED DATABASE SCHEMA (version 5) -- bun:sqlite
-- Applied idempotently at startup (src/schema.ts). Do not change without a migration (src/migrate.ts).
-- v1 -> v2 (strategy rewrite: Donchian + VCEB spec, any Binance USDT asset):
--   + bot_state       one account/position/regime state row per bot (replaces bot_asset_state)
--   + notifications   Telegram outbox (replaces transactions.notified)
--   - bot_asset_state, transactions.notified, idx_tx_unnotified   (dropped by the migration)
-- v2 -> v3 (live version):
--   + transactions.order_ref   exchange order reference (spot orderId) of real fills
-- v3 -> v4 (Donchian-only + dynamic universe):
--   + universe        the selected dynamic universe and every evaluated candidate's metrics
-- v4 -> v5 (paper trading):
--   + paper_account   fake balances of MODE=test (never populated in a live database)
--   + paper_orders    simulated resting stop orders of MODE=test (never populated in a live database)
--   meta keys used: worker_last_cycle, last_processed_at, worker_error, schema_version,
--   universe_max_assets, universe_updated_at, universe_updated_bar, universe_total_symbols,
--   universe_eligible_symbols, universe_progress, universe_error.
-- The real account balance is never stored: the capital ledger (src/capital.ts) reads it from the exchange on demand.
-- The paper tables are the exception: in MODE=test they hold the simulated account of the `data-test/` database copy.
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
  assets          TEXT    NOT NULL,     -- JSON array of symbols: the dynamic universe snapshot (plus a held symbol)
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
  strategy    TEXT,                     -- 'A' (Donchian)
  price       REAL,
  qty         REAL,
  notional    REAL,
  fee         REAL,
  pnl         REAL,                     -- net USDT, SELL only
  pnl_pct     REAL,                     -- net % on cost basis, SELL only
  r_multiple  REAL,                     -- SELL only
  exit_reason TEXT,                     -- STOP|HARD_STOP|KILL|TIME|TRAIL|MANUAL
  cash_after  REAL    NOT NULL,
  order_ref   TEXT                      -- exchange order id of the real fill (NULL for simulated fills)
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
  kind     TEXT    NOT NULL,            -- buy|sell|entry_queued|exit_queued|tighten|blocked|daily|lifecycle|api_error
  strategy TEXT,                        -- 'A' | 'C' | NULL
  text     TEXT    NOT NULL
);

-- Dynamic universe: every evaluated candidate (selected=1 for the trading list). Metrics is the JSON
-- snapshot from src/universe.ts (quoteVolume24h, bars, contiguous, historyOk, lastBar).
CREATE TABLE IF NOT EXISTS universe (
  symbol     TEXT PRIMARY KEY,
  selected   INTEGER NOT NULL,          -- 1 = in the trading universe
  rank       INTEGER,                   -- 24h quote-volume rank among history-ok candidates
  metrics    TEXT    NOT NULL,          -- JSON UniverseCandidate
  reason     TEXT    NOT NULL DEFAULT '',-- why it was rejected / removed ('' when selected)
  updated_at INTEGER NOT NULL,
  added_at   INTEGER                    -- when it entered the selected list (dashboard)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS idx_universe_selected ON universe (selected, rank);

-- Paper-trading account (MODE=test only). The live database never reads or writes these rows; the paper copy
-- starts from the live books and adds fake USDT through the dashboard ("Add test capital").
CREATE TABLE IF NOT EXISTS paper_account (
  asset  TEXT PRIMARY KEY,               -- USDT + every base asset held by a copied open position
  free   REAL NOT NULL DEFAULT 0,
  locked REAL NOT NULL DEFAULT 0
) WITHOUT ROWID;

-- Simulated resting stop orders (MODE=test only). Status mirrors Binance: NEW|FILLED|CANCELED.
CREATE TABLE IF NOT EXISTS paper_orders (
  order_ref  TEXT PRIMARY KEY,
  symbol     TEXT    NOT NULL,
  qty        REAL    NOT NULL,
  stop_price REAL    NOT NULL,
  status     TEXT    NOT NULL,
  created_at INTEGER NOT NULL
) WITHOUT ROWID;

INSERT OR IGNORE INTO meta (key, value) VALUES ('schema_version', '5');
