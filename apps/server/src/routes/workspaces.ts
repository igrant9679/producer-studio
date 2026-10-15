import { Hono } from 'hono'
import { and, eq, inArray, sql } from 'drizzle-orm'
import * as z from 'zod/v4'
import { FONTS, type BrandKitDoc, type Member, type Role, type Workspace } from '@producer/core'
import { type AppEnv, requireUser } from '../auth'
import { ctx } from '../context'
import { brandKits, exportsTable, invites, jobs, memberships, projects, shareLinks, users, workspaces } from '../db/schema'
import { HttpError, body, notFound, requireRole } from '../http'
import { newId, randomToken } from '../ids'

export async function createWorkspace(userId: string, name: string, personal = false): Promise<Workspace> {
  const id = newId('ws')
  const now = Date.now()
  const db = ctx().db
  await db.insert(workspaces).values({ id, name, personal, createdBy: userId, createdAt: now })
  await db.insert(memberships).values({ workspaceId: id, userId, role: 'owner', createdAt: now })
  return { id, name, role: 'owner', personal, memberCount: 1 }
}

export async function listWorkspaces(userId: string): Promise<Workspace[]> {
  const db = ctx().db
  const rows = await db
    .select({ w: workspaces, role: memberships.role })
    .from(memberships)
    .innerJoin(workspaces, eq(workspaces.id, memberships.workspaceId))
    .where(eq(memberships.userId, userId))
    .orderBy(workspaces.createdAt)
  if (!rows.length) return []
  const counts = await db
    .select({ ws: memberships.workspaceId, n: sql<number>`count(*)::int` })
    .from(memberships)
    .where(inArray(memberships.workspaceId, rows.map((r) => r.w.id)))
    .groupBy(memberships.workspaceId)
  const byWs = new Map(counts.map((c) => [c.ws, Number(c.n)]))
  // personal workspace first
  return rows
    .map((r) => ({ id: r.w.id, name: r.w.name, role: r.role as Role, personal: r.w.personal, memberCount: byWs.get(r.w.id) ?? 1 }))
    .sort((a, b) => Number(b.personal) - Number(a.personal))
}

/** Rename a workspace (owner). The change_seq trigger republishes it to desktop replicas. */
export async function renameWorkspace(userId: string, id: string, name: string): Promise<Workspace> {
  await requireRole(userId, id, 'owner')
  await ctx().db.update(workspaces).set({ name }).where(eq(workspaces.id, id))
  const ws = (await listWorkspaces(userId)).find((w) => w.id === id)!
  ctx().bus.publish(id, 'workspace', { id, name, deleted: false }, { id, inline: { id, name, deleted: false } })
  return ws
}

/**
 * Permanently delete a workspace (owner; not a personal space). Projects, assets, memberships, invites, brand kit
 * and AI settings/keys cascade; jobs, exports and share links have no FK so they go explicitly (a running job sees
 * its row gone and stops). Membership deletes write tombstones so members' desktops drop the space too.
 */
export async function deleteWorkspace(userId: string, id: string): Promise<void> {
  await requireRole(userId, id, 'owner')
  const db = ctx().db
  const ws = (await db.select().from(workspaces).where(eq(workspaces.id, id)).limit(1))[0]
  if (!ws) throw notFound()
  if (ws.personal) throw new HttpError(409, 'conflict', 'Personal spaces can’t be deleted')
  await db.transaction(async (tx) => {
    await tx.delete(shareLinks).where(inArray(shareLinks.projectId, tx.select({ id: projects.id }).from(projects).where(eq(projects.workspaceId, id))))
    await tx.delete(exportsTable).where(eq(exportsTable.workspaceId, id))
    await tx.delete(jobs).where(eq(jobs.workspaceId, id))
    await tx.delete(workspaces).where(eq(workspaces.id, id))
  })
  await ctx().storage.deletePrefix(`ws/${id}/`).catch(() => undefined)
  ctx().bus.publish(id, 'workspace', { id, deleted: true }, { id, inline: { id, deleted: true } })
}

export function defaultBrand(name: string): BrandKitDoc {
  return { name, colors: ['#0b1830', '#ff5a5f', '#f3f5fa', '#35e0ff'], fonts: { headline: 'Montserrat', body: 'Inter' }, captionPreset: 'clean', voice: 'af_heart' }
}

export async function getBrand(workspaceId: string): Promise<BrandKitDoc> {
  const db = ctx().db
  const row = (await db.select().from(brandKits).where(eq(brandKits.workspaceId, workspaceId)).limit(1))[0]
  if (row) return row.doc
  const ws = (await db.select().from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1))[0]
  return defaultBrand(ws?.name ?? 'Brand')
}

const hex = z.string().regex(/^#[0-9a-fA-F]{3,8}$/, 'must be a hex colour')
const BrandSchema = z.object({
  name: z.string().trim().min(1).max(80),
  colors: z.array(hex).max(12),
  fonts: z.object({ headline: z.string().min(1).max(60), body: z.string().min(1).max(60) }),
  logoAssetId: z.string().max(80).optional(),
  captionPreset: z.string().max(40).optional(),
  voice: z.string().max(80).optional(),
})

export const workspaceRoutes = new Hono<AppEnv>()

workspaceRoutes.get('/', async (c) => c.json(await listWorkspaces(requireUser(c).id)))

workspaceRoutes.post('/', async (c) => {
  const u = requireUser(c)
  const b = await body(c, z.object({ name: z.string().trim().min(1).max(80) }))
  return c.json(await createWorkspace(u.id, b.name))
})

const NameSchema = z.object({ name: z.string().trim().min(1).max(80) })

workspaceRoutes.patch('/:id', async (c) => {
  const u = requireUser(c)
  const b = await body(c, NameSchema)
  return c.json(await renameWorkspace(u.id, c.req.param('id'), b.name))
})

workspaceRoutes.delete('/:id', async (c) => {
  const u = requireUser(c)
  await deleteWorkspace(u.id, c.req.param('id'))
  return c.json({ ok: true })
})

workspaceRoutes.get('/:id/members', async (c) => {
  const u = requireUser(c)
  const id = c.req.param('id')
  await requireRole(u.id, id, 'viewer')
  const rows = await ctx()
    .db.select({ userId: users.id, name: users.name, email: users.email, role: memberships.role })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(eq(memberships.workspaceId, id))
    .orderBy(memberships.createdAt)
  return c.json(rows as Member[])
})

workspaceRoutes.post('/:id/invites', async (c) => {
  const u = requireUser(c)
  const id = c.req.param('id')
  await requireRole(u.id, id, 'owner')
  const b = await body(c, z.object({ email: z.string().trim().email(), role: z.enum(['owner', 'editor', 'viewer']).default('editor') }))
  const token = randomToken(24)
  await ctx().db.insert(invites).values({ token, workspaceId: id, email: b.email.toLowerCase(), role: b.role, createdBy: u.id, createdAt: Date.now() })
  return c.json({ ok: true, inviteUrl: `${ctx().config.publicUrl ?? ''}/invite/${token}` })
})

workspaceRoutes.get('/:id/brand', async (c) => {
  const u = requireUser(c)
  const id = c.req.param('id')
  await requireRole(u.id, id, 'viewer')
  return c.json(await getBrand(id))
})

workspaceRoutes.put('/:id/brand', async (c) => {
  const u = requireUser(c)
  const id = c.req.param('id')
  await requireRole(u.id, id, 'editor')
  const doc = (await body(c, BrandSchema)) as BrandKitDoc
  const known = new Set<string>(FONTS)
  for (const f of [doc.fonts.headline, doc.fonts.body]) if (!known.has(f)) throw new HttpError(400, 'invalid', `Unknown font "${f}". Available: ${FONTS.join(', ')}`)
  const now = Date.now()
  await ctx()
    .db.insert(brandKits)
    .values({ workspaceId: id, doc, updatedAt: now })
    .onConflictDoUpdate({ target: brandKits.workspaceId, set: { doc, updatedAt: now } })
  return c.json(doc)
})

// ---- invites (mounted at /api/invites) ----
export const inviteRoutes = new Hono<AppEnv>()

inviteRoutes.get('/:token', async (c) => {
  requireUser(c)
  const inv = (await ctx().db.select().from(invites).where(eq(invites.token, c.req.param('token'))).limit(1))[0]
  if (!inv) throw notFound('Invite not found')
  const ws = (await ctx().db.select().from(workspaces).where(eq(workspaces.id, inv.workspaceId)).limit(1))[0]
  return c.json({ workspaceId: inv.workspaceId, workspaceName: ws?.name ?? '', role: inv.role, email: inv.email, accepted: inv.acceptedAt != null })
})

inviteRoutes.post('/:token/accept', async (c) => {
  const u = requireUser(c)
  const db = ctx().db
  const inv = (await db.select().from(invites).where(eq(invites.token, c.req.param('token'))).limit(1))[0]
  if (!inv) throw notFound('Invite not found')
  if (inv.acceptedAt && inv.acceptedBy !== u.id) throw new HttpError(409, 'conflict', 'This invite has already been used')
  const existing = await db
    .select()
    .from(memberships)
    .where(and(eq(memberships.workspaceId, inv.workspaceId), eq(memberships.userId, u.id)))
    .limit(1)
  if (!existing.length) await db.insert(memberships).values({ workspaceId: inv.workspaceId, userId: u.id, role: inv.role, createdAt: Date.now() })
  await db.update(invites).set({ acceptedAt: Date.now(), acceptedBy: u.id }).where(eq(invites.token, inv.token))
  const ws = (await listWorkspaces(u.id)).find((w) => w.id === inv.workspaceId)
  return c.json(ws)
})
