import { test, expect } from 'bun:test'
import { Database } from 'bun:sqlite'
import { readFileSync } from 'node:fs'
import { ensureSchema } from '../src/schema'

// schema v1 exactly as shipped before the strategy rewrite
const V1 = `
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID;
CREATE TABLE candles (symbol TEXT NOT NULL, open_time INTEGER NOT NULL, open REAL NOT NULL, high REAL NOT NULL, low REAL NOT NULL, close REAL NOT NULL, volume REAL NOT NULL, PRIMARY KEY (symbol, open_time)) WITHOUT ROWID;
CREATE TABLE symbol_features (symbol TEXT PRIMARY KEY, bar_time INTEGER NOT NULL, features TEXT NOT NULL, updated_at INTEGER NOT NULL) WITHOUT ROWID;
CREATE TABLE bots (id TEXT PRIMARY KEY, name TEXT NOT NULL, assets TEXT NOT NULL, initial_capital REAL NOT NULL, cash REAL NOT NULL, status TEXT NOT NULL CHECK (status IN ('active','inactive')), pending_action TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL) WITHOUT ROWID;
CREATE TABLE bot_asset_state (bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE, symbol TEXT NOT NULL, last_processed_bar INTEGER, state TEXT NOT NULL, PRIMARY KEY (bot_id, symbol)) WITHOUT ROWID;
CREATE TABLE transactions (id INTEGER PRIMARY KEY AUTOINCREMENT, bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE, ts INTEGER NOT NULL, bar_time INTEGER, symbol TEXT, action TEXT NOT NULL CHECK (action IN ('BUY','SELL','CAPITAL')), strategy TEXT, price REAL, qty REAL, notional REAL, fee REAL, pnl REAL, pnl_pct REAL, r_multiple REAL, exit_reason TEXT, cash_after REAL NOT NULL, notified INTEGER NOT NULL DEFAULT 0);
CREATE INDEX idx_tx_bot ON transactions (bot_id, id);
CREATE INDEX idx_tx_unnotified ON transactions (id) WHERE notified = 0;
CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE, ts INTEGER NOT NULL, kind TEXT NOT NULL, symbol TEXT, detail TEXT);
INSERT INTO meta VALUES ('schema_version','1');
`

test('v1 database is upgraded in place: open position kept, tables reshaped', () => {
  const db = new Database(':memory:')
  db.exec('PRAGMA foreign_keys = ON;'); db.exec(V1)
  db.query("INSERT INTO bots VALUES ('b1','old','[\"BTCUSDT\",\"ETHUSDT\"]',1000,700,'active',NULL,1,1)").run()
  const pos = { strategy: 'C', entryTime: 5, entryFill: 100, qty: 3, entryFee: 0.3, signalAtr: 2, initialStop: 96, stop: 99, restStop: 99, hardStop: 92, highestClose: 101, highestHigh: 103, lowestLow: 99, barsHeld: 4, initialRisk: 4, initialRiskCash: 12 }
  const base = { position: null, pendingOrder: null, peakEquity: 1000, drawdownPct: 0, paused: false, pauseUntilBar: 0, cooldownLeft: 0, consecutiveLosses: 0, rollingWindowR: [], recentTradeR: { A: [], C: [] }, degradation: { A: null, C: null }, tradeCounters: { trades: 2 }, rejectionCounters: {} }
  db.query("INSERT INTO bot_asset_state VALUES ('b1','BTCUSDT',900,?)").run(JSON.stringify({ ...base, position: pos, cooldownLeft: 3 }))
  db.query("INSERT INTO bot_asset_state VALUES ('b1','ETHUSDT',900,?)").run(JSON.stringify({ ...base, pendingOrder: { type: 'ENTRY', strategy: 'A', signalAtr: 1, queuedBar: 1 } }))
  db.query("INSERT INTO transactions(bot_id,ts,action,cash_after) VALUES ('b1',1,'BUY',700)").run()
  ensureSchema(db)
  expect((db.query("SELECT value FROM meta WHERE key='schema_version'").get() as any).value).toBe('3')
  const row = db.query("SELECT last_processed_bar l, state s FROM bot_state WHERE bot_id='b1'").get() as any
  const st = JSON.parse(row.s)
  expect(row.l).toBe(900)
  expect(st.position).toMatchObject({ symbol: 'BTCUSDT', strategy: 'C', qty: 3, riskUsdt: 12, ratcheted: true })
  expect(st.pending).toBeNull() // unfilled entries are dropped
  expect(st.cooldown).toBe(3)
  expect(st.regime.state).toBe(1)
  expect(db.query("SELECT 1 FROM sqlite_master WHERE name='bot_asset_state'").get()).toBeNull()
  expect(db.query("SELECT 1 FROM pragma_table_info('transactions') WHERE name='notified'").get()).toBeNull()
  expect((db.query('SELECT COUNT(*) n FROM transactions').get() as any).n).toBe(1)
  ensureSchema(db) // idempotent
  expect((db.query('SELECT COUNT(*) n FROM bot_state').get() as any).n).toBe(1)
})

test('fresh database starts at v3 and matches schema.sql', () => {
  const db = new Database(':memory:')
  ensureSchema(db)
  expect((db.query("SELECT value FROM meta WHERE key='schema_version'").get() as any).value).toBe('3')
  for (const t of ['bot_state', 'notifications', 'candles', 'symbol_features', 'bots', 'transactions', 'events', 'meta'])
    expect(db.query("SELECT 1 FROM sqlite_master WHERE name=?").get(t)).not.toBeNull()
  expect(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8')).toContain('version 3')
})
