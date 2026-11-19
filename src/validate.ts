// Hand-written request validation (replaces zod). Every failure is an HTTP 400 `validation_failed` with `issues`.
import { config } from './config'

export interface Issue { path: string; message: string }
export class HttpError extends Error {
  constructor(public status: number, msg: string, public issues?: Issue[]) { super(msg) }
}
const invalid = (issues: Issue[]): never => { throw new HttpError(400, 'validation_failed', issues) }
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** Binance spot USDT pair: 2-20 alphanumerics followed by USDT (e.g. BTCUSDT, 1000SATSUSDT). */
export const SYMBOL_RE = /^[A-Z0-9]{2,20}USDT$/
export const normSymbol = (s: string) => s.trim().toUpperCase()

function assets(v: unknown, issues: Issue[]): string[] | undefined {
  if (!Array.isArray(v)) { issues.push({ path: 'assets', message: 'must be an array of symbols' }); return }
  const out: string[] = []
  for (const x of v) {
    if (typeof x !== 'string') { issues.push({ path: 'assets', message: 'symbols must be strings' }); return }
    const s = normSymbol(x)
    if (!SYMBOL_RE.test(s)) issues.push({ path: 'assets', message: `"${x}" is not a USDT pair symbol (e.g. BTCUSDT)` })
    out.push(s)
  }
  if (out.length < 1) issues.push({ path: 'assets', message: 'at least one asset is required' })
  if (out.length > config.maxAssetsPerBot) issues.push({ path: 'assets', message: `at most ${config.maxAssetsPerBot} assets per bot` })
  if (new Set(out).size !== out.length) issues.push({ path: 'assets', message: 'duplicate assets' })
  return out
}
function name(v: unknown, issues: Issue[]): string | undefined {
  if (typeof v !== 'string') { issues.push({ path: 'name', message: 'must be a string' }); return }
  const s = v.trim()
  if (s.length < 1 || s.length > 60) issues.push({ path: 'name', message: 'must be 1-60 characters' })
  return s
}
function capital(v: unknown, issues: Issue[]): number | undefined {
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) { issues.push({ path: 'capital', message: 'must be a positive finite number (USDT)' }); return }
  return v
}
export const WHEN = ['now', 'after_exit'] as const
export type When = (typeof WHEN)[number]
function when(v: unknown, issues: Issue[]): When | undefined {
  if (!WHEN.includes(v as When)) { issues.push({ path: 'when', message: 'must be "now" or "after_exit"' }); return }
  return v as When
}

export interface CreateInput { name?: string; assets: string[]; capital: number; active?: boolean }
export function parseCreate(b: unknown): CreateInput {
  const issues: Issue[] = []
  if (!isObj(b)) return invalid([{ path: '', message: 'body must be a JSON object' }])
  const out: Partial<CreateInput> = {}
  if (b.name !== undefined) out.name = name(b.name, issues)
  if (b.assets === undefined) issues.push({ path: 'assets', message: 'required' }); else out.assets = assets(b.assets, issues)
  if (b.capital === undefined) issues.push({ path: 'capital', message: 'required' }); else out.capital = capital(b.capital, issues)
  if (b.active !== undefined) { if (typeof b.active !== 'boolean') issues.push({ path: 'active', message: 'must be a boolean' }); else out.active = b.active }
  if (issues.length) invalid(issues)
  return out as CreateInput
}

export interface UpdateInput { name?: string; assets?: string[]; capital?: number; when?: When }
export function parseUpdate(b: unknown): UpdateInput {
  const issues: Issue[] = []
  if (!isObj(b)) return invalid([{ path: '', message: 'body must be a JSON object' }])
  const out: UpdateInput = {}
  if (b.name !== undefined) out.name = name(b.name, issues)
  if (b.assets !== undefined) out.assets = assets(b.assets, issues)
  if (b.capital !== undefined) out.capital = capital(b.capital, issues)
  if (b.when !== undefined) out.when = when(b.when, issues)
  if (issues.length) invalid(issues)
  return out
}

/** Body `{ when }` / query `?when=` with a default of `after_exit`. */
export function parseWhen(v: unknown): When {
  if (v === undefined || v === null || v === '') return 'after_exit'
  const issues: Issue[] = []
  const w = when(isObj(v) ? v.when ?? 'after_exit' : v, issues)
  if (issues.length) invalid(issues)
  return w!
}
