import { createHmac, timingSafeEqual } from 'node:crypto'
import type { Context, MiddlewareHandler } from 'hono'
import { getCookie, setCookie, deleteCookie } from 'hono/cookie'
import { getConnInfo } from 'hono/bun'
import { config } from './config'

/**
 * HTTP hardening for the dashboard / API.
 *
 * The access token is a long-lived shared secret, so it gets three layers of protection:
 *  1. TLS enforcement: plaintext API calls are refused from public addresses (loopback and
 *     private LAN addresses are exempt, so http://raspberrypi.local:3000 works at home), so the
 *     token is never accepted from an unencrypted public connection. Behind Cloudflare Tunnel the
 *     edge terminates TLS and `TRUST_PROXY=1` makes the forwarded scheme trustworthy.
 *  2. HttpOnly session cookies: the dashboard exchanges the token once for a signed, HttpOnly,
 *     Secure (when TLS is in use), SameSite=Strict cookie. JavaScript (and therefore XSS) can
 *     never read it back, and the token is not kept in localStorage.
 *  3. Rate limiting: per-IP failed-auth budget with a temporary block, plus a per-IP request
 *     budget for the whole API surface.
 */

export const SESSION_COOKIE = 'tb_session'

// ---- rate limiting -------------------------------------------------------------------------

type Bucket = { count: number; resetAt: number; blockedUntil: number }

/** Fixed-window counter with an optional lockout once the budget is exhausted. */
export class RateLimiter {
  private readonly buckets = new Map<string, Bucket>()
  private ops = 0

  constructor(
    private readonly windowMs: number,
    private readonly max: number,
    private readonly blockMs: number,
  ) {}

  /** Drop expired buckets lazily so the map cannot grow without bound. */
  private sweep(now: number) {
    if (++this.ops % 512 !== 0) return
    for (const [key, b] of this.buckets) if (now >= b.resetAt && now >= b.blockedUntil) this.buckets.delete(key)
  }

  /** Count one event and report whether it is allowed. */
  take(key: string, now = Date.now()): { allowed: boolean; retryAfter: number } {
    this.sweep(now)
    let b = this.buckets.get(key)
    if (!b) {
      b = { count: 0, resetAt: now + this.windowMs, blockedUntil: 0 }
      this.buckets.set(key, b)
    } else if (now >= b.resetAt) {
      // Start a new counting window. An active lockout survives the rollover: the block may be
      // longer than the window, and wiping it here would hand an attacker a fresh budget mid-block.
      b.count = 0
      b.resetAt = now + this.windowMs
      if (b.blockedUntil <= now) b.blockedUntil = 0
    }
    if (b.blockedUntil > now) return { allowed: false, retryAfter: Math.max(1, Math.ceil((b.blockedUntil - now) / 1000)) }
    if (b.blockedUntil) { b.blockedUntil = 0; b.count = 0 } // lockout served: start with a fresh budget
    b.count++
    if (b.count > this.max) {
      if (this.blockMs > 0) b.blockedUntil = now + this.blockMs
      const until = b.blockedUntil > now ? b.blockedUntil : b.resetAt
      return { allowed: false, retryAfter: Math.max(1, Math.ceil((until - now) / 1000)) }
    }
    return { allowed: true, retryAfter: 0 }
  }

  /** Read-only check used before doing any expensive work. */
  blocked(key: string, now = Date.now()): { blocked: boolean; retryAfter: number } {
    const b = this.buckets.get(key)
    if (!b || b.blockedUntil <= now) return { blocked: false, retryAfter: 0 }
    return { blocked: true, retryAfter: Math.max(1, Math.ceil((b.blockedUntil - now) / 1000)) }
  }

  reset(key: string) {
    this.buckets.delete(key)
  }
}

const authFailures = new RateLimiter(config.authRateLimitWindowMs, config.authRateLimitMax, config.authRateLimitBlockMs)
const apiRequests = new RateLimiter(config.apiRateLimitWindowMs, config.apiRateLimitMax, 0)

const rateLimited = (c: Context, retryAfter: number, scope: 'api' | 'auth') => {
  const seconds = Math.max(1, Math.ceil(retryAfter))
  c.header('retry-after', String(seconds))
  return c.json({ error: 'rate_limited', scope, retryAfter: seconds }, 429)
}

export const apiRateLimit: MiddlewareHandler = async (c, next) => {
  const r = apiRequests.take(clientIp(c))
  if (!r.allowed) return rateLimited(c, r.retryAfter, 'api')
  await next()
}

// ---- transport / proxy helpers -------------------------------------------------------------

const loopbackIp = (ip: string) =>
  ip === '::1' || ip === '::ffff:127.0.0.1' || ip.startsWith('127.')

/** Private / link-local address: a home or office LAN. */
const privateIp = (ip: string): boolean => {
  const v4 = ip.startsWith('::ffff:') ? ip.slice(7) : ip
  if (v4.startsWith('127.') || v4.startsWith('10.') || v4.startsWith('192.168.') || v4.startsWith('169.254.')) return true
  const m = /^172\.(\d{1,2})\./.exec(v4)
  if (m) { const n = Number(m[1]); if (n >= 16 && n <= 31) return true }
  const v6 = ip.toLowerCase()
  return v6 === '::1' || v6.startsWith('fc') || v6.startsWith('fd') || v6.startsWith('fe80:')
}

/** Peer address, or null for in-process requests (tests) where Bun cannot report it. */
const remoteAddress = (c: Context): string | null => {
  try { return getConnInfo(c).remote.address ?? null } catch { return null }
}

/**
 * Forwarded headers are only trustworthy when they come from the local tunnel/proxy. With
 * HOST=0.0.0.0 a LAN client could otherwise forge CF-Connecting-IP / X-Forwarded-Proto.
 * In-process requests (tests) have no peer address, so they keep the old behaviour.
 */
const trustedForwarded = (c: Context): boolean => {
  if (!config.trustProxy) return false
  const remote = remoteAddress(c)
  return remote === null || loopbackIp(remote)
}

/** Best-effort client IP. Forwarded headers are only honoured from the local proxy. */
export function clientIp(c: Context): string {
  const remote = remoteAddress(c)
  if (trustedForwarded(c)) {
    const cf = c.req.header('cf-connecting-ip')
    if (cf) return cf.split(',')[0].trim()
    const xff = c.req.header('x-forwarded-for')
    if (xff) return xff.split(',')[0].trim()
    const real = c.req.header('x-real-ip')
    if (real) return real.trim()
  }
  return remote ?? 'unknown'
}

/** True when the request reached the app over TLS (directly or through a trusted proxy). */
export function isSecureRequest(c: Context): boolean {
  if (new URL(c.req.url).protocol === 'https:') return true
  if (!trustedForwarded(c)) return false
  const proto = (c.req.header('x-forwarded-proto') ?? '').split(',')[0].trim().toLowerCase()
  if (proto === 'https') return true
  const visitor = c.req.header('cf-visitor')
  if (visitor) {
    try {
      if (JSON.parse(visitor)?.scheme === 'https') return true
    } catch { /* malformed header: ignore */ }
  }
  return false
}

/**
 * Local access: loopback or a private LAN address. Plain HTTP is accepted here (the token never
 * leaves the home network); requests from public addresses still get HTTPS enforcement.
 */
export function isLocalRequest(c: Context): boolean {
  const remote = remoteAddress(c)
  if (remote) return privateIp(remote)
  // No peer address (in-process tests): fall back to the request host.
  const host = new URL(c.req.url).hostname.toLowerCase()
  return host === 'localhost' || host.endsWith('.local') || host === '127.0.0.1' || host === '[::1]' || host === '::1'
}

/**
 * Refuse plaintext API traffic from public addresses and redirect page requests to HTTPS. A
 * redirect is deliberately not used for `/api/*`: a 307/308 would replay the Authorization header
 * over the wire.
 */
export const httpsGuard: MiddlewareHandler = async (c, next) => {
  if (!config.forceHttps || isSecureRequest(c) || isLocalRequest(c)) return next()
  if (c.req.path.startsWith('/api/')) {
    return c.json({ error: 'https_required', message: 'This API only accepts HTTPS from outside the local network.' }, 403)
  }
  const url = new URL(c.req.url)
  url.protocol = 'https:'
  if (config.trustProxy) {
    const forwardedHost = c.req.header('x-forwarded-host')?.split(',')[0].trim()
    if (forwardedHost) url.host = forwardedHost
  }
  return c.redirect(url.toString(), 308)
}

// ---- security headers ----------------------------------------------------------------------

const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  // The dashboard talks to Binance directly for prices / the asset list.
  "connect-src 'self' https://api.binance.com https://*.binance.com https://*.binance.vision http://localhost:* http://127.0.0.1:*",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "object-src 'none'",
].join('; ')

export const securityHeaders: MiddlewareHandler = async (c, next) => {
  await next()
  c.header('x-content-type-options', 'nosniff')
  c.header('x-frame-options', 'DENY')
  c.header('referrer-policy', 'no-referrer')
  c.header('permissions-policy', 'geolocation=(), microphone=(), camera=()')
  c.header('cross-origin-opener-policy', 'same-origin')
  c.header('content-security-policy', CSP)
  if (isSecureRequest(c)) c.header('strict-transport-security', 'max-age=31536000; includeSubDomains')
  if (c.req.path.startsWith('/api/')) c.header('cache-control', 'no-store')
}

// ---- access token + signed session cookie ---------------------------------------------------

const tokenOk = (given: unknown): boolean => {
  if (typeof given !== 'string') return false
  const a = Buffer.from(given)
  const b = Buffer.from(config.accessToken)
  return a.length === b.length && timingSafeEqual(a, b)
}

// Domain-separated HMAC key: sessions survive restarts, but a leaked cookie cannot be used as a token.
const sessionKey = createHmac('sha256', config.sessionSecret || config.accessToken).update('trading-bot/session/v1').digest()
const sign = (payload: string) => createHmac('sha256', sessionKey).update(payload).digest('base64url')

export type AuthKind = 'bearer' | 'session'
export type AuthResult = { ok: true; kind: AuthKind } | { ok: false; reason: 'missing' | 'invalid' | 'invalid_session' }
export type AppEnv = { Variables: { auth: AuthKind } }

export function issueSession(now = Date.now()): { value: string; expiresAt: number } {
  const expiresAt = now + config.sessionTtlMs
  const payload = String(expiresAt)
  return { value: `${payload}.${sign(payload)}`, expiresAt }
}

export function verifySession(value: string | undefined, now = Date.now()): boolean {
  if (!value) return false
  const i = value.lastIndexOf('.')
  if (i <= 0) return false
  const payload = value.slice(0, i)
  const given = Buffer.from(value.slice(i + 1))
  const expected = Buffer.from(sign(payload))
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return false
  const expiresAt = Number(payload)
  return Number.isFinite(expiresAt) && expiresAt > now
}

export function setSessionCookie(c: Context, value: string, expiresAt: number) {
  setCookie(c, SESSION_COOKIE, value, {
    path: '/',
    httpOnly: true,
    sameSite: 'Strict',
    secure: isSecureRequest(c),
    maxAge: Math.max(1, Math.floor((expiresAt - Date.now()) / 1000)),
  })
}

export function clearSessionCookie(c: Context) {
  deleteCookie(c, SESSION_COOKIE, { path: '/' })
}

/** Accept either a Bearer token (scripts / API clients) or the signed session cookie (dashboard). */
export function authenticate(c: Context): AuthResult {
  const cookie = getCookie(c, SESSION_COOKIE)
  if (cookie && verifySession(cookie)) return { ok: true, kind: 'session' }

  const header = c.req.header('authorization') ?? ''
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : (c.req.header('x-access-token') ?? '').trim()
  if (token) return tokenOk(token) ? { ok: true, kind: 'bearer' } : { ok: false, reason: 'invalid' }

  return cookie ? { ok: false, reason: 'invalid_session' } : { ok: false, reason: 'missing' }
}

/** Cookie-authenticated unsafe requests must come from the same origin (defence in depth on top of SameSite). */
function sameOrigin(c: Context): boolean {
  const origin = c.req.header('origin')
  if (!origin) return true
  const expected = new URL(c.req.url).origin
  if (origin === expected) return true
  if (trustedForwarded(c)) {
    const host = c.req.header('x-forwarded-host')?.split(',')[0].trim()
    const proto = (c.req.header('x-forwarded-proto') ?? '').split(',')[0].trim() || 'https'
    if (host && origin === `${proto}://${host}`) return true
  }
  return false
}

export const authMiddleware: MiddlewareHandler<AppEnv> = async (c, next) => {
  const ip = clientIp(c)
  const pre = authFailures.blocked(ip)
  if (pre.blocked) return rateLimited(c, pre.retryAfter, 'auth')

  const auth = authenticate(c)
  if (!auth.ok) {
    if (auth.reason === 'invalid') {
      const failure = authFailures.take(ip)
      if (!failure.allowed) return rateLimited(c, failure.retryAfter, 'auth')
    } else if (auth.reason === 'invalid_session') {
      clearSessionCookie(c) // stale / tampered cookie: drop it, but do not lock the user out
    }
    c.header('www-authenticate', 'Bearer realm="trading-bot"')
    return c.json({ error: 'unauthorized' }, 401)
  }

  authFailures.reset(ip)
  if (auth.kind === 'session' && !['GET', 'HEAD', 'OPTIONS'].includes(c.req.method) && !sameOrigin(c)) {
    return c.json({ error: 'cross_origin_request' }, 403)
  }
  c.set('auth', auth.kind)
  await next()
}

/** Exchange the access token for an HttpOnly session cookie. */
export function loginWithToken(c: Context, token: unknown) {
  const ip = clientIp(c)
  const pre = authFailures.blocked(ip)
  if (pre.blocked) return rateLimited(c, pre.retryAfter, 'auth')

  // A non-string token (number / null / object) is an invalid attempt, not a server error.
  if (typeof token !== 'string' || !token || !tokenOk(token)) {
    const failure = authFailures.take(ip)
    if (!failure.allowed) return rateLimited(c, failure.retryAfter, 'auth')
    c.header('www-authenticate', 'Bearer realm="trading-bot"')
    return c.json({ error: 'unauthorized' }, 401)
  }

  authFailures.reset(ip)
  const session = issueSession()
  setSessionCookie(c, session.value, session.expiresAt)
  return c.json({ ok: true, expiresAt: session.expiresAt, secure: isSecureRequest(c) })
}

export function logout(c: Context) {
  clearSessionCookie(c)
  return c.json({ ok: true })
}
