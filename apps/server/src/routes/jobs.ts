import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import { and, desc, eq } from 'drizzle-orm'
import { type AppEnv, requireUser } from '../auth'
import { ctx } from '../context'
import { jobs } from '../db/schema'
import { jobDto } from '../dto'
import { invalid, notFound, requireRole } from '../http'
import { cancelJob, getJob } from '../jobs/queue'

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
  const conds = [eq(jobs.workspaceId, workspaceId!)]
  if (projectId) conds.push(eq(jobs.projectId, projectId))
  const rows = await ctx().db.select().from(jobs).where(and(...conds)).orderBy(desc(jobs.createdAt)).limit(100)
  return c.json(rows.map(jobDto))
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

eventRoutes.get('/', async (c) => {
  const u = requireUser(c)
  const workspaceId = c.req.query('workspaceId')
  if (!workspaceId) throw invalid('workspaceId is required')
  await requireRole(u.id, workspaceId, 'viewer')
  c.header('X-Accel-Buffering', 'no')
  c.header('Cache-Control', 'no-cache, no-transform')
  return streamSSE(c, async (stream) => {
    const queue: Array<{ event: string; data: string }> = []
    let wake: (() => void) | undefined
    const unsub = ctx().bus.subscribe(workspaceId, (e) => {
      queue.push({ event: e.event, data: JSON.stringify(e.data) })
      wake?.()
    })
    let closed = false
    stream.onAbort(() => {
      closed = true
      unsub()
      wake?.()
    })
    await stream.write(': connected\n\n')
    const ka = setInterval(() => {
      void stream.write(': keepalive\n\n').catch(() => undefined)
    }, 20_000)
    try {
      while (!closed) {
        while (queue.length) {
          const m = queue.shift()!
          await stream.writeSSE({ event: m.event, data: m.data })
        }
        await new Promise<void>((r) => {
          wake = r
        })
        wake = undefined
      }
    } finally {
      clearInterval(ka)
      unsub()
    }
  })
})
