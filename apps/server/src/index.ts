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

let server: ReturnType<typeof serve> | undefined
if (config.role === 'all' || config.role === 'api') {
  const app = createApp()
  server = serve({ fetch: app.fetch, port: config.port, hostname: process.env.HOST ?? '0.0.0.0' }, (info) => {
    log.info('listening', { port: info.port, role: config.role, db: c.database.driver, storage: c.storage.kind, production: config.production })
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

let closing = false
async function shutdown(sig: string) {
  if (closing) return
  closing = true
  log.info('shutting down', { sig })
  stopWorker()
  tts.stop()
  server?.close()
  setTimeout(() => process.exit(0), 3000).unref()
  await c.database.close().catch(() => undefined)
  process.exit(0)
}
process.on('SIGINT', () => void shutdown('SIGINT'))
process.on('SIGTERM', () => void shutdown('SIGTERM'))
process.on('unhandledRejection', (err) => log.error('unhandled rejection', { err }))
