// Passwords (scrypt), sessions (hashed random tokens in an httpOnly cookie, 30-day sliding), rate limiting.
import crypto from 'node:crypto'
import { promisify } from 'node:util'
import type { Context, MiddlewareHandler } from 'hono'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import { and, eq, ne } from 'drizzle-orm'
import { ctx } from './context'
import { devices, sessions, users } from './db/schema'
import { HttpError, unauthorized } from './http'
import { randomToken, sha256 } from './ids'
import { type LimitRule, assertRoom, clearWindow, hit } from './limits'

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
/** Device tokens (desktop links) stop working after this long without a request. */
export const DEVICE_IDLE_MS = 90 * 24 * 3600 * 1000
const REFRESH_AFTER_MS = 24 * 3600 * 1000
/** A session's "last used" is written at most this often. */
const SEEN_EVERY_MS = 5 * 60 * 1000

export type UserRow = typeof users.$inferSelect

/** What a disabled account is told (P-10): only after its password was right. */
export const DISABLED_MESSAGE = 'This account has been disabled. Contact support to have it enabled again.'

export interface AppEnv {
  Variables: {
    user: UserRow | null
    sessionId: string | null
    /** Set when the request authenticated with a device token (Authorization: Bearer). */
    deviceId: string | null
    /** P-7: this request's id (request-id.ts). */
    requestId: string
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
  if (token) {
    const gone = await ctx().db.delete(sessions).where(eq(sessions.id, sha256(token))).returning({ userId: sessions.userId })
    // the live-update streams this session opened close now, not at their next check
    for (const s of gone) ctx().bus.accessChanged(s.userId)
  }
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
    if (!row || row.u.disabledAt) throw new HttpError(401, 'unauthorized', 'Invalid or revoked device token')
    // an app link syncs; managing the account, the space's people or anything else takes a signed-in browser
    if (!deviceMayUse(c.req.method, c.req.path)) throw new HttpError(403, 'forbidden', 'A linked desktop app can only sync. Sign in in the browser to do this.')
    const now = Date.now()
    // a token nobody has used for months is more likely leaked than needed: the app links again with a password
    if (now - (row.d.lastSeenAt ?? row.d.createdAt) > DEVICE_IDLE_MS) throw new HttpError(401, 'unauthorized', 'This app link expired after 90 days unused. Link the app again.')
    c.set('user', row.u)
    c.set('deviceId', row.d.id)
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
    // a disabled account's sessions end when it's disabled; one that slipped through counts as signed out
    if (row && row.s.expiresAt > now && !row.u.disabledAt) {
      c.set('user', row.u)
      c.set('sessionId', id)
      const slide = row.s.expiresAt - now < SESSION_MS - REFRESH_AFTER_MS
      if (slide || !row.s.lastSeenAt || now - row.s.lastSeenAt > SEEN_EVERY_MS)
        await ctx().db.update(sessions).set({ lastSeenAt: now, ...(slide ? { expiresAt: now + SESSION_MS } : {}) }).where(eq(sessions.id, id))
      if (slide) setCookie(c, SESSION_COOKIE, token, cookieOpts(new Date(now + SESSION_MS)))
    } else if (row) {
      await ctx().db.delete(sessions).where(eq(sessions.id, id))
    }
  }
  await next()
}

/**
 * What a device token (a linked desktop app) may call: the sync engine's routes and nothing else (P-22). Anything
 * about the account, members, invites, AI or sharing needs a browser session, so a leaked app token can't take over.
 */
const DEVICE_ROUTES: Array<[string, RegExp]> = [
  ['GET', /^\/api\/auth\/me$/],
  ['GET', /^\/api\/system$/],
  ['*', /^\/api\/sync(\/.*)?$/],
  ['GET|POST', /^\/api\/devices$/],
  ['DELETE', /^\/api\/devices\/[^/]+$/],
  ['GET|POST', /^\/api\/workspaces$/],
  ['PATCH|DELETE', /^\/api\/workspaces\/[^/]+$/],
  ['GET|PUT', /^\/api\/workspaces\/[^/]+\/brand$/],
  ['GET|POST', /^\/api\/projects$/],
  ['GET|PUT|PATCH', /^\/api\/projects\/[^/]+$/],
  ['POST', /^\/api\/uploads$/],
  ['PUT', /^\/api\/uploads\/[^/]+\/data$/],
  ['GET', /^\/api\/assets$/],
  ['GET|PATCH|DELETE', /^\/api\/assets\/[^/]+$/],
  ['POST', /^\/api\/assets\/[^/]+\/(complete|abort)$/],
  ['GET|HEAD', /^\/api\/media\/[^/]+\/[^/]+$/],
  ['*', /^\/api\/voice\/(profiles|relay)(\/.*)?$/],
  ['GET', /^\/api\/events$/],
]

export function deviceMayUse(method: string, path: string): boolean {
  const m = method.toUpperCase()
  return DEVICE_ROUTES.some(([methods, re]) => (methods === '*' || methods.split('|').includes(m)) && re.test(path))
}

/**
 * End a person's sessions: all of them, or all but `except` (the one asking). `devices` also unlinks every desktop
 * app. Their open live-update streams close now.
 */
export async function endSessions(userId: string, o: { except?: string | null; devices?: boolean } = {}): Promise<{ sessions: number; devices: number }> {
  const db = ctx().db
  const s = await db
    .delete(sessions)
    .where(o.except ? and(eq(sessions.userId, userId), ne(sessions.id, o.except)) : eq(sessions.userId, userId))
    .returning({ id: sessions.id })
  const d = o.devices ? await db.delete(devices).where(eq(devices.userId, userId)).returning({ id: devices.id }) : []
  ctx().bus.accessChanged(userId)
  return { sessions: s.length, devices: d.length }
}

/** An absolute link into the app for a mail: PUBLIC_URL, else the address this request came to. */
export function appUrl(c: Context, path: string): string {
  const base = ctx().config.publicUrl ?? new URL(c.req.url).origin
  return `${base.replace(/\/+$/, '')}${path}`
}

export function requireUser(c: Context<AppEnv>): UserRow {
  const u = c.get('user')
  if (!u) throw unauthorized()
  return u
}

// ---- sign-in rate limit: failures per IP + email, per email, and per IP, counted in Postgres (limits.ts) so every
// API replica shares one count ----
const WINDOW_MS = 15 * 60 * 1000
/** One person mistyping (IP + email); one account sprayed from many addresses (email); one address spraying many accounts (IP). */
const MAX_FAILS = { pair: 8, email: 30, ip: 50 }
const pairKey = (ip: string, email: string) => `login:pair:${ip}|${email}`

function loginRules(ip: string, email: string): LimitRule[] {
  const message = 'Too many sign-in attempts.'
  return [
    { key: pairKey(ip, email), limit: MAX_FAILS.pair, windowMs: WINDOW_MS, message },
    { key: `login:email:${email}`, limit: MAX_FAILS.email, windowMs: WINDOW_MS, message },
    { key: `login:ip:${ip}`, limit: MAX_FAILS.ip, windowMs: WINDOW_MS, message },
  ]
}

/** 429 when this address, account or pair already failed too often (checked before the password, counting nothing). */
export async function checkLoginRate(ip: string, email: string) {
  await assertRoom(loginRules(ip, email))
}

export async function recordLoginFailure(ip: string, email: string) {
  try {
    await hit(loginRules(ip, email))
  } catch (err) {
    // already full: the next attempt is refused by checkLoginRate either way
    if (!(err instanceof HttpError && err.status === 429)) throw err
  }
}

/** A correct password clears this person's own counter; the per-email and per-IP ones run out on their own. */
export async function clearLoginFailures(ip: string, email: string) {
  await clearWindow(pairKey(ip, email))
}

/**
 * The client's address. X-Forwarded-For is client-controlled except for the entries our own proxies append, so with
 * TRUST_PROXY_HOPS = n the client is the n-th entry from the end (Railway's edge appends one). 0 = the socket peer.
 */
export function clientIp(c: Context): string {
  const hops = ctx().config.trustProxyHops
  const fwd = c.req.header('x-forwarded-for')
  if (hops > 0 && fwd) {
    const parts = fwd.split(',').map((s) => s.trim()).filter(Boolean)
    const ip = parts[parts.length - hops]
    if (ip) return ip
  }
  const incoming = (c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)?.incoming
  return incoming?.socket?.remoteAddress ?? 'unknown'
}
