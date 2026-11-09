import { BAR_MS } from './config'
import { params, runTree } from './tree'
import { candidates, dataOk, type Series } from './features'
import type { AssetState, BotRow, Fx, Position, Strat } from './types'

const FEE = params.cost.feeRatePerSide
const SLIP = params.cost.slipRatePerSide
const STOP_SLIP = SLIP * params.cost.stopSlipMult
const acct = params.account

export const barIndex = (t: number) => Math.floor(t / BAR_MS)

export function newAssetState(equity: number): AssetState {
  return {
    position: null, pendingOrder: null, peakEquity: equity, drawdownPct: 0, paused: false, pauseUntilBar: 0,
    cooldownLeft: 0, consecutiveLosses: 0, rollingWindowR: [], recentTradeR: { A: [], C: [] },
    degradation: { A: null, C: null }, tradeCounters: {}, rejectionCounters: {},
  }
}
const inc = (o: Record<string, number>, k: string, n = 1) => { o[k] = (o[k] ?? 0) + n }

/** Realize a sell: updates cash, R history, cooldown, degradation. `px` already includes slippage. */
export function closePosition(bot: BotRow, st: AssetState, symbol: string, px: number, reason: string, barTime: number, fx: Fx, now = Date.now()) {
  const pos = st.position!
  const proceeds = pos.qty * px
  const fee = proceeds * FEE
  const basis = pos.qty * pos.entryFill + pos.entryFee
  const net = proceeds - fee - basis
  const r = net / pos.initialRiskCash
  const bar = barIndex(barTime)
  bot.cash += proceeds - fee
  fx.tx.push({
    ts: now, bar_time: barTime, symbol, action: 'SELL', strategy: pos.strategy, price: px, qty: pos.qty,
    notional: proceeds, fee, pnl: net, pnl_pct: (net / basis) * 100, r_multiple: r, exit_reason: reason, cash_after: bot.cash,
  })
  st.position = null
  inc(st.tradeCounters, 'trades')
  inc(st.tradeCounters, 'realizedPnl', net)
  inc(st.tradeCounters, 'fees', fee + pos.entryFee)
  // account state transitions
  st.rollingWindowR.push({ bar, r })
  st.consecutiveLosses = net < 0 ? st.consecutiveLosses + 1 : 0
  const stopExit = reason === 'STOP' || reason === 'HARD_STOP' || reason === 'KILL'
  st.cooldownLeft = Math.min(acct.cooldownMaxBars, Math.max(stopExit ? acct.cooldownAfterStopBars : acct.cooldownBaseBars, 6 * st.consecutiveLosses))
  const rec = st.recentTradeR[pos.strategy]
  rec.push(r)
  while (rec.length > acct.degradation.windowTrades) rec.shift()
  if (acct.degradation.enabled && rec.reduce((a, b) => a + b, 0) <= acct.degradation.minSumR) {
    st.degradation[pos.strategy] = bar + acct.degradation.resumeAfterBars
    st.recentTradeR[pos.strategy] = []
  }
}

function fillEntry(bot: BotRow, st: AssetState, symbol: string, bar: { t: number; o: number }, fx: Fx, now: number): void {
  const po = st.pendingOrder!
  st.pendingOrder = null
  const fill = bar.o * (1 + SLIP)
  const k = po.strategy === 'A' ? params.strategyA.initialStopAtr : params.strategyC.initialStopAtr
  const stopDistance = k * po.signalAtr
  const mult = params.risk.strategyMultiplier[po.strategy]
  const riskNotional = ((bot.cash * params.risk.riskPerTrade * mult) * fill) / stopDistance
  // small-account rule: when even a 75%-slice of capital can't clear the minimum notional,
  // a risk-sized entry is unpurchasable -> use 100% of capital (all-in) instead of standing dormant
  const allIn = bot.cash * params.risk.allInCheckFraction < params.risk.minimumNotional
  const notional = allIn ? bot.cash : Math.min(riskNotional, bot.cash * params.risk.maxPositionFraction, bot.cash)
  if (!(stopDistance > 0) || !(notional >= params.risk.minimumNotional)) {
    inc(st.rejectionCounters, 'sizing')
    fx.events.push({ ts: now, kind: 'entry_rejected', symbol, detail: `notional ${notional.toFixed(2)} below minimum or bad stop` })
    return
  }
  const qty = notional / (fill * (1 + FEE))
  const entryFee = qty * fill * FEE
  const preCash = bot.cash
  bot.cash -= qty * fill + entryFee
  const initialStop = fill - stopDistance
  const pos: Position = {
    strategy: po.strategy, entryTime: bar.t, entryFill: fill, qty, entryFee, signalAtr: po.signalAtr,
    initialStop, stop: initialStop, restStop: initialStop, hardStop: fill - params.risk.globalHardStopAtr * po.signalAtr,
    highestClose: fill, highestHigh: fill, lowestLow: fill, barsHeld: 0,
    initialRisk: stopDistance, initialRiskCash: qty * stopDistance, // R = pnl / (qty*(fill-initialStop))
  }
  st.position = pos
  if (allIn) fx.events.push({ ts: now, kind: 'all_in_entry', symbol, detail: `cash ${preCash.toFixed(2)} below minimum when sized at ${(params.risk.allInCheckFraction * 100).toFixed(0)}% -> 100% of capital` })
  inc(st.tradeCounters, po.strategy === 'A' ? 'executedA' : 'executedC')
  fx.tx.push({
    ts: now, bar_time: bar.t, symbol, action: 'BUY', strategy: po.strategy, price: fill, qty, notional: qty * fill,
    fee: entryFee, pnl: null, pnl_pct: null, r_multiple: null, exit_reason: null, cash_after: bot.cash,
  })
}

export interface EntryCandidate { strategy: Strat; signalAtr: number; expectedNetR: number }

/**
 * Process one closed candle for one asset of one bot, in the contract's bar order:
 * pending orders at the bar open -> position management -> account blocks -> tree decision.
 * Returns an entry candidate when the tree queues one (the caller applies the one-trade-at-a-time rule).
 */
export function stepAsset(
  bot: BotRow, symbol: string, st: AssetState, S: Series, i: number, fx: Fx,
  opts: { entries: boolean; now?: number },
): EntryCandidate | null {
  const now = opts.now ?? Date.now()
  const t = S.t[i]!
  const bar = { t, o: S.o[i]!, h: S.h[i]!, l: S.l[i]!, c: S.c[i]!, v: S.v[i]! }
  const bi = barIndex(t)
  const atr = S.atr14[i]!

  // 1. resolve pending orders at this bar's open
  if (st.pendingOrder?.type === 'EXIT' && st.position) {
    closePosition(bot, st, symbol, bar.o * (1 - SLIP), st.pendingOrder.exitReason ?? 'TRAIL', t, fx, now)
    st.pendingOrder = null
  } else if (st.pendingOrder?.type === 'ENTRY') {
    fillEntry(bot, st, symbol, bar, fx, now)
  } else st.pendingOrder = null

  // 2. drawdown / pause bookkeeping (equity marked at this close)
  const pos0 = st.position
  const equity = bot.cash + (pos0 ? pos0.qty * bar.c : 0)
  if (st.paused && bi >= st.pauseUntilBar) { st.paused = false; st.peakEquity = equity }
  if (!st.paused) {
    st.peakEquity = Math.max(st.peakEquity, equity)
    if (equity <= st.peakEquity * (1 - acct.drawdownPause)) { st.paused = true; st.pauseUntilBar = bi + acct.drawdownPauseBars }
  }
  st.drawdownPct = st.peakEquity > 0 ? Math.max(0, 1 - equity / st.peakEquity) : 0
  st.rollingWindowR = st.rollingWindowR.filter((x) => bi - x.bar < acct.rollingLossWindowBars)
  for (const s of ['A', 'C'] as const) if (st.degradation[s] != null && bi >= st.degradation[s]!) st.degradation[s] = null

  const idle = !st.position && !opts.entries
  const finish = (): EntryCandidate | null => {
    if (st.cooldownLeft > 0) st.cooldownLeft--
    return null
  }
  if (idle) return finish()

  // 3. build feature inputs
  const ok = dataOk(S, i, symbol)
  const cand = candidates(S, i, symbol, { A: true, C: true })
  // tree flag fires only when both strategies are frozen; a single frozen strategy is blocked post-tree
  const degradationActive = st.degradation.A != null && st.degradation.C != null ? 1 : 0

  const pos = st.position
  let posIn: Record<string, unknown> = { exists: 0 }
  let next: { stop: number; highestClose: number; highestHigh: number; lowestLow: number } | null = null
  if (pos) {
    const highestClose = Math.max(pos.highestClose, bar.c)
    const highestHigh = Math.max(pos.highestHigh, bar.h)
    const lowestLow = Math.min(pos.lowestLow, bar.l)
    const trailRef = pos.strategy === 'A' ? highestClose : highestHigh
    const trailAtr = pos.strategy === 'A' ? params.strategyA.trailAtr : params.strategyC.trailAtr
    const newStop = Math.max(pos.stop, trailRef - trailAtr * atr) // never loosen
    next = { stop: Number.isFinite(newStop) ? newStop : pos.stop, highestClose, highestHigh, lowestLow }
    posIn = {
      exists: 1, strategy: pos.strategy === 'A' ? 1 : 2, entryFill: pos.entryFill, qty: pos.qty, stop: next.stop, hardStop: pos.hardStop,
      highestClose, highestHigh, barsHeld: pos.barsHeld + 1,
      rNow: (bar.c - pos.entryFill) / pos.initialRisk,
      mfeR: (highestHigh - pos.entryFill) / pos.initialRisk, maeR: (lowestLow - pos.entryFill) / pos.initialRisk,
      stopHit: Number(bar.l <= pos.restStop), hardStopHit: Number(bar.l <= pos.hardStop),
      trailExitSignal: pos.strategy === 'A' ? Number(bar.c < next.stop) : 0,
      killStop: bar.c - params.kill.tightenAtrMult * atr,
    }
  }
  const weekR = st.rollingWindowR.reduce((a, x) => a + x.r, 0)
  const inputs = {
    dataOk: ok ? 1 : 0,
    atrPctPctl: S.atrPctPctl[i],
    pendingOrder: { exists: st.pendingOrder ? 1 : 0, type: st.pendingOrder?.type, signalAtr: st.pendingOrder?.signalAtr },
    position: posIn,
    assetState: {
      cash: bot.cash, equity, peakEquity: st.peakEquity, drawdownPct: st.drawdownPct, paused: st.paused ? 1 : 0,
      pauseUntilBar: st.pauseUntilBar, cooldownLeft: st.cooldownLeft, weekR, consecutiveLosses: st.consecutiveLosses,
      degradationActive,
    },
    A: cand.A, C: cand.C,
  }

  // diagnostics (never alter decisions)
  if (!pos) {
    if (cand.A.signal) inc(st.tradeCounters, 'signalsA')
    if (cand.C.rawSignal) inc(st.tradeCounters, 'signalsC')
    if (cand.A.signal && cand.C.rawSignal) inc(st.tradeCounters, 'sameBarConflicts')
    if (cand.C.gateRejected) inc(st.tradeCounters, 'cGateRejections')
  }

  // 4. decision
  let { node } = runTree(inputs)
  if (pos && !ok && node.action === 'NO_TRADE') {
    // safety: never leave an open position unmanaged when features are unavailable
    const e = (inputs.position as any)
    node = e.stopHit ? { id: 'safe_stop', type: 'action', action: 'EXIT', exitReason: 'STOP' } as any
      : e.hardStopHit ? { id: 'safe_hs', type: 'action', action: 'EXIT', exitReason: 'HARD_STOP' } as any
      : { id: 'safe_hold', type: 'action', action: 'HOLD', reason: 'in_position_data_gap' } as any
  }

  const keep = () => {
    if (!pos || !next) return
    pos.stop = next.stop; pos.highestClose = next.highestClose; pos.highestHigh = next.highestHigh; pos.lowestLow = next.lowestLow
    pos.barsHeld += 1
    if (pos.strategy === 'C') pos.restStop = Math.max(pos.restStop, pos.stop)
  }

  switch (node.action) {
    case 'EXIT': {
      if (!pos) break
      const reason = node.exitReason
      if (reason === 'STOP' || reason === 'HARD_STOP') {
        const level = reason === 'STOP' ? pos.restStop : pos.hardStop
        const raw = bar.o <= level ? bar.o : level // gap through the stop fills at the open
        closePosition(bot, st, symbol, raw * (1 - STOP_SLIP), reason, t, fx, now)
          } else if (reason === 'KILL' || reason === 'TIME') {
        closePosition(bot, st, symbol, bar.c * (1 - SLIP), reason, t, fx, now) // decision-bar close, no next-open delay
      } else {
        keep()
        st.pendingOrder = { type: 'EXIT', strategy: pos.strategy, signalAtr: pos.signalAtr, queuedBar: bi, exitReason: reason } // next bar open
      }
      break
    }
    case 'TIGHTEN_STOP': {
      keep()
      if (pos) {
        const ks = (inputs.position as any).killStop as number
        pos.stop = Math.max(pos.stop, ks)
        pos.restStop = Math.max(pos.restStop, ks)
      }
      break
    }
    case 'HOLD': keep(); break
    case 'NO_TRADE': {
      inc(st.rejectionCounters, node.reason)
      if (node.reason === 'drawdown_pause') inc(st.tradeCounters, 'blockedByPause')
      if (node.reason === 'cooldown') inc(st.tradeCounters, 'blockedByCooldown')
      break
    }
    case 'QUEUE_ENTRY': {
      const c = node.strategy === 'A' ? cand.A : cand.C
      if (st.degradation[node.strategy] != null) { // runtime-enforced per-strategy pause (no fallback to the other strategy)
        inc(st.tradeCounters, 'blockedByDegradation')
        inc(st.rejectionCounters, 'strategy_degradation_pause')
        return finish()
      }
      return { strategy: node.strategy, signalAtr: atr, expectedNetR: c.expectedNetR }
    }
  }
  return finish()
}
