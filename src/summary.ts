// Daily summary (sent after every 6th 4h candle = at the UTC day boundary): actions taken that day,
// bot status and generic market stats for the assets the bot can see.
import { BAR_MS } from './time'
import type { Row, Series } from './features'
import * as M from './messages'
import { P, STATE_NAME } from './params'
import { newDay } from './engine'
import { barIndex } from './time'
import { effectiveMinScore } from './strategy'
import { universeFunnel, universeRows } from './universe_store'
import type { BotRow, BotState } from './types'

interface Stat { symbol: string; chg: number; range: number; quoteVol: number; above: boolean | null }

/** 24h stats (the 6 bars ending at t) for one symbol; null if the day is not fully covered by contiguous candles. */
function dayStat(symbol: string, S: Series, t: number): Stat | null {
  const i = S.idx.get(t)
  if (i === undefined || i < 5 || S.t[i - 5] !== t - 5 * BAR_MS) return null
  let hi = -Infinity, lo = Infinity, qv = 0
  for (let j = i - 5; j <= i; j++) { hi = Math.max(hi, S.h[j]!); lo = Math.min(lo, S.l[j]!); qv += S.v[j]! * S.c[j]! }
  const o = S.o[i - 5]!
  return { symbol, chg: (S.c[i]! / o - 1) * 100, range: ((hi - lo) / o) * 100, quoteVol: qv, above: Number.isFinite(S.ema200[i]!) ? S.c[i]! > S.ema200[i]! : null }
}

const compactUsd = (n: number) => (n >= 1e9 ? `${(n / 1e9).toFixed(2)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(0)}K` : n.toFixed(0))
const count = (n: number) => n.toLocaleString('en-US')

/** Global universe filter funnel; the full asset list lives on the dashboard. */
function universeSummary(): string {
  const uf = universeFunnel()
  if (!uf.updatedAt || !uf.selected) return '• no completed universe scan yet'
  const rows = universeRows(true)
  const vol = rows.reduce((a, r) => a + (r.quoteVolume24h || 0), 0)
  const top = rows.slice(0, 3).map((r) => r.symbol.replace(/USDT$/, '')).join(', ')
  const funnel = uf.total > 0
    ? `${count(uf.total)} symbols → ${count(uf.eligible)} eligible → ${count(uf.volumeOk)} ≥ $${compactUsd(P.universe.volume24hMinUsd)}/24h → ${count(uf.historyOk)} ≥ ${P.universe.historyBars} bars`
    : `${count(uf.volumeOk)} volume candidates → ${count(uf.historyOk)} ≥ ${P.universe.historyBars} bars`
  const at = new Date(uf.updatedAt).toISOString().slice(0, 16).replace('T', ' ')
  return [
    `• funnel: ${funnel}`,
    `• selected ${uf.selected}/${uf.maxAssets} · 24h volume ${compactUsd(vol)} USDT${top ? ` · top ${top}` : ''}`,
    `• last scan ${at} UTC · full asset list on the dashboard`,
  ].join('\n')
}

export function buildDailySummary(bot: BotRow, st: BotState, rows: Map<string, Row>, getSeries: (s: string) => Series | null, t: number, lastPx: (s: string) => number | null): string {
  const day = new Date(t).toISOString().slice(0, 10)
  const bar = barIndex(t)
  const pos = st.position
  const holdPx = pos ? rows.get(pos.symbol)?.close ?? lastPx(pos.symbol) ?? pos.entryFill : null
  const equity = bot.cash + (pos && holdPx ? pos.qty * holdPx : 0)
  const pnl = equity - bot.initial_capital
  const flags: string[] = []
  if (st.pauseUntil != null) flags.push(`drawdown pause (${Math.max(0, st.pauseUntil - bar)} bars left)`)
  if (st.cooldown > 0) flags.push(`cooldown ${st.cooldown} bars`)
  if (st.frozenUntil.A > bar) flags.push('Donchian frozen')
  const weekR = st.closedR.filter((x) => x.bar > bar - P.lossWindowBars).reduce((a, x) => a + x.r, 0)
  const position = pos
    ? `holding ${pos.symbol} · ${M.strat(pos.strategy)} · ${M.fmt(pos.qty, 6)} @ ${M.px(pos.entryFill)} · ${M.sgn(((holdPx! - pos.entryFill) / pos.entryFill) * 100)}% · stop ${M.px(pos.stop)}`
    : st.pending ? `${st.pending.kind} order queued for ${st.pending.symbol} (${M.strat(st.pending.strategy)})` : 'flat (scanning)'

  const d = st.day
  const actions = d.lines.length ? d.lines.map((l) => `• ${l}`).join('\n') : '• no trades or signals today'
  const blockedTotal = Object.values(d.blocked).reduce((a, b) => a + b, 0)
  const blocked = blockedTotal ? Object.entries(d.blocked).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${M.reasonText(k)} ${v}`).join(', ') : 'none'

  // market stats over the assets the bot could see on the closing bar
  const stats: Stat[] = []
  for (const sym of rows.keys()) { const S = getSeries(sym); const s = S && dayStat(sym, S, t); if (s) stats.push(s) }
  const unseen = bot.assets.length - rows.size
  let market: string
  if (!stats.length) market = '• no complete 24h data for this bot’s assets'
  else {
    const by = [...stats].sort((a, b) => b.chg - a.chg)
    const avg = stats.reduce((a, s) => a + s.chg, 0) / stats.length
    const above = stats.filter((s) => s.above !== null)
    const anchor = stats.find((s) => s.symbol === P.regimeAnchor)
    const line = (s: Stat) => `${s.symbol.replace(/USDT$/, '')} ${M.sgn(s.chg)}% (range ${M.fmt(s.range, 1)}%)`
    const lines = [`• ${stats.length} assets · average ${M.sgn(avg)}% · 24h volume ${compactUsd(stats.reduce((a, s) => a + s.quoteVol, 0))} USDT`]
    if (above.length) lines.push(`• breadth: ${M.fmt((above.filter((s) => s.above).length / above.length) * 100, 0)}% above EMA200`)
    if (anchor) lines.push(`• ${line(anchor)} (regime anchor)`)
    lines.push(`• top: ${by.slice(0, 3).map(line).join(' · ')}`)
    if (by.length > 3) lines.push(`• bottom: ${by.slice(-3).reverse().map(line).join(' · ')}`)
    market = lines.join('\n')
  }
  if (unseen > 0) market += `\n• ${unseen} asset(s) not tracked on this bar${pos ? ' (data is pulled only for the held asset while in a trade)' : ''}`

  const text = [
    M.head('📊', `DAILY SUMMARY ${day} (UTC)`, bot),
    '',
    `Status: ${bot.status} · ${position}`,
    `Equity ${M.fmt(equity)} USDT · P/L ${M.sgn(pnl)} (${M.sgn((pnl / bot.initial_capital) * 100)}%) · cash ${M.fmt(bot.cash)}`,
    `Regime ${STATE_NAME[st.regime.state]} (min score ${M.fmt(effectiveMinScore(st.regime.state, bot.assets.length))}, risk x${M.fmt(P.regime.table[st.regime.state]!.riskMult)}) · 7-day R ${M.sgn(weekR)}`,
    flags.length ? `Protections: ${flags.join(', ')}` : 'Protections: none active',
    bot.pending_action.length ? `Scheduled: ${bot.pending_action.map((a) => a.type.replace('_', ' ')).join(', ')} after exit` : '',
    '',
    `Today: ${d.trades} closed trade(s), ${M.sgn(d.pnl)} USDT`,
    actions,
    `Signals A: ${d.signals.A} · blocked: ${blocked}`,
    '',
    'Universe filter',
    universeSummary(),
    '',
    'Market (24h)',
    market,
  ].filter((x, i, a) => !(x === '' && a[i - 1] === '')).join('\n')
  st.day = newDay(bar + 1)
  return text.length > 3900 ? text.slice(0, 3890) + '\n…' : text
}
