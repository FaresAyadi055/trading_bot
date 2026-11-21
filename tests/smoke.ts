// Manual end-to-end smoke test: mock Binance + real app + worker. Run: bun tests/smoke.ts
export {}
const BAR = 4 * 3600_000
const now = Date.now()
const lastOpen = Math.floor(now / BAR) * BAR - BAR
const N = 400
const asks: string[] = []
const mk = (phase: number) => {
  const rows: any[] = []
  let p = 100
  for (let k = 0; k < N; k++) {
    const t = lastOpen - (N - 1 - k) * BAR
    const o = p; p *= 1 + 0.004 + Math.sin(k * 1.7 + phase) * 0.003; const c = p
    rows.push([t, String(o), String(Math.max(o, c) * 1.003), String(Math.min(o, c) * 0.997), String(c), k % 5 === 0 ? '300' : '100', t + BAR - 1])
  }
  return rows
}
const KNOWN = new Set(['BTCUSDT', 'ETHUSDT', 'PEPEUSDT', 'DOGEUSDT'])
const data: Record<string, any[]> = Object.fromEntries([...KNOWN].map((s, i) => [s, mk(i)]))
const mock = Bun.serve({ port: 4999, fetch(req) {
  const u = new URL(req.url)
  const sym = u.searchParams.get('symbol') ?? ''
  if (u.pathname === '/api/v3/exchangeInfo') {
    if (!KNOWN.has(sym)) return Response.json({ code: -1121, msg: 'Invalid symbol.' }, { status: 400 })
    return Response.json({ symbols: [{ symbol: sym, status: 'TRADING', quoteAsset: 'USDT', isSpotTradingAllowed: true }] })
  }
  if (u.pathname !== '/api/v3/klines') return new Response('nf', { status: 404 })
  asks.push(sym)
  if (!KNOWN.has(sym)) return Response.json({ code: -1121 }, { status: 400 })
  const st = Number(u.searchParams.get('startTime') ?? 0)
  return Response.json(data[sym]!.filter((r) => r[0] >= st))
} })
process.env.DB_PATH = ':memory:'; process.env.ACCESS_TOKEN = 'tok'; process.env.MODE = 'test'; process.env.NO_EXCHANGE = '1'
process.env.BINANCE_DATA_URL = 'http://localhost:4999'; process.env.BINANCE_BASE_URL = 'http://localhost:4999'; process.env.FETCH_DELAY_MS = '10'
// Execution + balances come from an injected mock account (no credentials needed); candles come from the mock server above.
const { setExchange } = await import('../src/exchange')
const { MockExchange } = await import('./mock_exchange')
const acct = new MockExchange(10_000, { BTCUSDT: 100, ETHUSDT: 100, PEPEUSDT: 100, DOGEUSDT: 100 })
setExchange(acct)
// Seed the dynamic universe (the live app fills it from Binance every 24h; the mock server has no ticker feed).
const { db, setMeta } = await import('../src/db')
{
  const ins = db.query('INSERT INTO universe(symbol,selected,rank,metrics,reason,updated_at,added_at) VALUES(?,?,?,?,?,?,?)')
  const data = (i: number) => JSON.stringify({ quoteVolume24h: 1e9 - i, bars: 500, contiguous: true, historyOk: true, lastBar: 0 })
  ins.run('PEPEUSDT', 1, 1, data(1), '', Date.now(), Date.now())
  ins.run('DOGEUSDT', 1, 2, data(2), '', Date.now(), Date.now())
  setMeta('universe_max_assets', '50')
  setMeta('universe_updated_bar', String(Math.floor(now / BAR) - 1))
  setMeta('universe_updated_at', String(Date.now()))
}
const { app } = await import('../src/index')
const H = { authorization: 'Bearer tok', 'content-type': 'application/json' }
const call = async (m: string, path: string, body?: any) => {
  const r = await app.request(path, { method: m, headers: H, body: body ? JSON.stringify(body) : undefined })
  return { s: r.status, j: (await r.json().catch(() => null)) as any }
}
const ok = (name: string, cond: boolean) => { console.log(cond ? 'PASS' : 'FAIL', name); if (!cond) process.exitCode = 1 }
ok('no auth -> 401', (await app.request('/api/bots')).status === 401)
const c = await call('POST', '/api/bots', { name: 'smoke', capital: 1000 })
ok('bot gets the dynamic universe', c.s === 201 && c.j.assets.join() === 'PEPEUSDT,DOGEUSDT')
const uni = await call('GET', '/api/universe')
ok('universe API lists the selection', uni.s === 200 && uni.j.selected.join() === 'PEPEUSDT,DOGEUSDT' && uni.j.maxAssets === 50)
ok('universe max is configurable', (await call('PUT', '/api/universe/config', { maxAssets: 25 })).j.maxAssets === 25)
ok('invalid universe max -> 400', (await call('PUT', '/api/universe/config', { maxAssets: 0 })).s === 400)
await Bun.sleep(1500)
let st = (await call('GET', '/api/status')).j
ok('only the universe symbols were pulled', [...new Set(asks)].sort().join() === 'DOGEUSDT,PEPEUSDT')
ok('status lists pulled symbols', st.symbolsPulled.join() === 'DOGEUSDT,PEPEUSDT' && st.strategy.includes('Donchian'))
ok('market features exist only for pulled symbols', (await call('GET', '/api/market')).j.map((m: any) => m.symbol).sort().join() === 'DOGEUSDT,PEPEUSDT')
ok('capital (flat)', (await call('PATCH', `/api/bots/${c.j.id}`, { capital: 2000 })).j.cash === 2000)
ok('deactivate now', (await call('POST', `/api/bots/${c.j.id}/deactivate`, { when: 'now' })).j.status === 'inactive')
await Bun.sleep(200)
ok('nothing pulled while no bot is active', (await call('GET', '/api/status')).j.symbolsPulled.length === 0)
ok('activate', (await call('POST', `/api/bots/${c.j.id}/activate`)).j.status === 'active')
const ex = await app.request(`/api/bots/${c.j.id}/export`, { headers: H })
const exj = (await ex.json()) as any
ok('export', ex.status === 200 && 'state' in exj && 'transactions' in exj)
const cap = (await call('GET', '/api/capital')).j
ok('capital ledger: account 10000, bot holds 2000 -> unallocated 8000', cap.actualCapital === 10_000 && cap.allocated === 2000 && cap.unallocated === 8000 && cap.ok)
ok('over-allocation refused (409)', (await call('POST', '/api/bots', { capital: 8001 })).s === 409)
ok('exact remainder accepted', (await call('POST', '/api/bots', { name: 'rest', capital: 8000 })).s === 201)
ok('status exposes mode', (await call('GET', '/api/status')).j.mode === 'test')
for (const b of (await call('GET', '/api/bots')).j) if (b.name === 'rest') await call('DELETE', `/api/bots/${b.id}?when=now`)
ok('delete', (await call('DELETE', `/api/bots/${c.j.id}?when=now`)).j.result === 'deleted')
ok('bots left 0', (await call('GET', '/api/bots')).j.length === 0)
await Bun.sleep(100)
// The selected universe still references its candles (they are kept for the next bot / universe refresh).
ok('candles of the selected universe are kept', (await call('GET', '/api/status')).j.candles.length === 2)
const pc = await call('POST', '/api/paper/capital', { amount: 500 })
ok('paper capital endpoint credits the paper account', pc.s === 200 && pc.j.added === 500 && pc.j.usdt >= 500)
mock.stop(); process.exit(process.exitCode ?? 0)
