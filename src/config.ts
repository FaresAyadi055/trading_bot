export { BAR_MS, WINDOW, barOpen, lastClosedBar, barIndex } from './time'

/** Required: the app refuses to boot without an explicit token (no weak fallback). */
const accessToken = process.env.ACCESS_TOKEN
if (!accessToken) throw new Error('ACCESS_TOKEN is not set. Copy .env.example to .env and set it.')

/** MODE=live trades with real funds (Binance Convert). MODE=test trades on the Binance spot testnet. */
export type Mode = 'live' | 'test'
const rawMode = (process.env.MODE ?? '').trim().toLowerCase()
if (rawMode !== 'live' && rawMode !== 'test') throw new Error(`MODE must be "live" or "test" (got "${process.env.MODE ?? ''}"). Set it in .env.`)
const mode: Mode = rawMode

const apiKey = process.env.BINANCE_API_KEY ?? ''
const apiSecret = process.env.BINANCE_API_SECRET ?? ''
// Tests (NODE_ENV=test) and NO_EXCHANGE=1 inject a mock exchange, so they need no credentials.
const exchangeOptional = process.env.NODE_ENV === 'test' || process.env.NO_EXCHANGE === '1'
if (!exchangeOptional && (!apiKey || !apiSecret)) throw new Error(`BINANCE_API_KEY and BINANCE_API_SECRET are required (MODE=${mode}).`)

const strip = (u: string) => u.replace(/\/$/, '')
const num = (v: string | undefined, d: number) => (v !== undefined && v !== '' && Number.isFinite(Number(v)) ? Number(v) : d)

export const config = {
  mode,
  port: Number(process.env.PORT ?? 3000),
  dbPath: process.env.DB_PATH ?? 'data/trading.sqlite',
  accessToken,
  telegramToken: process.env.TELEGRAM_BOT_TOKEN ?? '',
  telegramChatId: process.env.TELEGRAM_CHAT_ID ?? '',
  apiKey,
  apiSecret,
  /** Execution + account endpoint: mainnet (Convert) in live mode, spot testnet in test mode. */
  binanceBase: strip(process.env.BINANCE_BASE_URL ?? (mode === 'live' ? 'https://api.binance.com' : 'https://testnet.binance.vision')),
  /** Public market data (candles, symbol list). Always mainnet by default: testnet candles are sparse and unrepresentative. */
  dataBase: strip(process.env.BINANCE_DATA_URL ?? 'https://api.binance.com'),
  /** Delay after a 4h boundary before fetching, so Binance has closed the candle. */
  fetchDelayMs: Number(process.env.FETCH_DELAY_MS ?? 5000),
  /** Upper bound of assets one bot may listen to (CPU / REST budget guard). */
  maxAssetsPerBot: Number(process.env.MAX_ASSETS_PER_BOT ?? 50),
  /** How often open positions are checked against their stop levels (Convert has no resting stop orders). */
  stopPollMs: Math.max(5, num(process.env.STOP_POLL_SECONDS, 15)) * 1000,
  /** Heartbeat / connectivity probe period. */
  heartbeatMs: Math.max(5, num(process.env.HEARTBEAT_SECONDS, 15)) * 1000,
  /** A gap in the heartbeat longer than this counts as an interruption (alert after reconnect). */
  interruptMinMs: Math.max(30, num(process.env.INTERRUPT_MIN_SECONDS, 120)) * 1000,
  /** A market BUY whose price is more than this % above the reference price is refused (Convert: checked on the quote, before accepting). */
  maxEntrySlipPct: Math.max(0.05, num(process.env.MAX_ENTRY_SLIPPAGE_PCT, 1)),
  /** Cache lifetime of the account balance snapshot used by the capital ledger. */
  balanceTtlMs: Math.max(0, num(process.env.BALANCE_TTL_SECONDS, 10)) * 1000,
}
