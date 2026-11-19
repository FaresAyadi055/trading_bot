export { BAR_MS, WINDOW, barOpen, lastClosedBar, barIndex } from './time'

/** Required: the app refuses to boot without an explicit token (no weak fallback). */
const accessToken = process.env.ACCESS_TOKEN
if (!accessToken) throw new Error('ACCESS_TOKEN is not set. Copy .env.example to .env and set it.')

export const config = {
  port: Number(process.env.PORT ?? 3000),
  dbPath: process.env.DB_PATH ?? 'data/trading.sqlite',
  accessToken,
  telegramToken: process.env.TELEGRAM_BOT_TOKEN ?? '',
  telegramChatId: process.env.TELEGRAM_CHAT_ID ?? '',
  binanceBase: (process.env.BINANCE_BASE_URL ?? 'https://api.binance.com').replace(/\/$/, ''),
  /** Delay after a 4h boundary before fetching, so Binance has closed the candle. */
  fetchDelayMs: Number(process.env.FETCH_DELAY_MS ?? 5000),
  /** Upper bound of assets one bot may listen to (CPU / REST budget guard). */
  maxAssetsPerBot: Number(process.env.MAX_ASSETS_PER_BOT ?? 50),
}
