import type { Strat } from './params'
export type { Strat }
/** Any Binance spot USDT pair, e.g. "BTCUSDT", "PEPEUSDT". */
export type Symbol = string
export interface Candle { t: number; o: number; h: number; l: number; c: number; v: number }

export interface Position {
  symbol: Symbol
  strategy: Strat
  entryTs: number          // open time of the bar the order filled on
  entryFill: number
  qty: number
  notional: number         // USDT spent (cost basis, fee included)
  initialStop: number
  stop: number             // current stop / trail level (never loosened)
  hardStop: number
  highestClose: number
  highestHigh: number
  ratcheted: boolean
  barsHeld: number
  riskUsdt: number         // qty * (entryFill - initialStop), fixed at entry (R denominator)
}

export interface PendingOrder {
  kind: 'entry' | 'exit'
  symbol: Symbol
  strategy: Strat
  queuedBar: number        // absolute 4h bar index of the decision bar
  // entry only (frozen at the signal bar)
  score?: number; atr?: number; stopAtr?: number; riskMult?: number
}

export interface RegimeRec { state: 0 | 1 | 2; pending: number | null; count: number }

/** Per-day (6 bars) accumulator, flushed into the Telegram daily summary and then reset. */
export interface DayLog {
  startBar: number                         // absolute bar index of the first bar of the accumulation
  lines: string[]                          // human-readable actions (capped)
  signals: { A: number; C: number }
  blocked: Record<string, number>          // reason -> count of blocked signals
  trades: number; pnl: number
}

/** Everything the bot must remember between bars. One JSON row per bot (table bot_state). */
export interface BotState {
  position: Position | null
  pending: PendingOrder | null
  peak: number                             // peak of realised cash (drawdown pause reference)
  pauseUntil: number | null                // bar index; entries blocked while set
  cooldown: number
  consecutiveLosses: number
  frozenUntil: { A: number; C: number }    // bar index until which a strategy is degraded
  rHistory: { A: number[]; C: number[] }   // last `degradeWindow` R per strategy
  closedR: { bar: number; r: number }[]    // trades closed within the rolling loss window
  regime: RegimeRec
  counters: Record<string, number>
  day: DayLog
  blockNotified: Record<string, number>    // `${symbol}:${strat}:${reason}` -> bar index (alert de-duplication)
  /** Live mode only: the engine decided to sell the open position at market; src/live.ts executes it (and retries until done). */
  exitNow?: { reason: string; bar: number; t: number }
}

export interface BotRow {
  id: string
  name: string
  assets: Symbol[]
  initial_capital: number
  cash: number
  status: 'active' | 'inactive'
  pending_action: PendingAction[]
  created_at: number
  updated_at: number
}

export type PendingAction =
  | { type: 'deactivate'; requestedAt: number }
  | { type: 'delete'; requestedAt: number }
  | { type: 'edit_assets'; assets: Symbol[]; requestedAt: number }
  | { type: 'set_capital'; capital: number; requestedAt: number }

export interface TxRow {
  ts: number; bar_time: number | null; symbol: string | null; action: 'BUY' | 'SELL' | 'CAPITAL'
  strategy: string | null; price: number | null; qty: number | null; notional: number | null; fee: number | null
  pnl: number | null; pnl_pct: number | null; r_multiple: number | null; exit_reason: string | null; cash_after: number
  /** Exchange order reference (Convert orderId / testnet orderId). Absent for simulated fills. */
  order_ref?: string | null
}
export interface EvRow { ts: number; kind: string; symbol: string | null; detail: string }
/** A Telegram message composed at event time and persisted in the outbox in the same transaction. */
export interface Note { kind: string; strategy?: string | null; text: string }
export interface Fx { tx: TxRow[]; events: EvRow[]; notes: Note[] }
export const newFx = (): Fx => ({ tx: [], events: [], notes: [] })
