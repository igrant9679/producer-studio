// Passwords (scrypt), sessions (hashed random tokens in an httpOnly cookie, 30-day sliding), rate limiting.
import crypto from 'node:crypto'
import { promisify } from 'node:util'
import type { Context, MiddlewareHandler } from 'hono'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import { eq } from 'drizzle-orm'
import { ctx } from './context'
import { devices, sessions, users } from './db/schema'
import { HttpError, unauthorized } from './http'
import { randomToken, sha256 } from './ids'

const scrypt = promisify(crypto.scrypt) as (pw: string, salt: Buffer, keylen: number, opts: crypto.ScryptOptions) => Promise<Buffer>
const SCRYPT = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }

export async function hashPassword(pw: string): Promise<string> {
  const salt = crypto.randomBytes(16)
  const key = await scrypt(pw, salt, 64, SCRYPT)
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${key.toString('base64')}`
}

export async function verifyPassword(pw: string, stored: string): Promise<boolean> {
  const parts = stored.split('$')
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false
  const [, n, r, p, saltB64, keyB64] = parts
  const expected = Buffer.from(keyB64, 'base64')
  const key = await scrypt(pw, Buffer.from(saltB64, 'base64'), expected.length, { N: Number(n), r: Number(r), p: Number(p), maxmem: 64 * 1024 * 1024 })
  return key.length === expected.length && crypto.timingSafeEqual(key, expected)
}

export const SESSION_COOKIE = 'ps_session'
const SESSION_MS = 30 * 24 * 3600 * 1000
const REFRESH_AFTER_MS = 24 * 3600 * 1000

export type UserRow = typeof users.$inferSelect

export interface AppEnv {
  Variables: {
    user: UserRow | null
    sessionId: string | null
    /** Set when the request authenticated with a device token (Authorization: Bearer). */
    deviceId: string | null
  }
}

function cookieOpts(expires: Date) {
  return { httpOnly: true, sameSite: 'Lax' as const, secure: ctx().config.production, path: '/', expires }
}

export async function createSession(c: Context, userId: string) {
  const token = randomToken(32)
  const now = Date.now()
  await ctx()
    .db.insert(sessions)
    .values({ id: sha256(token), userId, createdAt: now, expiresAt: now + SESSION_MS, userAgent: c.req.header('user-agent')?.slice(0, 200) ?? null })
  setCookie(c, SESSION_COOKIE, token, cookieOpts(new Date(now + SESSION_MS)))
}

export async function destroySession(c: Context) {
  const token = getCookie(c, SESSION_COOKIE)
  if (token) await ctx().db.delete(sessions).where(eq(sessions.id, sha256(token)))
  deleteCookie(c, SESSION_COOKIE, { path: '/' })
}

/** Resolve the session cookie (if any) into c.var.user; slides expiry at most once a day. */
export const sessionMiddleware: MiddlewareHandler<AppEnv> = async (c, next) => {
  c.set('user', null)
  c.set('sessionId', null)
  c.set('deviceId', null)
  const auth = c.req.header('authorization')
  const bearer = auth?.match(/^Bearer\s+(\S{20,200})$/i)?.[1]
  if (bearer) {
    const rows = await ctx()
      .db.select({ d: devices, u: users })
      .from(devices)
      .innerJoin(users, eq(users.id, devices.userId))
      .where(eq(devices.tokenHash, sha256(bearer)))
      .limit(1)
    const row = rows[0]
    if (!row) throw new HttpError(401, 'unauthorized', 'Invalid or revoked device token')
    c.set('user', row.u)
    c.set('deviceId', row.d.id)
    const now = Date.now()
    if (!row.d.lastSeenAt || now - row.d.lastSeenAt > 60_000) await ctx().db.update(devices).set({ lastSeenAt: now }).where(eq(devices.id, row.d.id))
    return next()
  }
  const token = getCookie(c, SESSION_COOKIE)
  if (token && token.length < 200) {
    const id = sha256(token)
    const rows = await ctx()
      .db.select({ s: sessions, u: users })
      .from(sessions)
      .innerJoin(users, eq(users.id, sessions.userId))
      .where(eq(sessions.id, id))
      .limit(1)
    const row = rows[0]
    const now = Date.now()
    if (row && row.s.expiresAt > now) {
      c.set('user', row.u)
      c.set('sessionId', id)
      if (row.s.expiresAt - now < SESSION_MS - REFRESH_AFTER_MS) {
        await ctx().db.update(sessions).set({ expiresAt: now + SESSION_MS }).where(eq(sessions.id, id))
        setCookie(c, SESSION_COOKIE, token, cookieOpts(new Date(now + SESSION_MS)))
      }
    } else if (row) {
      await ctx().db.delete(sessions).where(eq(sessions.id, id))
    }
  }
  await next()
}

export function requireUser(c: Context<AppEnv>): UserRow {
  const u = c.get('user')
  if (!u) throw unauthorized()
  return u
}

// ---- login rate limit (in memory, per IP + email) ----
const attempts = new Map<string, { fails: number; resetAt: number }>()
const WINDOW_MS = 15 * 60 * 1000
const MAX_FAILS = 8

export function checkLoginRate(key: string) {
  const a = attempts.get(key)
  const now = Date.now()
  if (a && a.resetAt > now && a.fails >= MAX_FAILS) {
    throw new HttpError(429, 'quota', `Too many sign-in attempts. Try again in ${Math.ceil((a.resetAt - now) / 60000)} minutes.`)
  }
}

export function recordLoginFailure(key: string) {
  const now = Date.now()
  const a = attempts.get(key)
  if (!a || a.resetAt <= now) attempts.set(key, { fails: 1, resetAt: now + WINDOW_MS })
  else a.fails++
  if (attempts.size > 10_000) for (const [k, v] of attempts) if (v.resetAt <= now) attempts.delete(k)
}

export function clearLoginFailures(key: string) {
  attempts.delete(key)
}

export function clientIp(c: Context): string {
  const fwd = c.req.header('x-forwarded-for')
  if (fwd) return fwd.split(',')[0].trim()
  const incoming = (c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)?.incoming
  return incoming?.socket?.remoteAddress ?? 'unknown'
}
