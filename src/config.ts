import { randomBytes } from 'node:crypto'

export const SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'SOLUSDT'] as const
export type Symbol = (typeof SYMBOLS)[number]
export const BAR_MS = 4 * 3600_000
/** Rolling candle window kept per symbol (constant storage). */
export const WINDOW = 1000

const generated = !process.env.ACCESS_TOKEN
export const config = {
  port: Number(process.env.PORT ?? 3000),
  dbPath: process.env.DB_PATH ?? 'data/trading.sqlite',
  accessToken: process.env.ACCESS_TOKEN || randomBytes(18).toString('hex'),
  tokenGenerated: generated,
  telegramToken: process.env.TELEGRAM_BOT_TOKEN ?? '',
  telegramChatId: process.env.TELEGRAM_CHAT_ID ?? '',
  binanceBase: (process.env.BINANCE_BASE_URL ?? 'https://api.binance.com').replace(/\/$/, ''),
  /** Delay after a 4h boundary before fetching, so Binance has closed the candle. */
  fetchDelayMs: Number(process.env.FETCH_DELAY_MS ?? 5000),
}

export const barOpen = (ms: number) => Math.floor(ms / BAR_MS) * BAR_MS
/** Open time of the most recent fully closed candle at `now`. */
export const lastClosedBar = (now = Date.now()) => barOpen(now) - BAR_MS
