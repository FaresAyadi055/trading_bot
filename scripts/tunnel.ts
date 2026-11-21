// Standalone tunnel runner. The app already starts the tunnel on boot when TUNNEL=true, so use
// this only to run cloudflared without the app (do not run both at once).
import { config } from '../src/config'
import { startTunnel } from '../src/tunnel'

if (!config.tunnel) {
  console.log('[tunnel] disabled (set TUNNEL=true in .env)')
  process.exit(0)
}

const t = startTunnel({ echo: true })
if (!t) process.exit(1)

const forward = (signal: NodeJS.Signals) => { try { t.child.kill(signal) } catch { /* already exited */ } }
process.on('SIGINT', () => forward('SIGINT'))
process.on('SIGTERM', () => forward('SIGTERM'))

const code = await t.done
process.exit(code)
