import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import { and, eq, gt, inArray } from 'drizzle-orm'
import type { JobKind } from '@producer/core'
import { requireProvider } from '../ai/provider'
import { type AppEnv, requireUser } from '../auth'
import { ctx } from '../context'
import { devices, jobs, projects, sessions } from '../db/schema'
import { jobDto } from '../dto'
import { HttpError, invalid, memberRole, notFound, requireRole, roleAtLeast } from '../http'
import { describeQueue } from '../jobs/queue-info'
import { cancelJob, enqueue, getJob } from '../jobs/queue'
import { QUEUED_KINDS, assertQueueRoom, limitAi } from '../limits'
import { afterCursor, pageOrder, pageQuery, toPage } from '../paging'

export const jobRoutes = new Hono<AppEnv>()

jobRoutes.get('/', async (c) => {
  const u = requireUser(c)
  const projectId = c.req.query('projectId')
  let workspaceId = c.req.query('workspaceId')
  if (!projectId && !workspaceId) throw invalid('projectId or workspaceId is required')
  if (projectId && !workspaceId) {
    const { loadProjectRow } = await import('../services/projects')
    workspaceId = (await loadProjectRow(projectId)).workspaceId
  }
  await requireRole(u.id, workspaceId!, 'viewer')
  const { limit, after } = pageQuery(c)
  const conds = [eq(jobs.workspaceId, workspaceId!)]
  if (projectId) conds.push(eq(jobs.projectId, projectId))
  const from = afterCursor(jobs.createdAt, jobs.id, after)
  if (from) conds.push(from)
  const rows = await ctx()
    .db.select()
    .from(jobs)
    .where(and(...conds))
    .orderBy(...pageOrder(jobs.createdAt, jobs.id))
    .limit(limit + 1)
  return c.json(toPage(rows, limit, (r) => [r.createdAt, r.id], jobDto))
})

/** A-9: where the space's queued jobs stand: place in line, estimated wait, and why they wait. */
jobRoutes.get('/queue', async (c) => {
  const u = requireUser(c)
  const workspaceId = c.req.query('workspaceId')
  if (!workspaceId) throw invalid('workspaceId is required')
  await requireRole(u.id, workspaceId, 'viewer')
  return c.json({ jobs: await describeQueue(workspaceId) })
})

const FINISHED = ['done', 'error', 'cancelled'] as const

/** The job history (A-8): finished, failed and cancelled jobs of the space, newest first. */
jobRoutes.get('/history', async (c) => {
  const u = requireUser(c)
  const workspaceId = c.req.query('workspaceId')
  if (!workspaceId) throw invalid('workspaceId is required')
  await requireRole(u.id, workspaceId, 'viewer')
  const status = c.req.query('status')
  if (status && !(FINISHED as readonly string[]).includes(status)) throw invalid('status must be done, error or cancelled')
  const { limit, after } = pageQuery(c)
  const conds = [eq(jobs.workspaceId, workspaceId), status ? eq(jobs.status, status) : inArray(jobs.status, [...FINISHED])]
  const projectId = c.req.query('projectId')
  if (projectId) conds.push(eq(jobs.projectId, projectId))
  // newest first by when it ended: history pages by updated time
  const from = afterCursor(jobs.updatedAt, jobs.id, after)
  if (from) conds.push(from)
  const rows = await ctx()
    .db.select()
    .from(jobs)
    .where(and(...conds))
    .orderBy(...pageOrder(jobs.updatedAt, jobs.id))
    .limit(limit + 1)
  // big results (transcripts, scripts) aren't needed in a list
  return c.json(toPage(rows, limit, (r) => [r.updatedAt, r.id], (r) => ({ ...jobDto(r), result: undefined })))
})

/** Retry (A-8): the same work queued again as a new job, by an editor, under the same limits as starting it by hand. */
jobRoutes.post('/:id/retry', async (c) => {
  const u = requireUser(c)
  const j = await getJob(c.req.param('id'))
  if (!j) throw notFound('Job not found')
  await requireRole(u.id, j.workspaceId, 'editor')
  if (j.status !== 'error' && j.status !== 'cancelled') throw new HttpError(409, 'conflict', 'Only a failed or cancelled job can be retried.')
  if (j.kind === 'asset.process') throw new HttpError(409, 'conflict', 'Retry this clip from the Library: its Retry button checks the file first.', { assetId: (j.input as { assetId?: string }).assetId })
  if (j.kind.startsWith('voicestudio.')) throw new HttpError(409, 'conflict', 'Run this again from Voice Studio on the desktop.')
  if (j.projectId) {
    const p = await ctx().db.select({ id: projects.id }).from(projects).where(eq(projects.id, j.projectId)).limit(1)
    if (!p.length) throw new HttpError(409, 'conflict', 'The project this job belonged to was deleted.')
  }
  if (QUEUED_KINDS.includes(j.kind as JobKind)) await assertQueueRoom(j.workspaceId)
  if (j.kind === 'ai.produce.script') {
    await requireProvider(j.workspaceId, 'script')
    await limitAi(u.id, j.workspaceId)
  }
  const row = await enqueue(j.kind as JobKind, j.input, { workspaceId: j.workspaceId, userId: u.id, projectId: j.projectId, message: 'Queued again' })
  return c.json(jobDto(row))
})

jobRoutes.get('/:id', async (c) => {
  const u = requireUser(c)
  const j = await getJob(c.req.param('id'))
  if (!j) throw notFound('Job not found')
  await requireRole(u.id, j.workspaceId, 'viewer')
  return c.json(jobDto(j))
})

jobRoutes.post('/:id/cancel', async (c) => {
  const u = requireUser(c)
  const j = await getJob(c.req.param('id'))
  if (!j) throw notFound('Job not found')
  await requireRole(u.id, j.workspaceId, 'editor')
  const r = await cancelJob(j.id)
  return c.json(jobDto(r ?? j))
})

export const eventRoutes = new Hono<AppEnv>()

/** Live-update streams per user (tabs, desktops); more than this is a leak or abuse, not use. */
const MAX_STREAMS_PER_USER = 20
/** Events waiting for a reader that has stopped reading; past this the stream is dropped (the client reconnects). */
const MAX_QUEUED_EVENTS = 2000
/** How often an open stream re-checks that its reader may still see the workspace. */
const RECHECK_MS = 20_000
const openStreams = new Map<string, number>()

/**
 * A workspace's live updates (SSE). Every event has an id; reconnecting with the last one (the browser's
 * Last-Event-ID header, or `?lastEventId=`) first sends what was missed, or a `resync` event when that can't be told
 * so the screen reloads. Then `ready`, whose id is the position to resume from even when nothing else has come. The
 * stream closes when its reader loses access: removed from the space, role lowered, signed out, device revoked.
 */
eventRoutes.get('/', async (c) => {
  const u = requireUser(c)
  const workspaceId = c.req.query('workspaceId')
  if (!workspaceId) throw invalid('workspaceId is required')
  const openedAs = await requireRole(u.id, workspaceId, 'viewer')
  const lastId = c.req.header('last-event-id') || c.req.query('lastEventId') || undefined
  if ((openStreams.get(u.id) ?? 0) >= MAX_STREAMS_PER_USER) throw new HttpError(429, 'quota', 'Too many open live-update connections. Close some tabs.')
  const sessionId = c.get('sessionId')
  const deviceId = c.get('deviceId')
  const db = ctx().db
  /** Still a member with the role the stream opened with (or more), and the session or device token that opened it still exists. */
  const stillAllowed = async () => {
    const role = await memberRole(u.id, workspaceId)
    if (!role || !roleAtLeast(role, openedAs)) return false
    if (sessionId) return (await db.select({ id: sessions.id }).from(sessions).where(and(eq(sessions.id, sessionId), gt(sessions.expiresAt, Date.now()))).limit(1)).length > 0
    if (deviceId) return (await db.select({ id: devices.id }).from(devices).where(eq(devices.id, deviceId)).limit(1)).length > 0
    return true
  }
  c.header('X-Accel-Buffering', 'no')
  c.header('Cache-Control', 'no-cache, no-transform')
  return streamSSE(c, async (stream) => {
    openStreams.set(u.id, (openStreams.get(u.id) ?? 0) + 1)
    const queue: Array<{ event: string; data: string; id?: string }> = []
    let wake: (() => void) | undefined
    let closed = false
    let recheck = false
    const close = () => {
      closed = true
      wake?.()
    }
    const unsub = ctx().bus.subscribe(workspaceId, (e) => {
      // membership changes and deletes arrive as workspace events: re-check access as soon as it's sent
      if (e.event === 'workspace') recheck = true
      if (queue.length >= MAX_QUEUED_EVENTS) return close()
      queue.push({ event: e.event, data: JSON.stringify(e.data), id: e.id })
      wake?.()
    })
    // in the same tick as subscribing: nothing published in between is missed or sent twice
    const missed = lastId ? ctx().bus.replay(workspaceId, lastId) : []
    const cursor = ctx().bus.cursor()
    const unsubAccess = ctx().bus.onAccessChanged(u.id, () => {
      recheck = true
      wake?.()
    })
    stream.onAbort(close)
    await stream.write(': connected\n\n')
    if (missed === null) await stream.writeSSE({ event: 'resync', data: '{}', id: cursor })
    else for (const e of missed) await stream.writeSSE({ event: e.event, data: JSON.stringify(e.data), id: e.id })
    await stream.writeSSE({ event: 'ready', data: '{}', id: cursor })
    const ka = setInterval(() => {
      void stream.write(': keepalive\n\n').catch(() => undefined)
      recheck = true
      wake?.()
    }, RECHECK_MS)
    try {
      while (!closed) {
        // send first, then check: someone just removed still gets the workspace event that makes their app move on
        while (queue.length && !closed) {
          const m = queue.shift()!
          await stream.writeSSE({ event: m.event, data: m.data, id: m.id })
        }
        if (recheck) {
          recheck = false
          if (!(await stillAllowed())) break
        }
        if (closed || recheck || queue.length) continue
        await new Promise<void>((r) => {
          wake = r
        })
        wake = undefined
      }
    } finally {
      clearInterval(ka)
      unsub()
      unsubAccess()
      const n = (openStreams.get(u.id) ?? 1) - 1
      if (n > 0) openStreams.set(u.id, n)
      else openStreams.delete(u.id)
    }
  })
})
