import { config } from './config'
import { db } from './db'

let flushing = false
const MAX_AGE_MS = 24 * 3600_000

/**
 * Deliver the Telegram outbox. Messages were composed (and committed) when the event happened, so a crash or an
 * outage only delays them: failures stay queued and are retried on the next flush. Delivered rows are deleted.
 */
export async function flushNotifications() {
  if (flushing) return
  flushing = true
  try {
    if (!config.telegramToken || !config.telegramChatId) { db.query('DELETE FROM notifications').run(); return }
    db.query('DELETE FROM notifications WHERE ts < ?').run(Date.now() - MAX_AGE_MS)
    const rows = db.query('SELECT id, text FROM notifications ORDER BY id LIMIT 50').all() as { id: number; text: string }[]
    const del = db.query('DELETE FROM notifications WHERE id=?')
    for (const r of rows) {
      try {
        const res = await fetch(`https://api.telegram.org/bot${config.telegramToken}/sendMessage`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ chat_id: config.telegramChatId, text: r.text.slice(0, 4000), disable_web_page_preview: true }),
          signal: AbortSignal.timeout(10_000),
        })
        if (res.ok || (res.status >= 400 && res.status < 500 && res.status !== 429)) { del.run(r.id); continue } // 4xx = poison message, drop it
        break // 429 / 5xx: keep queued, retry on the next flush
      } catch { break }
    }
  } finally { flushing = false }
}
