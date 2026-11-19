import { randomBytes } from 'node:crypto'
import { barIndex, lastClosedBar } from './time'
import { db, tx } from './db'
import { config } from './config'
import { closePosition, newBotState, newDay } from './engine'
import * as M from './messages'
import { STATE_NAME, STRATEGY_NAME, P } from './params'
import { effectiveMinScore } from './strategy'
import { rt } from './runtime'
import { assertAllocatable, assertBacked, recentFree } from './capital'
import type { BotRow, BotState, EvRow, Fx, PendingAction } from './types'
import { newFx } from './types'
import { HttpError, type CreateInput, type UpdateInput, type When } from './validate'

export { HttpError }

// ---------- persistence helpers ----------
const parseBot = (r: any): BotRow => ({ ...r, assets: JSON.parse(r.assets), pending_action: r.pending_action ? JSON.parse(r.pending_action) : [] })
export const getBot = (id: string): BotRow | null => {
  const r = db.query('SELECT * FROM bots WHERE id=?').get(id)
  return r ? parseBot(r) : null
}
export const listBots = (): BotRow[] => db.query('SELECT * FROM bots ORDER BY created_at').all().map(parseBot)

export function saveBot(b: BotRow) {
  b.updated_at = Date.now()
  db.query('UPDATE bots SET name=?, assets=?, initial_capital=?, cash=?, status=?, pending_action=?, updated_at=? WHERE id=?')
    .run(b.name, JSON.stringify(b.assets), b.initial_capital, b.cash, b.status, b.pending_action.length ? JSON.stringify(b.pending_action) : null, b.updated_at, b.id)
}
export interface Loaded { st: BotState; last: number | null }
export function loadState(botId: string): Loaded {
  const r = db.query('SELECT last_processed_bar, state FROM bot_state WHERE bot_id=?').get(botId) as { last_processed_bar: number | null; state: string } | null
  if (!r) return { st: newBotState(getBot(botId)?.cash ?? 0), last: null }
  return { st: JSON.parse(r.state), last: r.last_processed_bar }
}
export function saveState(botId: string, st: BotState, last: number | null) {
  db.query(`INSERT INTO bot_state(bot_id,last_processed_bar,state) VALUES(?,?,?)
            ON CONFLICT(bot_id) DO UPDATE SET last_processed_bar=excluded.last_processed_bar, state=excluded.state`)
    .run(botId, last, JSON.stringify(st))
}
export const telegramOn = () => !!(config.telegramToken && config.telegramChatId)

/** Persist a bar's side effects: transactions, capped events and (only when Telegram is configured) outbox messages. */
export function writeFx(botId: string, fx: Fx) {
  const ins = db.query(`INSERT INTO transactions(bot_id,ts,bar_time,symbol,action,strategy,price,qty,notional,fee,pnl,pnl_pct,r_multiple,exit_reason,cash_after,order_ref)
                        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
  for (const x of fx.tx) ins.run(botId, x.ts, x.bar_time, x.symbol, x.action, x.strategy, x.price, x.qty, x.notional, x.fee, x.pnl, x.pnl_pct, x.r_multiple, x.exit_reason, x.cash_after, x.order_ref ?? null)
  const ev = db.query('INSERT INTO events(bot_id,ts,kind,symbol,detail) VALUES(?,?,?,?,?)')
  for (const e of fx.events) ev.run(botId, e.ts, e.kind, e.symbol, e.detail)
  if (fx.events.length) db.query('DELETE FROM events WHERE bot_id=? AND id <= (SELECT id FROM events WHERE bot_id=? ORDER BY id DESC LIMIT 1 OFFSET 200)').run(botId, botId)
  if (fx.notes.length && telegramOn()) {
    const n = db.query('INSERT INTO notifications(ts,bot_id,kind,strategy,text) VALUES(?,?,?,?,?)')
    const now = Date.now()
    for (const x of fx.notes) n.run(now, botId, x.kind, x.strategy ?? null, x.text)
  }
}
const lastClose = (symbol: string): number | null =>
  (db.query('SELECT close FROM candles WHERE symbol=? ORDER BY open_time DESC LIMIT 1').get(symbol) as { close: number } | null)?.close ?? null

/** The symbol the bot is locked to (open position or pending order), if any. */
export const lockedSymbol = (st: BotState): string | null => st.position?.symbol ?? st.pending?.symbol ?? null
/** Symbols the bot reads on its next bar: only the held one while it is in a trade, its whole universe when flat. */
export const trackSet = (bot: BotRow, st: BotState): string[] => { const l = lockedSymbol(st); return l ? [l] : bot.assets }

/**
 * Symbols the worker must pull from Binance. An asset is pulled only if at least one ACTIVE bot listens to it,
 * and a bot that is in a trade (or has an order pending) contributes only the asset it is trading.
 */
export function neededSymbols(): string[] {
  const out = new Set<string>()
  for (const b of listBots()) if (b.status === 'active') for (const s of trackSet(b, loadState(b.id).st)) out.add(s)
  return [...out].sort()
}
/** Symbols referenced by an active bot (pulled or temporarily paused): their stored candles are kept. */
export const referencedSymbols = (): Set<string> => new Set(listBots().filter((b) => b.status === 'active').flatMap((b) => b.assets))

// ---------- lifecycle ----------
/** `free` = real free USDT of the account (fresh). Required in live mode: the new bot's capital must fit into the unallocated capital. */
export function createBot(input: CreateInput, free?: number): BotRow {
  if (rt.live) {
    if (free === undefined) throw new HttpError(503, 'binance_unavailable: account balance is required to allocate capital')
    assertAllocatable(free, input.capital, `bot capital ${input.capital}`)
  }
  const now = Date.now()
  const bot: BotRow = {
    id: randomBytes(4).toString('hex'), name: input.name ?? '', assets: input.assets, initial_capital: input.capital, cash: input.capital,
    status: input.active === false ? 'inactive' : 'active', pending_action: [], created_at: now, updated_at: now,
  }
  if (!bot.name) bot.name = `bot-${bot.id}`
  const live = lastClosedBar(now) // live from the next closed bar, no historical backfill
  tx(() => {
    db.query('INSERT INTO bots(id,name,assets,initial_capital,cash,status,pending_action,created_at,updated_at) VALUES(?,?,?,?,?,?,NULL,?,?)')
      .run(bot.id, bot.name, JSON.stringify(bot.assets), bot.initial_capital, bot.cash, bot.status, now, now)
    saveState(bot.id, newBotState(bot.cash, barIndex(live)), live)
    const fx = newFx()
    fx.events.push({ ts: now, kind: 'created', symbol: null, detail: `${bot.assets.join(',')} capital ${bot.cash}` })
    if (bot.status === 'active') fx.notes.push({ kind: 'lifecycle', text: M.msgLifecycle('🤖', 'BOT STARTED', bot, `${bot.assets.length} asset(s): ${bot.assets.slice(0, 12).join(', ')}${bot.assets.length > 12 ? '…' : ''}\nCapital ${M.fmt(bot.cash)} USDT · strategies Donchian (A) + VCEB (C)`) })
    writeFx(bot.id, fx)
  })
  return bot
}

function forceClose(bot: BotRow, now = Date.now()) {
  const { st, last } = loadState(bot.id)
  const sym = lockedSymbol(st)
  if (!sym) return
  if (rt.live && st.position) throw new HttpError(409, 'an open live position must be sold on the exchange first (use the API route, which does this)')
  const fx = newFx()
  const bar = last ?? lastClosedBar(now)
  if (st.position) {
    const px = lastClose(sym)
    if (px == null) throw new HttpError(409, `no market price for ${sym} yet; try again after the next candle`)
    closePosition(bot, st, fx, { now, fresh: true }, barIndex(bar), bar, px * (1 - P.slip), 'MANUAL')
  }
  st.pending = null
  fx.events.push({ ts: now, kind: 'forced_close', symbol: sym, detail: 'manual immediate action' })
  saveState(bot.id, st, last)
  writeFx(bot.id, fx)
}

function rebase(bot: BotRow, now = Date.now()) {
  const { st } = loadState(bot.id)
  const l = lastClosedBar(now)
  st.day = newDay(barIndex(l) + 1)
  saveState(bot.id, st, l)
}

function applyOne(bot: BotRow, a: PendingAction, now: number) {
  const ev: EvRow[] = []
  const fx = newFx()
  switch (a.type) {
    case 'deactivate':
      bot.status = 'inactive'; ev.push({ ts: now, kind: 'deactivated', symbol: null, detail: '' })
      fx.notes.push({ kind: 'lifecycle', text: M.msgLifecycle('⏸️', 'BOT DEACTIVATED', bot, `Cash ${M.fmt(bot.cash)} USDT`) })
      break
    case 'set_capital': {
      const delta = a.capital - bot.initial_capital
      if (bot.cash + delta <= 0) { ev.push({ ts: now, kind: 'capital_rejected', symbol: null, detail: 'would make cash non-positive' }); break }
      if (rt.live && delta > 0) { // growing a bot claims more of the account: it must fit into the unallocated capital right now
        const free = recentFree(120_000)
        try { if (free === null) throw new HttpError(503, 'account balance unavailable'); assertAllocatable(free, delta, `capital increase of ${bot.name}`) }
        catch (e) {
          const why = e instanceof HttpError ? e.message : String(e)
          ev.push({ ts: now, kind: 'capital_rejected', symbol: null, detail: why })
          fx.notes.push({ kind: 'lifecycle', text: M.msgLifecycle('🚫', 'CAPITAL INCREASE REJECTED', bot, why) })
          break
        }
      }
      const { st, last } = loadState(bot.id)
      const before = bot.cash
      bot.cash += delta; bot.initial_capital = a.capital
      st.peak = st.peak * (bot.cash / before) // keep the drawdown ratio unchanged by a capital move
      saveState(bot.id, st, last)
      fx.tx.push({ ts: now, bar_time: null, symbol: null, action: 'CAPITAL', strategy: null, price: null, qty: null, notional: delta, fee: null, pnl: null, pnl_pct: null, r_multiple: null, exit_reason: null, cash_after: bot.cash })
      break
    }
    case 'edit_assets':
      bot.assets = a.assets
      ev.push({ ts: now, kind: 'assets_changed', symbol: null, detail: a.assets.join(',') })
      break
  }
  fx.events.push(...ev)
  writeFx(bot.id, fx)
}

/** Apply actions that were waiting for the trade to exit. Returns true if the bot was deleted. */
export function applyPending(botId: string, now = Date.now()): boolean {
  return tx(() => {
    const bot = getBot(botId)
    if (!bot || !bot.pending_action.length) return !bot
    if (lockedSymbol(loadState(botId).st)) return false // still in a trade
    if (bot.pending_action.some((a) => a.type === 'delete')) { deleteNow(botId); return true }
    for (const a of bot.pending_action) applyOne(bot, a, now)
    bot.pending_action = []
    saveBot(bot)
    return false
  })
}

const addPending = (bot: BotRow, a: PendingAction) => {
  bot.pending_action = bot.pending_action.filter((x) => x.type !== a.type)
  bot.pending_action.push(a)
}

export function activate(id: string, free?: number) {
  return tx(() => {
    const bot = need(id)
    if (rt.live && bot.status === 'inactive') {
      if (free === undefined) throw new HttpError(503, 'binance_unavailable: account balance is required to activate')
      assertBacked(free, `activating ${bot.name}`)
    }
    bot.pending_action = bot.pending_action.filter((a) => a.type !== 'deactivate') // reactivate cancels a scheduled stop
    const fx = newFx()
    if (bot.status === 'inactive') {
      bot.status = 'active'; rebase(bot)
      fx.notes.push({ kind: 'lifecycle', text: M.msgLifecycle('▶️', 'BOT ACTIVATED', bot, `${bot.assets.length} asset(s) · cash ${M.fmt(bot.cash)} USDT`) })
    }
    fx.events.push({ ts: Date.now(), kind: 'activated', symbol: null, detail: '' })
    writeFx(id, fx)
    saveBot(bot)
    return bot
  })
}

export function deactivate(id: string, when: When) {
  tx(() => {
    const bot = need(id)
    if (bot.status === 'inactive') return
    const inTrade = !!lockedSymbol(loadState(id).st)
    if (inTrade && when === 'after_exit') { addPending(bot, { type: 'deactivate', requestedAt: Date.now() }); saveBot(bot); return }
    if (inTrade) forceClose(bot)
    applyOne(bot, { type: 'deactivate', requestedAt: Date.now() }, Date.now())
    saveBot(bot)
  })
  return need(id)
}

export function updateBot(id: string, u: UpdateInput, free?: number) {
  tx(() => {
    const bot = need(id)
    if (rt.live && u.capital != null && u.capital > bot.initial_capital) {
      if (free === undefined) throw new HttpError(503, 'binance_unavailable: account balance is required to change capital')
      assertAllocatable(free, u.capital - bot.initial_capital, `capital increase of ${bot.name}`)
    }
    if (u.name) bot.name = u.name
    const when = u.when ?? 'after_exit'
    const locked = lockedSymbol(loadState(id).st)
    if (u.assets) {
      const conflict = !!locked && !u.assets.includes(locked)
      if (conflict && when === 'after_exit') addPending(bot, { type: 'edit_assets', assets: u.assets, requestedAt: Date.now() })
      else {
        if (conflict) forceClose(bot)
        applyOne(bot, { type: 'edit_assets', assets: u.assets, requestedAt: Date.now() }, Date.now())
        bot.pending_action = bot.pending_action.filter((a) => a.type !== 'edit_assets')
      }
    }
    if (u.capital != null) {
      if (locked) addPending(bot, { type: 'set_capital', capital: u.capital, requestedAt: Date.now() }) // never mid-trade
      else applyOne(bot, { type: 'set_capital', capital: u.capital, requestedAt: Date.now() }, Date.now())
    }
    saveBot(bot)
  })
  return need(id)
}

export function deleteBot(id: string, when: When): 'deleted' | 'scheduled' {
  return tx(() => {
    const bot = need(id)
    if (lockedSymbol(loadState(id).st) && when === 'after_exit') {
      addPending(bot, { type: 'delete', requestedAt: Date.now() }); saveBot(bot); return 'scheduled'
    }
    if (lockedSymbol(loadState(id).st)) forceClose(bot) // when=now: the SELL is logged / notified before the footprint goes
    deleteNow(id); return 'deleted'
  })
}
function deleteNow(id: string) {
  db.query('DELETE FROM bots WHERE id=?').run(id) // cascades: bot_state, transactions, events
}
export function cancelPending(id: string, type: string) {
  const bot = need(id)
  bot.pending_action = bot.pending_action.filter((a) => a.type !== type)
  saveBot(bot)
  return bot
}
export function need(id: string): BotRow {
  const b = getBot(id)
  if (!b) throw new HttpError(404, 'bot not found')
  return b
}

/** Drop candles/features of symbols no active bot references any more (keeps storage constant). */
export function gcMarketData() {
  const used = referencedSymbols()
  const stored = db.query('SELECT DISTINCT symbol FROM candles UNION SELECT symbol FROM symbol_features').all() as { symbol: string }[]
  for (const { symbol } of stored) if (!used.has(symbol)) {
    db.query('DELETE FROM candles WHERE symbol=?').run(symbol)
    db.query('DELETE FROM symbol_features WHERE symbol=?').run(symbol)
  }
}

// ---------- views ----------
export function botView(b: BotRow) {
  const { st, last } = loadState(b.id)
  const lock = lockedSymbol(st)
  const pos = st.position
  const px = lock ? lastClose(lock) : null
  const equity = b.cash + (pos ? pos.qty * (px ?? pos.entryFill) : 0)
  const realized = db.query("SELECT COALESCE(SUM(pnl),0) AS p, COUNT(*) AS n FROM transactions WHERE bot_id=? AND action='SELL'").get(b.id) as any
  const bar = barIndex(lastClosedBar())
  const basis = b.cash + (pos?.notional ?? 0) // realised equity (open position at cost)
  const pulled = b.status === 'active' ? trackSet(b, st) : []
  return {
    id: b.id, name: b.name, mode: b.assets.length === 1 ? 'single' : 'multi', assets: b.assets, status: b.status,
    initialCapital: b.initial_capital, cash: b.cash, equity, lastPrice: px, realizedPnl: realized.p, closedTrades: realized.n,
    position: pos ? { ...pos, strategyName: STRATEGY_NAME[pos.strategy] } : null,
    pendingOrder: st.pending ? { ...st.pending, strategyName: STRATEGY_NAME[st.pending.strategy] } : null,
    pendingActions: b.pending_action, createdAt: b.created_at, updatedAt: b.updated_at, lastProcessedBar: last,
    tracking: { pulled, paused: b.status === 'active' ? b.assets.filter((s) => !pulled.includes(s)) : [] },
    account: {
      regime: STATE_NAME[st.regime.state], minScore: effectiveMinScore(st.regime.state, b.assets.length), riskMult: P.regime.table[st.regime.state]!.riskMult,
      cooldownLeft: st.cooldown, paused: st.pauseUntil != null, pauseUntilBar: st.pauseUntil, consecutiveLosses: st.consecutiveLosses,
      peak: st.peak, drawdownPct: st.peak > 0 ? Math.max(0, 1 - basis / st.peak) : 0,
      weekR: st.closedR.filter((x) => x.bar > bar - P.lossWindowBars).reduce((a, x) => a + x.r, 0),
      frozen: { A: st.frozenUntil.A > bar, C: st.frozenUntil.C > bar },
    },
    counters: st.counters,
  }
}

export function exportBot(id: string) {
  const b = need(id)
  const { st, last } = loadState(id)
  return {
    exportedAt: new Date().toISOString(), bot: botView(b), state: { lastProcessedBar: last, ...st },
    transactions: db.query('SELECT * FROM transactions WHERE bot_id=? ORDER BY id').all(id),
    events: db.query('SELECT * FROM events WHERE bot_id=? ORDER BY id').all(id),
  }
}
