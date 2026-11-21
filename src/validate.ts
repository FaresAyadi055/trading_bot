// Hand-written request validation (replaces zod). Every failure is an HTTP 400 `validation_failed` with `issues`.
export interface Issue { path: string; message: string }
export class HttpError extends Error {
  constructor(public status: number, msg: string, public issues?: Issue[]) { super(msg) }
}
const invalid = (issues: Issue[]): never => { throw new HttpError(400, 'validation_failed', issues) }
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** Binance spot USDT pair: 2-20 alphanumerics followed by USDT (e.g. BTCUSDT, 1000SATSUSDT). */
export const SYMBOL_RE = /^[A-Z0-9]{2,20}USDT$/
export const normSymbol = (s: string) => s.trim().toUpperCase()

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

export interface CreateInput { name?: string; capital: number; active?: boolean }
export function parseCreate(b: unknown): CreateInput {
  const issues: Issue[] = []
  if (!isObj(b)) return invalid([{ path: '', message: 'body must be a JSON object' }])
  const out: Partial<CreateInput> = {}
  if (b.name !== undefined) out.name = name(b.name, issues)
  if (b.capital === undefined) issues.push({ path: 'capital', message: 'required' }); else out.capital = capital(b.capital, issues)
  if (b.active !== undefined) { if (typeof b.active !== 'boolean') issues.push({ path: 'active', message: 'must be a boolean' }); else out.active = b.active }
  if (issues.length) invalid(issues)
  return out as CreateInput
}

export interface UpdateInput { name?: string; capital?: number; when?: When }
export function parseUpdate(b: unknown): UpdateInput {
  const issues: Issue[] = []
  if (!isObj(b)) return invalid([{ path: '', message: 'body must be a JSON object' }])
  const out: UpdateInput = {}
  if (b.name !== undefined) out.name = name(b.name, issues)
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

/** `{ maxAssets }` for the dynamic universe configuration. */
export function parseUniverseConfig(b: unknown): { maxAssets: number } {
  if (!isObj(b)) return invalid([{ path: '', message: 'body must be a JSON object' }])
  const n = b.maxAssets
  if (typeof n !== 'number' || !Number.isFinite(n) || !Number.isInteger(n) || n < 1 || n > 500)
    return invalid([{ path: 'maxAssets', message: 'must be an integer between 1 and 500' }])
  return { maxAssets: n }
}
