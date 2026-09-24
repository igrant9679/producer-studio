import { type Context, Hono } from 'hono'
import { eq } from 'drizzle-orm'
import * as z from 'zod/v4'
import type { MeResponse } from '@producer/core'
import {
  type AppEnv,
  checkLoginRate,
  clearLoginFailures,
  clientIp,
  createSession,
  destroySession,
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
import { createWorkspace, listWorkspaces } from './workspaces'

const COLORS = ['#ff5a5f', '#35e0ff', '#ffb020', '#7c5cff', '#2ecc71', '#ff7ac6', '#4fd1c5', '#ff8a3d']

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
    avatarColor: COLORS[Math.floor(Math.random() * COLORS.length)],
    createdAt: Date.now(),
  })
  await createWorkspace(id, `${name.trim().split(/\s+/)[0]}'s space`, true)
  return id
}

export const authRoutes = new Hono<AppEnv>()

authRoutes.post('/signup', async (c) => {
  const b = await body(c, z.object({ email: z.string().trim().email().max(254), password: z.string().min(8).max(200), name: z.string().trim().min(1).max(80) }))
  const id = await createUser(b.email, b.password, b.name)
  await createSession(c, id)
  return c.json(await meResponse(id))
})

/** Verify email + password with the per-IP+email rate limit; returns the user or throws 401/429. */
export async function checkCredentials(c: Context, emailIn: string, password: string) {
  const email = emailIn.trim().toLowerCase()
  const key = `${clientIp(c)}|${email}`
  checkLoginRate(key)
  const u = (await ctx().db.select().from(users).where(eq(users.email, email)).limit(1))[0]
  // always run scrypt so response time doesn't reveal whether the account exists
  const ok = u ? await verifyPassword(password, u.passwordHash) : (await hashPassword(password), false)
  if (!u || !ok) {
    recordLoginFailure(key)
    throw new HttpError(401, 'unauthorized', 'Email or password is incorrect')
  }
  clearLoginFailures(key)
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
