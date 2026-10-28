import { Hono } from 'hono'
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm'
import * as z from 'zod/v4'
import { FONTS, INVITE_TTL_MS, type BrandKitDoc, type InviteInfo, type InviteStatus, type Member, type PendingInvite, type Role, type Workspace } from '@producer/core'
import { type AppEnv, requireUser } from '../auth'
import { ctx } from '../context'
import { activity, brandKits, comments, exportsTable, invites, jobs, memberships, projects, shareLinks, users, workspaces } from '../db/schema'
import { recordActivity } from '../services/activity'
import { HttpError, body, memberRole, notFound, requireRole, roleAtLeast } from '../http'
import { newId, randomToken } from '../ids'
import { jobsDeleted } from '../jobs/queue'
import { checkIfMatch, etagOf, setEtag } from '../etag'

export async function createWorkspace(userId: string, name: string, personal = false): Promise<Workspace> {
  const id = newId('ws')
  const now = Date.now()
  const db = ctx().db
  await db.insert(workspaces).values({ id, name, personal, createdBy: userId, createdAt: now })
  await db.insert(memberships).values({ workspaceId: id, userId, role: 'owner', createdAt: now })
  // a new space starts with a sample project to open (A-6)
  const { addSampleProject } = await import('../services/onboarding')
  await addSampleProject(id, userId)
  return { id, name, role: 'owner', personal, memberCount: 1, etag: etagOf({ name }) }
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
    .map((r) => ({ id: r.w.id, name: r.w.name, role: r.role as Role, personal: r.w.personal, memberCount: byWs.get(r.w.id) ?? 1, etag: etagOf({ name: r.w.name }) }))
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
 * and AI settings/keys cascade; jobs, exports, share links, comments and activity have no FK so they go explicitly. A running job is
 * stopped (here at once, on another worker at its next heartbeat, when it finds its row gone), and whatever it
 * writes to storage after this is swept when it ends. Membership deletes write tombstones so members' desktops drop
 * the space too.
 */
export async function deleteWorkspace(userId: string, id: string): Promise<void> {
  await requireRole(userId, id, 'owner')
  const db = ctx().db
  const ws = (await db.select().from(workspaces).where(eq(workspaces.id, id)).limit(1))[0]
  if (!ws) throw notFound()
  if (ws.personal) throw new HttpError(409, 'conflict', 'Personal spaces can’t be deleted')
  const removed = await db.transaction(async (tx) => {
    await tx.delete(shareLinks).where(inArray(shareLinks.projectId, tx.select({ id: projects.id }).from(projects).where(eq(projects.workspaceId, id))))
    await tx.delete(exportsTable).where(eq(exportsTable.workspaceId, id))
    await tx.delete(comments).where(eq(comments.workspaceId, id))
    await tx.delete(activity).where(eq(activity.workspaceId, id))
    const gone = await tx.delete(jobs).where(eq(jobs.workspaceId, id)).returning({ id: jobs.id })
    await tx.delete(workspaces).where(eq(workspaces.id, id))
    return gone
  })
  jobsDeleted(removed.map((j) => j.id))
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
export const BrandSchema = z.object({
  name: z.string().trim().min(1).max(80),
  colors: z.array(hex).max(12),
  fonts: z.object({ headline: z.string().min(1).max(60), body: z.string().min(1).max(60) }),
  logoAssetId: z.string().max(80).optional(),
  captionPreset: z.string().max(40).optional(),
  voice: z.string().max(80).optional(),
  customFonts: z.array(z.string().max(60)).max(4).optional(),
})

/** Save the space's default kit (fonts: bundled or uploaded to the space, see services/brand.ts). */
export async function saveDefaultKit(workspaceId: string, raw: BrandKitDoc): Promise<BrandKitDoc> {
  const { checkKitDoc } = await import('../services/brand')
  const doc = await checkKitDoc(workspaceId, raw)
  const now = Date.now()
  await ctx()
    .db.insert(brandKits)
    .values({ workspaceId, doc, updatedAt: now })
    .onConflictDoUpdate({ target: brandKits.workspaceId, set: { doc, updatedAt: now } })
  // open Brand kit pages and editors reload it
  const ev = { id: workspaceId, deleted: false, brand: true }
  ctx().bus.publish(workspaceId, 'workspace', ev, { id: workspaceId, inline: ev })
  return doc
}

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
  const cur = (await ctx().db.select({ name: workspaces.name }).from(workspaces).where(eq(workspaces.id, c.req.param('id'))).limit(1))[0]
  if (cur) checkIfMatch(c, { name: cur.name }, 'This space')
  const ws = await renameWorkspace(u.id, c.req.param('id'), b.name)
  if (ws.etag) c.header('ETag', ws.etag)
  return c.json(ws)
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

/** Tell everyone's open screens (and the person affected) that the member list changed. */
function membersChanged(workspaceId: string) {
  ctx().bus.publish(workspaceId, 'workspace', { id: workspaceId, deleted: false, members: true }, { id: workspaceId, inline: { id: workspaceId, deleted: false, members: true } })
}

async function ownerCount(workspaceId: string): Promise<number> {
  const [r] = await ctx()
    .db.select({ n: sql<number>`count(*)::int` })
    .from(memberships)
    .where(and(eq(memberships.workspaceId, workspaceId), eq(memberships.role, 'owner')))
  return Number(r?.n ?? 0)
}

/** Change a member's role (owner). A space always keeps at least one owner. */
workspaceRoutes.patch('/:id/members/:userId', async (c) => {
  const u = requireUser(c)
  const id = c.req.param('id')
  const target = c.req.param('userId')
  await requireRole(u.id, id, 'owner')
  const b = await body(c, z.object({ role: z.enum(['owner', 'editor', 'viewer']) }))
  const current = await memberRole(target, id)
  if (!current) throw notFound('This person is not a member of the space')
  if (current === 'owner' && b.role !== 'owner' && (await ownerCount(id)) <= 1)
    throw new HttpError(409, 'conflict', 'A space needs at least one owner. Make someone else an owner first.')
  await ctx().db.update(memberships).set({ role: b.role }).where(and(eq(memberships.workspaceId, id), eq(memberships.userId, target)))
  membersChanged(id)
  if (current !== b.role) await recordActivity({ workspaceId: id, actorId: u.id, kind: 'member.role', data: { member: await userName(target), role: b.role } })
  return c.json({ ok: true, role: b.role })
})

/**
 * Remove a member (owner), or leave (anyone, for themselves). The last owner can't go; a personal space is its
 * owner's for good. Their pending invites to this space are withdrawn too, so an old link can't bring them back.
 */
workspaceRoutes.delete('/:id/members/:userId', async (c) => {
  const u = requireUser(c)
  const id = c.req.param('id')
  const target = c.req.param('userId')
  const self = target === u.id
  await requireRole(u.id, id, self ? 'viewer' : 'owner')
  const current = await memberRole(target, id)
  if (!current) throw notFound('This person is not a member of the space')
  const ws = (await ctx().db.select().from(workspaces).where(eq(workspaces.id, id)).limit(1))[0]
  if (ws?.personal && ws.createdBy === target) throw new HttpError(409, 'conflict', 'This is their personal space; it can’t be left.')
  if (current === 'owner' && (await ownerCount(id)) <= 1)
    throw new HttpError(409, 'conflict', self ? 'You’re the only owner. Make someone else an owner before you leave.' : 'A space needs at least one owner.')
  const email = (await ctx().db.select({ email: users.email }).from(users).where(eq(users.id, target)).limit(1))[0]?.email
  await ctx().db.transaction(async (tx) => {
    await tx.delete(memberships).where(and(eq(memberships.workspaceId, id), eq(memberships.userId, target)))
    if (email)
      await tx
        .update(invites)
        .set({ revokedAt: Date.now() })
        .where(and(eq(invites.workspaceId, id), eq(invites.email, email.toLowerCase()), isNull(invites.acceptedAt), isNull(invites.revokedAt)))
  })
  membersChanged(id)
  await recordActivity(self ? { workspaceId: id, actorId: u.id, kind: 'member.left' } : { workspaceId: id, actorId: u.id, kind: 'member.removed', data: { member: await userName(target) } })
  return c.json({ ok: true })
})

const inviteUrl = (token: string) => `${ctx().config.publicUrl ?? ''}/invite/${token}`

type InviteRow = typeof invites.$inferSelect

/** Rows made before v7 have no expires_at: they count 7 days from creation. */
const inviteExpiry = (inv: InviteRow) => inv.expiresAt ?? inv.createdAt + INVITE_TTL_MS

function inviteStatus(inv: InviteRow, now = Date.now()): InviteStatus {
  if (inv.acceptedAt) return 'accepted'
  if (inv.revokedAt) return 'revoked'
  if (inviteExpiry(inv) <= now) return 'expired'
  return 'pending'
}

workspaceRoutes.post('/:id/invites', async (c) => {
  const u = requireUser(c)
  const id = c.req.param('id')
  await requireRole(u.id, id, 'owner')
  const b = await body(c, z.object({ email: z.string().trim().email().max(254), role: z.enum(['owner', 'editor', 'viewer']).default('editor') }))
  const token = randomToken(24)
  const now = Date.now()
  const expiresAt = now + INVITE_TTL_MS
  await ctx().db.insert(invites).values({ token, workspaceId: id, email: b.email.toLowerCase(), role: b.role, createdBy: u.id, createdAt: now, expiresAt })
  return c.json({ ok: true, inviteUrl: inviteUrl(token), expiresAt })
})

workspaceRoutes.get('/:id/invites', async (c) => {
  const u = requireUser(c)
  const id = c.req.param('id')
  await requireRole(u.id, id, 'owner')
  const rows = await ctx().db.select().from(invites).where(eq(invites.workspaceId, id)).orderBy(desc(invites.createdAt)).limit(200)
  const now = Date.now()
  const list: PendingInvite[] = rows
    .filter((r) => inviteStatus(r, now) === 'pending')
    .map((r) => ({ token: r.token, email: r.email, role: r.role as Role, createdAt: r.createdAt, expiresAt: inviteExpiry(r), inviteUrl: inviteUrl(r.token) }))
  return c.json(list)
})

workspaceRoutes.delete('/:id/invites/:token', async (c) => {
  const u = requireUser(c)
  const id = c.req.param('id')
  await requireRole(u.id, id, 'owner')
  const rows = await ctx()
    .db.update(invites)
    .set({ revokedAt: Date.now() })
    .where(and(eq(invites.token, c.req.param('token')), eq(invites.workspaceId, id), isNull(invites.acceptedAt)))
    .returning({ token: invites.token })
  if (!rows.length) throw notFound('Invite not found, or it was already used')
  return c.json({ ok: true })
})

workspaceRoutes.get('/:id/brand', async (c) => {
  const u = requireUser(c)
  const id = c.req.param('id')
  await requireRole(u.id, id, 'viewer')
  const doc = await getBrand(id)
  setEtag(c, doc)
  return c.json(doc)
})

workspaceRoutes.put('/:id/brand', async (c) => {
  const u = requireUser(c)
  const id = c.req.param('id')
  await requireRole(u.id, id, 'editor')
  const raw = (await body(c, BrandSchema)) as BrandKitDoc
  checkIfMatch(c, await getBrand(id), 'The brand kit')
  const doc = await saveDefaultKit(id, raw)
  setEtag(c, doc)
  return c.json(doc)
})

// ---- invites (mounted at /api/invites) ----
export const inviteRoutes = new Hono<AppEnv>()

async function loadInvite(token: string): Promise<InviteRow> {
  const inv = (await ctx().db.select().from(invites).where(eq(invites.token, token)).limit(1))[0]
  if (!inv) throw notFound('Invite not found')
  return inv
}

inviteRoutes.get('/:token', async (c) => {
  const u = requireUser(c)
  const inv = await loadInvite(c.req.param('token'))
  const ws = (await ctx().db.select().from(workspaces).where(eq(workspaces.id, inv.workspaceId)).limit(1))[0]
  const info: InviteInfo = {
    workspaceId: inv.workspaceId,
    workspaceName: ws?.name ?? '',
    role: inv.role as Role,
    email: inv.email,
    status: inviteStatus(inv),
    expiresAt: inviteExpiry(inv),
    ...(inv.acceptedAt ? { acceptedAt: inv.acceptedAt } : {}),
    forYou: u.email.toLowerCase() === inv.email.toLowerCase(),
    member: (await memberRole(u.id, inv.workspaceId)) !== null,
  }
  return c.json(info)
})

/**
 * Accept: only the account the invite was sent to, only once, only while it's live. The claim is one conditional
 * UPDATE, so two people racing on one link can't both join. An existing member keeps their role unless the
 * invite raises it.
 */
inviteRoutes.post('/:token/accept', async (c) => {
  const u = requireUser(c)
  const db = ctx().db
  const inv = await loadInvite(c.req.param('token'))
  if (u.email.toLowerCase() !== inv.email.toLowerCase())
    throw new HttpError(403, 'forbidden', `This invite is for ${inv.email}. Sign in with that address to accept it.`)
  const status = inviteStatus(inv)
  if (status === 'accepted') {
    if (inv.acceptedBy === u.id) return c.json((await listWorkspaces(u.id)).find((w) => w.id === inv.workspaceId))
    throw new HttpError(409, 'conflict', 'This invite has already been used')
  }
  if (status === 'revoked') throw new HttpError(410, 'conflict', 'This invite was withdrawn by an owner of the space')
  if (status === 'expired') throw new HttpError(410, 'conflict', 'This invite has expired. Ask an owner of the space for a new one.')
  const now = Date.now()
  await db.transaction(async (tx) => {
    const claimed = await tx
      .update(invites)
      .set({ acceptedAt: now, acceptedBy: u.id })
      .where(and(eq(invites.token, inv.token), isNull(invites.acceptedAt), isNull(invites.revokedAt)))
      .returning({ token: invites.token })
    if (!claimed.length) throw new HttpError(409, 'conflict', 'This invite has already been used')
    const existing = (await tx.select().from(memberships).where(and(eq(memberships.workspaceId, inv.workspaceId), eq(memberships.userId, u.id))).limit(1))[0]
    if (!existing) await tx.insert(memberships).values({ workspaceId: inv.workspaceId, userId: u.id, role: inv.role, createdAt: now })
    else if (!roleAtLeast(existing.role as Role, inv.role as Role))
      await tx.update(memberships).set({ role: inv.role }).where(and(eq(memberships.workspaceId, inv.workspaceId), eq(memberships.userId, u.id)))
  })
  await recordActivity({ workspaceId: inv.workspaceId, actorId: u.id, kind: 'member.joined', data: { role: inv.role } })
  const ws = (await listWorkspaces(u.id)).find((w) => w.id === inv.workspaceId)
  return c.json(ws)
})

const userName = async (id: string) => (await ctx().db.select({ name: users.name }).from(users).where(eq(users.id, id)).limit(1))[0]?.name ?? 'someone'
