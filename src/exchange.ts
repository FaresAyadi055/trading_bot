// Exchange layer: spot account, prices and order execution (market + resting stop-loss orders).
//   MODE=live -> api.binance.com spot (real funds, spot trade permission)
//   MODE=test -> PaperExchange: real mainnet prices, simulated fills against a fake USDT balance in the
//                paper database (data-test/), no API keys. Everything else talks to the `Exchange` interface,
//                so tests inject a mock.
import { createHmac } from 'node:crypto'
import { config } from './config'
import { db, tx } from './db'

export interface Balances { free: Record<string, number>; locked: Record<string, number> }
export interface Fill {
  orderRef: string
  /** Base asset quantity bought / sold. */
  qty: number
  /** USDT spent (buy) or received after costs (sell). */
  usdt: number
  /** Explicit fee in USDT when the venue reports one separately. */
  feeUsdt: number
  /** Effective price = usdt / qty. */
  price: number
}
export interface TradeOpts {
  /** Unique id so a retried order cannot be executed twice. */
  clientId?: string
  /** Reference price: a BUY whose effective price is more than maxSlipPct above it is refused. */
  refPrice?: number
  maxSlipPct?: number
}
export interface SymbolCheck { symbol: string; ok: boolean; reason?: string; unavailable?: boolean }
export interface StopOrder { orderRef: string; stopPrice: number; qty: number; status: string; type: string }
export interface OrderState { status: string; fill: Fill | null }

export interface Exchange {
  readonly name: string
  balances(): Promise<Balances>
  /** Last prices (SYMBOLUSDT -> price) from the execution venue. */
  prices(symbols: string[]): Promise<Record<string, number>>
  buy(symbol: string, usdt: number, o?: TradeOpts): Promise<Fill>
  sell(symbol: string, qty: number, o?: TradeOpts): Promise<Fill>
  /** Place a resting stop-loss sell order for `qty` at `stopPrice`. */
  placeStop(symbol: string, qty: number, stopPrice: number, o?: TradeOpts): Promise<StopOrder>
  cancelOrder(symbol: string, orderRef: string): Promise<void>
  /** Current state of an order; `fill` is set when it is FILLED. */
  orderStatus(symbol: string, orderRef: string): Promise<OrderState>
  /** Can this venue trade the given USDT pairs? */
  tradable(symbols: string[]): Promise<SymbolCheck[]>
}

export class ExchangeError extends Error {
  constructor(msg: string, public status = 0, public code: number | null = null, public retryable = false) { super(msg) }
}

export const baseAsset = (symbol: string) => symbol.replace(/USDT$/, '')
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Decimal string with at most `d` decimals, rounded DOWN, no exponent, no trailing zeros. */
export function floorStr(x: number, d: number): string {
  const f = 10 ** d
  const v = Math.floor(x * f + 1e-9) / f
  let s = v.toFixed(d)
  if (s.includes('.')) s = s.replace(/0+$/, '').replace(/\.$/, '')
  return s
}
/** Decimal string rounded to the nearest tick (never above `x` for a sell stop). */
export function tickStr(x: number, tick: number): { s: string; d: number } {
  const d = Math.max(0, Math.round(-Math.log10(tick)))
  const v = Math.floor(x / tick + 1e-9) * tick
  return { s: floorStr(v, d), d }
}

// ---------------------------------------------------------------- signed REST client
class Client {
  private offset = 0
  private synced = false
  constructor(private base: string, private key: string, private secret: string) {}

  private async sync() {
    const r = await fetch(`${this.base}/api/v3/time`, { signal: AbortSignal.timeout(10_000) })
    if (!r.ok) throw new ExchangeError(`time sync failed (HTTP ${r.status})`, r.status, null, true)
    this.offset = ((await r.json()) as { serverTime: number }).serverTime - Date.now()
    this.synced = true
  }

  /** Signed request. The query string is percent-encoded BEFORE signing (Binance requirement since 2026-01-15). */
  async call(method: 'GET' | 'POST' | 'DELETE', path: string, params: Record<string, string | number | undefined> = {}, signed = true): Promise<any> {
    for (let attempt = 0; attempt < 2; attempt++) {
      if (signed && !this.synced) await this.sync()
      const entries = Object.entries(params).filter(([, v]) => v !== undefined) as [string, string | number][]
      if (signed) { entries.push(['recvWindow', 10_000], ['timestamp', Date.now() + this.offset]) }
      let qs = entries.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`).join('&')
      if (signed) qs += `&signature=${createHmac('sha256', this.secret).update(qs).digest('hex')}`
      let res: Response
      try {
        res = await fetch(`${this.base}${path}${qs ? `?${qs}` : ''}`, { method, headers: { 'X-MBX-APIKEY': this.key }, signal: AbortSignal.timeout(15_000) })
      } catch (e) { throw new ExchangeError(`network error: ${String(e)}`, 0, null, true) }
      const text = await res.text()
      let j: any = null
      try { j = text ? JSON.parse(text) : null } catch { /* non-JSON error page */ }
      if (res.ok) return j
      const code = typeof j?.code === 'number' ? j.code : null
      if (code === -1021 && attempt === 0) { this.synced = false; continue } // clock drift: resync once
      throw new ExchangeError(`${path} -> HTTP ${res.status}${code != null ? ` (${code})` : ''}: ${j?.msg ?? text.slice(0, 200)}`, res.status, code, res.status >= 500 || res.status === 429 || res.status === 418)
    }
    throw new ExchangeError('request failed after clock resync', 0, null, true)
  }
}

async function accountBalances(c: Client): Promise<Balances> {
  const acc = await c.call('GET', '/api/v3/account', { omitZeroBalances: 'true' })
  const out: Balances = { free: {}, locked: {} }
  for (const b of acc.balances ?? []) { out.free[b.asset] = Number(b.free); out.locked[b.asset] = Number(b.locked) }
  return out
}
async function publicPrices(base: string, symbols: string[]): Promise<Record<string, number>> {
  if (!symbols.length) return {}
  const url = `${base}/api/v3/ticker/price?symbols=${encodeURIComponent(JSON.stringify(symbols))}`
  let res: Response
  try { res = await fetch(url, { signal: AbortSignal.timeout(10_000) }) } catch (e) { throw new ExchangeError(`network error: ${String(e)}`, 0, null, true) }
  if (!res.ok) throw new ExchangeError(`ticker/price -> HTTP ${res.status}`, res.status, null, res.status >= 500 || res.status === 429)
  const out: Record<string, number> = {}
  for (const r of (await res.json()) as { symbol: string; price: string }[]) out[r.symbol] = Number(r.price)
  return out
}

function guardSlippage(side: 'BUY' | 'SELL', price: number, o?: TradeOpts) {
  if (side !== 'BUY' || !o?.refPrice || !o.maxSlipPct) return
  const slip = (price / o.refPrice - 1) * 100
  if (slip > o.maxSlipPct) throw new ExchangeError(`price guard: effective ${price} is ${slip.toFixed(2)}% above reference ${o.refPrice} (max ${o.maxSlipPct}%)`, 0, null, false)
}

interface Filters { step: number; minQty: number; tick: number; minNotional: number }

export class SpotExchange implements Exchange {
  readonly name: string
  private c: Client
  private filters = new Map<string, Filters>()

  constructor(private base = config.binanceBase, key = config.apiKey, secret = config.apiSecret) {
    this.name = 'binance-spot'
    this.c = new Client(base, key, secret)
  }

  balances() { return accountBalances(this.c) }
  prices(symbols: string[]) { return publicPrices(this.base, symbols) }

  private async info(symbol: string): Promise<Filters> {
    const hit = this.filters.get(symbol)
    if (hit) return hit
    const j = await this.c.call('GET', '/api/v3/exchangeInfo', { symbol }, false)
    const list = (j.symbols?.[0]?.filters ?? []) as any[]
    const lot = list.find((x) => x.filterType === 'LOT_SIZE')
    const price = list.find((x) => x.filterType === 'PRICE_FILTER')
    const notional = list.find((x) => x.filterType === 'NOTIONAL') ?? list.find((x) => x.filterType === 'MIN_NOTIONAL')
    const v: Filters = {
      step: Number(lot?.stepSize ?? 1e-8), minQty: Number(lot?.minQty ?? 0),
      tick: Number(price?.tickSize ?? 1e-8), minNotional: Number(notional?.minNotional ?? 0),
    }
    this.filters.set(symbol, v)
    return v
  }

  async tradable(symbols: string[]): Promise<SymbolCheck[]> {
    return Promise.all(symbols.map(async (symbol) => {
      try {
        const j = await this.c.call('GET', '/api/v3/exchangeInfo', { symbol }, false)
        const s = j.symbols?.[0]
        if (!s) return { symbol, ok: false, reason: 'unknown Binance symbol' }
        if (s.quoteAsset !== 'USDT') return { symbol, ok: false, reason: `quote asset is ${s.quoteAsset}, only USDT pairs are supported` }
        return s.status === 'TRADING' ? { symbol, ok: true } : { symbol, ok: false, reason: `not trading (status ${s.status})` }
      } catch (e) { return { symbol, ok: false, unavailable: true, reason: String(e) } }
    }))
  }

  private async order(symbol: string, side: 'BUY' | 'SELL', amt: Record<string, string | undefined>, o?: TradeOpts) {
    const clientId = o?.clientId?.slice(0, 36)
    try { return await this.c.call('POST', '/api/v3/order', { symbol, side, newOrderRespType: 'FULL', newClientOrderId: clientId, ...amt }) }
    catch (e) {
      // ambiguous failure: the order may exist. Resolve by client id before reporting an error (never double-execute).
      if (clientId && e instanceof ExchangeError && (e.retryable || e.status === 0)) {
        const x = await this.c.call('GET', '/api/v3/order', { symbol, origClientOrderId: clientId }).catch(() => null)
        if (x?.status === 'FILLED' || x?.status === 'NEW' || x?.status === 'PARTIALLY_FILLED') return x
      }
      throw e
    }
  }

  private parse(r: any): Fill {
    const executed = Number(r.executedQty), quote = Number(r.cummulativeQuoteQty)
    let baseFee = 0, usdtFee = 0
    for (const f of r.fills ?? []) { if (f.commissionAsset === (r.symbol ?? '').replace(/USDT$/, '')) baseFee += Number(f.commission); else if (f.commissionAsset === 'USDT') usdtFee += Number(f.commission) }
    if (!(executed > 0)) throw new ExchangeError(`order ${r.orderId} not filled (status ${r.status})`)
    const qty = executed - baseFee
    const usdt = quote - usdtFee
    return { orderRef: String(r.orderId), qty, usdt, feeUsdt: baseFee * (quote / executed) + usdtFee, price: usdt / qty }
  }

  async buy(symbol: string, usdt: number, o?: TradeOpts): Promise<Fill> {
    const r = await this.order(symbol, 'BUY', { type: 'MARKET', quoteOrderQty: floorStr(usdt, 8) }, o)
    return this.parse(r) // a market order cannot be pre-quoted, so the price guard runs on the actual fill
  }

  async sell(symbol: string, qty: number, o?: TradeOpts): Promise<Fill> {
    const { step, minQty } = await this.info(symbol)
    const dec = Math.max(0, Math.round(-Math.log10(step)))
    const q = Math.floor(qty / step + 1e-9) * step
    if (q < minQty || !(q > 0)) throw new ExchangeError(`quantity ${qty} is below the minimum lot ${minQty} for ${symbol}`)
    return this.parse(await this.order(symbol, 'SELL', { type: 'MARKET', quantity: floorStr(q, dec) }, o))
  }

  /**
   * Resting stop-loss. STOP_LOSS (market on trigger) is preferred; if the symbol rejects that order type we
   * fall back to STOP_LOSS_LIMIT with a 1% buffer below the stop. The caller keeps a price monitor as a backstop.
   */
  async placeStop(symbol: string, qty: number, stopPrice: number, o?: TradeOpts): Promise<StopOrder> {
    const { step, minQty, tick } = await this.info(symbol)
    const dec = Math.max(0, Math.round(-Math.log10(step)))
    const q = Math.floor(qty / step + 1e-9) * step
    if (q < minQty || !(q > 0)) throw new ExchangeError(`stop quantity ${qty} is below the minimum lot ${minQty} for ${symbol}`)
    const stop = tickStr(stopPrice, tick)
    const clientId = o?.clientId?.slice(0, 36)
    try {
      const r = await this.order(symbol, 'SELL', { type: 'STOP_LOSS', quantity: floorStr(q, dec), stopPrice: stop.s, newClientOrderId: clientId }, o)
      return { orderRef: String(r.orderId), stopPrice: Number(stop.s), qty: q, status: r.status ?? 'NEW', type: 'STOP_LOSS' }
    } catch (e) {
      if (!(e instanceof ExchangeError) || e.retryable || e.status !== 400) throw e
      const limit = tickStr(Number(stop.s) * 0.99, tick)
      const r = await this.order(symbol, 'SELL', { type: 'STOP_LOSS_LIMIT', quantity: floorStr(q, dec), stopPrice: stop.s, price: limit.s, timeInForce: 'GTC', newClientOrderId: `${clientId ?? ''}L`.slice(0, 36) }, o)
      return { orderRef: String(r.orderId), stopPrice: Number(stop.s), qty: q, status: r.status ?? 'NEW', type: 'STOP_LOSS_LIMIT' }
    }
  }

  async cancelOrder(symbol: string, orderRef: string): Promise<void> {
    try { await this.c.call('DELETE', '/api/v3/order', { symbol, orderId: orderRef }) }
    catch (e) {
      // -2011 = unknown order (already filled / cancelled): treat as done, the caller reconciles by orderStatus
      if (e instanceof ExchangeError && e.code === -2011) return
      throw e
    }
  }

  /**
   * `GET /api/v3/order` has no `fills` array, so a filled resting stop would otherwise book a zero
   * fee. Read the actual commissions from `myTrades` (one extra request only when a stop fills).
   */
  private async fillsForOrder(symbol: string, orderId: string): Promise<any[]> {
    try {
      const r = await this.c.call('GET', '/api/v3/myTrades', { symbol, orderId, limit: 1000 })
      return Array.isArray(r) ? r : []
    } catch {
      return [] // best effort: booking the fill without the fee is better than not booking it
    }
  }

  async orderStatus(symbol: string, orderRef: string): Promise<OrderState> {
    const r = await this.c.call('GET', '/api/v3/order', { symbol, orderId: orderRef })
    const status = String(r.status ?? 'UNKNOWN')
    if (status === 'FILLED') {
      const fills = await this.fillsForOrder(symbol, orderRef)
      try { return { status, fill: this.parse({ ...r, symbol, fills }) } } catch { return { status, fill: null } }
    }
    return { status, fill: null }
  }
}

// ---------------------------------------------------------------- paper trading (MODE=test)
// Simulated fills at real mainnet prices. The fake account lives in the paper copy of the database, so a
// simulation can never move real funds. Stop orders are simulated too and fill at their stop price.

const PAPER_FEE = 0.001 // 0.1% per side, like Binance spot
const PAPER_SLIP = 0.001 // 10 bps adverse slippage per side

function paperBalancesRaw(): Balances {
  const out: Balances = { free: {}, locked: {} }
  for (const r of db.query('SELECT asset, free, locked FROM paper_account').all() as { asset: string; free: number; locked: number }[]) {
    out.free[r.asset] = r.free
    out.locked[r.asset] = r.locked
  }
  return out
}

/**
 * Create the fake account on first use. When the paper database was copied from a live one, seed enough USDT
 * to back the copied bots and credit the base assets of their open positions, so the ledger starts reconciled.
 */
export function ensurePaperAccount(): void {
  if (db.query("SELECT 1 FROM paper_account WHERE asset='USDT'").get()) return
  const botCash = (db.query('SELECT COALESCE(SUM(cash),0) AS s FROM bots').get() as { s: number }).s
  const usdt = Math.max(config.paperStartUsdt, botCash)
  tx(() => {
    db.query("INSERT OR IGNORE INTO paper_account(asset,free,locked) VALUES('USDT',?,0)").run(usdt)
    for (const row of db.query('SELECT state FROM bot_state').all() as { state: string }[]) {
      let pos: { symbol?: string; qty?: number } | null = null
      try { pos = JSON.parse(row.state).position } catch { continue }
      const qty = pos?.qty ?? 0
      if (!pos?.symbol || !(qty > 0)) continue
      db.query('INSERT INTO paper_account(asset,free,locked) VALUES(?,?,0) ON CONFLICT(asset) DO UPDATE SET free=free+excluded.free')
        .run(baseAsset(pos.symbol), qty)
    }
  })
}

/** Add fake USDT to the paper account. Returns the new free USDT. */
export function addPaperCapital(usdt: number): number {
  ensurePaperAccount()
  tx(() => db.query("UPDATE paper_account SET free=free+? WHERE asset='USDT'").run(usdt))
  return paperBalancesRaw().free.USDT ?? 0
}

export class PaperExchange implements Exchange {
  readonly name = 'paper'
  private pricesCache = new Map<string, { px: number; at: number }>()
  private seq = 0

  private nextRef(kind: string) { return `paper-${kind}-${Date.now().toString(36)}-${++this.seq}` }

  private async price(symbol: string): Promise<number> {
    const hit = this.pricesCache.get(symbol)
    if (hit && Date.now() - hit.at < 5_000) return hit.px
    const px = (await publicPrices(config.dataBase, [symbol]))[symbol]
    if (!(px > 0)) throw new ExchangeError(`no price for ${symbol}`, 0, null, true)
    this.pricesCache.set(symbol, { px, at: Date.now() })
    return px
  }

  private free(asset: string): number {
    return (db.query('SELECT free FROM paper_account WHERE asset=?').get(asset) as { free: number } | null)?.free ?? 0
  }
  private move(asset: string, delta: number) {
    db.query('INSERT INTO paper_account(asset,free,locked) VALUES(?,?,0) ON CONFLICT(asset) DO UPDATE SET free=free+excluded.free')
      .run(asset, delta)
  }

  balances(): Promise<Balances> {
    ensurePaperAccount()
    return Promise.resolve(paperBalancesRaw())
  }

  async prices(symbols: string[]): Promise<Record<string, number>> {
    if (!symbols.length) return {}
    const out = await publicPrices(config.dataBase, symbols)
    const at = Date.now()
    for (const [s, p] of Object.entries(out)) if (p > 0) this.pricesCache.set(s, { px: p, at })
    return out
  }

  async buy(symbol: string, usdt: number, o?: TradeOpts): Promise<Fill> {
    const px = await this.price(symbol)
    const fillPx = px * (1 + PAPER_SLIP)
    guardSlippage('BUY', fillPx, o)
    ensurePaperAccount()
    const grossQty = usdt / fillPx
    const baseFee = grossQty * PAPER_FEE
    const qty = grossQty - baseFee
    tx(() => {
      const free = this.free('USDT')
      if (free + 1e-9 < usdt) throw new ExchangeError(`paper account has ${free.toFixed(2)} USDT free, order needs ${usdt.toFixed(2)}`, 400, -2010)
      this.move('USDT', -usdt)
      this.move(baseAsset(symbol), qty)
    })
    return { orderRef: this.nextRef('b'), qty, usdt, feeUsdt: baseFee * fillPx, price: usdt / qty }
  }

  async sell(symbol: string, qty: number, _o?: TradeOpts): Promise<Fill> {
    const px = await this.price(symbol)
    const fillPx = px * (1 - PAPER_SLIP)
    ensurePaperAccount()
    const gross = qty * fillPx
    const feeUsdt = gross * PAPER_FEE
    const usdt = gross - feeUsdt
    tx(() => {
      const have = this.free(baseAsset(symbol))
      if (have + 1e-9 < qty) throw new ExchangeError(`paper account holds ${have} ${baseAsset(symbol)}, sell needs ${qty}`, 400, -2010)
      this.move(baseAsset(symbol), -qty)
      this.move('USDT', usdt)
    })
    return { orderRef: this.nextRef('s'), qty, usdt, feeUsdt, price: usdt / qty }
  }

  async placeStop(symbol: string, qty: number, stopPrice: number, _o?: TradeOpts): Promise<StopOrder> {
    ensurePaperAccount()
    const ref = this.nextRef('p')
    db.query('INSERT INTO paper_orders(order_ref,symbol,qty,stop_price,status,created_at) VALUES(?,?,?,?,?,?)')
      .run(ref, symbol, qty, stopPrice, 'NEW', Date.now())
    // Keep the simulated order table bounded: old completed orders are no longer needed for reconciliation.
    db.query("DELETE FROM paper_orders WHERE status!='NEW' AND created_at < ?").run(Date.now() - 7 * 24 * 3600_000)
    return { orderRef: ref, stopPrice, qty, status: 'NEW', type: 'STOP_LOSS' }
  }

  async cancelOrder(_symbol: string, orderRef: string): Promise<void> {
    const row = db.query('SELECT status FROM paper_orders WHERE order_ref=?').get(orderRef) as { status: string } | null
    if (!row) return // an order id copied from the live books: nothing to cancel
    if (row.status === 'FILLED') throw new ExchangeError('unknown order sent', 400, -2011)
    db.query("UPDATE paper_orders SET status='CANCELED' WHERE order_ref=?").run(orderRef)
  }

  private stopFill(row: { qty: number; stop_price: number }, orderRef: string): Fill {
    const gross = row.qty * row.stop_price
    const feeUsdt = gross * PAPER_FEE
    const usdt = gross - feeUsdt
    return { orderRef, qty: row.qty, usdt, feeUsdt, price: usdt / row.qty }
  }

  async orderStatus(_symbol: string, orderRef: string): Promise<OrderState> {
    const row = db.query('SELECT symbol, qty, stop_price, status FROM paper_orders WHERE order_ref=?').get(orderRef) as
      { symbol: string; qty: number; stop_price: number; status: string } | null
    if (!row) return { status: 'CANCELED', fill: null } // live order id copied with the DB: recreate it
    if (row.status === 'FILLED') return { status: 'FILLED', fill: this.stopFill(row, orderRef) }
    if (row.status !== 'NEW') return { status: row.status, fill: null }
    const px = await this.price(row.symbol).catch(() => 0)
    if (!(px > 0) || px > row.stop_price) return { status: 'NEW', fill: null }
    const fill = this.stopFill(row, orderRef)
    const asset = baseAsset(row.symbol)
    tx(() => {
      this.move(asset, -row.qty)
      this.move('USDT', fill.usdt)
      db.query("UPDATE paper_orders SET status='FILLED' WHERE order_ref=?").run(orderRef)
    })
    return { status: 'FILLED', fill }
  }

  async tradable(symbols: string[]): Promise<SymbolCheck[]> {
    return symbols.map((symbol) => ({ symbol, ok: /^[A-Z0-9]{2,}USDT$/.test(symbol) }))
  }
}

// ---------------------------------------------------------------- singleton / injection
let current: Exchange | null = null
export function getExchange(): Exchange {
  if (!current) current = config.mode === 'test' ? new PaperExchange() : new SpotExchange()
  return current
}
export const setExchange = (e: Exchange | null) => { current = e }
