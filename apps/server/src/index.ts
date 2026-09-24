// Producer Studio server entry: API (Hono) and/or job worker, per ROLE=all|api|worker.
import { serve } from '@hono/node-server'
import { createApp } from './app'
import { loadConfig } from './config'
import { initCtx } from './context'
import { registerHandlers } from './jobs/handlers'
import { startWorker, stopWorker } from './jobs/worker'
import { log } from './log'
import { tts } from './ai/tts'

const config = loadConfig()
const c = await initCtx(config)
registerHandlers()
const desktop = config.mode === 'desktop' ? await import('./desktop') : undefined
if (desktop) await desktop.initDesktop()

let server: ReturnType<typeof serve> | undefined
if (config.role === 'all' || config.role === 'api') {
  const app = createApp()
  // desktop: loopback only, never the LAN
  const hostname = config.mode === 'desktop' ? '127.0.0.1' : (process.env.HOST ?? '0.0.0.0')
  server = serve({ fetch: app.fetch, port: config.port, hostname }, (info) => {
    log.info('listening', { port: info.port, host: hostname, mode: config.mode, role: config.role, db: c.database.driver, storage: c.storage.kind, production: config.production })
  })
  // uploads and renders can be long-lived; don't let Node cut them off
  const s = server as unknown as { requestTimeout?: number; headersTimeout?: number }
  s.requestTimeout = 0
  s.headersTimeout = 120_000
} else {
  // worker-only services still expose health for the platform's checks
  const { Hono } = await import('hono')
  const h = new Hono()
  h.get('/api/health', (x) => x.json({ ok: true, role: 'worker' }))
  server = serve({ fetch: h.fetch, port: config.port })
}
if (config.role === 'all' || config.role === 'worker') startWorker({ concurrency: config.workerConcurrency })
if (desktop) await desktop.startDesktopServices()

let closing = false
async function shutdown(sig: string) {
  if (closing) return
  closing = true
  log.info('shutting down', { sig })
  stopWorker()
  desktop?.stopDesktopServices()
  tts.stop()
  server?.close()
  setTimeout(() => process.exit(0), 3000).unref()
  await c.database.close().catch(() => undefined)
  process.exit(0)
}
process.on('SIGINT', () => void shutdown('SIGINT'))
// desktop: the Electron main process holds our stdin; when it goes away (crash, kill), shut down too
if (process.env.DESKTOP_PARENT_STDIN === '1') {
  process.stdin.on('end', () => void shutdown('parent-exit'))
  process.stdin.on('close', () => void shutdown('parent-exit'))
  process.stdin.resume()
}
process.on('SIGTERM', () => void shutdown('SIGTERM'))
process.on('unhandledRejection', (err) => log.error('unhandled rejection', { err }))
