import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import { and, eq, gt } from 'drizzle-orm'
import { type AppEnv, requireUser } from '../auth'
import { ctx } from '../context'
import { devices, jobs, sessions } from '../db/schema'
import { jobDto } from '../dto'
import { HttpError, invalid, memberRole, notFound, requireRole } from '../http'
import { cancelJob, getJob } from '../jobs/queue'
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

eventRoutes.get('/', async (c) => {
  const u = requireUser(c)
  const workspaceId = c.req.query('workspaceId')
  if (!workspaceId) throw invalid('workspaceId is required')
  await requireRole(u.id, workspaceId, 'viewer')
  if ((openStreams.get(u.id) ?? 0) >= MAX_STREAMS_PER_USER) throw new HttpError(429, 'quota', 'Too many open live-update connections. Close some tabs.')
  const sessionId = c.get('sessionId')
  const deviceId = c.get('deviceId')
  const db = ctx().db
  /** Still a member, and the session or device token that opened the stream still exists (not signed out or revoked). */
  const stillAllowed = async () => {
    if (!(await memberRole(u.id, workspaceId))) return false
    if (sessionId) return (await db.select({ id: sessions.id }).from(sessions).where(and(eq(sessions.id, sessionId), gt(sessions.expiresAt, Date.now()))).limit(1)).length > 0
    if (deviceId) return (await db.select({ id: devices.id }).from(devices).where(eq(devices.id, deviceId)).limit(1)).length > 0
    return true
  }
  c.header('X-Accel-Buffering', 'no')
  c.header('Cache-Control', 'no-cache, no-transform')
  return streamSSE(c, async (stream) => {
    openStreams.set(u.id, (openStreams.get(u.id) ?? 0) + 1)
    const queue: Array<{ event: string; data: string }> = []
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
      queue.push({ event: e.event, data: JSON.stringify(e.data) })
      wake?.()
    })
    stream.onAbort(close)
    await stream.write(': connected\n\n')
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
          await stream.writeSSE({ event: m.event, data: m.data })
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
      const n = (openStreams.get(u.id) ?? 1) - 1
      if (n > 0) openStreams.set(u.id, n)
      else openStreams.delete(u.id)
    }
  })
})
