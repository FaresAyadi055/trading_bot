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
process.env.DB_PATH = ':memory:'; process.env.ACCESS_TOKEN = 'tok'; process.env.BINANCE_BASE_URL = 'http://localhost:4999'; process.env.FETCH_DELAY_MS = '10'
const { app } = await import('../src/index')
const H = { authorization: 'Bearer tok', 'content-type': 'application/json' }
const call = async (m: string, path: string, body?: any) => {
  const r = await app.request(path, { method: m, headers: H, body: body ? JSON.stringify(body) : undefined })
  return { s: r.status, j: (await r.json().catch(() => null)) as any }
}
const ok = (name: string, cond: boolean) => { console.log(cond ? 'PASS' : 'FAIL', name); if (!cond) process.exitCode = 1 }
ok('no auth -> 401', (await app.request('/api/bots')).status === 401)
const c = await call('POST', '/api/bots', { name: 'smoke', assets: ['pepeusdt', 'DOGEUSDT'], capital: 1000 })
ok('create with arbitrary assets (normalised)', c.s === 201 && c.j.assets.join() === 'PEPEUSDT,DOGEUSDT')
ok('unknown symbol -> 400', (await call('POST', '/api/bots', { assets: ['FAKEUSDT'], capital: 1 })).s === 400)
ok('non-USDT symbol -> 400', (await call('POST', '/api/bots', { assets: ['BTCBUSD'], capital: 1 })).s === 400)
await Bun.sleep(1500)
let st = (await call('GET', '/api/status')).j
ok('only the bot assets were pulled', [...new Set(asks)].sort().join() === 'DOGEUSDT,PEPEUSDT')
ok('status lists pulled symbols', st.symbolsPulled.join() === 'DOGEUSDT,PEPEUSDT' && st.strategy.includes('A+C'))
ok('market features exist only for pulled symbols', (await call('GET', '/api/market')).j.map((m: any) => m.symbol).sort().join() === 'DOGEUSDT,PEPEUSDT')
ok('capital (flat)', (await call('PATCH', `/api/bots/${c.j.id}`, { capital: 2000 })).j.cash === 2000)
const e = await call('PATCH', `/api/bots/${c.j.id}`, { assets: ['PEPEUSDT', 'ETHUSDT'] })
ok('edit assets', e.s === 200 && e.j.assets.join() === 'PEPEUSDT,ETHUSDT')
await Bun.sleep(1500)
ok('ETH now pulled, DOGE no longer', (await call('GET', '/api/status')).j.symbolsPulled.join() === 'ETHUSDT,PEPEUSDT')
ok('deactivate now', (await call('POST', `/api/bots/${c.j.id}/deactivate`, { when: 'now' })).j.status === 'inactive')
await Bun.sleep(200)
ok('nothing pulled while no bot is active', (await call('GET', '/api/status')).j.symbolsPulled.length === 0)
ok('activate', (await call('POST', `/api/bots/${c.j.id}/activate`)).j.status === 'active')
const ex = await app.request(`/api/bots/${c.j.id}/export`, { headers: H })
const exj = (await ex.json()) as any
ok('export', ex.status === 200 && 'state' in exj && 'transactions' in exj)
ok('delete', (await call('DELETE', `/api/bots/${c.j.id}?when=now`)).j.result === 'deleted')
ok('bots left 0', (await call('GET', '/api/bots')).j.length === 0)
await Bun.sleep(100)
ok('candles purged with the last bot', (await call('GET', '/api/status')).j.candles.length === 0)
mock.stop(); process.exit(process.exitCode ?? 0)
