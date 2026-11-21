export { BAR_MS, WINDOW, barOpen, lastClosedBar, barIndex } from './time'

/** Required: the app refuses to boot without an explicit token (no weak fallback). */
const accessToken = process.env.ACCESS_TOKEN
if (!accessToken) throw new Error('ACCESS_TOKEN is not set. Copy .env.example to .env and set it.')

/**
 * MODE=live trades real funds on Binance spot. MODE=test is paper trading: real mainnet prices, simulated fills,
 * no API keys, and its own database under `data-test/` (seeded from the live database on first boot).
 */
export type Mode = 'live' | 'test'
const rawMode = (process.env.MODE ?? '').trim().toLowerCase()
if (rawMode !== 'live' && rawMode !== 'test') throw new Error(`MODE must be "live" or "test" (got "${process.env.MODE ?? ''}"). Set it in .env.`)
const mode: Mode = rawMode

const apiKey = process.env.BINANCE_API_KEY ?? ''
const apiSecret = process.env.BINANCE_API_SECRET ?? ''
// Tests (NODE_ENV=test), NO_EXCHANGE=1 and paper mode inject a simulated exchange, so they need no credentials.
const exchangeOptional = process.env.NODE_ENV === 'test' || process.env.NO_EXCHANGE === '1' || mode === 'test'
if (!exchangeOptional && (!apiKey || !apiSecret)) throw new Error(`BINANCE_API_KEY and BINANCE_API_SECRET are required (MODE=${mode}).`)

const strip = (u: string) => u.replace(/\/$/, '')
const num = (v: string | undefined, d: number) => (v !== undefined && v !== '' && Number.isFinite(Number(v)) ? Number(v) : d)
const flag = (v: string | undefined) => /^(1|true|yes|on)$/i.test((v ?? '').trim())
const binanceBase = strip(process.env.BINANCE_BASE_URL ?? 'https://api.binance.com')

// Cloudflare Tunnel. TUNNEL=true is the only setting needed: the app starts a temporary quick
// tunnel on boot (src/tunnel.ts) and sends its URL to Telegram. Unit tests never start it.
const tunnel = process.env.NODE_ENV !== 'test' && flag(process.env.TUNNEL)

// Paper mode always works on a copy under data-test/. `DB_PATH` is the live database (also the copy source);
// `TEST_DB_PATH` can override the paper file, and `:memory:` is kept for tests.
const memoryDb = process.env.DB_PATH === ':memory:'
const liveDbPath = process.env.DB_PATH && process.env.DB_PATH !== ':memory:' ? process.env.DB_PATH : 'data/trading.sqlite'
const dbPath = memoryDb ? ':memory:' : mode === 'test' ? (process.env.TEST_DB_PATH ?? 'data-test/trading.sqlite') : liveDbPath

const port = Number(process.env.PORT ?? 3000)
/** Bind address. Loopback by default; HOST=0.0.0.0 makes the dashboard reachable on the LAN. */
const host = process.env.HOST?.trim() || '127.0.0.1'
// HOST=0.0.0.0 is a bind address, not something a browser can open.
const browseHost = host === '0.0.0.0' || host === '::' || host === '[::]' ? 'localhost' : host
const baseUrl = (process.env.BASE_URL?.trim() || `http://${browseHost}:${port}`).replace(/\/$/, '')

export const config = {
  mode,
  port,
  host,
  /** Address to open in the browser (BASE_URL); defaults to http://<HOST>:<PORT>. */
  baseUrl,
  /** Paper mode never touches the live books: it works on its own copy under `data-test/`. */
  dbPath,
  /** The live database path, even in test mode (where `dbPath` points at the copy). */
  liveDbPath,
  /** Live database copied into the paper database on first boot (test mode only). */
  paperSource: process.env.TEST_DB_SOURCE ?? liveDbPath,
  accessToken,
  telegramToken: process.env.TELEGRAM_BOT_TOKEN ?? '',
  telegramChatId: process.env.TELEGRAM_CHAT_ID ?? '',
  apiKey: mode === 'test' ? '' : apiKey,
  apiSecret: mode === 'test' ? '' : apiSecret,
  /** Real execution/account endpoint (only used in live mode). */
  binanceBase,
  /** What the dashboard/status should show as the execution venue. */
  executionBase: mode === 'test' ? 'paper' : binanceBase,
  /** Public market data (candles, symbol list, paper prices). Always mainnet. */
  dataBase: strip(process.env.BINANCE_DATA_URL ?? 'https://api.binance.com'),
  /** Fake USDT credited to the paper account when it is first created. */
  paperStartUsdt: Math.max(0, num(process.env.PAPER_START_USDT, 10_000)),
  /** Delay after a 4h boundary before fetching, so Binance has closed the candle. */
  fetchDelayMs: Number(process.env.FETCH_DELAY_MS ?? 5000),
  /** How often resting stops are reconciled and the market-sell backstop is checked. */
  stopPollMs: Math.max(5, num(process.env.STOP_POLL_SECONDS, 15)) * 1000,
  /** A market BUY whose price is more than this % above the reference price is refused (spot fill check). */
  maxEntrySlipPct: Math.max(0.05, num(process.env.MAX_ENTRY_SLIPPAGE_PCT, 1)),
  /** Cache lifetime of the account balance snapshot used by the capital ledger. */
  balanceTtlMs: Math.max(0, num(process.env.BALANCE_TTL_SECONDS, 10)) * 1000,

  // ---- Cloudflare Tunnel (src/tunnel.ts) ----
  /** Start the tunnel on boot. The only tunnel setting that normally needs to be set. */
  tunnel,
  /** Quick tunnel (temporary https://<random>.trycloudflare.com) is the default; false = named tunnel. */
  tunnelQuick: process.env.TUNNEL_QUICK === undefined ? true : flag(process.env.TUNNEL_QUICK),
  /** Send the public URL to Telegram once the tunnel is up. */
  tunnelNotify: process.env.TUNNEL_NOTIFY === undefined ? true : flag(process.env.TUNNEL_NOTIFY),
  /** Named-tunnel ingress config (only used when TUNNEL_QUICK=false). */
  tunnelConfig: process.env.TUNNEL_CONFIG?.trim() || 'deploy/cloudflared.yml',
  cloudflaredBin: process.env.CLOUDFLARED_BIN?.trim() || 'cloudflared',

  // ---- HTTP hardening (src/security.ts) ----
  /** Honour X-Forwarded-* / CF-Connecting-IP. Defaults to on with the tunnel, off otherwise. */
  trustProxy: process.env.TRUST_PROXY !== undefined ? process.env.TRUST_PROXY === '1' : tunnel,
  /** Refuse plaintext API traffic. Default on; set FORCE_HTTPS=0 only on a trusted LAN. */
  forceHttps: process.env.FORCE_HTTPS !== '0',
  /** Optional separate key for signing session cookies (defaults to the access token). */
  sessionSecret: process.env.SESSION_SECRET ?? '',
  sessionTtlMs: Math.max(60, num(process.env.SESSION_TTL_SECONDS, 12 * 3600)) * 1000,
  authRateLimitWindowMs: Math.max(1, num(process.env.AUTH_RATE_LIMIT_WINDOW_SECONDS, 300)) * 1000,
  authRateLimitMax: Math.max(1, num(process.env.AUTH_RATE_LIMIT_MAX, 5)),
  authRateLimitBlockMs: Math.max(0, num(process.env.AUTH_RATE_LIMIT_BLOCK_SECONDS, 900)) * 1000,
  apiRateLimitWindowMs: Math.max(1, num(process.env.API_RATE_LIMIT_WINDOW_SECONDS, 60)) * 1000,
  apiRateLimitMax: Math.max(1, num(process.env.API_RATE_LIMIT_MAX, 240)),
}
