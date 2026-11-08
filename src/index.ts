import { Hono } from 'hono'
import { timingSafeEqual } from 'node:crypto'
import { ZodError } from 'zod'
import { BAR_MS, SYMBOLS, config } from './config'
import { db, getMeta, setMeta } from './db'
import {
  HttpError, activate, botView, cancelPending, createBot, createSchema, deactivate, deleteBot, exportBot, gcMarketData, getBot,
  listBots, updateBot, updateSchema, whenSchema,
} from './bots'
import { processAll, upsertCandles } from './runner'
import { flushNotifications } from './notify'
import { tree } from './tree'

const app = new Hono()

// ---- worker wiring (Binance REST fetching lives in the worker) ----
declare global { var __tbWorker: Worker | undefined }
function neededSymbols() {
  const used = new Set(listBots().filter((b) => b.status === 'active').flatMap((b) => b.assets))
  return [...used].map((symbol) => ({
    symbol,
    since: (db.query('SELECT MAX(open_time) m FROM candles WHERE symbol=?').get(symbol) as { m: number | null }).m,
  }))
}
function syncWorker(force = false) {
  globalThis.__tbWorker?.postMessage({ type: 'config', base: config.binanceBase, delay: config.fetchDelayMs, symbols: neededSymbols(), force })
}
function startWorker() {
  globalThis.__tbWorker?.terminate() // hot-reload safe
  const w = new Worker(new URL('./worker.ts', import.meta.url))
  w.onmessage = (e: MessageEvent) => {
    const m = e.data
    if (m.type === 'candles') upsertCandles(m.symbol, m.candles)
    else if (m.type === 'error') { setMeta('worker_error', `${new Date().toISOString()} ${m.symbol}: ${m.message}`); console.error('[worker]', m.symbol, m.message) }
    else if (m.type === 'cycleDone') {
      setMeta('worker_last_cycle', String(m.at))
      if (m.ok) db.query('DELETE FROM meta WHERE key=?').run('worker_error') // a clean cycle supersedes any stale error
      try { processAll() } catch (err) { console.error('[processAll]', err) }
      void flushNotifications()
    }
  }
  globalThis.__tbWorker = w
  syncWorker()
}

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
  if (err instanceof HttpError) return c.json({ error: err.message }, err.status as any)
  if (err instanceof ZodError) return c.json({ error: 'validation_failed', issues: err.issues }, 400)
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
  return c.json({
    now: Date.now(), nextBarAt: (Math.floor(Date.now() / BAR_MS) + 1) * BAR_MS, treeVersion: tree.treeVersion,
    symbols: SYMBOLS, workerLastCycle: Number(getMeta('worker_last_cycle') ?? 0) || null, workerError: getMeta('worker_error'),
    lastProcessedAt: Number(getMeta('last_processed_at') ?? 0) || null, candles: last, telegram: !!(config.telegramToken && config.telegramChatId),
    schemaVersion: getMeta('schema_version'), botCount: listBots().length,
  })
})
app.get('/api/market', (c) =>
  c.json((db.query('SELECT symbol, bar_time, features, updated_at FROM symbol_features').all() as any[]).map((r) => ({ symbol: r.symbol, barTime: r.bar_time, updatedAt: r.updated_at, features: JSON.parse(r.features) }))))

app.get('/api/bots', (c) => c.json(listBots().map(botView)))
app.post('/api/bots', async (c) => {
  const bot = createBot(createSchema.parse(await body(c)))
  syncWorker()
  return c.json(botView(bot), 201)
})
const need = (id: string) => { const b = getBot(id); if (!b) throw new HttpError(404, 'bot not found'); return b }
app.get('/api/bots/:id', (c) => c.json(botView(need(c.req.param('id')))))
app.patch('/api/bots/:id', async (c) => {
  const b = updateBot(c.req.param('id'), updateSchema.parse(await body(c)))
  syncWorker()
  return c.json(botView(b))
})
app.delete('/api/bots/:id', async (c) => {
  const { when } = whenSchema.parse({ when: c.req.query('when') ?? undefined })
  const r = deleteBot(c.req.param('id'), when)
  if (r === 'deleted') { gcMarketData(); syncWorker() }
  return c.json({ result: r }, r === 'deleted' ? 200 : 202)
})
app.post('/api/bots/:id/activate', (c) => { const b = activate(c.req.param('id')); syncWorker(); return c.json(botView(b)) })
app.post('/api/bots/:id/deactivate', async (c) => {
  const { when } = whenSchema.parse(await body(c))
  const b = deactivate(c.req.param('id'), when)
  syncWorker()
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
  startWorker()
  void flushNotifications()
}

export default { port: config.port, fetch: app.fetch, idleTimeout: 30 }
export { app }
