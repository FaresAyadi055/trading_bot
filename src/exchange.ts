// Exchange layer: account balances, prices and order execution.
//   MODE=live -> Binance Convert API (/sapi/v1/convert/*). The API key only needs "Reading" + Convert permission.
//   MODE=test -> spot market orders on the Binance testnet (testnet has no /sapi Convert endpoints).
// Everything else in the app talks to the `Exchange` interface, so tests inject a mock.
import { createHmac } from 'node:crypto'
import { config } from './config'

export interface Balances { free: Record<string, number>; locked: Record<string, number> }
export interface Fill {
  orderRef: string
  /** Base asset quantity bought / sold. */
  qty: number
  /** USDT spent (buy) or received after costs (sell). */
  usdt: number
  /** Explicit fee in USDT when the venue reports one separately (Convert embeds it in the rate: 0). */
  feeUsdt: number
  /** Effective price = usdt / qty. */
  price: number
}
export interface TradeOpts {
  /** Unique id so a retried order cannot be executed twice (honoured by the testnet backend). */
  clientId?: string
  /** Reference price: a BUY whose effective price is more than maxSlipPct above it is refused. */
  refPrice?: number
  maxSlipPct?: number
}
export interface SymbolCheck { symbol: string; ok: boolean; reason?: string; unavailable?: boolean }

export interface Exchange {
  readonly name: string
  ping(): Promise<void>
  balances(): Promise<Balances>
  /** Last prices (SYMBOLUSDT -> price) from the execution venue. */
  prices(symbols: string[]): Promise<Record<string, number>>
  buy(symbol: string, usdt: number, o?: TradeOpts): Promise<Fill>
  sell(symbol: string, qty: number, o?: TradeOpts): Promise<Fill>
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
async function publicPing(base: string) {
  let res: Response
  try { res = await fetch(`${base}/api/v3/ping`, { signal: AbortSignal.timeout(8_000) }) } catch (e) { throw new ExchangeError(`network error: ${String(e)}`, 0, null, true) }
  if (!res.ok) throw new ExchangeError(`ping -> HTTP ${res.status}`, res.status, null, true)
}

function guardSlippage(side: 'BUY' | 'SELL', price: number, o?: TradeOpts) {
  if (side !== 'BUY' || !o?.refPrice || !o.maxSlipPct) return
  const slip = (price / o.refPrice - 1) * 100
  if (slip > o.maxSlipPct) throw new ExchangeError(`price guard: effective ${price} is ${slip.toFixed(2)}% above reference ${o.refPrice} (max ${o.maxSlipPct}%)`, 0, null, false)
}

// ---------------------------------------------------------------- MODE=live : Binance Convert
interface ConvertPair { fromAsset: string; toAsset: string; fromAssetMinAmount: string; fromAssetMaxAmount: string }

export class ConvertExchange implements Exchange {
  readonly name = 'binance-convert'
  private c: Client
  private fraction = new Map<string, number>()
  private pairs = new Map<string, { at: number; list: ConvertPair[] }>()
  constructor(private base = config.binanceBase, key = config.apiKey, secret = config.apiSecret) { this.c = new Client(base, key, secret) }

  ping() { return publicPing(this.base) }
  balances() { return accountBalances(this.c) }
  prices(symbols: string[]) { return publicPrices(this.base, symbols) }

  private async digits(asset: string): Promise<number> {
    if (!this.fraction.size) for (const a of (await this.c.call('GET', '/sapi/v1/convert/assetInfo')) as { asset: string; fraction: number }[]) this.fraction.set(a.asset, Number(a.fraction))
    return this.fraction.get(asset) ?? 8
  }
  private async pairsFrom(from: string): Promise<ConvertPair[]> {
    const hit = this.pairs.get(from)
    if (hit && Date.now() - hit.at < 10 * 60_000) return hit.list
    const list = (await this.c.call('GET', '/sapi/v1/convert/exchangeInfo', { fromAsset: from })) as ConvertPair[]
    this.pairs.set(from, { at: Date.now(), list })
    return list
  }

  async tradable(symbols: string[]): Promise<SymbolCheck[]> {
    let buyable: Set<string>
    try { buyable = new Set((await this.pairsFrom('USDT')).map((p) => p.toAsset)) } catch (e) { return symbols.map((symbol) => ({ symbol, ok: false, unavailable: true, reason: String(e) })) }
    return symbols.map((symbol) => buyable.has(baseAsset(symbol)) ? { symbol, ok: true } : { symbol, ok: false, reason: `${baseAsset(symbol)} is not convertible with USDT on Binance Convert` })
  }

  /**
   * getQuote (retried: nothing is committed yet) -> acceptQuote (ONE attempt) -> poll orderStatus.
   * After the accept is sent the order is never re-sent: an ambiguous accept is resolved by quoteId, a slow one is surfaced for reconciliation.
   */
  private async convert(from: string, to: string, fromAmount: string, o?: TradeOpts, side: 'BUY' | 'SELL' = 'BUY'): Promise<{ orderRef: string; fromAmount: number; toAmount: number }> {
    let q: any
    for (let attempt = 0; ; attempt++) {
      try {
        q = await this.c.call('POST', '/sapi/v1/convert/getQuote', { fromAsset: from, toAsset: to, fromAmount, walletType: 'SPOT', validTime: '30s' })
        break
      } catch (e) {
        if (attempt >= 2 || !(e instanceof ExchangeError && e.retryable)) throw e
        await sleep(1000 * (attempt + 1))
      }
    }
    if (!q?.quoteId) throw new ExchangeError(`no quote returned for ${from}->${to} ${fromAmount} (insufficient balance or amount outside Convert limits)`)
    if (side === 'BUY') guardSlippage('BUY', Number(q.fromAmount) / Number(q.toAmount), o) // nothing executed yet: safe to refuse

    let orderId: string | undefined
    try {
      orderId = String((await this.c.call('POST', '/sapi/v1/convert/acceptQuote', { quoteId: q.quoteId })).orderId)
    } catch (e) {
      const s = await this.c.call('GET', '/sapi/v1/convert/orderStatus', { quoteId: q.quoteId }).catch(() => null)
      if (s?.orderId && s.orderStatus !== 'FAIL') orderId = String(s.orderId) // it did execute
      else throw e
    }
    for (let i = 0; i < 30; i++) {
      const s = await this.c.call('GET', '/sapi/v1/convert/orderStatus', { orderId })
      if (s.orderStatus === 'SUCCESS') return { orderRef: orderId, fromAmount: Number(s.fromAmount), toAmount: Number(s.toAmount) }
      if (s.orderStatus === 'FAIL') throw new ExchangeError(`convert order ${orderId} failed`)
      await sleep(1000)
    }
    throw new ExchangeError(`convert order ${orderId} still processing after 30s; reconcile manually`, 0, null, false)
  }

  async buy(symbol: string, usdt: number, o?: TradeOpts): Promise<Fill> {
    const amount = floorStr(usdt, await this.digits('USDT'))
    const r = await this.convert('USDT', baseAsset(symbol), amount, o, 'BUY')
    return { orderRef: r.orderRef, qty: r.toAmount, usdt: r.fromAmount, feeUsdt: 0, price: r.fromAmount / r.toAmount }
  }
  async sell(symbol: string, qty: number, o?: TradeOpts): Promise<Fill> {
    const base = baseAsset(symbol)
    const amount = floorStr(qty, await this.digits(base))
    const r = await this.convert(base, 'USDT', amount, o, 'SELL')
    return { orderRef: r.orderRef, qty: r.fromAmount, usdt: r.toAmount, feeUsdt: 0, price: r.toAmount / r.fromAmount }
  }
}

// ---------------------------------------------------------------- MODE=test : spot testnet market orders
export class TestnetExchange implements Exchange {
  readonly name = 'binance-testnet'
  private c: Client
  private lot = new Map<string, { step: number; minQty: number }>()
  constructor(private base = config.binanceBase, key = config.apiKey, secret = config.apiSecret) { this.c = new Client(base, key, secret) }

  ping() { return publicPing(this.base) }
  balances() { return accountBalances(this.c) }
  prices(symbols: string[]) { return publicPrices(this.base, symbols) }

  private async info(symbol: string) {
    const hit = this.lot.get(symbol)
    if (hit) return hit
    const j = await this.c.call('GET', '/api/v3/exchangeInfo', { symbol }, false)
    const f = (j.symbols?.[0]?.filters ?? []).find((x: any) => x.filterType === 'LOT_SIZE')
    const v = { step: Number(f?.stepSize ?? 1e-8), minQty: Number(f?.minQty ?? 0) }
    this.lot.set(symbol, v)
    return v
  }
  async tradable(symbols: string[]): Promise<SymbolCheck[]> {
    return Promise.all(symbols.map(async (symbol) => {
      try { const j = await this.c.call('GET', '/api/v3/exchangeInfo', { symbol }, false); return j.symbols?.[0]?.status === 'TRADING' ? { symbol, ok: true } : { symbol, ok: false, reason: 'not trading on the testnet' } }
      catch (e) { return e instanceof ExchangeError && e.status === 400 ? { symbol, ok: false, reason: 'not listed on the spot testnet' } : { symbol, ok: false, unavailable: true, reason: String(e) } }
    }))
  }

  private async order(symbol: string, side: 'BUY' | 'SELL', amt: Record<string, string>, o?: TradeOpts) {
    const clientId = o?.clientId?.slice(0, 36)
    try { return await this.c.call('POST', '/api/v3/order', { symbol, side, type: 'MARKET', newOrderRespType: 'FULL', newClientOrderId: clientId, ...amt }) }
    catch (e) {
      // ambiguous failure: the order may exist. Resolve by client id before reporting an error (never double-execute).
      if (clientId && e instanceof ExchangeError && (e.retryable || e.status === 0)) {
        const x = await this.c.call('GET', '/api/v3/order', { symbol, origClientOrderId: clientId }).catch(() => null)
        if (x?.status === 'FILLED') return x
      }
      throw e
    }
  }
  private parse(symbol: string, side: 'BUY' | 'SELL', r: any): Fill {
    const base = baseAsset(symbol)
    let baseFee = 0, usdtFee = 0
    for (const f of r.fills ?? []) { if (f.commissionAsset === base) baseFee += Number(f.commission); else if (f.commissionAsset === 'USDT') usdtFee += Number(f.commission) }
    const executed = Number(r.executedQty), quote = Number(r.cummulativeQuoteQty)
    if (!(executed > 0)) throw new ExchangeError(`order ${r.orderId} not filled (status ${r.status})`)
    if (side === 'BUY') { const qty = executed - baseFee; return { orderRef: String(r.orderId), qty, usdt: quote + usdtFee, feeUsdt: baseFee * (quote / executed) + usdtFee, price: (quote + usdtFee) / qty } }
    return { orderRef: String(r.orderId), qty: executed, usdt: quote - usdtFee, feeUsdt: usdtFee, price: (quote - usdtFee) / executed }
  }
  async buy(symbol: string, usdt: number, o?: TradeOpts): Promise<Fill> {
    const r = await this.order(symbol, 'BUY', { quoteOrderQty: floorStr(usdt, 8) }, o)
    return this.parse(symbol, 'BUY', r) // a market order cannot be pre-quoted, so no price guard here (an executed order must never be thrown away)
  }
  async sell(symbol: string, qty: number, o?: TradeOpts): Promise<Fill> {
    const { step, minQty } = await this.info(symbol)
    const dec = Math.max(0, Math.round(-Math.log10(step)))
    const q = Math.floor(qty / step + 1e-9) * step
    if (q < minQty || !(q > 0)) throw new ExchangeError(`quantity ${qty} is below the minimum lot ${minQty} for ${symbol}`)
    return this.parse(symbol, 'SELL', await this.order(symbol, 'SELL', { quantity: floorStr(q, dec) }, o))
  }
}

// ---------------------------------------------------------------- singleton / injection
let current: Exchange | null = null
export function getExchange(): Exchange {
  if (!current) current = config.mode === 'live' ? new ConvertExchange() : new TestnetExchange()
  return current
}
export const setExchange = (e: Exchange | null) => { current = e }
