// Cloud hardening shared by every response: security headers and request body caps. (The desktop has its own
// guard in desktop/index.ts: loopback only, a stricter CSP, and no body caps for VoiceStudio's large uploads.)
import type { MiddlewareHandler } from 'hono'
import type { AppEnv } from './auth'
import { ctx } from './context'

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  // media and thumbnails can be 302s to the bucket's signed URLs; uploads PUT straight to the bucket
  "img-src 'self' data: blob: https:",
  "media-src 'self' data: blob: https:",
  "connect-src 'self' https:",
  "font-src 'self' data:",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ')

/** CSP (scripts from this origin only, never framed), nosniff, referrer and opener policy; HSTS in production. */
export const cloudHeaders: MiddlewareHandler<AppEnv> = async (c, next) => {
  await next()
  const h = c.res.headers
  // a response that set its own policy (a sandboxed download) keeps it
  if (!h.has('Content-Security-Policy')) h.set('Content-Security-Policy', CSP)
  h.set('X-Content-Type-Options', 'nosniff')
  h.set('X-Frame-Options', 'DENY')
  h.set('Referrer-Policy', 'strict-origin-when-cross-origin')
  h.set('Cross-Origin-Opener-Policy', 'same-origin')
  if (ctx().config.production) h.set('Strict-Transport-Security', 'max-age=31536000')
}

const MB = 1024 * 1024

/**
 * Largest request body a cloud route accepts, or null for no cap. Whole project documents can be large; the
 * local-storage upload stream is capped by MAX_UPLOAD_MB as it is written; everything else is small JSON.
 */
export function bodyLimitFor(method: string, path: string): number | null {
  if (ctx().config.mode !== 'cloud' || method === 'GET' || method === 'HEAD') return null
  if (/^\/api\/uploads\/[^/]+\/data$/.test(path)) return null
  if (/^\/api\/projects(\/[^/]+)?$/.test(path) || path === '/api/ai/assistant') return 64 * MB
  if (path.startsWith('/api/ai/') || path.startsWith('/api/voice/') || path.startsWith('/api/sync')) return 8 * MB
  // a brand kit's font file (A-21: at most 5 MB, checked by the route too)
  if (/^\/api\/workspaces\/[^/]+\/brand\/fonts$/.test(path)) return 6 * MB
  return 1 * MB
}
