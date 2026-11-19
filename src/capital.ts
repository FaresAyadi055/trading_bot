// Capital ledger: compares the REAL account (Binance balances) with the bots' sub-allocations.
//   botCash     = Σ bot.cash                     USDT that must sit free in the account (it backs every bot's claim)
//   inPositions = Σ open position cost basis     USDT already converted into the bots' assets
//   allocated   = botCash + inPositions          what the bots are entitled to (inactive bots included: their cash is reserved)
//   unallocated = free USDT − botCash            real USDT not claimed by any bot  (= actualCapital − allocated)
// A bot may only be created / grown if the new claim fits into `unallocated`, so bots can never over-allocate the account.
import { db } from './db'
import { config } from './config'
import { baseAsset, getExchange, type Balances } from './exchange'
import { HttpError } from './validate'

const EPS = 1e-6
interface BotLine { id: string; name: string; status: string; cash: number; symbol: string | null; qty: number; positionCost: number }

function botLines(): BotLine[] {
  const rows = db.query('SELECT b.id, b.name, b.status, b.cash, s.state FROM bots b LEFT JOIN bot_state s ON s.bot_id = b.id ORDER BY b.created_at').all() as
    { id: string; name: string; status: string; cash: number; state: string | null }[]
  return rows.map((r) => {
    const pos = r.state ? (JSON.parse(r.state).position as { symbol: string; qty: number; notional: number } | null) : null
    return { id: r.id, name: r.name, status: r.status, cash: r.cash, symbol: pos?.symbol ?? null, qty: pos?.qty ?? 0, positionCost: pos?.notional ?? 0 }
  })
}

export interface Ledger {
  free: number; botCash: number; inPositions: number; allocated: number; actualCapital: number
  unallocated: number; shortfall: number
}
/** Pure bookkeeping given the real free USDT. `shortfall` > 0 means the bots claim more cash than the account holds. */
export function ledger(free: number, lines = botLines()): Ledger {
  const botCash = lines.reduce((a, b) => a + b.cash, 0)
  const inPositions = lines.reduce((a, b) => a + b.positionCost, 0)
  const unallocated = free - botCash
  return { free, botCash, inPositions, allocated: botCash + inPositions, actualCapital: free + inPositions, unallocated, shortfall: Math.max(0, -unallocated - EPS) }
}

let lastBal: { at: number; bal: Balances } | null = null
/** Fresh balances from the exchange (also feeds the cached view). */
export async function fetchBalances(): Promise<Balances> {
  const bal = await getExchange().balances()
  lastBal = { at: Date.now(), bal }
  return bal
}
export const fetchFree = async () => (await fetchBalances()).free.USDT ?? 0
/** Free USDT from the last balance fetch if it is not older than maxAgeMs (used where an await is impossible). */
export const recentFree = (maxAgeMs: number): number | null => (lastBal && Date.now() - lastBal.at <= maxAgeMs ? lastBal.bal.free.USDT ?? 0 : null)
export const resetCapitalCache = () => { lastBal = null }

/** Throws 409 when `delta` more USDT of allocation does not fit into the unallocated capital. Call synchronously right before mutating. */
export function assertAllocatable(free: number, delta: number, what: string) {
  if (delta <= 0) return
  const L = ledger(free)
  if (L.shortfall > 0) throw new HttpError(409, `capital_shortfall: the bots already claim ${L.botCash.toFixed(2)} USDT but the account only has ${free.toFixed(2)} USDT free; ${what} refused`)
  if (delta > L.unallocated + EPS) throw new HttpError(409, `over_allocation: ${what} needs ${delta.toFixed(2)} USDT but only ${Math.max(0, L.unallocated).toFixed(2)} USDT of the account is unallocated (account ${free.toFixed(2)} free, bots hold ${L.botCash.toFixed(2)})`)
}
/** Activation needs the bots' cash to be fully backed by the account. */
export function assertBacked(free: number, what: string) {
  const L = ledger(free)
  if (L.shortfall > 0) throw new HttpError(409, `capital_shortfall: the bots claim ${L.botCash.toFixed(2)} USDT but the account only has ${free.toFixed(2)} USDT free; ${what} refused`)
}

export interface CapitalSnapshot {
  at: number; mode: string; exchange: string; cached: boolean
  usdt: { free: number; locked: number }
  actualCapital: number; allocated: number; unallocated: number; botCash: number; inPositions: number; shortfall: number
  allocatedPct: number
  ok: boolean; drift: string[]
  bots: { id: string; name: string; status: string; cash: number; positionCost: number; allocated: number; share: number }[]
  holdings: { asset: string; needed: number; free: number; ok: boolean }[]
}

/** Dashboard / API view. Reconciles USDT and every bot-held asset against the real balances. */
export async function snapshot(fresh = false): Promise<CapitalSnapshot> {
  let cached = false
  let bal: Balances
  if (!fresh && lastBal && Date.now() - lastBal.at <= config.balanceTtlMs) { bal = lastBal.bal; cached = true } else bal = await fetchBalances()
  const lines = botLines()
  const L = ledger(bal.free.USDT ?? 0, lines)
  const needed = new Map<string, number>()
  for (const b of lines) if (b.symbol) needed.set(baseAsset(b.symbol), (needed.get(baseAsset(b.symbol)) ?? 0) + b.qty)
  const holdings = [...needed].map(([asset, n]) => ({ asset, needed: n, free: bal.free[asset] ?? 0, ok: (bal.free[asset] ?? 0) + EPS >= n * 0.999 }))
  const drift: string[] = []
  if (L.shortfall > 0) drift.push(`USDT shortfall: bots claim ${L.botCash.toFixed(2)} USDT cash but only ${L.free.toFixed(2)} USDT is free in the account`)
  for (const h of holdings) if (!h.ok) drift.push(`${h.asset} shortfall: bots hold ${h.needed} but the account has ${h.free}`)
  return {
    at: Date.now(), mode: config.mode, exchange: getExchange().name, cached,
    usdt: { free: bal.free.USDT ?? 0, locked: bal.locked.USDT ?? 0 },
    actualCapital: L.actualCapital, allocated: L.allocated, unallocated: L.unallocated, botCash: L.botCash, inPositions: L.inPositions, shortfall: L.shortfall,
    allocatedPct: L.actualCapital > 0 ? (L.allocated / L.actualCapital) * 100 : 0,
    ok: drift.length === 0, drift,
    bots: lines.map((b) => ({ id: b.id, name: b.name, status: b.status, cash: b.cash, positionCost: b.positionCost, allocated: b.cash + b.positionCost, share: L.actualCapital > 0 ? ((b.cash + b.positionCost) / L.actualCapital) * 100 : 0 })),
    holdings,
  }
}
