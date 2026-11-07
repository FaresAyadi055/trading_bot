import { z } from 'zod'
import { randomBytes } from 'node:crypto'
import { SYMBOLS, lastClosedBar, type Symbol } from './config'
import { db, tx } from './db'
import { closePosition, newAssetState } from './engine'
import { params } from './tree'
import type { AssetState, BotRow, EvRow, Fx, PendingAction, TxRow } from './types'

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
export function loadStates(botId: string): Map<string, { st: AssetState; last: number | null }> {
  const m = new Map()
  for (const r of db.query('SELECT symbol,last_processed_bar,state FROM bot_asset_state WHERE bot_id=?').all(botId) as any[])
    m.set(r.symbol, { st: JSON.parse(r.state), last: r.last_processed_bar })
  return m
}
export function saveState(botId: string, symbol: string, st: AssetState, last: number | null) {
  db.query(`INSERT INTO bot_asset_state(bot_id,symbol,last_processed_bar,state) VALUES(?,?,?,?)
            ON CONFLICT(bot_id,symbol) DO UPDATE SET last_processed_bar=excluded.last_processed_bar, state=excluded.state`)
    .run(botId, symbol, last, JSON.stringify(st))
}
export function writeFx(botId: string, fx: Fx) {
  const ins = db.query(`INSERT INTO transactions(bot_id,ts,bar_time,symbol,action,strategy,price,qty,notional,fee,pnl,pnl_pct,r_multiple,exit_reason,cash_after)
                        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
  for (const x of fx.tx) ins.run(botId, x.ts, x.bar_time, x.symbol, x.action, x.strategy, x.price, x.qty, x.notional, x.fee, x.pnl, x.pnl_pct, x.r_multiple, x.exit_reason, x.cash_after)
  const ev = db.query('INSERT INTO events(bot_id,ts,kind,symbol,detail) VALUES(?,?,?,?,?)')
  for (const e of fx.events) ev.run(botId, e.ts, e.kind, e.symbol, e.detail)
  if (fx.events.length) db.query('DELETE FROM events WHERE bot_id=? AND id <= (SELECT id FROM events WHERE bot_id=? ORDER BY id DESC LIMIT 1 OFFSET 200)').run(botId, botId)
}
const lastClose = (symbol: string): number | null =>
  (db.query('SELECT close FROM candles WHERE symbol=? ORDER BY open_time DESC LIMIT 1').get(symbol) as { close: number } | null)?.close ?? null

/** The symbol the bot is locked to (open position or pending order), if any. */
export const lockedSymbol = (states: Map<string, { st: AssetState }>): string | null => {
  for (const [sym, { st }] of states) if (st.position || st.pendingOrder) return sym
  return null
}

// ---------- validation ----------
const symbolEnum = z.enum(SYMBOLS)
const assetsSchema = z.array(symbolEnum).min(1).max(SYMBOLS.length).refine((a) => new Set(a).size === a.length, 'duplicate assets')
export const createSchema = z.object({
  name: z.string().trim().min(1).max(60).optional(),
  assets: assetsSchema,
  capital: z.number().positive().finite(),
  active: z.boolean().optional(),
})
export const updateSchema = z.object({
  name: z.string().trim().min(1).max(60).optional(),
  assets: assetsSchema.optional(),
  capital: z.number().positive().finite().optional(),
  when: z.enum(['now', 'after_exit']).optional(),
})
export const whenSchema = z.object({ when: z.enum(['now', 'after_exit']).default('after_exit') })

export class HttpError extends Error { constructor(public status: number, msg: string) { super(msg) } }

// ---------- lifecycle ----------
export function createBot(input: z.infer<typeof createSchema>): BotRow {
  const now = Date.now()
  const bot: BotRow = {
    id: randomBytes(4).toString('hex'), name: input.name ?? '', assets: input.assets, initial_capital: input.capital, cash: input.capital,
    status: input.active === false ? 'inactive' : 'active', pending_action: [], created_at: now, updated_at: now,
  }
  if (!bot.name) bot.name = `bot-${bot.id}`
  tx(() => {
    db.query('INSERT INTO bots(id,name,assets,initial_capital,cash,status,pending_action,created_at,updated_at) VALUES(?,?,?,?,?,?,NULL,?,?)')
      .run(bot.id, bot.name, JSON.stringify(bot.assets), bot.initial_capital, bot.cash, bot.status, now, now)
    for (const s of bot.assets) saveState(bot.id, s, newAssetState(bot.cash), lastClosedBar(now)) // live from the next closed bar
    writeFx(bot.id, { tx: [], events: [{ ts: now, kind: 'created', symbol: null, detail: `${bot.assets.join(',')} capital ${bot.cash}` }] })
  })
  return bot
}

function forceClose(bot: BotRow, now = Date.now()) {
  const states = loadStates(bot.id)
  const sym = lockedSymbol(states)
  if (!sym) return
  const { st, last } = states.get(sym)!
  const fx: Fx = { tx: [], events: [] }
  if (st.position) {
    const px = lastClose(sym)
    if (px == null) throw new HttpError(409, `no market price for ${sym} yet; try again after the next candle`)
    closePosition(bot, st, sym, px * (1 - params.cost.slipRatePerSide), 'MANUAL', last ?? now, fx, now)
  }
  st.pendingOrder = null
  fx.events.push({ ts: now, kind: 'forced_close', symbol: sym, detail: 'manual immediate action' })
  saveState(bot.id, sym, st, last)
  writeFx(bot.id, fx)
}

function rebaseStates(bot: BotRow, now = Date.now()) {
  const l = lastClosedBar(now)
  for (const [sym, { st }] of loadStates(bot.id)) saveState(bot.id, sym, st, l)
}

function applyOne(bot: BotRow, a: PendingAction, now: number) {
  const ev: EvRow[] = []
  switch (a.type) {
    case 'deactivate':
      bot.status = 'inactive'; ev.push({ ts: now, kind: 'deactivated', symbol: null, detail: '' }); break
    case 'set_capital': {
      const delta = a.capital - bot.initial_capital
      if (bot.cash + delta <= 0) { ev.push({ ts: now, kind: 'capital_rejected', symbol: null, detail: 'would make cash non-positive' }); break }
      bot.cash += delta; bot.initial_capital = a.capital
      writeFx(bot.id, { tx: [{ ts: now, bar_time: null, symbol: null, action: 'CAPITAL', strategy: null, price: null, qty: null, notional: delta, fee: null, pnl: null, pnl_pct: null, r_multiple: null, exit_reason: null, cash_after: bot.cash }], events: [] })
      break
    }
    case 'edit_assets': {
      const states = loadStates(bot.id)
      const ref = [...states.values()].map((s) => s.last).find((x) => x != null) ?? lastClosedBar(now)
      for (const s of states.keys()) if (!a.assets.includes(s as Symbol)) db.query('DELETE FROM bot_asset_state WHERE bot_id=? AND symbol=?').run(bot.id, s)
      for (const s of a.assets) if (!states.has(s)) saveState(bot.id, s, newAssetState(bot.cash), ref)
      bot.assets = a.assets
      ev.push({ ts: now, kind: 'assets_changed', symbol: null, detail: a.assets.join(',') })
      break
    }
  }
  writeFx(bot.id, { tx: [], events: ev })
}

/** Apply actions that were waiting for the trade to exit. Returns true if the bot was deleted. */
export function applyPending(botId: string, now = Date.now()): boolean {
  return tx(() => {
    const bot = getBot(botId)
    if (!bot || !bot.pending_action.length) return !bot
    if (lockedSymbol(loadStates(botId))) return false // still in a trade
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

export function activate(id: string) {
  return tx(() => {
    const bot = need(id)
    bot.pending_action = bot.pending_action.filter((a) => a.type !== 'deactivate') // reactivate cancels a scheduled stop
    if (bot.status === 'inactive') { bot.status = 'active'; rebaseStates(bot) }
    writeFx(id, { tx: [], events: [{ ts: Date.now(), kind: 'activated', symbol: null, detail: '' }] })
    saveBot(bot)
    return bot
  })
}

export function deactivate(id: string, when: 'now' | 'after_exit') {
  tx(() => {
    const bot = need(id)
    if (bot.status === 'inactive') return
    const inTrade = !!lockedSymbol(loadStates(id))
    if (inTrade && when === 'after_exit') { addPending(bot, { type: 'deactivate', requestedAt: Date.now() }); saveBot(bot); return }
    if (inTrade) forceClose(bot)
    applyOne(bot, { type: 'deactivate', requestedAt: Date.now() }, Date.now())
    saveBot(bot)
  })
  return need(id)
}

export function updateBot(id: string, u: z.infer<typeof updateSchema>) {
  tx(() => {
    const bot = need(id)
    if (u.name) bot.name = u.name
    const when = u.when ?? 'after_exit'
    const locked = lockedSymbol(loadStates(id))
    if (u.assets) {
      const conflict = !!locked && !u.assets.includes(locked as Symbol)
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

export function deleteBot(id: string, when: 'now' | 'after_exit'): 'deleted' | 'scheduled' {
  return tx(() => {
    const bot = need(id)
    if (lockedSymbol(loadStates(id)) && when === 'after_exit') {
      addPending(bot, { type: 'delete', requestedAt: Date.now() }); saveBot(bot); return 'scheduled'
    }
    deleteNow(id); return 'deleted'
  })
}
function deleteNow(id: string) {
  db.query('DELETE FROM bots WHERE id=?').run(id) // cascades: states, transactions, events
}
export function cancelPending(id: string, type: string) {
  const bot = need(id)
  bot.pending_action = bot.pending_action.filter((a) => a.type !== type)
  saveBot(bot)
  return bot
}
function need(id: string): BotRow {
  const b = getBot(id)
  if (!b) throw new HttpError(404, 'bot not found')
  return b
}

/** Drop candles/features of symbols no bot trades any more (keeps storage constant). */
export function gcMarketData() {
  const used = new Set(listBots().flatMap((b) => b.assets))
  for (const s of SYMBOLS) if (!used.has(s)) {
    db.query('DELETE FROM candles WHERE symbol=?').run(s)
    db.query('DELETE FROM symbol_features WHERE symbol=?').run(s)
  }
}

// ---------- views ----------
export function botView(b: BotRow) {
  const states = loadStates(b.id)
  const lock = lockedSymbol(states)
  const lockSt = lock ? states.get(lock)!.st : null
  const pos = lockSt?.position ?? null
  const px = lock ? lastClose(lock) : null
  const equity = b.cash + (pos && px ? pos.qty * px : pos ? pos.qty * pos.entryFill : 0)
  const realized = (db.query("SELECT COALESCE(SUM(pnl),0) AS p, COUNT(*) AS n FROM transactions WHERE bot_id=? AND action='SELL'").get(b.id) as any)
  return {
    id: b.id, name: b.name, mode: b.assets.length === 1 ? 'single' : 'multi', assets: b.assets, status: b.status,
    initialCapital: b.initial_capital, cash: b.cash, equity, lastPrice: px, realizedPnl: realized.p, closedTrades: realized.n,
    position: pos && lock ? { symbol: lock, ...pos } : null,
    pendingOrder: lockSt?.pendingOrder ? { symbol: lock, ...lockSt.pendingOrder } : null,
    pendingActions: b.pending_action, createdAt: b.created_at, updatedAt: b.updated_at,
    perAsset: [...states].map(([symbol, { st, last }]) => ({
      symbol, lastProcessedBar: last, paused: st.paused, cooldownLeft: st.cooldownLeft, consecutiveLosses: st.consecutiveLosses,
      peakEquity: st.peakEquity, drawdownPct: st.drawdownPct, degradation: st.degradation, counters: st.tradeCounters, rejections: st.rejectionCounters,
    })),
  }
}

export function exportBot(id: string) {
  const b = need(id)
  return {
    exportedAt: new Date().toISOString(), bot: botView(b),
    assetStates: Object.fromEntries([...loadStates(id)].map(([s, v]) => [s, { lastProcessedBar: v.last, ...v.st }])),
    transactions: db.query('SELECT * FROM transactions WHERE bot_id=? ORDER BY id').all(id),
    events: db.query('SELECT * FROM events WHERE bot_id=? ORDER BY id').all(id),
  }
}
