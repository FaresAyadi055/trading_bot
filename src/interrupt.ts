// Interrupt handling. There is NO catch-up replay any more: bars that closed while the bot was blind are skipped
// (runner.skipStaleBars), and the operator is told about it with ONE Telegram alert once the connection is back.
//
// Detection: a heartbeat probes Binance every 60s and persists `heartbeat_at` ONLY when the probe succeeds.
// The gap between that timestamp and the first successful probe afterwards is the interruption. The same code covers a
// process that was down (the timestamp survives in SQLite) and a network / Binance outage while the process kept running.
import { config } from './config'
import { db, getMeta, setMeta } from './db'
import { fetchBalances, snapshot } from './capital'
import { getExchange } from './exchange'
import { listBots, loadState, telegramOn } from './bots'
import { skipStaleBars } from './runner'
import * as M from './messages'

let lastOk: number | null = null
let ticking = false
let timer: ReturnType<typeof setInterval> | null = null
export interface InterruptHooks { onReconnect?: () => void | Promise<void>; afterAlert?: () => void | Promise<void> }

const dur = (ms: number) => {
  const s = Math.round(ms / 1000)
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60), r = s % 60
  return [d && `${d}d`, h && `${h}h`, m && `${m}m`, (r || !s) && !d && !h && `${r}s`].filter(Boolean).join(' ')
}
const utc = (t: number) => new Date(t).toISOString().slice(0, 19).replace('T', ' ') + ' UTC'

/** `data: false` skips the separate market-data host probe (tests). */
export const probeOpts = { data: true }
async function probe() {
  await getExchange().ping()
  if (probeOpts.data && config.dataBase !== config.binanceBase) { // market data may live on another host (testnet execution + mainnet candles)
    const r = await fetch(`${config.dataBase}/api/v3/ping`, { signal: AbortSignal.timeout(8_000) })
    if (!r.ok) throw new Error(`data ping HTTP ${r.status}`)
  }
}

/** Build and queue the alert, advance every active bot past the skipped bars. Returns the message text. */
export async function handleReconnect(from: number, to: number): Promise<string> {
  const bots = listBots().filter((b) => b.status === 'active')
  const lines: string[] = []
  let skippedTotal = 0
  for (const b of bots) {
    const n = skipStaleBars(b.id, to)
    skippedTotal += n
    const { st } = loadState(b.id)
    const pos = st.position
    lines.push(`• ${b.name} (${b.id}): ${n} bar(s) skipped · ${pos ? `HOLDING ${pos.symbol} ${M.strat(pos.strategy)} · stop ${M.px(pos.stop)} · hard stop ${M.px(pos.hardStop)}` : st.pending ? `pending ${st.pending.kind} order` : 'flat'}`)
  }
  let capital = 'Capital check: unavailable (balances could not be read)'
  try {
    const s = await snapshot(true)
    capital = `Capital: ${M.fmt(s.usdt.free)} USDT free · allocated ${M.fmt(s.allocated)} · unallocated ${M.fmt(s.unallocated)}${s.ok ? ' · reconciled ✔' : `\n⚠️ MISMATCH: ${s.drift.join('; ')}`}`
  } catch { /* keep the default text */ }
  const text = [
    `⚠️ CONNECTION INTERRUPTED (${config.mode.toUpperCase()})`,
    `Offline: ${utc(from)} → ${utc(to)} (${dur(to - from)})`,
    `Reconnected. ${skippedTotal} closed 4h bar(s) were NOT evaluated and will NOT be replayed — trading resumes with the next live bar.`,
    bots.length ? lines.join('\n') : 'No active bots.',
    'Open positions are re-checked against their stops now.',
    capital,
  ].join('\n')
  if (telegramOn()) db.query('INSERT INTO notifications(ts,bot_id,kind,strategy,text) VALUES(?,?,?,?,?)').run(Date.now(), null, 'interrupt', null, text)
  return text
}

async function tick(h: InterruptHooks) {
  if (ticking) return
  ticking = true
  try {
    try { await probe() } catch { return } // still offline: lastOk keeps its old value, the gap keeps growing
    const now = Date.now()
    if (lastOk === null) lastOk = now // very first start: nothing to report
    if (now - lastOk > config.interruptMinMs) {
      const from = lastOk
      lastOk = now; setMeta('heartbeat_at', String(now)) // advance first so a failing alert cannot re-fire
      console.warn(`[interrupt] reconnected after ${dur(now - from)}`)
      await handleReconnect(from, now).catch((e) => console.error('[interrupt] alert failed', e))
      await h.onReconnect?.()
      await h.afterAlert?.()
      return
    }
    lastOk = now; setMeta('heartbeat_at', String(now))
    if (listBots().length) await fetchBalances().catch(() => {}) // keeps the ledger's balance snapshot fresh for apply-time checks
  } finally { ticking = false }
}

export function startHeartbeat(h: InterruptHooks = {}) {
  const saved = Number(getMeta('heartbeat_at') ?? 0)
  lastOk = saved > 0 ? saved : null
  if (timer) clearInterval(timer)
  timer = setInterval(() => void tick(h), config.heartbeatMs)
  void tick(h)
}
export const stopHeartbeat = () => { if (timer) clearInterval(timer); timer = null }
/** Test hook: run one probe cycle. */
export const _tick = (h: InterruptHooks = {}) => tick(h)
export const _setLastOk = (t: number | null) => { lastOk = t }
