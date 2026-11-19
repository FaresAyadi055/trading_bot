// In-memory Exchange used by tests / smoke: balances, fills at a settable price, call log, failure injection.
import { baseAsset, ExchangeError, type Balances, type Exchange, type Fill, type SymbolCheck, type TradeOpts } from '../src/exchange'

export class MockExchange implements Exchange {
  readonly name = 'mock'
  free: Record<string, number>
  locked: Record<string, number> = {}
  price: Record<string, number> = {}
  calls: { op: string; symbol?: string; amount?: number }[] = []
  failNext: { op: 'buy' | 'sell' | 'balances' | 'prices' | 'ping'; err: Error }[] = []
  offline = false
  unsupported = new Set<string>()
  private n = 0
  constructor(usdt: number, price: Record<string, number> = {}) { this.free = { USDT: usdt }; this.price = price }

  private maybeFail(op: 'buy' | 'sell' | 'balances' | 'prices' | 'ping') {
    if (this.offline) throw new ExchangeError('offline', 0, null, true)
    const i = this.failNext.findIndex((f) => f.op === op)
    if (i >= 0) throw this.failNext.splice(i, 1)[0]!.err
  }
  async ping() { this.maybeFail('ping') }
  async balances(): Promise<Balances> { this.maybeFail('balances'); this.calls.push({ op: 'balances' }); return { free: { ...this.free }, locked: { ...this.locked } } }
  async prices(symbols: string[]) { this.maybeFail('prices'); return Object.fromEntries(symbols.map((s) => [s, this.price[s]!])) }
  async tradable(symbols: string[]): Promise<SymbolCheck[]> { return symbols.map((symbol) => this.unsupported.has(symbol) ? { symbol, ok: false, reason: 'not convertible' } : { symbol, ok: true }) }
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
}
