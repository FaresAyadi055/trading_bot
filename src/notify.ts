import { config } from './config'
import { db } from './db'

const fmt = (n: number, d = 2) => n.toLocaleString('en-US', { maximumFractionDigits: d })
let flushing = false

/** Send unsent BUY/SELL notifications; failures stay queued (outbox pattern survives crashes). */
export async function flushNotifications() {
  if (flushing) return
  flushing = true
  try {
    const rows = db.query(`SELECT t.*, b.name FROM transactions t JOIN bots b ON b.id=t.bot_id WHERE t.notified=0 ORDER BY t.id LIMIT 50`).all() as any[]
    const mark = db.query('UPDATE transactions SET notified=1 WHERE id=?')
    for (const r of rows) {
      if (r.action === 'CAPITAL' || !config.telegramToken || !config.telegramChatId || Date.now() - r.ts > 24 * 3600_000) { mark.run(r.id); continue }
      const head = `${r.action === 'BUY' ? '🟢 BUY' : '🔴 SELL'} | bot ${r.bot_id} (${r.name})`
      const body = `${r.symbol} @ ${fmt(r.price, 4)} | qty ${fmt(r.qty, 6)} | strat ${r.strategy}`
      const pl = r.action === 'SELL' ? `\nP/L: ${r.pnl >= 0 ? '+' : ''}${fmt(r.pnl)} USDT (${r.pnl_pct >= 0 ? '+' : ''}${fmt(r.pnl_pct)}%) | ${r.exit_reason}` : ''
      try {
        const res = await fetch(`https://api.telegram.org/bot${config.telegramToken}/sendMessage`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ chat_id: config.telegramChatId, text: `${head}\n${body}${pl}` }),
          signal: AbortSignal.timeout(10_000),
        })
        if (!res.ok) break // keep queued, retry on the next flush
        mark.run(r.id)
      } catch { break }
    }
  } finally { flushing = false }
}
