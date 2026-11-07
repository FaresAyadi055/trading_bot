// Manual end-to-end smoke test: mock Binance + real app + worker. Run: bun tests/smoke.ts
export {}
const BAR = 4 * 3600_000
const now = Date.now()
const lastOpen = Math.floor(now / BAR) * BAR - BAR
const N = 400
const rows: any[] = []
let p = 100
for (let k = 0; k < N; k++) {
  const i = N - 1 - k
  const t = lastOpen - i * BAR
  const o = p; p *= 1 + 0.004 + Math.sin(k * 1.7) * 0.003; const c = p
  rows.push([t, String(o), String(Math.max(o, c) * 1.003), String(Math.min(o, c) * 0.997), String(c), k % 5 === 0 ? '300' : '100', t + BAR - 1])
}
const mock = Bun.serve({ port: 4999, fetch(req) {
  const u = new URL(req.url)
  if (u.pathname !== '/api/v3/klines') return new Response('nf', { status: 404 })
  const st = Number(u.searchParams.get('startTime') ?? 0)
  return Response.json(rows.filter((r) => r[0] >= st))
} })
process.env.DB_PATH = ':memory:'; process.env.ACCESS_TOKEN = 'tok'; process.env.BINANCE_BASE_URL = 'http://localhost:4999'; process.env.FETCH_DELAY_MS = '10'
const { app } = await import('../src/index')
const H = { authorization: 'Bearer tok', 'content-type': 'application/json' }
const call = async (m: string, path: string, body?: any) => {
  const r = await app.request(path, { method: m, headers: H, body: body ? JSON.stringify(body) : undefined })
  return { s: r.status, j: (await r.json().catch(() => null)) as any }
}
console.log('no auth ->', (await app.request('/api/bots')).status)
const c = await call('POST', '/api/bots', { name: 'smoke', assets: ['BTCUSDT', 'ETHUSDT'], capital: 1000 })
console.log('create', c.s, c.j.id, c.j.mode)
await call('POST', '/api/bots', { assets: ['DOGEUSDT'], capital: 1 }).then((r) => console.log('bad asset ->', r.s))
await Bun.sleep(1500) // worker fetches candles from the mock
console.log('status', JSON.stringify((await call('GET', '/api/status')).j.candles))
console.log('market', (await call('GET', '/api/market')).j.map((m: any) => m.symbol))
console.log('capital (flat) ->', (await call('PATCH', `/api/bots/${c.j.id}`, { capital: 2000 })).j.cash)
console.log('deactivate now ->', (await call('POST', `/api/bots/${c.j.id}/deactivate`, { when: 'now' })).j.status)
console.log('activate ->', (await call('POST', `/api/bots/${c.j.id}/activate`)).j.status)
const ex = await app.request(`/api/bots/${c.j.id}/export`, { headers: H })
console.log('export', ex.status, ex.headers.get('content-disposition'), Object.keys((await ex.json()) as object))
console.log('delete ->', (await call('DELETE', `/api/bots/${c.j.id}?when=now`)).j)
console.log('bots left', (await call('GET', '/api/bots')).j.length)
mock.stop(); process.exit(0)
