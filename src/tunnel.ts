// Cloudflare Tunnel supervisor.
//
// TUNNEL=true is the only setting needed: the app starts a temporary quick tunnel on boot and
// sends its public URL to Telegram once it is up. `bun run tunnel` runs the same thing standalone.
//
// Advanced: TUNNEL_QUICK=false uses TUNNEL_CONFIG (a named tunnel with a stable hostname).
import { existsSync, readFileSync } from 'node:fs'
import { config } from './config'

export interface Tunnel {
  readonly child: ReturnType<typeof Bun.spawn>
  /** Resolves with cloudflared's exit code after the URL message has been attempted. */
  readonly done: Promise<number>
  stop(): void
}

declare global { var __tbTunnel: Tunnel | undefined }

async function sendUrl(url: string) {
  if (!config.tunnelNotify) {
    console.log('[tunnel] TUNNEL_NOTIFY=false: URL message not sent')
    return
  }
  if (!config.telegramToken || !config.telegramChatId) {
    console.log('[tunnel] Telegram not configured (TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID): URL message not sent')
    return
  }
  try {
    const r = await fetch(`https://api.telegram.org/bot${config.telegramToken}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chat_id: config.telegramChatId,
        text: `🛰️ Tunnel active\n${url}\nlocal: ${config.baseUrl}`,
        disable_web_page_preview: true,
      }),
      signal: AbortSignal.timeout(10_000),
    })
    if (r.ok) console.log('[tunnel] Telegram message sent')
    else console.warn(`[tunnel] Telegram rejected the message (HTTP ${r.status})`)
  } catch (e) {
    console.warn(`[tunnel] Telegram send failed: ${e instanceof Error ? e.message : e}`)
  }
}

/**
 * Start cloudflared. Returns null when the tunnel is disabled or cloudflared cannot be started;
 * a tunnel problem must never take the trading app down. `echo` forwards cloudflared's full log
 * (used by the standalone runner; the app only logs errors).
 */
export function startTunnel(opts: { echo?: boolean } = {}): Tunnel | null {
  if (!config.tunnel) return null
  if (globalThis.__tbTunnel) return globalThis.__tbTunnel // survives `bun --hot` reloads

  const localUrl = `http://${config.host === '0.0.0.0' || config.host === '::' || config.host === '[::]' ? '127.0.0.1' : config.host}:${config.port}`
  let args: string[]
  let namedUrl: string | null = null
  if (config.tunnelQuick) {
    args = ['tunnel', '--no-autoupdate', '--url', localUrl]
  } else {
    if (!existsSync(config.tunnelConfig)) {
      console.error(`[tunnel] ${config.tunnelConfig} not found; remove TUNNEL_QUICK=false to use the temporary URL.`)
      return null
    }
    // The first ingress hostname is the public dashboard URL (the last rule is the 404 catch-all).
    const hostname = /^\s*-\s*hostname:\s*(\S+)/m.exec(readFileSync(config.tunnelConfig, 'utf8'))?.[1]
    namedUrl = hostname ? `https://${hostname}` : null
    args = ['tunnel', '--no-autoupdate', '--config', config.tunnelConfig, 'run']
  }

  let child: ReturnType<typeof Bun.spawn>
  try {
    child = Bun.spawn([config.cloudflaredBin, ...args], { stdin: 'inherit', stdout: 'pipe', stderr: 'pipe' })
  } catch (e) {
    console.error(`[tunnel] could not start ${config.cloudflaredBin}: ${e instanceof Error ? e.message : e}`)
    console.error('[tunnel] install cloudflared: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/')
    return null
  }

  console.log(`[tunnel] starting ${config.tunnelQuick ? 'quick tunnel' : 'named tunnel'} → ${localUrl}`)

  let scan = ''
  let announced = false
  let pending: Promise<void> | null = null
  const announce = (url: string) => {
    if (announced) return
    announced = true
    console.log(`[tunnel] public URL: ${url}`)
    pending = sendUrl(url)
  }

  // Quick tunnels print the URL; named tunnels print "Registered tunnel connection" once the edge
  // is actually serving the hostname.
  const onOutput = (text: string) => {
    scan = (scan + text).slice(-4000)
    if (config.tunnelQuick) {
      const m = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i.exec(scan)
      if (m) announce(m[0])
    } else if (namedUrl && /Registered tunnel connection/i.test(scan)) {
      announce(namedUrl)
    }
  }

  const pump = async (stream: ReadableStream<Uint8Array> | undefined, out: { write(s: string): unknown }) => {
    if (!stream) return
    const dec = new TextDecoder()
    const reader = stream.getReader()
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        const text = dec.decode(value, { stream: true })
        if (opts.echo) out.write(text)
        else if (/\b(ERR|FTL)\b/.test(text)) process.stderr.write(text)
        onOutput(text)
      }
    } catch { /* stream closed */ }
  }

  const pumps = [
    pump(child.stdout as ReadableStream<Uint8Array>, process.stdout),
    pump(child.stderr as ReadableStream<Uint8Array>, process.stderr),
  ]

  const done = (async () => {
    const code = await child.exited
    await Promise.allSettled(pumps)
    if (pending) await pending
    if (!announced) {
      console.warn(config.tunnelQuick
        ? '[tunnel] cloudflared never printed a trycloudflare.com URL'
        : '[tunnel] the tunnel never reported a connection')
    }
    if (globalThis.__tbTunnel?.child === child) globalThis.__tbTunnel = undefined
    return code ?? 0
  })()

  const handle: Tunnel = {
    child,
    done,
    stop: () => { try { child.kill('SIGTERM') } catch { /* already exited */ } },
  }
  globalThis.__tbTunnel = handle
  return handle
}

/** Stop the running tunnel (used on shutdown). Safe to call when none is running. */
export function stopTunnel() {
  globalThis.__tbTunnel?.stop()
  globalThis.__tbTunnel = undefined
}
