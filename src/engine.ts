// Per-bar bot engine: BOT_SPEC §9.1 pipeline, implemented as a pure function over (bot, state, rows).
//   1 features -> 2 regime -> 3 pause expiry / cooldown -> 4 pending order at the bar open
//   -> 5 manage the position -> 6 scan for entries -> 7 bookkeeping
import { barIndex } from './time'
import type { Row } from './features'
import * as M from './messages'
import { BEAR, P, type Strat } from './params'
import { crossSection, effectiveMinScore, evaluateSymbol, rankCmp, regimeName, regimeUpdate, type Blocked, type BlockReason, type Pick } from './strategy'
import type { BotRow, BotState, DayLog, Fx, Position } from './types'

const SLIP = P.slip
const STOP_SLIP = P.slip * P.stopSlipMult
const DAY_LINES_MAX = 40
const BLOCK_DEDUPE_BARS = 6 // the same (symbol, strategy, reason) alert is repeated at most once per 24h

export const newDay = (startBar: number): DayLog => ({ startBar, lines: [], signals: { A: 0, C: 0 }, blocked: {}, trades: 0, pnl: 0 })
export function newBotState(cash: number, startBar = 0): BotState {
  return {
    position: null, pending: null, peak: cash, pauseUntil: null, cooldown: 0, consecutiveLosses: 0,
    frozenUntil: { A: 0, C: 0 }, rHistory: { A: [], C: [] }, closedR: [], regime: { state: 1, pending: null, count: 0 },
    counters: {}, day: newDay(startBar), blockNotified: {},
  }
}
const inc = (o: Record<string, number>, k: string, n = 1) => { o[k] = (o[k] ?? 0) + n }
const hhmm = (t: number) => new Date(t).toISOString().slice(11, 16)

/** `live`: the engine only DECIDES (pending orders / exitNow); src/live.ts places the real order and books the actual fill. */
export interface StepOpts { now: number; fresh: boolean; live?: boolean }
/** An executed order as reported by the exchange layer. */
export interface RealFill { qty: number; usdt: number; feeUsdt: number; orderRef: string }
const note = (fx: Fx, o: StepOpts, always: boolean, kind: string, text: string, strategy?: string) => { if (always || o.fresh) fx.notes.push({ kind, strategy: strategy ?? null, text }) }
const dayLine = (st: BotState, line: string) => { if (st.day.lines.length < DAY_LINES_MAX) st.day.lines.push(line) }

const cooldownBars = (reason: string, losses: number) => {
  const floor = reason === 'STOP' || reason === 'HARD_STOP' || reason === 'KILL' ? P.cooldownStop : P.cooldownBase
  return Math.min(P.cooldownMax, Math.max(floor, P.cooldownStep * losses))
}

/** Realise a sell. `fill` already includes slippage. Updates cash, R history, cooldown, degradation and the drawdown pause. */
export function closePosition(bot: BotRow, st: BotState, fx: Fx, o: StepOpts, bar: number, t: number, fill: number, reason: string, real?: RealFill) {
  const pos = st.position!
  if (o.live && !real) { // live: record the intent only, the real sell is executed (and booked) by src/live.ts
    if (!st.exitNow) {
      st.exitNow = { reason, bar, t }
      fx.events.push({ ts: o.now, kind: 'exit_triggered', symbol: pos.symbol, detail: `${M.strat(pos.strategy)} ${reason}` })
    }
    return
  }
  delete st.exitNow
  const sold = real ? real.qty : pos.qty
  const gross = real ? real.usdt + real.feeUsdt : pos.qty * fill
  const fee = real ? real.feeUsdt : gross * P.fee
  const cashIn = real ? real.usdt : gross - fee
  bot.cash += cashIn
  const pnl = cashIn - pos.notional
  const r = pos.riskUsdt > 0 ? pnl / pos.riskUsdt : 0
  const pct = (pnl / pos.notional) * 100
  fx.tx.push({
    ts: o.now, bar_time: t, symbol: pos.symbol, action: 'SELL', strategy: pos.strategy, price: fill, qty: sold, notional: gross, fee,
    pnl, pnl_pct: pct, r_multiple: r, exit_reason: reason, cash_after: bot.cash, order_ref: real?.orderRef ?? null,
  })
  note(fx, o, true, 'sell', M.msgSell(bot, pos.symbol, pos.strategy, fill, sold, pnl, pct, r, reason, bot.cash, t), pos.strategy)
  dayLine(st, `${hhmm(t)} SELL ${pos.symbol} ${M.strat(pos.strategy)} ${M.sgn(pnl)} USDT (${M.sgn(r)}R) ${reason}`)
  st.day.trades++; st.day.pnl += pnl
  inc(st.counters, 'trades'); inc(st.counters, `exit_${reason}`)

  st.consecutiveLosses = r < 0 ? st.consecutiveLosses + 1 : 0
  st.cooldown = cooldownBars(reason, st.consecutiveLosses)
  const hist = st.rHistory[pos.strategy]
  hist.push(r)
  while (hist.length > P.degradeWindow) hist.shift()
  if (hist.length >= P.degradeWindow && hist.reduce((a, b) => a + b, 0) <= P.degradeMinSumR) {
    st.frozenUntil[pos.strategy] = Math.max(st.frozenUntil[pos.strategy], bar + P.degradeBars)
    fx.events.push({ ts: o.now, kind: 'strategy_degraded', symbol: pos.symbol, detail: `${M.strat(pos.strategy)} frozen for ${P.degradeBars} bars` })
    dayLine(st, `${hhmm(t)} ${M.strat(pos.strategy)} frozen for ${P.degradeBars} bars (last ${P.degradeWindow} trades <= ${P.degradeMinSumR}R)`)
  }
  st.closedR.push({ bar, r })
  if (bot.cash > st.peak) st.peak = bot.cash
  else if (bot.cash <= st.peak * (1 - P.ddPause)) {
    st.pauseUntil = bar + P.ddPauseBars
    fx.events.push({ ts: o.now, kind: 'drawdown_pause', symbol: null, detail: `cash ${bot.cash.toFixed(2)} <= ${(100 * (1 - P.ddPause)).toFixed(0)}% of peak ${st.peak.toFixed(2)}; no entries for ${P.ddPauseBars} bars` })
    dayLine(st, `${hhmm(t)} drawdown pause for ${P.ddPauseBars} bars`)
  }
  st.position = null
}

const rejectEntry = (bot: BotRow, st: BotState, fx: Fx, o: StepOpts, t: number, pend: NonNullable<BotState['pending']>, why: string, reason = 'min_notional') => {
  inc(st.counters, 'entry_rejected')
  fx.events.push({ ts: o.now, kind: 'entry_rejected', symbol: pend.symbol, detail: why })
  inc(st.day.blocked, reason)
  note(fx, o, false, 'blocked', M.msgBlocked(bot, [{ symbol: pend.symbol, strategy: pend.strategy, reason: reason as BlockReason, detail: why }], regimeName(st.regime.state), t), pend.strategy)
}
export { rejectEntry }

/** Position size and stop levels for a pending entry at reference fill price `fill` (spec §9.2). */
export function sizeEntry(bot: BotRow, pend: NonNullable<BotState['pending']>, fill: number):
  { ok: true; notional: number; stop: number; hard: number; stopDist: number } | { ok: false; why: string } {
  const atr = pend.atr!
  const stop = fill - pend.stopAtr! * atr
  const hard = fill - P.hardStopAtr * atr
  const stopDist = fill - stop
  if (!(stopDist > 0) || !(bot.cash > 0)) return { ok: false, why: 'bad stop distance or no cash' }
  const notional = Math.min((bot.cash * P.riskPerTrade * pend.riskMult! * fill) / stopDist, bot.cash * P.maxPositionFraction, bot.cash)
  if (!(notional >= P.minNotional)) return { ok: false, why: `notional ${notional.toFixed(2)} USDT below the ${P.minNotional} USDT minimum` }
  return { ok: true, notional, stop, hard, stopDist }
}

/** Book an opened position (shared by the simulated fill and the real exchange fill). */
function openPosition(bot: BotRow, st: BotState, fx: Fx, o: StepOpts, t: number, pend: NonNullable<BotState['pending']>,
  p: { fill: number; notional: number; qty: number; fee: number; stop: number; hard: number; stopDist: number; high: number; close: number; orderRef?: string }) {
  bot.cash -= p.notional
  st.position = {
    symbol: pend.symbol, strategy: pend.strategy, entryTs: t, entryFill: p.fill, qty: p.qty, notional: p.notional, initialStop: p.stop, stop: p.stop, hardStop: p.hard,
    highestClose: p.close, highestHigh: p.high, ratcheted: false, barsHeld: 1, riskUsdt: p.qty * p.stopDist,
  }
  inc(st.counters, pend.strategy === 'A' ? 'executedA' : 'executedC')
  fx.tx.push({
    ts: o.now, bar_time: t, symbol: pend.symbol, action: 'BUY', strategy: pend.strategy, price: p.fill, qty: p.qty, notional: p.notional, fee: p.fee,
    pnl: null, pnl_pct: null, r_multiple: null, exit_reason: null, cash_after: bot.cash, order_ref: p.orderRef ?? null,
  })
  note(fx, o, true, 'buy', M.msgBuy(bot, pend.symbol, pend.strategy, p.fill, p.qty, p.notional, p.stop, p.hard, bot.cash, t), pend.strategy)
  dayLine(st, `${hhmm(t)} BUY ${pend.symbol} ${M.strat(pend.strategy)} @ ${M.px(p.fill)} (${M.fmt(p.notional)} USDT)`)
}

function fillEntry(bot: BotRow, st: BotState, fx: Fx, o: StepOpts, t: number, row: Row | undefined) {
  const pend = st.pending!
  st.pending = null
  if (!row || !Number.isFinite(row.open) || row.open <= 0) return rejectEntry(bot, st, fx, o, t, pend, 'no candle for the fill bar; entry dropped')
  const fill = row.open * (1 + SLIP)
  const z = sizeEntry(bot, pend, fill)
  if (!z.ok) return rejectEntry(bot, st, fx, o, t, pend, z.why)
  const qty = (z.notional - z.notional * P.fee) / fill
  openPosition(bot, st, fx, o, t, pend, { fill, notional: z.notional, qty, fee: z.notional * P.fee, stop: z.stop, hard: z.hard, stopDist: z.stopDist, high: row.high, close: row.close })
}

/** Live: book a position from a REAL buy. Stops are derived from the effective fill price. `t` = open of the bar the order was filled in. */
export function applyLiveEntry(bot: BotRow, st: BotState, fx: Fx, o: StepOpts, t: number, real: RealFill) {
  const pend = st.pending!
  st.pending = null
  const fill = real.usdt / real.qty
  const stop = fill - pend.stopAtr! * pend.atr!
  const hard = fill - P.hardStopAtr * pend.atr!
  openPosition(bot, st, fx, o, t, pend, { fill, notional: real.usdt, qty: real.qty, fee: real.feeUsdt, stop, hard, stopDist: fill - stop, high: fill, close: fill, orderRef: real.orderRef })
}

function manage(bot: BotRow, st: BotState, fx: Fx, o: StepOpts, i: number, t: number, row: Row | undefined) {
  const pos = st.position!
  if (!row) { pos.barsHeld++; return } // no candle for the held symbol on this bar
  const { open: op, high: h, low: l, close: c } = row
  // 1-2. resting intrabar orders, resolved before anything else (C trail/stop; both hard stops)
  if (pos.strategy === 'C' && l <= pos.stop) {
    closePosition(bot, st, fx, o, i, t, (op <= pos.stop ? op : pos.stop) * (1 - STOP_SLIP), pos.ratcheted ? 'TRAIL' : 'STOP')
    return
  }
  if (l <= pos.hardStop) {
    closePosition(bot, st, fx, o, i, t, (op <= pos.hardStop ? op : pos.hardStop) * (1 - STOP_SLIP), 'HARD_STOP')
    return
  }
  // safety (deviation from the reference, which skips the bar): features unavailable -> keep the position
  // protected by the resting stops above and the time cap, but do not ratchet.
  if (!row.dataOk) {
    if (pos.barsHeld >= P.maxHoldBars) closePosition(bot, st, fx, o, i, t, c * (1 - SLIP), 'TIME')
    else pos.barsHeld++
    return
  }
  const atr = row.atr14
  // 3. ratchet (the stop set on this bar protects from the next bar on)
  let trailSignal = false
  if (pos.strategy === 'A') {
    pos.highestClose = Math.max(pos.highestClose, c)
    const cand = pos.highestClose - P.A.trailAtr * atr
    if (Number.isFinite(cand)) pos.stop = Math.max(pos.stop, cand)
    trailSignal = c < pos.stop
  } else {
    pos.highestHigh = Math.max(pos.highestHigh, h)
    const cand = pos.highestHigh - P.C.trailAtr * atr
    if (Number.isFinite(cand) && cand > pos.stop) { pos.stop = cand; pos.ratcheted = true }
  }
  // 4. kill switch, time cap, regime tightening
  const rNow = (c - pos.entryFill) / (pos.entryFill - pos.initialStop)
  const pctl = row.atrPctPctl
  if (Number.isFinite(pctl) && pctl > P.kill.pctlMin) {
    if (rNow < P.kill.rNowMin) { closePosition(bot, st, fx, o, i, t, c * (1 - SLIP), 'KILL'); return }
    const ks = c - P.kill.tightenAtr * atr
    if (Number.isFinite(ks) && ks > pos.stop) {
      pos.stop = ks
      inc(st.counters, 'killTighten')
      fx.events.push({ ts: o.now, kind: 'stop_tightened', symbol: pos.symbol, detail: `kill switch: stop -> ${ks}` })
      note(fx, o, false, 'tighten', M.msgTighten(bot, pos.symbol, pos.strategy, ks, t), pos.strategy)
      dayLine(st, `${hhmm(t)} stop tightened ${pos.symbol} -> ${M.px(ks)} (volatility kill switch)`)
    }
  }
  if (pos.barsHeld >= P.maxHoldBars) { closePosition(bot, st, fx, o, i, t, c * (1 - SLIP), 'TIME'); return }
  if (P.regime.tightenOnBear && st.regime.state === BEAR) {
    const rs = c - P.regime.tightenAtrMult * atr
    if (Number.isFinite(rs) && rs > pos.stop) pos.stop = rs
  }
  // 5. A's close-based trail: exit queued for the next open
  if (trailSignal) {
    st.pending = { kind: 'exit', symbol: pos.symbol, strategy: pos.strategy, queuedBar: i }
    fx.events.push({ ts: o.now, kind: 'exit_queued', symbol: pos.symbol, detail: `${M.strat(pos.strategy)} close ${c} < stop ${pos.stop}` })
    note(fx, o, false, 'exit_queued', M.msgExitQueued(bot, pos.symbol, pos.strategy, `close ${M.px(c)} below trailing stop ${M.px(pos.stop)}`, t), pos.strategy)
    dayLine(st, `${hhmm(t)} EXIT signal ${pos.symbol} ${M.strat(pos.strategy)} (trail)`)
    return
  }
  pos.barsHeld++
}

/** Process one closed bar `t` for one bot. `rows` holds the symbols the bot may see on this bar (its tracked set). */
export function stepBot(bot: BotRow, st: BotState, rows: Map<string, Row>, t: number, fx: Fx, o: StepOpts): void {
  const i = barIndex(t)
  const live = [...rows.values()].filter((r) => r.dataOk)

  // 2. regime (every bar). Needs >= 4 dataOk symbols and the BTC anchor; otherwise the state is left unchanged.
  if (live.length >= P.minSymbolsCrossSection) {
    const anchor = rows.get(P.regimeAnchor)
    if (anchor && anchor.dataOk) {
      const breadth = live.filter((r) => r.close > r.ema200).length / live.length
      const before = st.regime.state
      if (regimeUpdate(st.regime, anchor.close > anchor.ema200, breadth)) {
        fx.events.push({ ts: o.now, kind: 'regime_change', symbol: null, detail: `${regimeName(before)} -> ${regimeName(st.regime.state)} (breadth ${(breadth * 100).toFixed(0)}%)` })
        dayLine(st, `${hhmm(t)} regime ${regimeName(before)} -> ${regimeName(st.regime.state)}`)
      }
    }
  }
  // 3. pause expiry, cooldown, rolling-window pruning
  if (st.pauseUntil != null && i >= st.pauseUntil) { st.pauseUntil = null; st.peak = bot.cash }
  if (st.cooldown > 0) st.cooldown--
  st.closedR = st.closedR.filter((x) => x.bar > i - P.lossWindowBars)
  for (const k of Object.keys(st.blockNotified)) if (i - st.blockNotified[k]! >= BLOCK_DEDUPE_BARS) delete st.blockNotified[k]

  // live: a sell that is still waiting for execution blocks everything else (src/live.ts retries it)
  if (o.live && st.exitNow) return

  // 4. pending order resolved at this bar's open
  if (st.pending) {
    const pend = st.pending
    if (pend.kind === 'entry') {
      if (o.live) { // live entries are executed by src/live.ts at the real open; one that is still pending now has expired
        st.pending = null
        rejectEntry(bot, st, fx, o, t, pend, 'entry not executed in time; dropped', 'entry_expired')
      } else fillEntry(bot, st, fx, o, t, rows.get(pend.symbol))
    } else {
      const row = rows.get(pend.symbol)
      if (st.position && (o.live || (row && Number.isFinite(row.open)))) closePosition(bot, st, fx, o, i, t, row ? row.open * (1 - SLIP) : NaN, 'TRAIL')
      st.pending = null
    }
    if (o.live && st.exitNow) return
  }
  // 5. manage the open position on its own symbol
  if (st.position) manage(bot, st, fx, o, i, t, rows.get(st.position.symbol))
  if (st.position || st.pending) return

  // 6. flat and nothing pending: scan the whole tracked universe
  scan(bot, st, rows, live, i, t, fx, o)
}

function scan(bot: BotRow, st: BotState, rows: Map<string, Row>, live: Row[], i: number, t: number, fx: Fx, o: StepOpts) {
  for (const r of live) { if (r.signalA) st.day.signals.A++; if (r.signalC) st.day.signals.C++ }
  const weekR = st.closedR.reduce((a, x) => a + x.r, 0)
  const degraded = { A: st.frozenUntil.A > i, C: st.frozenUntil.C > i }
  const block: BlockReason | null =
    st.pauseUntil != null ? 'drawdown_pause'
      : st.cooldown > 0 ? 'cooldown'
        : weekR <= P.lossFloorR ? 'rolling_loss_cap'
          : degraded.A && degraded.C ? 'all_strategies_degraded' : null
  const reg = P.regime.table[st.regime.state]!
  const blocked: Blocked[] = []

  if (block || !reg.allowEntries) {
    const why = block ?? 'cooldown'
    for (const r of live) {
      if (r.signalA) blocked.push({ symbol: r.symbol, strategy: 'A', reason: why, detail: '' })
      if (r.signalC) blocked.push({ symbol: r.symbol, strategy: 'C', reason: why, detail: '' })
    }
    report(bot, st, blocked, i, t, fx, o)
    return
  }

  const minScore = effectiveMinScore(st.regime.state, live.length)
  const rs = crossSection(new Map(live.map((r) => [r.symbol, r.relReturn])))
  const picks: Pick[] = []
  for (const r of live) {
    const e = evaluateSymbol(r, rs.get(r.symbol) ?? 0.5, minScore, degraded)
    blocked.push(...e.blocked)
    if (e.pick) picks.push(e.pick)
  }
  picks.sort(rankCmp)
  const best = picks[0]
  for (const p of picks.slice(1)) blocked.push({ symbol: p.symbol, strategy: p.strategy, reason: 'slot_taken', detail: `${best!.symbol} ${M.strat(best!.strategy)} scored ${best!.score.toFixed(2)} vs ${p.score.toFixed(2)}` })
  if (best) {
    const riskMult = P.strategyMult[best.strategy] * reg.riskMult
    st.pending = { kind: 'entry', symbol: best.symbol, strategy: best.strategy, queuedBar: i, score: best.score, atr: best.atr, stopAtr: best.stopAtr, riskMult }
    inc(st.counters, `queued${best.strategy}`)
    fx.events.push({ ts: o.now, kind: 'entry_queued', symbol: best.symbol, detail: `${M.strat(best.strategy)} score ${best.score.toFixed(3)}` })
    const rank = picks.length > 1 ? `Best of ${picks.length} candidates` : 'Only candidate'
    note(fx, o, false, 'entry_queued', M.msgEntryQueued(bot, best.symbol, best.strategy, best.score, regimeName(st.regime.state), riskMult, rank, t), best.strategy)
    dayLine(st, `${hhmm(t)} ENTRY signal ${best.symbol} ${M.strat(best.strategy)} score ${best.score.toFixed(2)}`)
  }
  report(bot, st, blocked, i, t, fx, o)
}

/** Count every blocked signal for the daily summary; alert (once per 24h per symbol/strategy/reason) via one message per bar. */
function report(bot: BotRow, st: BotState, blocked: Blocked[], i: number, t: number, fx: Fx, o: StepOpts) {
  if (!blocked.length) return
  const fresh: Blocked[] = []
  for (const b of blocked) {
    inc(st.day.blocked, b.reason)
    inc(st.counters, `blocked_${b.reason}`)
    const key = `${b.symbol}:${b.strategy}:${b.reason}`
    if (st.blockNotified[key] === undefined) { st.blockNotified[key] = i; fresh.push(b) }
  }
  if (!fresh.length) return
  const rg = regimeName(st.regime.state)
  fx.events.push({ ts: o.now, kind: 'blocked', symbol: null, detail: fresh.slice(0, 10).map((b) => `${b.symbol} ${b.strategy} ${b.reason}`).join('; ') })
  note(fx, o, false, 'blocked', M.msgBlocked(bot, fresh, rg, t))
}
