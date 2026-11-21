// In-memory Exchange used by tests / smoke: balances, fills at a settable price, resting stop orders, call log,
// failure injection.
import { baseAsset, ExchangeError, type Balances, type Exchange, type Fill, type OrderState, type StopOrder, type SymbolCheck, type TradeOpts } from '../src/exchange'

interface MockStop { orderRef: string; symbol: string; qty: number; stopPrice: number; status: string; type: string }

export class MockExchange implements Exchange {
  readonly name = 'mock'
  free: Record<string, number>
  locked: Record<string, number> = {}
  price: Record<string, number> = {}
  calls: { op: string; symbol?: string; amount?: number }[] = []
  stops = new Map<string, MockStop>()
  failNext: { op: 'buy' | 'sell' | 'balances' | 'prices' | 'placeStop' | 'cancelOrder' | 'orderStatus'; err: Error }[] = []
  unsupported = new Set<string>()
  private n = 0
  constructor(usdt: number, price: Record<string, number> = {}) { this.free = { USDT: usdt }; this.price = price }

  private maybeFail(op: 'buy' | 'sell' | 'balances' | 'prices' | 'placeStop' | 'cancelOrder' | 'orderStatus') {
    const i = this.failNext.findIndex((f) => f.op === op)
    if (i >= 0) throw this.failNext.splice(i, 1)[0]!.err
  }
  async balances(): Promise<Balances> { this.maybeFail('balances'); this.calls.push({ op: 'balances' }); return { free: { ...this.free }, locked: { ...this.locked } } }
  async prices(symbols: string[]) { this.maybeFail('prices'); return Object.fromEntries(symbols.map((s) => [s, this.price[s]!])) }
  async tradable(symbols: string[]): Promise<SymbolCheck[]> { return symbols.map((symbol) => this.unsupported.has(symbol) ? { symbol, ok: false, reason: 'not tradable' } : { symbol, ok: true }) }
  async buy(symbol: string, usdt: number, _o?: TradeOpts): Promise<Fill> {
    this.calls.push({ op: 'buy', symbol, amount: usdt }); this.maybeFail('buy')
    if ((this.free.USDT ?? 0) < usdt) throw new ExchangeError('insufficient balance')
    const px = this.price[symbol]! * 1.0005
    const qty = usdt / px
    this.free.USDT! -= usdt; this.free[baseAsset(symbol)] = (this.free[baseAsset(symbol)] ?? 0) + qty
    return { orderRef: `m${++this.n}`, qty, usdt, feeUsdt: 0, price: px }
  }
  async sell(symbol: string, qty: number, _o?: TradeOpts): Promise<Fill> {
    this.calls.push({ op: 'sell', symbol, amount: qty }); this.maybeFail('sell')
    const a = baseAsset(symbol)
    if ((this.free[a] ?? 0) + 1e-12 < qty) throw new ExchangeError('insufficient balance')
    const px = this.price[symbol]! * 0.9995
    const usdt = qty * px
    this.free[a]! -= qty; this.free.USDT! += usdt
    return { orderRef: `m${++this.n}`, qty, usdt, feeUsdt: 0, price: px }
  }
  async placeStop(symbol: string, qty: number, stopPrice: number, _o?: TradeOpts): Promise<StopOrder> {
    this.calls.push({ op: 'placeStop', symbol, amount: stopPrice }); this.maybeFail('placeStop')
    const orderRef = `s${++this.n}`
    this.stops.set(orderRef, { orderRef, symbol, qty, stopPrice, status: 'NEW', type: 'STOP_LOSS' })
    return { orderRef, stopPrice, qty, status: 'NEW', type: 'STOP_LOSS' }
  }
  async cancelOrder(symbol: string, orderRef: string): Promise<void> {
    this.calls.push({ op: 'cancelOrder', symbol }); this.maybeFail('cancelOrder')
    const s = this.stops.get(orderRef)
    if (!s) throw new ExchangeError('unknown order', 400, -2011)
    if (s.status === 'NEW') s.status = 'CANCELED'
  }
  async orderStatus(symbol: string, orderRef: string): Promise<OrderState> {
    this.calls.push({ op: 'orderStatus', symbol }); this.maybeFail('orderStatus')
    const s = this.stops.get(orderRef)
    if (!s) throw new ExchangeError('unknown order', 400, -2011)
    if (s.status === 'NEW' && (this.price[symbol] ?? Infinity) <= s.stopPrice) {
      // trigger: the resting stop executes at its stop price
      const a = baseAsset(symbol)
      if ((this.free[a] ?? 0) + 1e-12 < s.qty) { s.status = 'REJECTED'; return { status: s.status, fill: null } }
      const usdt = s.qty * s.stopPrice
      this.free[a]! -= s.qty; this.free.USDT! += usdt
      s.status = 'FILLED'
      const fill: Fill = { orderRef: `m${++this.n}`, qty: s.qty, usdt, feeUsdt: 0, price: s.stopPrice }
      return { status: 'FILLED', fill }
    }
    return { status: s.status, fill: null }
  }
}
