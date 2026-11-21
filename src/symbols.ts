// Tradability check for symbols a bot is about to listen to. The HTTP call itself is made by the worker
// (the only code that talks to Binance); tests inject their own validator.
import { listBots } from './bots'
import { HttpError } from './validate'
import { rt } from './runtime'
import { getExchange } from './exchange'

export interface SymbolCheck { symbol: string; ok: boolean; reason?: string; unavailable?: boolean }
export type SymbolValidator = (symbols: string[]) => Promise<SymbolCheck[]>

let validator: SymbolValidator = async () => { throw new HttpError(503, 'binance_unavailable: symbol validation is not running') }
export const setSymbolValidator = (v: SymbolValidator) => { validator = v }

/** Rejects (400) symbols that are not tradable Binance spot USDT pairs. Symbols already used by a bot were validated earlier. */
export async function assertTradable(symbols: string[]) {
  const known = new Set(listBots().flatMap((b) => b.assets))
  const todo = symbols.filter((s) => !known.has(s))
  if (!todo.length) return
  const res = await validator(todo)
  const down = res.find((r) => r.unavailable)
  if (down) throw new HttpError(503, `binance_unavailable: could not verify ${down.symbol} (${down.reason})`)
  const bad = res.filter((r) => !r.ok)
  if (!bad.length && rt.live) { // the execution venue must be able to trade it too (spot status / permissions)
    const ex = await getExchange().tradable(todo)
    const dn = ex.find((r) => r.unavailable)
    if (dn) throw new HttpError(503, `binance_unavailable: could not verify ${dn.symbol} on ${getExchange().name} (${dn.reason})`)
    bad.push(...ex.filter((r) => !r.ok))
  }
  if (bad.length) throw new HttpError(400, 'validation_failed', bad.map((b) => ({ path: 'assets', message: `${b.symbol}: ${b.reason}` })))
}
