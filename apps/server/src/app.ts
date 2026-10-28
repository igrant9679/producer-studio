// Hono application: middleware, routes, JSON errors, SPA static serving.
import fs from 'node:fs'
import path from 'node:path'
import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { eq } from 'drizzle-orm'
import { type AppEnv, sessionMiddleware } from './auth'
import { ctx } from './context'
import { assets, jobs, projects } from './db/schema'
import { assetRecord, jobDto } from './dto'
import { HttpError } from './http'
import { idempotency } from './idempotency'
import { log } from './log'
import { aiConfigured } from './ai/claude'
import { aiRoutes } from './routes/ai'
import { voiceRoutes } from './routes/voice'
import { aiSettingsRoutes } from './routes/ai-settings'
import { assetRoutes, mediaRoutes, uploadRoutes } from './routes/assets'
import { sceneRoutes } from './routes/scenes'
import { smartRoutes, smartToolsRoutes } from './routes/smart'
import { smoothRoutes } from './routes/smooth'
import { authRoutes } from './routes/auth'
import { accountRoutes } from './routes/account'
import { eventRoutes, jobRoutes } from './routes/jobs'
import { preferenceRoutes } from './routes/preferences'
import { projectRoutes } from './routes/projects'
import { versionRoutes } from './routes/versions'
import { exportRoutes, projectExportRoutes, shareRoutes, workspaceShareRoutes } from './routes/share'
import { activityRoutes, commentRoutes, projectCollabRoutes } from './routes/collab'
import { deviceRoutes, syncRoutes, systemRoutes } from './routes/sync'
import { templateRoutes } from './routes/templates'
import { inviteRoutes, workspaceRoutes } from './routes/workspaces'
import { desktopGuard, desktopRoutes } from './desktop'
import { storageHealth } from './services/storage-health'
import { bodyLimitFor, cloudHeaders } from './security'
import { serveStatic } from './static'

const started = Date.now()

/** Postgres/PGlite unique_violation (23505), possibly wrapped by Drizzle as the error's `cause`. */
function isUniqueViolation(err: unknown): boolean {
  for (let e = err as { code?: unknown; cause?: unknown } | undefined, depth = 0; e && depth < 4; e = e.cause as typeof e, depth++) {
    if (e.code === '23505') return true
  }
  return false
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
  else app.use('*', cloudHeaders)

  app.onError((err, c) => {
    if (err instanceof HttpError) return c.json({ error: err.message, code: err.code, ...(err.details !== undefined ? { details: err.details } : {}) }, err.status as 400)
    const status = (err as { status?: number }).status
    if (status === 413) return c.json({ error: 'Request body too large', code: 'quota' }, 413)
    // two identical requests at once (a double click, a retry): the second hits a unique key, which is a conflict
    if (isUniqueViolation(err)) return c.json({ error: 'This already exists. Refresh and try again.', code: 'conflict' }, 409)
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
        // reported, never gating: a deploy that brings new credentials must pass this check. The reason is for
        // signed-in people only (/api/system): this endpoint is public.
        storageStatus: storageHealth().status,
        uptimeSec: Math.round((Date.now() - started) / 1000),
        features: {
          whisper: Boolean(cfg.whisperCli && cfg.whisperModel && fs.existsSync(cfg.whisperCli) && fs.existsSync(cfg.whisperModel)),
          ai: aiConfigured(),
        },
      },
      db === 'ok' ? 200 : 503,
    )
  })

  // every request body is capped before anything reads it (sign-in included); the upload stream has its own cap
  app.use('/api/*', async (c, next) => {
    const max = bodyLimitFor(c.req.method, c.req.path)
    if (max === null) return next()
    return bodyLimit({ maxSize: max, onError: (x) => x.json({ error: 'Request body too large', code: 'quota' }, 413) })(c, next)
  })
  app.use('/api/*', sessionMiddleware)
  app.use('/api/*', idempotency)

  // desktop-only routes first: they shadow signup and (while linked) workspace creation
  if (ctx().config.mode === 'desktop') app.route('/api', desktopRoutes)
  app.route('/api/auth', authRoutes)
  app.route('/api/account', accountRoutes)
  app.route('/api/me', preferenceRoutes)
  app.route('/api/workspaces', workspaceShareRoutes)
  app.route('/api/workspaces', activityRoutes)
  app.route('/api/workspaces', workspaceRoutes)
  app.route('/api/invites', inviteRoutes)
  app.route('/api/projects', projectExportRoutes)
  app.route('/api/projects', versionRoutes)
  app.route('/api/projects', projectCollabRoutes)
  app.route('/api/comments', commentRoutes)
  app.route('/api/projects', projectRoutes)
  app.route('/api/uploads', uploadRoutes)
  app.route('/api/assets', sceneRoutes)
  app.route('/api/assets', smartRoutes)
  app.route('/api/smart-tools', smartToolsRoutes)
  app.route('/api/assets', smoothRoutes)
  app.route('/api/assets', assetRoutes)
  app.route('/api/media', mediaRoutes)
  app.route('/api/jobs', jobRoutes)
  app.route('/api/events', eventRoutes)
  app.route('/api/ai', aiSettingsRoutes)
  app.route('/api/ai', aiRoutes)
  app.route('/api/voice', voiceRoutes)
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
    let rel: string
    try {
      rel = decodeURIComponent(c.req.path).replace(/^\/+/, '')
    } catch {
      return c.text('Bad request', 400)
    }
    const root = path.resolve(dist)
    let file = path.resolve(root, rel)
    const inside = path.relative(root, file)
    const contained = Boolean(inside) && !inside.startsWith('..') && !path.isAbsolute(inside)
    // source maps stay on the build machine: they hold the app's full source
    if (path.extname(file) === '.map') return c.text('Not found', 404)
    if (!contained || !rel || !fs.existsSync(file) || !fs.statSync(file).isFile()) file = index
    return serveStatic(file, index, c.req.header('accept-encoding'))
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
      return a ? { workspaceId: a.workspaceId, data: assetRecord(a, { light: true }) } : null
    }
    const p = (await db.select({ id: projects.id, ws: projects.workspaceId, version: projects.version }).from(projects).where(eq(projects.id, id)).limit(1))[0]
    return p ? { workspaceId: p.ws, data: { id: p.id, version: p.version } } : null
  })

  return app
}
