import type { Symbol } from './config'

export type Strat = 'A' | 'C'
export interface Candle { t: number; o: number; h: number; l: number; c: number; v: number }

export interface Position {
  strategy: Strat
  entryTime: number
  entryFill: number
  qty: number
  entryFee: number
  signalAtr: number
  initialStop: number
  stop: number          // trailing/initial stop level (never loosened)
  restStop: number      // level checked intrabar (C: = stop; A: initial stop, raised by kill-tighten)
  hardStop: number
  highestClose: number
  highestHigh: number
  lowestLow: number
  barsHeld: number
  initialRisk: number       // per-unit price risk (entryFill - initialStop)
  initialRiskCash: number   // fee-adjusted initial risk in USDT
}

export interface PendingOrder {
  type: 'ENTRY' | 'EXIT'
  strategy: Strat
  signalAtr: number
  queuedBar: number
  exitReason?: string
}

export interface AssetState {
  position: Position | null
  pendingOrder: PendingOrder | null
  peakEquity: number
  drawdownPct: number
  paused: boolean
  pauseUntilBar: number
  cooldownLeft: number
  consecutiveLosses: number
  rollingWindowR: { bar: number; r: number }[]
  recentTradeR: { A: number[]; C: number[] }
  degradation: { A: number | null; C: number | null } // paused-until bar index
  tradeCounters: Record<string, number>
  rejectionCounters: Record<string, number>
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
}
export interface EvRow { ts: number; kind: string; symbol: string | null; detail: string }
export interface Fx { tx: TxRow[]; events: EvRow[] }
