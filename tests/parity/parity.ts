// Parity check: the TypeScript engine vs the Python reference of BOT_SPEC §12, trade for trade.
// Needs python3 + pandas + numpy.  Run: bun run parity
process.env.ACCESS_TOKEN ??= 'x'
process.env.MODE ??= 'test'
process.env.NO_EXCHANGE = '1'
import { readFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildSeries, rowAt, type Series } from '../../src/features'
import { newBotState, stepBot } from '../../src/engine'
import { P } from '../../src/params'
import { newFx, type BotRow, type Candle } from '../../src/types'

if (process.env.PARITY_LOOSE_C) Object.assign(P.C, { gateCompressionRatio: 1.0, gateBreakoutMarginAtr: 0, gateAvoidAAtr: -1000, volumeMult: 1.2 })
if (process.env.PARITY_ONLY_C) P.A.volumeMult = 1e12
const dir = mkdtempSync(join(tmpdir(), 'parity-'))
const SYMS = ['BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'SOLUSDT', 'ADAUSDT']
const here = new URL('.', import.meta.url).pathname
const run = (args: string[]) => { const r = Bun.spawnSync(args, { stderr: 'inherit' }); if (r.exitCode !== 0) throw new Error(`failed: ${args.join(' ')}`) }
run(['python3', here + 'gen_data.py', dir, process.env.BARS ?? '6000'])
run(['python3', here + 'ref_dump.py', dir, SYMS.join(','), join(dir, 'ref.json')])
const ref = JSON.parse(readFileSync(join(dir, 'ref.json'), 'utf8')) as { trades: any[]; cash: number; signals: Record<string, number[]> }

const series = new Map<string, Series>()
for (const s of SYMS) {
  const lines = readFileSync(join(dir, `2017_${s}_4h.csv`), 'utf8').trim().split('\n').slice(1)
  const cs: Candle[] = lines.map((l) => { const [ts, o, h, lo, c, v] = l.split(','); return { t: Date.parse(ts!), o: +o!, h: +h!, l: +lo!, c: +c!, v: +v! } })
  series.set(s, buildSeries(cs))
}
const start = Math.max(...[...series.values()].map((S) => S.t[0]!)), end = Math.min(...[...series.values()].map((S) => S.t[S.t.length - 1]!))
const times = [...new Set([...series.values()].flatMap((S) => S.t))].filter((t) => t >= start && t <= end).sort((a, b) => a - b)

const bot: BotRow = { id: 'p', name: 'parity', assets: SYMS, initial_capital: 10_000, cash: 10_000, status: 'active', pending_action: [], created_at: 0, updated_at: 0 }
const st = newBotState(10_000)
const sells: any[] = [], buys: any[] = []
for (const t of times) {
  const rows = new Map()
  for (const [sym, S] of series) { const i = S.idx.get(t); if (i !== undefined) rows.set(sym, rowAt(sym, S, i)) }
  const fx = newFx()
  stepBot(bot, st, rows, t, fx, { now: 0, fresh: false })
  for (const x of fx.tx) (x.action === 'SELL' ? sells : buys).push(x)
}
const mine = sells.map((s, k) => ({ symbol: s.symbol, strategy: s.strategy, exit: s.bar_time, reason: s.exit_reason, r: s.r_multiple, pnl: s.pnl, entry: buys[k]?.bar_time }))
const refT = ref.trades.filter((t) => t.reason !== 'OPEN_AT_END')
console.log('signals A/C per symbol (reference):', JSON.stringify(ref.signals))
console.log(`trades  ts=${mine.length}  reference=${refT.length}`)
let bad = 0, maxDr = 0
for (let k = 0; k < Math.max(mine.length, refT.length); k++) {
  const a = mine[k], b = refT[k]
  if (!a || !b || a.symbol !== b.symbol || a.strategy !== b.strategy || a.exit !== b.exit || a.reason !== b.reason || a.entry !== b.entry) { bad++; if (bad < 6) console.log('MISMATCH', k, a, b); continue }
  maxDr = Math.max(maxDr, Math.abs(a.r - b.r))
}
const byStrat = (xs: any[]) => ['A', 'C'].map((s) => `${s}:${xs.filter((x) => x.strategy === s).length}`).join(' ')
console.log('by strategy  ts', byStrat(mine), ' ref', byStrat(refT))
console.log('exit reasons ts', JSON.stringify(Object.groupBy(mine, (x) => x.reason) && Object.fromEntries(Object.entries(Object.groupBy(mine, (x) => x.reason)).map(([k, v]) => [k, v!.length]))))
console.log(`mismatching trades: ${bad}   max |dR| = ${maxDr.toExponential(2)}`)
if (!st.position) console.log(`final cash  ts=${bot.cash.toFixed(6)}  reference=${ref.cash.toFixed(6)}`)
process.exit(bad === 0 && mine.length === refT.length && maxDr < 1e-9 ? 0 : 1)
