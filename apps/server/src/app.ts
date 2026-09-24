// Hono application: middleware, routes, JSON errors, SPA static serving.
import fs from 'node:fs'
import path from 'node:path'
import { Readable } from 'node:stream'
import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { eq } from 'drizzle-orm'
import { type AppEnv, sessionMiddleware } from './auth'
import { ctx } from './context'
import { assets, jobs, projects } from './db/schema'
import { assetRecord, jobDto } from './dto'
import { HttpError } from './http'
import { log } from './log'
import { aiConfigured } from './ai/claude'
import { aiRoutes } from './routes/ai'
import { aiSettingsRoutes } from './routes/ai-settings'
import { assetRoutes, mediaRoutes, uploadRoutes } from './routes/assets'
import { authRoutes } from './routes/auth'
import { eventRoutes, jobRoutes } from './routes/jobs'
import { preferenceRoutes } from './routes/preferences'
import { projectRoutes } from './routes/projects'
import { exportRoutes, projectExportRoutes, shareRoutes } from './routes/share'
import { deviceRoutes, syncRoutes, systemRoutes } from './routes/sync'
import { templateRoutes } from './routes/templates'
import { inviteRoutes, workspaceRoutes } from './routes/workspaces'
import { desktopGuard, desktopRoutes } from './desktop'

const started = Date.now()

const STATIC_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.webp': 'image/webp',
  '.map': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm',
}

export function createApp() {
  const app = new Hono<AppEnv>()

  // request log
  app.use('*', async (c, next) => {
    const t0 = performance.now()
    await next()
    const p = c.req.path
    if (p.startsWith('/api/') && p !== '/api/health' && !p.startsWith('/api/events')) {
      log.info('http', { method: c.req.method, path: p, status: c.res.status, ms: Math.round(performance.now() - t0) })
    }
  })

  // desktop: Host allow-list, loopback peers, CSP — before any route (health and the SPA included)
  if (ctx().config.mode === 'desktop') app.use('*', desktopGuard)

  app.onError((err, c) => {
    if (err instanceof HttpError) return c.json({ error: err.message, code: err.code, ...(err.details !== undefined ? { details: err.details } : {}) }, err.status as 400)
    const status = (err as { status?: number }).status
    if (status === 413) return c.json({ error: 'Request body too large', code: 'quota' }, 413)
    log.error('unhandled error', { path: c.req.path, err })
    return c.json({ error: 'Internal server error', code: 'server' }, 500)
  })

  app.get('/api/health', async (c) => {
    let db = 'ok'
    try {
      await ctx().db.select({ id: jobs.id }).from(jobs).limit(1)
    } catch {
      db = 'error'
    }
    const cfg = ctx().config
    return c.json(
      {
        ok: db === 'ok',
        role: cfg.role,
        db: ctx().database.driver,
        dbStatus: db,
        storage: ctx().storage.kind,
        uptimeSec: Math.round((Date.now() - started) / 1000),
        features: {
          whisper: Boolean(cfg.whisperCli && cfg.whisperModel && fs.existsSync(cfg.whisperCli) && fs.existsSync(cfg.whisperModel)),
          ai: aiConfigured(),
        },
      },
      db === 'ok' ? 200 : 503,
    )
  })

  app.use('/api/*', sessionMiddleware)
  app.use('/api/projects/:id', bodyLimit({ maxSize: 64 * 1024 * 1024 }))
  app.use('/api/ai/assistant', bodyLimit({ maxSize: 64 * 1024 * 1024 }))

  // desktop-only routes first: they shadow signup and (while linked) workspace creation
  if (ctx().config.mode === 'desktop') app.route('/api', desktopRoutes)
  app.route('/api/auth', authRoutes)
  app.route('/api/me', preferenceRoutes)
  app.route('/api/workspaces', workspaceRoutes)
  app.route('/api/invites', inviteRoutes)
  app.route('/api/projects', projectExportRoutes)
  app.route('/api/projects', projectRoutes)
  app.route('/api/uploads', uploadRoutes)
  app.route('/api/assets', assetRoutes)
  app.route('/api/media', mediaRoutes)
  app.route('/api/jobs', jobRoutes)
  app.route('/api/events', eventRoutes)
  app.route('/api/ai', aiSettingsRoutes)
  app.route('/api/ai', aiRoutes)
  app.route('/api/exports', exportRoutes)
  app.route('/api/share', shareRoutes)
  app.route('/api/templates', templateRoutes)
  app.route('/api/system', systemRoutes)
  app.route('/api/devices', deviceRoutes)
  app.route('/api/sync', syncRoutes)

  app.all('/api/*', (c) => c.json({ error: `No route for ${c.req.method} ${c.req.path}`, code: 'not_found' }, 404))

  // SPA (production build) with index.html fallback for client routes (/edit/:id, /r/:token, ...)
  app.get('*', async (c) => {
    const dist = ctx().config.webDist
    const index = path.join(dist, 'index.html')
    if (!fs.existsSync(index)) return c.text('Producer Studio API is running. Build the web app (npm run build -w @producer/web) to serve the UI here.', 200)
    const rel = decodeURIComponent(c.req.path).replace(/^\/+/, '')
    let file = path.resolve(dist, rel)
    if (!file.startsWith(path.resolve(dist)) || !rel || !fs.existsSync(file) || !fs.statSync(file).isFile()) file = index
    const ext = path.extname(file)
    const immutable = file !== index && /[\\/]assets[\\/]/.test(file)
    return new Response(Readable.toWeb(fs.createReadStream(file)) as unknown as ReadableStream, {
      headers: {
        'Content-Type': STATIC_TYPES[ext] ?? 'application/octet-stream',
        'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
      },
    })
  })

  // Cross-process event rehydration (NOTIFY carries references only).
  ctx().bus.setLoader(async (event, id) => {
    const db = ctx().db
    if (event === 'job') {
      const j = (await db.select().from(jobs).where(eq(jobs.id, id)).limit(1))[0]
      return j ? { workspaceId: j.workspaceId, data: jobDto(j) } : null
    }
    if (event === 'asset') {
      const a = (await db.select().from(assets).where(eq(assets.id, id)).limit(1))[0]
      return a ? { workspaceId: a.workspaceId, data: assetRecord(a) } : null
    }
    const p = (await db.select({ id: projects.id, ws: projects.workspaceId, version: projects.version }).from(projects).where(eq(projects.id, id)).limit(1))[0]
    return p ? { workspaceId: p.ws, data: { id: p.id, version: p.version } } : null
  })

  return app
}
