import { Hono } from 'hono'
import { BAR_MS, config } from './config'
import { db, getMeta, setMeta } from './db'
import { apiRateLimit, authMiddleware, httpsGuard, isSecureRequest, loginWithToken, logout, securityHeaders, type AppEnv } from './security'
import {
  activate, botView, cancelPending, createBot, deactivate, deleteBot, exportBot, gcMarketData, getBot, listBots, need,
  loadState, neededSymbols, referencedSymbols, syncUniverseToBots, updateBot,
} from './bots'
import { P, STRATEGY_NAME, STRATEGY_VERSION } from './params'
import { processAll, upsertCandles } from './runner'
import { flushNotifications, notifyApiFailure } from './notify'
import { rt } from './runtime'
import { getExchange, addPaperCapital } from './exchange'
import { fetchFree, resetCapitalCache, snapshot } from './capital'
import { closeBotNow, executeAll, monitorTick } from './live'
import * as M from './messages'
import { skipStaleBars } from './runner'
import { HttpError, parseCreate, parseUniverseConfig, parseUpdate, parseWhen } from './validate'
import {
  deselectSymbol, getUniverseMax, markUniverseBar, saveUniverse,
  setUniverseMax, universeStatus, universeUpdatedBar,
} from './universe_store'
import type { UniverseRow } from './universe'

const app = new Hono<AppEnv>()

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

let universeReqId = 0
let universeRequestedAt = 0
const UNIVERSE_REQUEST_TTL = 15 * 60_000

/** Ask the worker for a new universe snapshot (at most once per 15 min while one is in flight). */
function refreshUniverse(force = false) {
  const w = globalThis.__tbWorker
  if (!w) return false
  const bar = Math.floor(Date.now() / BAR_MS) - 1
  const last = universeUpdatedBar()
  const due = last == null || bar - last >= P.universe.refreshBars
  if (!force && !due) return false
  if (!force && universeRequestedAt && Date.now() - universeRequestedAt < UNIVERSE_REQUEST_TTL) return false
  universeRequestedAt = Date.now()
  setMeta('universe_progress', 'requested')
  w.postMessage({ type: 'universe', id: ++universeReqId, maxAssets: getUniverseMax() })
  return true
}

const waiting = new Map<number, (r: any[]) => void>()
let rpcId = 0
function startWorker() {
  globalThis.__tbWorker?.terminate() // hot-reload safe
  const w = new Worker(new URL('./worker.ts', import.meta.url))
  w.onmessage = (e: MessageEvent) => {
    const m = e.data
    if (m.type === 'candles') upsertCandles(m.symbol, m.candles)
    else if (m.type === 'error') {
      setMeta('worker_error', `${new Date().toISOString()} ${m.symbol}: ${m.message}`); console.error('[worker]', m.symbol, m.message)
      notifyApiFailure(`candles:${m.symbol}`, M.msgApiFailed(`Candles ${m.symbol}`, m.message))
      void flushNotifications()
      if (m.permanent) {
        const held = listBots().some((b) => { const { st } = loadState(b.id); return st.position?.symbol === m.symbol || st.pending?.symbol === m.symbol })
        if (!held) { deselectSymbol(m.symbol, 'delisted / not trading'); syncUniverseToBots(); syncWorker() }
      }
    } else if (m.type === 'universeProgress') {
      setMeta('universe_progress', `${m.done}/${m.total}`)
    } else if (m.type === 'universeResult') {
      universeRequestedAt = 0
      const rows = m.rows as UniverseRow[]
      const counts = m.counts as { total?: number; eligible?: number; volumeOk?: number } | undefined
      saveUniverse(rows, m.selected as string[])
      if (counts) {
        setMeta('universe_total_symbols', String(counts.total ?? 0))
        setMeta('universe_eligible_symbols', String(counts.eligible ?? 0))
      }
      markUniverseBar(Math.floor(m.at / BAR_MS) - 1)
      setMeta('universe_progress', 'done')
      db.query('DELETE FROM meta WHERE key=?').run('universe_error')
      syncUniverseToBots()
      syncWorker(true)
      console.log(`[universe] ${m.selected.length}/${getUniverseMax()} selected from ${rows.length} candidates in ${Math.round((m.at - m.startedAt) / 1000)}s`)
    } else if (m.type === 'universeError') {
      universeRequestedAt = 0
      setMeta('universe_progress', 'error')
      setMeta('universe_error', `${new Date().toISOString()} ${m.message}`)
      console.error('[universe]', m.message)
      notifyApiFailure('universe', M.msgApiFailed('Universe scan', m.message))
      void flushNotifications()
    } else if (m.type === 'cycleDone') {
      setMeta('worker_last_cycle', String(m.at))
      if (m.ok) db.query('DELETE FROM meta WHERE key=?').run('worker_error') // a clean cycle supersedes any stale error
      try { processAll() } catch (err) { console.error('[processAll]', err) }
      refreshUniverse()
      syncWorker() // a bot that entered / exited a trade changes which assets must be pulled
      void flushNotifications()
      if (rt.live) void executeAll().catch((err) => console.error('[executeAll]', err)).finally(() => { syncWorker(); void flushNotifications() }) // real orders for the decisions just made
    }
  }
  globalThis.__tbWorker = w
  syncWorker()
}

/** Fresh free USDT of the account; the capital ledger cannot be enforced without it, so failure is a 503 (fail closed). */
async function freeOrFail(): Promise<number> {
  try { return await fetchFree() } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    notifyApiFailure('balances', M.msgApiFailed('Account balance', msg))
    void flushNotifications()
    throw new HttpError(503, `binance_unavailable: could not read the account balance (${msg})`)
  }
}
const lockedNow = (id: string) => { const { st } = loadState(id); return st.position?.symbol ?? st.pending?.symbol ?? null }

// ---- auth / HTTP hardening ----
const body = async (c: any) => { try { return await c.req.json() } catch { return {} } }
app.use('*', securityHeaders)
app.use('*', httpsGuard)
app.use('/api/*', apiRateLimit)
// The session endpoint is the only API route reachable without a credential.
app.post('/api/session', async (c) => loginWithToken(c, (await body(c)).token))
app.delete('/api/session', (c) => logout(c))
app.use('/api/*', authMiddleware)
app.onError((err, c) => {
  if (err instanceof HttpError) return c.json(err.issues ? { error: err.message, issues: err.issues } : { error: err.message }, err.status as any)
  if (err instanceof SyntaxError) return c.json({ error: 'invalid JSON body' }, 400)
  console.error(err)
  return c.json({ error: 'internal_error' }, 500)
})

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
  const uni = universeStatus()
  return c.json({
    now: Date.now(), nextBarAt: (Math.floor(Date.now() / BAR_MS) + 1) * BAR_MS, strategy: STRATEGY_VERSION,
    strategies: STRATEGY_NAME, regimeAnchor: P.regimeAnchor, binanceBase: config.dataBase, executionBase: config.executionBase, mode: config.mode, exchange: getExchange().name, live: rt.live,
    auth: c.get('auth'), secure: isSecureRequest(c),
    universe: { selected: uni.selected.length, max: uni.maxAssets, candidates: uni.candidates, updatedAt: uni.updatedAt, updatedBar: uni.updatedBar, progress: getMeta('universe_progress'), error: getMeta('universe_error') },
    symbolsTracked: tracked, symbolsPulled: pulled, symbolsPaused: tracked.filter((s) => !pulled.includes(s)),
    workerLastCycle: Number(getMeta('worker_last_cycle') ?? 0) || null, workerError: getMeta('worker_error'),
    lastProcessedAt: Number(getMeta('last_processed_at') ?? 0) || null, candles: last, telegram: !!(config.telegramToken && config.telegramChatId),
    schemaVersion: getMeta('schema_version'), botCount: listBots().length,
  })
})
app.get('/api/universe', (c) => c.json(universeStatus()))
app.put('/api/universe/config', async (c) => {
  const { maxAssets } = parseUniverseConfig(await body(c))
  const max = setUniverseMax(maxAssets)
  syncUniverseToBots()
  syncWorker()
  return c.json({ maxAssets: max })
})
app.post('/api/universe/refresh', (c) => {
  const started = refreshUniverse(true)
  return c.json({ started }, started ? 202 : 409)
})
app.get('/api/capital', async (c) => {
  try { return c.json(await snapshot(c.req.query('fresh') === '1')) }
  catch (e) { throw new HttpError(503, `binance_unavailable: ${e instanceof Error ? e.message : e}`) }
})
/** Paper mode only: credit fake USDT to the simulated account (dashboard "Add test capital"). */
app.post('/api/paper/capital', async (c) => {
  if (config.mode !== 'test') throw new HttpError(400, 'paper_capital_is_only_available_in_test_mode')
  const amount = Number((await body(c)).amount)
  if (!Number.isFinite(amount) || amount <= 0 || amount > 1e9) throw new HttpError(400, 'amount must be a positive number (max 1e9)')
  const usdt = addPaperCapital(amount)
  resetCapitalCache()
  return c.json({ added: amount, usdt, mode: config.mode })
})
app.get('/api/market', (c) =>
  c.json((db.query('SELECT symbol, bar_time, features, updated_at FROM symbol_features ORDER BY symbol').all() as any[]).map((r) => ({ symbol: r.symbol, barTime: r.bar_time, updatedAt: r.updated_at, features: JSON.parse(r.features) }))))

app.get('/api/bots', (c) => c.json(listBots().map(botView)))
app.post('/api/bots', async (c) => {
  const input = parseCreate(await body(c))
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
  rt.live = true // execution + capital enforcement (real in live mode, simulated in paper mode; pure-engine tests leave it off)
  // No catch-up replay: bars that closed while the process was down are skipped. There is no connectivity
  // heartbeat; failures surface only through real requests (worker errors / order failures).
  for (const b of listBots()) if (b.status === 'active') skipStaleBars(b.id)
  syncUniverseToBots()
  startWorker()
  refreshUniverse(true)
  void flushNotifications()
  setInterval(() => void monitorTick().then(() => flushNotifications()).catch((e) => console.error('[monitor]', e)), config.stopPollMs)
  void executeAll().catch((e) => console.error('[executeAll]', e))
  console.log(`[boot] MODE=${config.mode} exchange=${getExchange().name} execution=${config.executionBase} data=${config.dataBase}`)
}

export default { port: config.port, fetch: app.fetch, idleTimeout: 30 }
export { app, getBot }
