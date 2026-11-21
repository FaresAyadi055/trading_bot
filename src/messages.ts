// Telegram message composition (plain text, no parse mode). Every message names the bot and, for trading
// actions, the strategy used: Donchian (A).
import { STRATEGY_NAME, type Strat } from './params'
import type { Blocked } from './strategy'
import type { BotRow } from './types'

export const fmt = (n: number | null | undefined, d = 2) =>
  n == null || !Number.isFinite(n) ? 'n/a' : n.toLocaleString('en-US', { maximumFractionDigits: d, minimumFractionDigits: d })
/** Price with precision that adapts to tiny-priced assets (PEPE, SHIB...). */
export const px = (n: number | null | undefined) => (n == null || !Number.isFinite(n) ? 'n/a' : fmt(n, n >= 100 ? 2 : n >= 1 ? 4 : n >= 0.01 ? 6 : 8))
export const sgn = (n: number, d = 2) => (n > 0 ? '+' : '') + fmt(n, d)
export const strat = (s: string | null | undefined) => (s === 'A' ? `${STRATEGY_NAME[s]} (${s})` : s ?? '-')
export const barLabel = (t: number) => new Date(t).toISOString().slice(0, 16).replace('T', ' ') + ' UTC'
export const head = (icon: string, title: string, b: Pick<BotRow, 'id' | 'name'>) => `${icon} ${title} | bot ${b.id} (${b.name})`

export const msgEntryQueued = (b: BotRow, symbol: string, s: Strat, score: number, regime: string, riskMult: number, rank: string, t: number) =>
  `${head('📥', 'ENTRY SIGNAL', b)}\n${symbol} · strategy ${strat(s)} · score ${fmt(score)}\nFills at the next 4h open · regime ${regime} · risk x${fmt(riskMult)}\n${rank}\nDecision bar ${barLabel(t)}`

export const msgBuy = (b: BotRow, symbol: string, s: Strat, price: number, qty: number, notional: number, stop: number, hard: number, cash: number, t: number) =>
  `${head('🟢', 'BUY', b)}\n${symbol} @ ${px(price)} · qty ${fmt(qty, 6)} · ${fmt(notional)} USDT\nStrategy: ${strat(s)}\nInitial stop ${px(stop)} · resting hard stop ${px(hard)} · cash left ${fmt(cash)}\nBar ${barLabel(t)}`

export const msgExitQueued = (b: BotRow, symbol: string, s: Strat, reason: string, t: number) =>
  `${head('🟠', 'EXIT SIGNAL', b)}\n${symbol} · strategy ${strat(s)} · ${reason}\nPosition closes at the next 4h open\nDecision bar ${barLabel(t)}`

export const msgSell = (b: BotRow, symbol: string, s: Strat, price: number, qty: number, pnl: number, pct: number, r: number, reason: string, cash: number, t: number) =>
  `${head('🔴', 'SELL', b)}\n${symbol} @ ${px(price)} · qty ${fmt(qty, 6)}\nStrategy: ${strat(s)} · exit ${reason}\nP/L: ${sgn(pnl)} USDT (${sgn(pct)}%) · ${sgn(r)} R · cash ${fmt(cash)}\nBar ${barLabel(t)}`

export const msgTighten = (b: BotRow, symbol: string, s: Strat, stop: number, t: number) =>
  `${head('🛡️', 'STOP TIGHTENED (volatility kill switch)', b)}\n${symbol} · strategy ${strat(s)} · new stop ${px(stop)}\nBar ${barLabel(t)}`

/** A functional Binance request failed (candles, universe, balances, prices). No periodic heartbeat alerts. */
export const msgApiFailed = (what: string, reason: string) =>
  `❗ BINANCE API FAILURE\n${what}\n${reason.slice(0, 500)}`

/** A live BUY/SELL rejected by the Binance API: always names the side, the symbol and the API's reason. */
export const msgOrderFailed = (b: Pick<BotRow, 'id' | 'name'>, side: 'BUY' | 'SELL', symbol: string, reason: string, retrying: boolean) =>
  `${head('❗', `ORDER FAILED (${side})`, b)}\n${side} ${symbol}\nBinance API error: ${reason.slice(0, 300)}${retrying ? '\nThe sell is retried automatically.' : ''}`

const REASON_TEXT: Record<string, string> = {
  score_below_min: 'score below regime minimum', strategy_degraded: 'strategy degraded',
  cost_gate: 'cost gate', edge_gate: 'edge gate', slot_taken: 'slot taken by a better candidate',
  min_notional: 'below minimum notional', drawdown_pause: 'drawdown pause', cooldown: 'cooldown', rolling_loss_cap: 'rolling loss cap',
  entry_expired: 'entry not executed in time', capital_guard: 'capital guard (not enough unallocated USDT in the account)', exec_failed: 'order execution failed',
}
export const reasonText = (r: string) => REASON_TEXT[r] ?? r

export function msgBlocked(b: BotRow, items: Blocked[], regime: string, t: number) {
  const shown = items.slice(0, 10).map((x) => `• ${x.symbol} · ${strat(x.strategy)} · ${reasonText(x.reason)}${x.detail ? ` — ${x.detail}` : ''}`)
  const more = items.length > shown.length ? `\n…and ${items.length - shown.length} more` : ''
  return `${head('⛔', `TRADE BLOCKED (${items.length})`, b)}\n${shown.join('\n')}${more}\nRegime ${regime} · bar ${barLabel(t)}`
}

export const msgLifecycle = (icon: string, title: string, b: Pick<BotRow, 'id' | 'name'>, detail = '') => `${head(icon, title, b)}${detail ? `\n${detail}` : ''}`
