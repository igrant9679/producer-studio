// The signed-in person's own account (A-17): profile, email and password, sessions and app links, notification
// choices, and deleting the account. Mounted at /api/account; routes are listed in packages/core/src/account.ts.
import { Hono } from 'hono'
import { and, desc, eq, gt } from 'drizzle-orm'
import * as z from 'zod/v4'
import { type AccountInfo, type AccountSession, type EmailChangeResult, normalizeNotifications, type NotificationPrefs } from '@producer/core'
import { deleteCookie } from 'hono/cookie'
import { type AppEnv, type UserRow, SESSION_COOKIE, appUrl, clientIp, endSessions, hashPassword, requireUser, verifyPassword } from '../auth'
import { ctx } from '../context'
import { sessions, users } from '../db/schema'
import { userDto } from '../dto'
import { HttpError, body, notFound } from '../http'
import { mailEnabled, sendMail } from '../mail'
import { emailChangeMail, passwordChangedNotice } from '../mail/messages'
import { checkTokenIpRate, deleteAccount, issueToken, pendingEmail, planAccountDelete } from '../services/account'
import { AVATAR_COLORS, sendVerification } from './auth'

async function loadUser(id: string): Promise<UserRow> {
  const u = (await ctx().db.select().from(users).where(eq(users.id, id)).limit(1))[0]
  if (!u) throw notFound('This account no longer exists')
  return u
}

async function accountInfo(u: UserRow): Promise<AccountInfo> {
  const plan = await planAccountDelete(u.id)
  const pending = await pendingEmail(u.id)
  return {
    user: userDto(u),
    emailVerified: u.emailVerifiedAt != null,
    ...(pending ? { pendingEmail: pending } : {}),
    mail: mailEnabled(),
    notifications: normalizeNotifications(u.notify),
    soleOwnerOf: plan.blocked,
  }
}

/** The desktop app's local account isn't a real sign-in: its email, password and deletion live on the cloud. */
function cloudOnly() {
  if (ctx().config.mode !== 'cloud') throw new HttpError(409, 'conflict', 'Manage your email, password and account on Producer Studio cloud.')
}

/** Changing who the account is takes its password again: a session left open on someone else's screen isn't enough. */
async function confirmPassword(u: UserRow, password: string) {
  if (!(await verifyPassword(password, u.passwordHash))) throw new HttpError(403, 'forbidden', 'That password isn’t right')
}

export const accountRoutes = new Hono<AppEnv>()

accountRoutes.get('/', async (c) => c.json(await accountInfo(await loadUser(requireUser(c).id))))

accountRoutes.patch('/', async (c) => {
  const u = requireUser(c)
  const b = await body(c, z.object({ name: z.string().trim().min(1).max(80).optional(), avatarColor: z.enum(AVATAR_COLORS as [string, ...string[]]).optional() }).strict())
  if (b.name !== undefined || b.avatarColor !== undefined) await ctx().db.update(users).set(b).where(eq(users.id, u.id))
  return c.json(await accountInfo(await loadUser(u.id)))
})

accountRoutes.post('/password', async (c) => {
  cloudOnly()
  const u = await loadUser(requireUser(c).id)
  const b = await body(c, z.object({ current: z.string().max(200), password: z.string().min(8, 'Use at least 8 characters').max(200) }))
  await confirmPassword(u, b.current)
  await ctx().db.update(users).set({ passwordHash: await hashPassword(b.password) }).where(eq(users.id, u.id))
  // everyone else signed in as them is out; this browser stays in. App links stay (Sign out everywhere ends those).
  await endSessions(u.id, { except: c.get('sessionId') })
  void sendMail(passwordChangedNotice({ to: u.email, name: u.name }))
  return c.json({ ok: true })
})

/**
 * Change the sign-in email. With mail on, the new address gets a confirmation link and nothing changes until it's
 * used; with mail off nothing could confirm it, so the change (password-checked) is made at once.
 */
accountRoutes.post('/email', async (c) => {
  cloudOnly()
  const u = await loadUser(requireUser(c).id)
  const b = await body(c, z.object({ email: z.string().trim().email().max(254), password: z.string().max(200) }))
  await confirmPassword(u, b.password)
  const email = b.email.toLowerCase()
  if (email === u.email) throw new HttpError(400, 'invalid', 'That’s already your email')
  const db = ctx().db
  const taken = (await db.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1))[0]
  if (taken) throw new HttpError(409, 'conflict', 'Another account already uses that address')
  if (!mailEnabled()) {
    await db.update(users).set({ email, emailVerifiedAt: null }).where(eq(users.id, u.id))
    return c.json({ ok: true, email } satisfies EmailChangeResult)
  }
  await checkTokenIpRate(clientIp(c))
  const token = await issueToken(u.id, 'email', email, clientIp(c))
  if (!token) throw new HttpError(429, 'quota', 'Too many confirmation mails this hour. Try again later.')
  const sent = await sendMail(emailChangeMail({ to: email, name: u.name, url: appUrl(c, `/verify/${token}`) }))
  if (!sent) throw new HttpError(502, 'server', 'The confirmation mail couldn’t be sent. Try again in a moment.')
  return c.json({ ok: true, pending: email } satisfies EmailChangeResult)
})

accountRoutes.post('/verify', async (c) => {
  cloudOnly()
  const u = await loadUser(requireUser(c).id)
  if (u.emailVerifiedAt) return c.json({ ok: true, emailed: false })
  if (!mailEnabled()) throw new HttpError(409, 'conflict', 'This server sends no mail, so addresses can’t be confirmed.')
  await checkTokenIpRate(clientIp(c))
  const emailed = await sendVerification(c, u.id)
  if (!emailed) throw new HttpError(429, 'quota', 'A confirmation was sent recently. Check your inbox, or try again in an hour.')
  return c.json({ ok: true, emailed })
})

const NotifyPatch = z.object({ browser: z.boolean(), emailJobs: z.boolean() }).partial().strict()

accountRoutes.put('/notifications', async (c) => {
  const u = await loadUser(requireUser(c).id)
  const patch = await body(c, NotifyPatch)
  const next: NotificationPrefs = normalizeNotifications({ ...normalizeNotifications(u.notify), ...patch })
  await ctx().db.update(users).set({ notify: { ...next } }).where(eq(users.id, u.id))
  return c.json(next)
})

accountRoutes.get('/sessions', async (c) => {
  const u = requireUser(c)
  const current = c.get('sessionId')
  const rows = await ctx()
    .db.select()
    .from(sessions)
    .where(and(eq(sessions.userId, u.id), gt(sessions.expiresAt, Date.now())))
    .orderBy(desc(sessions.createdAt))
  const list: AccountSession[] = rows.map((s) => ({
    id: s.id,
    current: s.id === current,
    ...(s.userAgent ? { userAgent: s.userAgent } : {}),
    createdAt: s.createdAt,
    ...(s.lastSeenAt ? { lastSeenAt: s.lastSeenAt } : {}),
    expiresAt: s.expiresAt,
  }))
  // the one in use first
  return c.json(list.sort((a, b) => Number(b.current) - Number(a.current)))
})

accountRoutes.delete('/sessions/:id', async (c) => {
  const u = requireUser(c)
  const gone = await ctx()
    .db.delete(sessions)
    .where(and(eq(sessions.id, c.req.param('id')), eq(sessions.userId, u.id)))
    .returning({ id: sessions.id })
  if (!gone.length) throw notFound('That session already ended')
  ctx().bus.accessChanged(u.id)
  return c.json({ ok: true })
})

/** Every other browser session ends and every desktop app is unlinked; this browser stays signed in. */
accountRoutes.post('/sign-out-everywhere', async (c) => {
  const u = requireUser(c)
  const n = await endSessions(u.id, { except: c.get('sessionId'), devices: true })
  return c.json({ ok: true, ...n })
})

accountRoutes.delete('/', async (c) => {
  cloudOnly()
  const u = await loadUser(requireUser(c).id)
  const b = await body(c, z.object({ password: z.string().max(200) }))
  await confirmPassword(u, b.password)
  await deleteAccount(u.id)
  deleteCookie(c, SESSION_COOKIE, { path: '/' })
  return c.json({ ok: true })
})
