import { type Context, Hono } from 'hono'
import { eq } from 'drizzle-orm'
import * as z from 'zod/v4'
import type { MeResponse } from '@producer/core'
import {
  type AppEnv,
  appUrl,
  checkLoginRate,
  clearLoginFailures,
  clientIp,
  createSession,
  destroySession,
  endSessions,
  hashPassword,
  recordLoginFailure,
  requireUser,
  verifyPassword,
} from '../auth'
import { ctx } from '../context'
import { users } from '../db/schema'
import { userDto } from '../dto'
import { HttpError, body } from '../http'
import { newId } from '../ids'
import { limitSignup } from '../limits'
import { mailEnabled, sendMail } from '../mail'
import { emailChangedNotice, passwordChangedNotice, resetMail, verifyMail } from '../mail/messages'
import { checkTokenIpRate, consumeToken, issueToken, peekToken } from '../services/account'
import { createWorkspace, listWorkspaces } from './workspaces'

export const AVATAR_COLORS = ['#ff5a5f', '#35e0ff', '#ffb020', '#7c5cff', '#2ecc71', '#ff7ac6', '#4fd1c5', '#ff8a3d']

export async function meResponse(userId: string): Promise<MeResponse> {
  const u = (await ctx().db.select().from(users).where(eq(users.id, userId)).limit(1))[0]
  return { user: userDto(u), workspaces: await listWorkspaces(userId) }
}

/** Create a user and their personal workspace (also used by the seed script). */
export async function createUser(email: string, password: string, name: string) {
  const db = ctx().db
  const normEmail = email.trim().toLowerCase()
  const existing = await db.select({ id: users.id }).from(users).where(eq(users.email, normEmail)).limit(1)
  if (existing.length) throw new HttpError(409, 'conflict', 'An account with this email already exists')
  const id = newId('u')
  await db.insert(users).values({
    id,
    email: normEmail,
    name: name.trim(),
    passwordHash: await hashPassword(password),
    avatarColor: AVATAR_COLORS[Math.floor(Math.random() * AVATAR_COLORS.length)],
    createdAt: Date.now(),
  })
  await createWorkspace(id, `${name.trim().split(/\s+/)[0]}'s space`, true)
  return id
}

export const authRoutes = new Hono<AppEnv>()

authRoutes.post('/signup', async (c) => {
  const b = await body(c, z.object({ email: z.string().trim().email().max(254), password: z.string().min(8).max(200), name: z.string().trim().min(1).max(80) }))
  limitSignup(clientIp(c))
  const id = await createUser(b.email, b.password, b.name)
  await createSession(c, id)
  await sendVerification(c, id)
  return c.json(await meResponse(id))
})

/** Mail an account a link that confirms its address (nothing when mail is off, or it was sent too often). */
export async function sendVerification(c: Context, userId: string): Promise<boolean> {
  if (!mailEnabled()) return false
  const u = (await ctx().db.select().from(users).where(eq(users.id, userId)).limit(1))[0]
  if (!u || u.emailVerifiedAt) return false
  const token = await issueToken(u.id, 'verify', u.email, clientIp(c))
  if (!token) return false
  return sendMail(verifyMail({ to: u.email, name: u.name, url: appUrl(c, `/verify/${token}`) }))
}

const Password = z.string().min(8, 'Use at least 8 characters').max(200)

/**
 * Forgot password: mail a single-use reset link. The answer is the same whether or not the account exists (no
 * fishing for addresses); `mail: false` says this server sends no mail at all, so nobody could have been sent one.
 */
authRoutes.post('/forgot', async (c) => {
  const b = await body(c, z.object({ email: z.string().trim().max(254) }))
  if (!mailEnabled()) return c.json({ ok: true, mail: false })
  const ip = clientIp(c)
  await checkTokenIpRate(ip)
  const u = (await ctx().db.select().from(users).where(eq(users.email, b.email.toLowerCase())).limit(1))[0]
  if (u) {
    const token = await issueToken(u.id, 'reset', u.email, ip)
    if (token) await sendMail(resetMail({ to: u.email, name: u.name, url: appUrl(c, `/reset/${token}`) }))
  } else {
    // spend about the same time as a real send, so timing doesn't tell
    await hashPassword(b.email)
  }
  return c.json({ ok: true, mail: true })
})

authRoutes.get('/reset/:token', async (c) => {
  const row = await peekToken(c.req.param('token'), ['reset'])
  return c.json({ email: row.email })
})

/** Set a new password with a reset link: every other session and app link ends, and this browser is signed in. */
authRoutes.post('/reset', async (c) => {
  const b = await body(c, z.object({ token: z.string().min(10).max(200), password: Password }))
  const row = await consumeToken(b.token, ['reset'])
  const db = ctx().db
  const u = (await db.select().from(users).where(eq(users.id, row.userId)).limit(1))[0]
  if (!u) throw new HttpError(404, 'not_found', 'This account no longer exists')
  // the link came through their inbox, so the address is theirs
  await db.update(users).set({ passwordHash: await hashPassword(b.password), emailVerifiedAt: u.emailVerifiedAt ?? Date.now() }).where(eq(users.id, u.id))
  await endSessions(u.id, { devices: true })
  clearLoginFailures(clientIp(c), u.email)
  await createSession(c, u.id)
  void sendMail(passwordChangedNotice({ to: u.email, name: u.name }))
  return c.json(await meResponse(u.id))
})

/** Confirm an address from its inbox: the account's own (verify) or a new one it asked to switch to (email). */
authRoutes.post('/verify', async (c) => {
  const b = await body(c, z.object({ token: z.string().min(10).max(200) }))
  const row = await consumeToken(b.token, ['verify', 'email'])
  const db = ctx().db
  const u = (await db.select().from(users).where(eq(users.id, row.userId)).limit(1))[0]
  if (!u) throw new HttpError(404, 'not_found', 'This account no longer exists')
  const now = Date.now()
  if (row.purpose === 'verify') {
    if (row.email !== u.email) throw new HttpError(410, 'conflict', 'This account’s email changed since that link was sent.')
    await db.update(users).set({ emailVerifiedAt: now }).where(eq(users.id, u.id))
  } else {
    const taken = (await db.select({ id: users.id }).from(users).where(eq(users.email, row.email)).limit(1))[0]
    if (taken && taken.id !== u.id) throw new HttpError(409, 'conflict', 'Another account already uses that address.')
    await db.update(users).set({ email: row.email, emailVerifiedAt: now }).where(eq(users.id, u.id))
    void sendMail(emailChangedNotice({ to: u.email, name: u.name, newEmail: row.email }))
  }
  return c.json({ ok: true, email: row.email, purpose: row.purpose === 'verify' ? 'verify' : 'email' })
})

/** Verify email + password with the per-IP+email rate limit; returns the user or throws 401/429. */
export async function checkCredentials(c: Context, emailIn: string, password: string) {
  const email = emailIn.trim().toLowerCase()
  const ip = clientIp(c)
  checkLoginRate(ip, email)
  const u = (await ctx().db.select().from(users).where(eq(users.email, email)).limit(1))[0]
  // always run scrypt so response time doesn't reveal whether the account exists
  const ok = u ? await verifyPassword(password, u.passwordHash) : (await hashPassword(password), false)
  if (!u || !ok) {
    recordLoginFailure(ip, email)
    throw new HttpError(401, 'unauthorized', 'Email or password is incorrect')
  }
  clearLoginFailures(ip, email)
  return u
}

authRoutes.post('/login', async (c) => {
  const b = await body(c, z.object({ email: z.string().trim().max(254), password: z.string().max(200) }))
  const u = await checkCredentials(c, b.email, b.password)
  await createSession(c, u.id)
  return c.json(await meResponse(u.id))
})

authRoutes.post('/logout', async (c) => {
  await destroySession(c)
  return c.json({ ok: true })
})

authRoutes.get('/me', async (c) => {
  const u = requireUser(c)
  return c.json(await meResponse(u.id))
})
