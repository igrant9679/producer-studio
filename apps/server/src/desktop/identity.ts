// The one local user of the desktop edition (no login screen) and the per-launch session handed to Electron.
// On first run: a local user + personal workspace. When linked, the local user adopts the cloud user's id, name
// and email so project/asset authorship and workspace membership match the cloud exactly.
import crypto from 'node:crypto'
import os from 'node:os'
import { eq, sql } from 'drizzle-orm'
import type { User } from '@producer/core'
import { hashPassword } from '../auth'
import { ctx } from '../context'
import { sessions, users } from '../db/schema'
import { newId, randomToken, sha256 } from '../ids'
import { log } from '../log'
import { createWorkspace } from '../routes/workspaces'
import { kvGet, kvSet } from './db'

const SESSION_MS = 30 * 24 * 3600 * 1000
const COLORS = ['#ff5a5f', '#35e0ff', '#ffb020', '#7c5cff', '#2ecc71', '#ff7ac6']

let cachedId: string | undefined

function displayName(): string {
  let n = ''
  try {
    n = os.userInfo().username
  } catch {
    /* no user info */
  }
  n = n.replace(/[._-]+/g, ' ').trim()
  return n ? n.replace(/\b\w/g, (ch) => ch.toUpperCase()).slice(0, 60) : 'You'
}

/** The local user's id, creating the user and a personal workspace on first run. */
export async function ensureLocalUser(): Promise<string> {
  const db = ctx().db
  const stored = await kvGet<string>('localUserId')
  if (stored && (await db.select({ id: users.id }).from(users).where(eq(users.id, stored)).limit(1)).length) return (cachedId = stored)
  // a data folder from an earlier install without the kv entry: adopt its oldest user
  const existing = (await db.select({ id: users.id }).from(users).orderBy(users.createdAt).limit(1))[0]
  if (existing) {
    await kvSet('localUserId', existing.id)
    return (cachedId = existing.id)
  }
  const id = newId('u')
  const name = displayName()
  await db.insert(users).values({
    id,
    email: 'you@this-computer.local',
    name,
    // never used to sign in: the desktop session comes from POST /api/desktop/session
    passwordHash: await hashPassword(randomToken(32)),
    avatarColor: COLORS[Math.floor(Math.random() * COLORS.length)],
    createdAt: Date.now(),
  })
  await createWorkspace(id, `${name.split(/\s+/)[0]}'s space`, true)
  await kvSet('localUserId', id)
  log.info('desktop: created local user', { id })
  return (cachedId = id)
}

export async function localUserId(): Promise<string> {
  return cachedId ?? ensureLocalUser()
}

/** A fresh session for the local user; the token becomes Electron's `ps_session` cookie. */
export async function createLocalSession(userAgent?: string): Promise<{ token: string; expiresAt: number }> {
  const userId = await localUserId()
  const token = randomToken(32)
  const now = Date.now()
  await ctx()
    .db.insert(sessions)
    .values({ id: sha256(token), userId, createdAt: now, expiresAt: now + SESSION_MS, userAgent: userAgent?.slice(0, 200) ?? 'Producer Studio desktop' })
  // old per-launch sessions are useless once Electron restarts; keep the table small
  await ctx().db.execute(sql`DELETE FROM sessions WHERE user_id = ${userId} AND created_at < ${now - 7 * 24 * 3600 * 1000}`)
  return { token, expiresAt: now + SESSION_MS }
}

export function secretMatches(given: string | undefined): boolean {
  const expected = process.env.DESKTOP_SECRET
  if (!expected || !given || given.length !== expected.length) return false
  return crypto.timingSafeEqual(Buffer.from(given), Buffer.from(expected))
}

/**
 * Re-key the local user to the cloud user (same id, email, name, colour). References are moved inside one
 * transaction; the old row is deleted afterwards.
 */
export async function adoptCloudIdentity(cloud: User): Promise<void> {
  const db = ctx().db
  const oldId = await localUserId()
  const email = cloud.email.trim().toLowerCase()
  if (oldId === cloud.id) {
    await db.update(users).set({ email, name: cloud.name, avatarColor: cloud.avatarColor }).where(eq(users.id, oldId))
    return
  }
  await db.transaction(async (tx) => {
    const old = (await tx.select().from(users).where(eq(users.id, oldId)).limit(1))[0]
    // free the email if another (stale) row holds it
    await tx.execute(sql`UPDATE users SET email = ${`stale-${Date.now()}@this-computer.local`} WHERE email = ${email} AND id <> ${cloud.id}`)
    await tx.execute(sql`
      INSERT INTO users (id, email, name, password_hash, avatar_color, created_at)
      VALUES (${cloud.id}, ${email}, ${cloud.name}, ${old?.passwordHash ?? ''}, ${cloud.avatarColor}, ${cloud.createdAt})
      ON CONFLICT (id) DO UPDATE SET email = EXCLUDED.email, name = EXCLUDED.name, avatar_color = EXCLUDED.avatar_color`)
    for (const [table, col] of [
      ['sessions', 'user_id'],
      ['devices', 'user_id'],
      ['jobs', 'user_id'],
      ['projects', 'created_by'],
      ['assets', 'created_by'],
      ['workspaces', 'created_by'],
      ['invites', 'created_by'],
      ['exports', 'created_by'],
      ['share_links', 'created_by'],
    ] as const) {
      await tx.execute(sql.raw(`UPDATE ${table} SET ${col} = '${cloud.id.replace(/'/g, "''")}' WHERE ${col} = '${oldId.replace(/'/g, "''")}'`))
    }
    // memberships: move, skipping workspaces the cloud user already belongs to locally
    await tx.execute(sql`UPDATE memberships SET user_id = ${cloud.id} WHERE user_id = ${oldId} AND workspace_id NOT IN (SELECT workspace_id FROM memberships WHERE user_id = ${cloud.id})`)
    await tx.execute(sql`DELETE FROM users WHERE id = ${oldId}`)
  })
  await kvSet('localUserId', cloud.id)
  cachedId = cloud.id
  log.info('desktop: adopted cloud identity', { from: oldId, to: cloud.id })
}
