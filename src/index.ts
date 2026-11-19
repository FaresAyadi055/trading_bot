import { Hono } from 'hono'
import { timingSafeEqual } from 'node:crypto'
import { BAR_MS, config } from './config'
import { db, getMeta, setMeta } from './db'
import {
  activate, botView, cancelPending, createBot, deactivate, deleteBot, exportBot, gcMarketData, getBot, listBots, need,
  loadState, neededSymbols, referencedSymbols, updateBot,
} from './bots'
import { P, STRATEGY_NAME, STRATEGY_VERSION } from './params'
import { processAll, upsertCandles } from './runner'
import { flushNotifications } from './notify'
import { assertTradable, setSymbolValidator } from './symbols'
import { rt } from './runtime'
import { getExchange } from './exchange'
import { fetchFree, snapshot } from './capital'
import { closeBotNow, executeAll, monitorTick } from './live'
import { startHeartbeat } from './interrupt'
import { skipStaleBars } from './runner'
import { HttpError, parseCreate, parseUpdate, parseWhen } from './validate'

const app = new Hono()

// ---- worker wiring (Binance REST fetching lives in the worker) ----
declare global { var __tbWorker: Worker | undefined }
/** What the worker must pull right now: only assets an active bot listens to; a bot in a trade asks only for its asset. */
function workerSymbols() {
  return neededSymbols().map((symbol) => ({
    symbol,
    since: (db.query('SELECT MAX(open_time) m FROM candles WHERE symbol=?').get(symbol) as { m: number | null }).m,
  }))
}
function syncWorker(force = false) {
  globalThis.__tbWorker?.postMessage({ type: 'config', base: config.dataBase, delay: config.fetchDelayMs, symbols: workerSymbols(), force })
}
const waiting = new Map<number, (r: any[]) => void>()
let rpcId = 0
function startWorker() {
  globalThis.__tbWorker?.terminate() // hot-reload safe
  const w = new Worker(new URL('./worker.ts', import.meta.url))
  w.onmessage = (e: MessageEvent) => {
    const m = e.data
    if (m.type === 'candles') upsertCandles(m.symbol, m.candles)
    else if (m.type === 'error') { setMeta('worker_error', `${new Date().toISOString()} ${m.symbol}: ${m.message}`); console.error('[worker]', m.symbol, m.message) }
    else if (m.type === 'validated') { waiting.get(m.id)?.(m.results); waiting.delete(m.id) }
    else if (m.type === 'cycleDone') {
      setMeta('worker_last_cycle', String(m.at))
      if (m.ok) db.query('DELETE FROM meta WHERE key=?').run('worker_error') // a clean cycle supersedes any stale error
      try { processAll() } catch (err) { console.error('[processAll]', err) }
      syncWorker() // a bot that entered / exited a trade changes which assets must be pulled
      void flushNotifications()
      if (rt.live) void executeAll().catch((err) => console.error('[executeAll]', err)).finally(() => { syncWorker(); void flushNotifications() }) // real orders for the decisions just made
    }
  }
  globalThis.__tbWorker = w
  setSymbolValidator((symbols) => new Promise((resolve, reject) => {
    const id = ++rpcId
    const timer = setTimeout(() => { waiting.delete(id); reject(new HttpError(503, 'binance_unavailable: symbol validation timed out')) }, 25_000)
    waiting.set(id, (r) => { clearTimeout(timer); resolve(r) })
    w.postMessage({ type: 'validate', id, symbols })
  }))
  syncWorker()
}

/** Fresh free USDT of the account; the capital ledger cannot be enforced without it, so failure is a 503 (fail closed). */
async function freeOrFail(): Promise<number> {
  try { return await fetchFree() } catch (e) { throw new HttpError(503, `binance_unavailable: could not read the account balance (${e instanceof Error ? e.message : e})`) }
}
const lockedNow = (id: string) => { const { st } = loadState(id); return st.position?.symbol ?? st.pending?.symbol ?? null }

// ---- auth ----
const tokenOk = (given: string) => {
  const a = Buffer.from(given), b = Buffer.from(config.accessToken)
  return a.length === b.length && timingSafeEqual(a, b)
}
app.use('/api/*', async (c, next) => {
  const h = c.req.header('authorization') ?? ''
  const t = h.startsWith('Bearer ') ? h.slice(7) : (c.req.header('x-access-token') ?? '')
  if (!t || !tokenOk(t)) return c.json({ error: 'unauthorized' }, 401)
  await next()
})
app.onError((err, c) => {
  if (err instanceof HttpError) return c.json(err.issues ? { error: err.message, issues: err.issues } : { error: err.message }, err.status as any)
  if (err instanceof SyntaxError) return c.json({ error: 'invalid JSON body' }, 400)
  console.error(err)
  return c.json({ error: 'internal_error' }, 500)
})
const body = async (c: any) => { try { return await c.req.json() } catch { return {} } }

// ---- static dashboard (streamed from disk, not cached in memory) ----
const page = () => new Response(Bun.file(new URL('../public/index.html', import.meta.url)), { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } })
app.get('/', (c) => c.redirect('/bot'))
app.get('/bot', page) // frontend root
app.get('/bot/', page)
app.get('/bot/dashboard', page)
app.get('/bot/icon.svg', () => new Response(Bun.file(new URL('../public/icon.svg', import.meta.url)), { headers: { 'content-type': 'image/svg+xml', 'cache-control': 'no-store' } })) // dashboard route
app.get('/health', (c) => c.json({ ok: true }))

// ---- API ----
app.get('/api/status', (c) => {
  const last = (db.query('SELECT symbol, MAX(open_time) t, COUNT(*) n FROM candles GROUP BY symbol').all() as any[])
  const pulled = neededSymbols()
  const tracked = [...referencedSymbols()].sort()
  return c.json({
    now: Date.now(), nextBarAt: (Math.floor(Date.now() / BAR_MS) + 1) * BAR_MS, strategy: STRATEGY_VERSION,
    strategies: STRATEGY_NAME, regimeAnchor: P.regimeAnchor, binanceBase: config.dataBase, executionBase: config.binanceBase, mode: config.mode, exchange: getExchange().name, live: rt.live,
    heartbeatAt: Number(getMeta('heartbeat_at') ?? 0) || null, maxAssetsPerBot: config.maxAssetsPerBot,
    symbolsTracked: tracked, symbolsPulled: pulled, symbolsPaused: tracked.filter((s) => !pulled.includes(s)),
    workerLastCycle: Number(getMeta('worker_last_cycle') ?? 0) || null, workerError: getMeta('worker_error'),
    lastProcessedAt: Number(getMeta('last_processed_at') ?? 0) || null, candles: last, telegram: !!(config.telegramToken && config.telegramChatId),
    schemaVersion: getMeta('schema_version'), botCount: listBots().length,
  })
})
app.get('/api/capital', async (c) => {
  try { return c.json(await snapshot(c.req.query('fresh') === '1')) }
  catch (e) { throw new HttpError(503, `binance_unavailable: ${e instanceof Error ? e.message : e}`) }
})
app.get('/api/market', (c) =>
  c.json((db.query('SELECT symbol, bar_time, features, updated_at FROM symbol_features ORDER BY symbol').all() as any[]).map((r) => ({ symbol: r.symbol, barTime: r.bar_time, updatedAt: r.updated_at, features: JSON.parse(r.features) }))))

app.get('/api/bots', (c) => c.json(listBots().map(botView)))
app.post('/api/bots', async (c) => {
  const input = parseCreate(await body(c))
  await assertTradable(input.assets)
  const free = rt.live ? await freeOrFail() : undefined // fresh balance, then check + insert synchronously: bots can never over-allocate
  const bot = createBot(input, free)
  syncWorker()
  return c.json(botView(bot), 201)
})
app.get('/api/bots/:id', (c) => c.json(botView(need(c.req.param('id')))))
app.patch('/api/bots/:id', async (c) => {
  const id = c.req.param('id')
  const cur = need(id)
  const input = parseUpdate(await body(c))
  if (input.assets) await assertTradable(input.assets)
  const locked = lockedNow(id)
  if (rt.live && input.assets && input.when === 'now' && locked && !input.assets.includes(locked)) await closeBotNow(id)
  const free = rt.live && input.capital != null && input.capital > cur.initial_capital ? await freeOrFail() : undefined
  const b = updateBot(id, input, free)
  gcMarketData()
  syncWorker()
  return c.json(botView(b))
})
app.delete('/api/bots/:id', async (c) => {
  const when = parseWhen(c.req.query('when'))
  if (rt.live && when === 'now') await closeBotNow(c.req.param('id'))
  const r = deleteBot(c.req.param('id'), when)
  if (r === 'deleted') { gcMarketData(); syncWorker(); void flushNotifications() }
  return c.json({ result: r }, r === 'deleted' ? 200 : 202)
})
app.post('/api/bots/:id/activate', async (c) => {
  const id = c.req.param('id')
  const free = rt.live && need(id).status === 'inactive' ? await freeOrFail() : undefined
  const b = activate(id, free); syncWorker(); void flushNotifications(); return c.json(botView(b))
})
app.post('/api/bots/:id/deactivate', async (c) => {
  const when = parseWhen(await body(c))
  if (rt.live && when === 'now') await closeBotNow(c.req.param('id'))
  const b = deactivate(c.req.param('id'), when)
  gcMarketData()
  syncWorker()
  void flushNotifications()
  return c.json(botView(b))
})
app.delete('/api/bots/:id/pending/:type', (c) => c.json(botView(cancelPending(c.req.param('id'), c.req.param('type')))))
app.get('/api/bots/:id/transactions', (c) => {
  need(c.req.param('id'))
  const limit = Math.min(Number(c.req.query('limit') ?? 200) || 200, 1000)
  const before = Number(c.req.query('before') ?? 0) || Number.MAX_SAFE_INTEGER
  return c.json(db.query('SELECT * FROM transactions WHERE bot_id=? AND id<? ORDER BY id DESC LIMIT ?').all(c.req.param('id'), before, limit))
})
app.get('/api/bots/:id/events', (c) => { need(c.req.param('id')); return c.json(db.query('SELECT * FROM events WHERE bot_id=? ORDER BY id DESC LIMIT 200').all(c.req.param('id'))) })
app.get('/api/bots/:id/export', (c) => {
  const id = c.req.param('id')
  return new Response(JSON.stringify(exportBot(id), null, 2), {
    headers: { 'content-type': 'application/json', 'content-disposition': `attachment; filename="bot-${id}.json"` },
  })
})

// ---- boot ----
if (!process.env.NO_WORKER) {
  rt.live = true // real execution + capital enforcement (unit tests of the pure engine leave this off)
  // No catch-up replay: bars that closed while the process was down are skipped, then the heartbeat reports the gap.
  for (const b of listBots()) if (b.status === 'active') skipStaleBars(b.id)
  startWorker()
  void flushNotifications()
  startHeartbeat({
    onReconnect: () => syncWorker(true), // refresh candles right away
    afterAlert: async () => { await monitorTick(); await executeAll(); syncWorker(); void flushNotifications() }, // stops are re-checked after the alert
  })
  setInterval(() => void monitorTick().then(() => flushNotifications()).catch((e) => console.error('[monitor]', e)), config.stopPollMs)
  void executeAll().catch((e) => console.error('[executeAll]', e))
  console.log(`[boot] MODE=${config.mode} exchange=${getExchange().name} execution=${config.binanceBase} data=${config.dataBase}`)
}

export default { port: config.port, fetch: app.fetch, idleTimeout: 30 }
export { app, getBot }
