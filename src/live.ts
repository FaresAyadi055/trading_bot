// Live execution. The engine (src/engine.ts, `live` mode) only DECIDES: it queues a pending entry/exit or sets `exitNow`.
// This module turns those decisions into real orders (Binance Convert in MODE=live, spot testnet in MODE=test) right at
// the bar open and books the ACTUAL fill (price, quantity, order reference) into the bot's cash / position.
//
// Safety rules
//  * BUYs are never retried: a failed or ambiguous buy drops the entry (a missed trade is cheap, a double buy is not).
//  * SELLs are retried with back-off until they succeed (a position must never stay open by accident).
//  * Before every buy the real balances are fetched and compared with the bots' claims (capital guard).
//  * Convert has no resting stop orders, so monitorTick() polls prices and sells at market when a stop level is crossed.
import { barIndex, barOpen, BAR_MS, LIVE_BAR_MAX_AGE_MS } from './time'
import { tx } from './db'
import { config } from './config'
import { applyLiveEntry, closePosition, rejectEntry, sizeEntry } from './engine'
import { applyPending, getBot, listBots, loadState, need, saveBot, saveState, writeFx } from './bots'
import { fetchBalances, ledger } from './capital'
import { getExchange } from './exchange'
import * as M from './messages'
import { P } from './params'
import { killCheck } from './runner'
import { newFx } from './types'
import { HttpError } from './validate'

const busy = new Set<string>()
const retryAt = new Map<string, number>()
const alertedAt = new Map<string, number>()
const ALERT_EVERY_MS = 30 * 60_000
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e))

/** Record a failed order: event + (rate-limited) Telegram alert with the Binance error reason. Back-off applies to sells only. */
function failure(botId: string, what: 'BUY' | 'SELL', symbol: string, e: unknown, now: number, backoffMs = 0) {
  const bot = getBot(botId)
  if (!bot) return
  if (backoffMs) retryAt.set(botId, now + backoffMs)
  const key = `${botId}:${what}`
  const fx = newFx()
  fx.events.push({ ts: now, kind: 'exec_failed', symbol, detail: `${what} ${symbol}: ${errText(e)}`.slice(0, 500) })
  if (now - (alertedAt.get(key) ?? 0) > ALERT_EVERY_MS) {
    alertedAt.set(key, now)
    fx.notes.push({ kind: 'lifecycle', text: M.msgOrderFailed(bot, what, symbol, errText(e), backoffMs > 0) })
  }
  tx(() => writeFx(botId, fx))
  console.error(`[live] bot ${botId} ${what} ${symbol} failed:`, errText(e))
}

/** Execute whatever the bot is waiting for (one order at a time per bot). */
export async function executeBot(botId: string, now = Date.now()): Promise<void> {
  if (busy.has(botId)) return
  busy.add(botId)
  try {
    const { st } = loadState(botId)
    if (st.position && (st.exitNow || st.pending?.kind === 'exit')) await sellOut(botId, now)
    else if (!st.position && st.pending?.kind === 'entry') await buyIn(botId, now)
    else if (!st.position && st.pending?.kind === 'exit') { st.pending = null; const { last } = loadState(botId); saveState(botId, st, last) } // nothing to sell
  } finally { busy.delete(botId) }
}

async function sellOut(botId: string, now: number) {
  if ((retryAt.get(botId) ?? 0) > now) return
  const { st } = loadState(botId)
  const pos = st.position!
  const reason = st.exitNow?.reason ?? 'TRAIL'
  let fill
  try { fill = await getExchange().sell(pos.symbol, pos.qty, { clientId: `tb${botId}x${now.toString(36)}` }) }
  catch (e) { return failure(botId, 'SELL', pos.symbol, e, now, /reconcile manually/i.test(errText(e)) ? 10 * 60_000 : 60_000) }
  // state may have moved while we awaited: re-read before booking
  const bot = getBot(botId)
  if (!bot) { console.error(`[live] bot ${botId} vanished while selling ${pos.symbol}; ${fill.qty} sold for ${fill.usdt} USDT is now unallocated`); return }
  const { st: s2, last } = loadState(botId)
  if (!s2.position) return
  const t = barOpen(now)
  const fx = newFx()
  closePosition(bot, s2, fx, { now, fresh: true, live: true }, barIndex(t), t, fill.price, reason, { qty: fill.qty, usdt: fill.usdt, feeUsdt: fill.feeUsdt, orderRef: fill.orderRef })
  s2.pending = null
  tx(() => { saveBot(bot); saveState(botId, s2, last); writeFx(botId, fx) })
  retryAt.delete(botId)
  killCheck(botId)
  applyPending(botId, now)
}

async function buyIn(botId: string, now: number) {
  const first = loadState(botId)
  const pend = first.st.pending!
  const t = barOpen(now)
  const drop = (reason: string, why: string) => {
    const bot = getBot(botId)
    if (!bot) return
    const { st, last } = loadState(botId)
    if (!st.pending) return
    const fx = newFx()
    st.pending = null
    rejectEntry(bot, st, fx, { now, fresh: true, live: true }, t, pend, why, reason)
    tx(() => { saveState(botId, st, last); writeFx(botId, fx) })
  }
  if (now - (pend.queuedBar + 1) * BAR_MS > LIVE_BAR_MAX_AGE_MS) return drop('entry_expired', 'entry is older than the live window; dropped')
  const ex = getExchange()
  let ref: number
  try { ref = (await ex.prices([pend.symbol]))[pend.symbol]! } catch (e) { failure(botId, 'BUY', pend.symbol, e, now); return drop('exec_failed', `no price: ${errText(e)}`) }
  if (!(ref > 0)) return drop('exec_failed', `no price for ${pend.symbol}`)

  // capital guard on FRESH balances: the bots' cash must be fully backed by the account, and this order must fit
  let free: number
  try { free = (await fetchBalances()).free.USDT ?? 0 } catch (e) { failure(botId, 'BUY', pend.symbol, e, now); return drop('exec_failed', `balances unavailable: ${errText(e)}`) }
  const bot = getBot(botId)
  if (!bot) return
  const { st: s1 } = loadState(botId)
  if (!s1.pending || s1.position) return
  const z = sizeEntry(bot, pend, ref * (1 + P.slip))
  if (!z.ok) return drop('min_notional', z.why)
  const L = ledger(free)
  if (L.shortfall > 0 || free + 1e-9 < z.notional) return drop('capital_guard', `account has ${free.toFixed(2)} USDT free, bots claim ${L.botCash.toFixed(2)}, order needs ${z.notional.toFixed(2)}`)

  let fill
  try { fill = await ex.buy(pend.symbol, z.notional, { clientId: `tb${botId}b${now.toString(36)}`, refPrice: ref, maxSlipPct: config.maxEntrySlipPct }) }
  catch (e) { failure(botId, 'BUY', pend.symbol, e, now); return drop('exec_failed', errText(e).slice(0, 200)) }

  const b2 = getBot(botId)
  if (!b2) { console.error(`[live] bot ${botId} vanished while buying ${pend.symbol}: ${fill.qty} bought for ${fill.usdt} USDT is unallocated`); return }
  const { st: s2, last } = loadState(botId)
  s2.pending = pend // the order is real whatever happened to the intent meanwhile
  const fx = newFx()
  applyLiveEntry(b2, s2, fx, { now, fresh: true, live: true }, t, { qty: fill.qty, usdt: fill.usdt, feeUsdt: fill.feeUsdt, orderRef: fill.orderRef })
  tx(() => { saveBot(b2); saveState(botId, s2, last); writeFx(botId, fx) })
}

/** Execute the decisions of every bot (called right after a bar was processed, and on boot). */
export async function executeAll(now = Date.now()) {
  for (const b of listBots()) {
    const { st } = loadState(b.id)
    if (st.exitNow || st.pending) await executeBot(b.id, now).catch((e) => console.error('[live] execute', b.id, e))
  }
}

let monitoring = false
/**
 * Stop monitor: Convert cannot rest stop orders on the exchange, so every STOP_POLL_SECONDS the last price of each held
 * asset is compared with the position's stop levels (C: trail/stop, all: hard stop). A breach sells at market.
 * It also retries sells that failed earlier.
 */
export async function monitorTick(now = Date.now()) {
  if (monitoring) return
  monitoring = true
  try {
    const held = listBots().map((b) => ({ b, st: loadState(b.id).st })).filter((x) => x.st.position)
    for (const x of held) if (x.st.exitNow || x.st.pending?.kind === 'exit') await executeBot(x.b.id, now).catch((e) => console.error('[live] retry', x.b.id, e))
    const open = held.map((x) => ({ id: x.b.id, symbol: x.st.position!.symbol })).filter((x) => !busy.has(x.id))
    if (!open.length) return
    let prices: Record<string, number>
    try { prices = await getExchange().prices([...new Set(open.map((x) => x.symbol))]) } catch { return }
    for (const { id } of open) {
      const { st, last } = loadState(id)
      const pos = st.position
      if (!pos || st.exitNow || busy.has(id)) continue
      const px = prices[pos.symbol]
      if (!(px > 0)) continue
      let reason: string | null = null
      if (pos.strategy === 'C' && px <= pos.stop) reason = pos.ratcheted ? 'TRAIL' : 'STOP'
      else if (px <= pos.hardStop) reason = 'HARD_STOP'
      if (!reason) continue
      const t = barOpen(now)
      st.exitNow = { reason, bar: barIndex(t), t }
      const fx = newFx()
      fx.events.push({ ts: now, kind: 'exit_triggered', symbol: pos.symbol, detail: `${reason}: price ${px} <= ${reason === 'HARD_STOP' ? pos.hardStop : pos.stop}` })
      tx(() => { saveState(id, st, last); writeFx(id, fx) }) // persist the intent BEFORE the order: a crash cannot lose it
      await executeBot(id, now).catch((e) => console.error('[live] stop sell', id, e))
    }
  } finally { monitoring = false }
}

/** API helper: sell the bot's position now (or drop its pending entry). Throws when the sell did not go through. */
export async function closeBotNow(botId: string, reason = 'MANUAL') {
  need(botId)
  const { st, last } = loadState(botId)
  if (!st.position) {
    if (st.pending) { st.pending = null; saveState(botId, st, last) }
    return
  }
  if (busy.has(botId)) throw new HttpError(409, 'an order for this bot is in flight, try again in a moment')
  if (!st.exitNow) { const t = barOpen(Date.now()); st.exitNow = { reason, bar: barIndex(t), t } }
  st.pending = null
  saveState(botId, st, last)
  retryAt.delete(botId)
  await executeBot(botId)
  if (loadState(botId).st.position) throw new HttpError(502, 'the sell order failed; the position is still open and will be retried automatically (see events)')
}

export const _test = { busy, retryAt, alertedAt }
