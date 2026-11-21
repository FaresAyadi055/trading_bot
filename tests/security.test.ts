// Auth hardening: HTTPS enforcement, session cookies, security headers and rate limiting.
import { describe, expect, test } from 'bun:test'

process.env.DB_PATH = ':memory:'
process.env.ACCESS_TOKEN = 'test-token'
process.env.MODE = 'test'
process.env.NO_EXCHANGE = '1'
process.env.NO_WORKER = '1'
process.env.TRUST_PROXY = '1'
process.env.FORCE_HTTPS = '1'
process.env.AUTH_RATE_LIMIT_MAX = '3'
process.env.AUTH_RATE_LIMIT_WINDOW_SECONDS = '60'
process.env.AUTH_RATE_LIMIT_BLOCK_SECONDS = '60'
process.env.API_RATE_LIMIT_MAX = '1000'
process.env.API_RATE_LIMIT_WINDOW_SECONDS = '60'

const { app } = await import('../src/index')
const { config } = await import('../src/config')

const https = (path: string, init?: RequestInit) => app.request('https://bot.example.com' + path, init)
const http = (path: string, init?: RequestInit) => app.request('http://bot.example.com' + path, init)
const bearer = { authorization: 'Bearer test-token' }
/** Distinct client IPs per test so the per-IP budgets do not interfere. */
const ip = (n: number) => ({ 'cf-connecting-ip': `203.0.113.${n}` })

describe('transport', () => {
  test('bearer auth over HTTPS works', async () => {
    const r = await https('/api/status', { headers: { ...bearer, ...ip(1) } })
    expect(r.status).toBe(200)
    const j = (await r.json()) as any
    expect(j.auth).toBe('bearer')
    expect(j.secure).toBe(true)
  })

  test('plaintext API requests are refused (token is never accepted over HTTP)', async () => {
    const r = await http('/api/status', { headers: { ...bearer, ...ip(2), 'x-forwarded-proto': 'http' } })
    expect(r.status).toBe(403)
    expect(((await r.json()) as any).error).toBe('https_required')
  })

  test('plaintext page requests redirect to HTTPS', async () => {
    const r = await http('/bot', { headers: { ...ip(3), 'x-forwarded-proto': 'http' } })
    expect(r.status).toBe(308)
    expect(r.headers.get('location')).toBe('https://bot.example.com/bot')
  })

  test('security headers are set', async () => {
    const r = await https('/health', { headers: ip(4) })
    expect(r.headers.get('strict-transport-security')).toContain('max-age=')
    expect(r.headers.get('x-content-type-options')).toBe('nosniff')
    expect(r.headers.get('x-frame-options')).toBe('DENY')
    expect(r.headers.get('content-security-policy')).toContain("default-src 'self'")
    expect(r.headers.get('referrer-policy')).toBe('no-referrer')
  })
})

describe('session cookie', () => {
  test('the token is exchanged for an HttpOnly/Secure/SameSite cookie', async () => {
    const r = await https('/api/session', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...ip(5) },
      body: JSON.stringify({ token: 'test-token' }),
    })
    expect(r.status).toBe(200)
    const set = r.headers.get('set-cookie') ?? ''
    expect(set).toContain('tb_session=')
    expect(set.toLowerCase()).toContain('httponly')
    expect(set.toLowerCase()).toContain('secure')
    expect(set.toLowerCase()).toContain('samesite=strict')

    const cookie = set.split(';')[0]
    const s = await https('/api/status', { headers: { cookie, ...ip(5) } })
    expect(s.status).toBe(200)
    expect(((await s.json()) as any).auth).toBe('session')
  })

  test('a wrong token is rejected and counted', async () => {
    const r = await https('/api/session', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...ip(6) },
      body: JSON.stringify({ token: 'wrong' }),
    })
    expect(r.status).toBe(401)
  })

  test('logout clears the cookie', async () => {
    const r = await https('/api/session', { method: 'DELETE', headers: ip(7) })
    expect(r.status).toBe(200)
    expect((r.headers.get('set-cookie') ?? '').toLowerCase()).toContain('max-age=0')
  })

  test('missing credentials -> 401', async () => {
    const r = await https('/api/status', { headers: ip(8) })
    expect(r.status).toBe(401)
  })

  test('a non-string token is a normal 401, not a 500', async () => {
    const tokens = [123, null, {}, ['x']]
    for (let i = 0; i < tokens.length; i++) {
      const r = await https('/api/session', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...ip(10 + i) },
        body: JSON.stringify({ token: tokens[i] }),
      })
      expect(r.status).toBe(401)
    }
  })
})

describe('rate limiter', () => {
  test('a lockout survives a window rollover (block may outlive the counting window)', async () => {
    const { RateLimiter } = await import('../src/security')
    const rl = new RateLimiter(1_000, 2, 5_000)
    expect(rl.take('k', 0).allowed).toBe(true)
    expect(rl.take('k', 1).allowed).toBe(true)
    const blocked = rl.take('k', 2)
    expect(blocked.allowed).toBe(false)
    expect(blocked.retryAfter).toBe(5)
    expect(rl.take('k', 1_500).allowed).toBe(false) // the window rolled over, the block did not
    expect(rl.blocked('k', 1_500).blocked).toBe(true)
    expect(rl.take('k', 5_002).allowed).toBe(true) // block expired: a new budget starts
  })
})

describe('rate limiting', () => {
  test('failed logins are blocked after the configured budget', async () => {
    const headers = { authorization: 'Bearer wrong', ...ip(9) }
    // `bun test` shares the module cache between files, so read the limit that was actually configured
    // (this file's env is only applied when it is the first to import config).
    for (let i = 0; i < config.authRateLimitMax; i++) expect((await https('/api/status', { headers })).status).toBe(401)
    const blocked = await https('/api/status', { headers })
    expect(blocked.status).toBe(429)
    expect(Number(blocked.headers.get('retry-after'))).toBeGreaterThan(0)
    expect(((await blocked.json()) as any).error).toBe('rate_limited')
  })
})
