// Producer Studio server entry: API (Hono) and/or job worker, per ROLE=all|api|worker.
import { serve } from '@hono/node-server'
import { createApp } from './app'
import { takeDesktopSecrets } from './child-env'
import { loadConfig } from './config'
import { initCtx } from './context'
import { registerHandlers } from './jobs/handlers'
import { startWorker, stopWorker } from './jobs/worker'
import { log } from './log'
import { tts } from './ai/tts'
import { startStorageMonitor, stopStorageMonitor } from './services/storage-health'

// first, before anything can spawn a child: the desktop secrets live in memory only, never in our environment
takeDesktopSecrets()
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
  // desktop: live dictation WebSocket → VoiceStudio
  if (desktop) desktop.attachUpgrades(server as unknown as import('node:http').Server, config.port)
  // A request must arrive in full within this time (slow-body clients can't hold connections open forever). With
  // S3, uploads go straight to the bucket and the largest body here is a project save; with local storage the
  // upload itself comes through this server, so there's no cap. Responses (SSE, media) aren't affected.
  const s = server as unknown as { requestTimeout?: number; headersTimeout?: number }
  s.requestTimeout = config.s3 ? 10 * 60_000 : 0
  s.headersTimeout = 120_000
} else {
  // worker-only services still expose health for the platform's checks
  const { Hono } = await import('hono')
  const h = new Hono()
  h.get('/api/health', (x) => x.json({ ok: true, role: 'worker' }))
  server = serve({ fetch: h.fetch, port: config.port })
}
if (config.role === 'all' || config.role === 'worker') startWorker({ concurrency: config.workerConcurrency })
// cloud only: a desktop's local disk needs no watching, and its cloud media has its own error paths
if (config.mode === 'cloud') startStorageMonitor()
if (desktop) await desktop.startDesktopServices()

let closing = false
async function shutdown(sig: string) {
  if (closing) return
  closing = true
  log.info('shutting down', { sig })
  setTimeout(() => process.exit(0), 6000).unref()
  stopStorageMonitor()
  desktop?.stopDesktopServices()
  server?.close()
  // running jobs go back in the queue (not a failed attempt), then their processes are stopped
  await stopWorker().catch((err) => log.warn('stopping the worker failed', { err }))
  tts.stop()
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
