// Desktop mode (MODE=desktop): one local user, local settings, the sync engine, Claude sign-in, and the hardening
// that makes the local API unusable by other processes (127.0.0.1 only, Host allow-list, per-launch session from a
// secret only the Electron main process knows, CSP).
import { type Context, Hono, type MiddlewareHandler } from 'hono'
import * as z from 'zod/v4'
import { type AppEnv, SESSION_COOKIE, requireUser } from '../auth'
import { ctx } from '../context'
import { HttpError, body, forbidden } from '../http'
import { log } from '../log'
import { getProvider } from '../ai/provider'
import { findClaude } from '../ai/cli/detect'
import { setMissingMediaFetcher } from '../services/assets'
import { openSignInTerminal } from './claude-login'
import { ensureDesktopTables } from './db'
import { createLocalSession, ensureLocalUser, secretMatches } from './identity'
import { fetchMissingMedia } from './media'
import { SettingsPatch, getSettings, saveSettings } from './settings'
import { syncEngine } from './sync'

export async function initDesktop() {
  await ensureDesktopTables()
  await ensureLocalUser()
  setMissingMediaFetcher(fetchMissingMedia)
  if (!process.env.DESKTOP_SECRET) log.warn('desktop: DESKTOP_SECRET is not set; POST /api/desktop/session is disabled')
}

export async function startDesktopServices() {
  await syncEngine.start()
}

export function stopDesktopServices() {
  syncEngine.stop()
}

function remoteAddress(c: Context): string {
  const incoming = (c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)?.incoming
  return incoming?.socket?.remoteAddress ?? ''
}

const LOOPBACK = /^(127\.\d+\.\d+\.\d+|::1|::ffff:127\.\d+\.\d+\.\d+)$/
const LOCAL_HOSTS = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i

export const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "media-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ')

/**
 * Desktop hardening for every request: only local Host headers (defeats DNS rebinding from web pages), only loopback
 * peers, and security headers (CSP, nosniff, no referrer) on every response.
 */
export const desktopGuard: MiddlewareHandler<AppEnv> = async (c, next) => {
  const host = c.req.header('host') ?? ''
  if (host && !LOCAL_HOSTS.test(host)) return c.json({ error: 'Forbidden host', code: 'forbidden' }, 403)
  const peer = remoteAddress(c)
  if (peer && !LOOPBACK.test(peer)) return c.json({ error: 'Forbidden', code: 'forbidden' }, 403)
  await next()
  c.res.headers.set('Content-Security-Policy', CSP)
  c.res.headers.set('X-Content-Type-Options', 'nosniff')
  c.res.headers.set('Referrer-Policy', 'no-referrer')
  c.res.headers.set('Cross-Origin-Opener-Policy', 'same-origin')
}

export const desktopRoutes = new Hono<AppEnv>()

// one local user: no sign-ups on the desktop
desktopRoutes.post('/auth/signup', () => {
  throw forbidden('Producer Studio desktop has a single local user. Link a cloud account in Settings instead.')
})

/** Per-launch session for the Electron shell. Requires the secret the main process generated for this launch. */
desktopRoutes.post('/desktop/session', async (c) => {
  if (!secretMatches(c.req.header('x-desktop-secret'))) throw new HttpError(403, 'forbidden', 'Forbidden')
  const s = await createLocalSession(c.req.header('user-agent'))
  return c.json({ cookie: SESSION_COOKIE, token: s.token, expiresAt: s.expiresAt })
})

/** Open a terminal running `claude auth login`; the UI then polls /api/system?refresh=1. */
desktopRoutes.post('/desktop/claude/login', async (c) => {
  requireUser(c)
  const install = await findClaude(getSettings().claudePath)
  if (!install) throw new HttpError(404, 'not_found', 'Claude Code CLI not found. Install Claude Code, or set its path in Settings → AI.')
  openSignInTerminal(install.path)
  ;((await getProvider()) as { invalidate?: () => void }).invalidate?.()
  return c.json({ ok: true, path: install.path })
})

desktopRoutes.get('/settings', (c) => {
  requireUser(c)
  return c.json(getSettings())
})

desktopRoutes.put('/settings', async (c) => {
  requireUser(c)
  const patch = await body(c, SettingsPatch)
  try {
    const next = saveSettings(patch)
    if (patch.claudePath !== undefined || patch.claudeModel !== undefined) ((await getProvider()) as { invalidate?: () => void }).invalidate?.()
    return c.json(next)
  } catch (err) {
    if ((err as { invalid?: boolean }).invalid) throw new HttpError(400, 'invalid', (err as Error).message)
    throw err
  }
})

desktopRoutes.get('/sync/status', async (c) => {
  requireUser(c)
  return c.json(await syncEngine.status())
})

desktopRoutes.post('/sync/now', async (c) => {
  requireUser(c)
  return c.json(await syncEngine.syncNow())
})

desktopRoutes.post('/sync/link', async (c) => {
  requireUser(c)
  const b = await body(c, z.object({ cloudUrl: z.string().min(1).max(500), email: z.string().trim().min(1).max(254), password: z.string().min(1).max(200) }))
  return c.json(await syncEngine.link(b.cloudUrl, b.email, b.password))
})

desktopRoutes.post('/sync/unlink', async (c) => {
  requireUser(c)
  return c.json(await syncEngine.unlink())
})

desktopRoutes.post('/projects/:id/sync', async (c) => {
  requireUser(c)
  const b = await body(c, z.object({ mode: z.enum(['keep-local', 'keep-cloud', 'keep-both']) }))
  return c.json(await syncEngine.resolve(c.req.param('id'), b.mode))
})

// while linked, new workspaces are created in the cloud first (it owns workspace ids) and mirrored here
desktopRoutes.post('/workspaces', async (c, next) => {
  requireUser(c)
  const raw = (await c.req.raw.clone().json().catch(() => ({}))) as { name?: unknown }
  const name = typeof raw.name === 'string' ? raw.name.trim().slice(0, 80) : ''
  if (!name) return next()
  const w = await syncEngine.createWorkspace(name)
  if (!w) return next()
  return c.json(w)
})

export function desktopMode(): boolean {
  return ctx().config.mode === 'desktop'
}
