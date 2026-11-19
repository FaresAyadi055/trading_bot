// Schema migrations. v1 -> v2 converts the per-asset decision-tree state into the single per-bot state of the
// Donchian + VCEB strategy. Open positions survive; unfilled entry orders are dropped (no money at risk).
import type { Database } from 'bun:sqlite'
import { newBotState, newDay } from './engine'
import { barIndex } from './time'
import type { BotState, Position } from './types'

export const SCHEMA_VERSION = 3

export function migrate(db: Database, from: number): void {
  if (from < 2) v1ToV2(db)
  if (from < 3) v2ToV3(db)
  db.query("INSERT INTO meta(key,value) VALUES('schema_version',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(String(SCHEMA_VERSION))
}

function v1ToV2(db: Database) {
  db.transaction(() => {
    const hasOld = !!db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='bot_asset_state'").get()
    if (hasOld) {
      const bots = db.query('SELECT id, cash FROM bots').all() as { id: string; cash: number }[]
      const ins = db.query('INSERT OR IGNORE INTO bot_state(bot_id,last_processed_bar,state) VALUES(?,?,?)')
      for (const b of bots) {
        const rows = db.query('SELECT symbol,last_processed_bar,state FROM bot_asset_state WHERE bot_id=?').all(b.id) as { symbol: string; last_processed_bar: number | null; state: string }[]
        let last: number | null = null
        const st: BotState = newBotState(b.cash)
        for (const r of rows) {
          const o = JSON.parse(r.state)
          if (r.last_processed_bar != null) last = Math.max(last ?? 0, r.last_processed_bar)
          st.cooldown = Math.max(st.cooldown, o.cooldownLeft ?? 0)
          st.consecutiveLosses = Math.max(st.consecutiveLosses, o.consecutiveLosses ?? 0)
          for (const k of ['A', 'C'] as const) {
            if (o.degradation?.[k] != null) st.frozenUntil[k] = Math.max(st.frozenUntil[k], o.degradation[k])
            st.rHistory[k].push(...(o.recentTradeR?.[k] ?? []))
            st.rHistory[k] = st.rHistory[k].slice(-12)
          }
          st.closedR.push(...(o.rollingWindowR ?? []))
          for (const [k, v] of Object.entries(o.tradeCounters ?? {})) st.counters[k] = (st.counters[k] ?? 0) + (v as number)
          const p = o.position
          if (p) {
            const pos: Position = {
              symbol: r.symbol, strategy: p.strategy, entryTs: p.entryTime, entryFill: p.entryFill, qty: p.qty,
              notional: p.qty * p.entryFill + (p.entryFee ?? 0), initialStop: p.initialStop, stop: p.stop, hardStop: p.hardStop,
              highestClose: p.highestClose, highestHigh: p.highestHigh, ratcheted: p.strategy === 'C' && p.stop > p.initialStop,
              barsHeld: p.barsHeld, riskUsdt: p.initialRiskCash,
            }
            st.position = pos
            st.peak = Math.max(st.peak, b.cash + pos.notional)
          }
          if (o.pendingOrder?.type === 'EXIT' && p) st.pending = { kind: 'exit', symbol: r.symbol, strategy: p.strategy, queuedBar: o.pendingOrder.queuedBar ?? 0 }
          // a pending ENTRY was never filled: dropped on purpose
        }
        st.day = newDay(last != null ? barIndex(last) : 0)
        ins.run(b.id, last, JSON.stringify(st))
      }
      db.exec('DROP TABLE bot_asset_state')
    }
    db.exec('DROP INDEX IF EXISTS idx_tx_unnotified')
    const col = (db.query("SELECT 1 FROM pragma_table_info('transactions') WHERE name='notified'").get())
    if (col) db.exec('ALTER TABLE transactions DROP COLUMN notified')
    // candles/features computed under the old definitions (sample std, old ER) must not be reused
    db.exec('DELETE FROM symbol_features')
  })()
}

/** v3 (live version): real fills carry the exchange order reference. */
function v2ToV3(db: Database) {
  const has = db.query("SELECT 1 FROM pragma_table_info('transactions') WHERE name='order_ref'").get()
  if (!has) db.exec('ALTER TABLE transactions ADD COLUMN order_ref TEXT')
}
