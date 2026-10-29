// Operator tools (P-10), mounted at /api/operator: support without database access. Find a person, disable or enable
// them, send a reset; inspect, requeue or cancel any job; storage per space; orphaned storage. Only operators
// (OPERATOR_EMAILS) get past requireOperator, and everyone else gets 404. Every action is written to the audit log.
// Routes are listed in packages/core/src/operations.ts.
import { Hono } from 'hono'
import { type SQL, and, count, desc, eq, gt, ilike, inArray, max, or, sql, sum } from 'drizzle-orm'
import * as z from 'zod/v4'
import type { OperatorJob, OperatorUser, OperatorUserDetail, StorageUsageRow } from '@producer/core'
import { type AppEnv, appUrl, clientIp, endSessions } from '../auth'
import { ctx } from '../context'
import { assets, auditLog, devices, jobs, memberships, sessions, users, workspaces } from '../db/schema'
import { HttpError, body, invalid, notFound } from '../http'
import { cancelJob, getJob, requeueJob } from '../jobs/queue'
import { mailEnabled, sendMail } from '../mail'
import { resetMail } from '../mail/messages'
import { afterCursor, pageOrder, pageQuery, toPage } from '../paging'
import { issueToken } from '../services/account'
import { audit, listAudit } from '../services/audit'
import { requireOperator } from '../services/operator'
import { dryRunOrphans, removeOrphans } from '../services/orphans'

export const operatorRoutes = new Hono<AppEnv>()

// everything here is the operator's: the check runs before any route (an unknown path is a 404 either way)
operatorRoutes.use('*', async (c, next) => {
  requireOperator(c)
  await next()
})

type UserRow = typeof users.$inferSelect
const like = (q: string) => `%${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`

async function describeUsers(rows: UserRow[]): Promise<OperatorUser[]> {
  if (!rows.length) return []
  const ids = rows.map((r) => r.id)
  const db = ctx().db
  const now = Date.now()
  const [spaces, live, devs, signins] = await Promise.all([
    db.select({ id: memberships.userId, n: count() }).from(memberships).where(inArray(memberships.userId, ids)).groupBy(memberships.userId),
    db.select({ id: sessions.userId, n: count() }).from(sessions).where(and(inArray(sessions.userId, ids), gt(sessions.expiresAt, now))).groupBy(sessions.userId),
    db.select({ id: devices.userId, n: count() }).from(devices).where(inArray(devices.userId, ids)).groupBy(devices.userId),
    db.select({ id: auditLog.actorId, at: max(auditLog.at) }).from(auditLog).where(and(eq(auditLog.kind, 'signin.ok'), inArray(auditLog.actorId, ids))).groupBy(auditLog.actorId),
  ])
  const by = <T extends { id: string | null }>(xs: T[]) => new Map(xs.map((x) => [x.id, x]))
  const [s, l, d, si] = [by(spaces), by(live), by(devs), by(signins)]
  return rows.map((u) => ({
    id: u.id,
    email: u.email,
    name: u.name,
    createdAt: u.createdAt,
    emailVerified: u.emailVerifiedAt != null,
    ...(u.disabledAt ? { disabledAt: u.disabledAt } : {}),
    spaces: Number(s.get(u.id)?.n ?? 0),
    sessions: Number(l.get(u.id)?.n ?? 0),
    devices: Number(d.get(u.id)?.n ?? 0),
    ...(si.get(u.id)?.at != null ? { lastSignInAt: Number(si.get(u.id)!.at) } : {}),
  }))
}

async function loadUser(id: string): Promise<UserRow> {
  const u = (await ctx().db.select().from(users).where(eq(users.id, id)).limit(1))[0]
  if (!u) throw notFound('No such account')
  return u
}

async function userDetail(u: UserRow): Promise<OperatorUserDetail> {
  const db = ctx().db
  const [summary] = await describeUsers([u])
  const spaces = await db
    .select({ id: workspaces.id, name: workspaces.name, personal: workspaces.personal, role: memberships.role })
    .from(memberships)
    .innerJoin(workspaces, eq(workspaces.id, memberships.workspaceId))
    .where(eq(memberships.userId, u.id))
    .orderBy(workspaces.name)
  const devs = await db.select().from(devices).where(eq(devices.userId, u.id)).orderBy(desc(devices.createdAt))
  const recent = await listAudit({ userId: u.id, limit: 20 })
  return {
    ...summary,
    memberships: spaces.map((w) => ({ workspaceId: w.id, name: w.name, role: w.role, personal: w.personal })),
    deviceList: devs.map((x) => ({ id: x.id, name: x.name, createdAt: x.createdAt, ...(x.lastSeenAt ? { lastSeenAt: x.lastSeenAt } : {}) })),
    recent: recent.items,
  }
}

// ---- people ----

operatorRoutes.get('/users', async (c) => {
  const q = (c.req.query('q') ?? '').trim().slice(0, 200)
  const where = q ? or(ilike(users.email, like(q)), ilike(users.name, like(q)), eq(users.id, q)) : undefined
  const rows = await ctx().db.select().from(users).where(where).orderBy(desc(users.createdAt)).limit(50)
  return c.json(await describeUsers(rows))
})

operatorRoutes.get('/users/:id', async (c) => c.json(await userDetail(await loadUser(c.req.param('id')))))

/** Disable: they can't sign in, and every session and app link of theirs ends now. */
operatorRoutes.post('/users/:id/disable', async (c) => {
  const op = requireOperator(c)
  const b = await body(c, z.object({ reason: z.string().trim().max(500).optional() }))
  const u = await loadUser(c.req.param('id'))
  if (u.id === op.id) throw new HttpError(409, 'conflict', 'You can’t disable your own account.')
  if (!u.disabledAt) await ctx().db.update(users).set({ disabledAt: Date.now() }).where(eq(users.id, u.id))
  const ended = await endSessions(u.id, { devices: true })
  await audit(c, { kind: 'operator.user.disabled', targetId: u.id, target: u.email, data: { ...(b.reason ? { reason: b.reason } : {}), ...ended } })
  return c.json(await userDetail(await loadUser(u.id)))
})

operatorRoutes.post('/users/:id/enable', async (c) => {
  const u = await loadUser(c.req.param('id'))
  if (u.disabledAt) await ctx().db.update(users).set({ disabledAt: null }).where(eq(users.id, u.id))
  await audit(c, { kind: 'operator.user.enabled', targetId: u.id, target: u.email })
  return c.json(await userDetail(await loadUser(u.id)))
})

/**
 * A password reset for someone who can't get in: mailed to them (mail on), or a one-time link the operator passes on
 * by another channel (it's shown once and never stored; the audit log records only that one was made).
 */
operatorRoutes.post('/users/:id/reset', async (c) => {
  const b = await body(c, z.object({ mode: z.enum(['mail', 'link']) }))
  const u = await loadUser(c.req.param('id'))
  if (u.disabledAt) throw new HttpError(409, 'conflict', 'This account is disabled. Enable it before sending a reset.')
  if (b.mode === 'mail' && !mailEnabled()) throw new HttpError(409, 'conflict', 'This server sends no mail. Make a one-time link instead.')
  const token = await issueToken(u.id, 'reset', u.email, clientIp(c))
  if (!token) throw new HttpError(429, 'quota', 'This account was sent three resets in the last hour. Try again later.')
  const url = appUrl(c, `/reset/${token}`)
  if (b.mode === 'mail') {
    const emailed = await sendMail(resetMail({ to: u.email, name: u.name, url }))
    if (!emailed) throw new HttpError(502, 'server', 'The reset mail couldn’t be sent. Try again, or make a one-time link.')
    await audit(c, { kind: 'operator.reset.mailed', targetId: u.id, target: u.email })
    return c.json({ ok: true, mode: 'mail', emailed })
  }
  await audit(c, { kind: 'operator.reset.link', targetId: u.id, target: u.email })
  c.header('Cache-Control', 'no-store')
  return c.json({ ok: true, mode: 'link', url })
})

// ---- jobs ----

function operatorJob(j: typeof jobs.$inferSelect, workspaceName?: string, full = false): OperatorJob {
  return {
    id: j.id,
    kind: j.kind,
    status: j.status,
    progress: j.progress,
    message: j.message,
    workspaceId: j.workspaceId,
    ...(workspaceName ? { workspaceName } : {}),
    userId: j.userId,
    ...(j.projectId ? { projectId: j.projectId } : {}),
    attempts: j.attempts,
    ...(j.error ? { error: j.error } : {}),
    ...(j.errorDetail ? { errorDetail: j.errorDetail } : {}),
    ...(j.lockedBy ? { lockedBy: j.lockedBy } : {}),
    createdAt: j.createdAt,
    ...(j.startedAt != null ? { startedAt: j.startedAt } : {}),
    updatedAt: j.updatedAt,
    ...(j.waitMs != null ? { waitMs: j.waitMs } : {}),
    ...(j.runMs != null ? { runMs: j.runMs } : {}),
    ...(j.peakRss != null ? { peakRssBytes: j.peakRss } : {}),
    ...(full ? { input: j.input } : {}),
  }
}

const STATUSES = ['queued', 'running', 'done', 'error', 'cancelled']

operatorRoutes.get('/jobs', async (c) => {
  const { limit, after } = pageQuery(c)
  const status = c.req.query('status')
  if (status && !STATUSES.includes(status)) throw invalid(`status must be one of ${STATUSES.join(', ')}`)
  const q = (c.req.query('q') ?? '').trim().slice(0, 200)
  const conds: Array<SQL | undefined> = [
    status ? eq(jobs.status, status) : undefined,
    c.req.query('kind') ? eq(jobs.kind, c.req.query('kind')!) : undefined,
    c.req.query('workspaceId') ? eq(jobs.workspaceId, c.req.query('workspaceId')!) : undefined,
    q ? or(eq(jobs.id, q), eq(jobs.userId, q), ilike(jobs.error, like(q)), ilike(jobs.errorDetail, like(q))) : undefined,
    afterCursor(jobs.createdAt, jobs.id, after),
  ]
  const rows = await ctx()
    .db.select({ j: jobs, ws: workspaces.name })
    .from(jobs)
    .leftJoin(workspaces, eq(workspaces.id, jobs.workspaceId))
    .where(and(...conds))
    .orderBy(...pageOrder(jobs.createdAt, jobs.id))
    .limit(limit + 1)
  return c.json(toPage(rows, limit, (r) => [r.j.createdAt, r.j.id], (r) => operatorJob(r.j, r.ws ?? undefined)))
})

async function jobWithSpace(id: string, full = true): Promise<OperatorJob> {
  const row = (await ctx().db.select({ j: jobs, ws: workspaces.name }).from(jobs).leftJoin(workspaces, eq(workspaces.id, jobs.workspaceId)).where(eq(jobs.id, id)).limit(1))[0]
  if (!row) throw notFound('Job not found')
  return operatorJob(row.j, row.ws ?? undefined, full)
}

operatorRoutes.get('/jobs/:id', async (c) => c.json(await jobWithSpace(c.req.param('id'))))

operatorRoutes.post('/jobs/:id/requeue', async (c) => {
  const j = await getJob(c.req.param('id'))
  if (!j) throw notFound('Job not found')
  if (j.kind === 'voice.relay') throw new HttpError(409, 'conflict', 'A relayed voice waits for its desktop. Ask the person to start it again.')
  if (j.status === 'queued') throw new HttpError(409, 'conflict', 'This job is already waiting in the queue.')
  if (j.status === 'done') throw new HttpError(409, 'conflict', 'This job finished. Start the work again from the app instead.')
  const row = await requeueJob(j.id)
  if (!row) throw new HttpError(409, 'conflict', 'The job changed meanwhile. Reload and look again.')
  await audit(c, { kind: 'operator.job.requeued', workspaceId: j.workspaceId, targetId: j.id, target: `${j.id} (${j.kind})`, data: { from: j.status, kind: j.kind } })
  return c.json(await jobWithSpace(j.id))
})

operatorRoutes.post('/jobs/:id/cancel', async (c) => {
  const j = await getJob(c.req.param('id'))
  if (!j) throw notFound('Job not found')
  if (j.status !== 'queued' && j.status !== 'running') throw new HttpError(409, 'conflict', 'This job has already ended.')
  await cancelJob(j.id, 'Cancelled by an operator')
  await audit(c, { kind: 'operator.job.cancelled', workspaceId: j.workspaceId, targetId: j.id, target: `${j.id} (${j.kind})`, data: { from: j.status, kind: j.kind } })
  return c.json(await jobWithSpace(j.id))
})

// ---- storage ----

/** Storage per space (the clips and exports it holds, as its quota counts them), largest first. */
operatorRoutes.get('/storage', async (c) => {
  const q = (c.req.query('q') ?? '').trim().slice(0, 200)
  const db = ctx().db
  const rows = await db
    .select({ id: workspaces.id, name: workspaces.name, personal: workspaces.personal, bytes: sql<number>`coalesce(${sum(assets.size)}, 0)`, files: count(assets.id) })
    .from(workspaces)
    .leftJoin(assets, eq(assets.workspaceId, workspaces.id))
    .where(q ? or(ilike(workspaces.name, like(q)), eq(workspaces.id, q)) : undefined)
    .groupBy(workspaces.id, workspaces.name, workspaces.personal)
    .orderBy(desc(sql`coalesce(${sum(assets.size)}, 0)`), workspaces.id)
    .limit(200)
  const owners = rows.length
    ? await db
        .select({ ws: memberships.workspaceId, email: users.email })
        .from(memberships)
        .innerJoin(users, eq(users.id, memberships.userId))
        .where(and(inArray(memberships.workspaceId, rows.map((r) => r.id)), eq(memberships.role, 'owner')))
    : []
  const ownerOf = new Map<string, string>()
  for (const o of owners) if (!ownerOf.has(o.ws)) ownerOf.set(o.ws, o.email)
  const out: StorageUsageRow[] = rows.map((r) => ({ workspaceId: r.id, name: r.name, personal: r.personal, ...(ownerOf.get(r.id) ? { owner: ownerOf.get(r.id) } : {}), bytes: Number(r.bytes), files: Number(r.files) }))
  return c.json(out)
})

/** Without scanId: a dry run (nothing removed). With the scanId of a dry run: remove what it listed. */
operatorRoutes.post('/storage/orphans', async (c) => {
  const op = requireOperator(c)
  const b = await body(c, z.object({ scanId: z.string().max(100).optional() }))
  if (!b.scanId) return c.json(await dryRunOrphans(op.id))
  const res = await removeOrphans(b.scanId, op.id)
  await audit(c, { kind: 'operator.storage.orphans', target: `${res.removed} objects`, data: { removed: res.removed, bytes: res.bytes, scanId: b.scanId } })
  return c.json(res)
})

// ---- the audit log ----

operatorRoutes.get('/audit', async (c) => {
  const kind = c.req.query('kind')
  return c.json(
    await listAudit({
      ...pageQuery(c),
      ...(c.req.query('workspaceId') ? { workspaceId: c.req.query('workspaceId') } : {}),
      ...(c.req.query('userId') ? { userId: c.req.query('userId') } : {}),
      ...(kind ? { kinds: [kind] } : {}),
      ...(c.req.query('q') ? { q: c.req.query('q')!.trim().slice(0, 200) } : {}),
    }),
  )
})
