// Smooth slow motion (E-17): a job that makes a copy of a stretch of a clip's file with frames made in between.
import { Hono } from 'hono'
import * as z from 'zod/v4'
import { SMOOTH_MAX_FPS } from '@producer/core'
import { type AppEnv, requireUser } from '../auth'
import { jobDto } from '../dto'
import { HttpError, body, requireRole } from '../http'
import { enqueue } from '../jobs/queue'
import { assertQueueRoom } from '../limits'
import { loadAsset } from '../services/assets'
import { assertProjectInWorkspace } from '../services/projects'

/** Mounted at /api/assets. */
export const smoothRoutes = new Hono<AppEnv>()

/** The longest stretch one smooth copy covers (seconds): in-between frames take a while to make. */
export const SMOOTH_MAX_SECONDS = 120

smoothRoutes.post('/:id/smooth', async (c) => {
  const u = requireUser(c)
  const a = await loadAsset(c.req.param('id'))
  await requireRole(u.id, a.workspaceId, 'editor')
  const b = await body(c, z.object({ from: z.number().min(0).max(1e6), to: z.number().min(0).max(1e6), fps: z.number().min(2).max(SMOOTH_MAX_FPS), projectId: z.string().max(100).optional() }))
  if (a.kind !== 'video') throw new HttpError(400, 'invalid', 'Smooth slow motion works on video clips')
  if (a.status !== 'ready') throw new HttpError(409, 'conflict', 'This clip is still being processed')
  if (b.to <= b.from) throw new HttpError(400, 'invalid', 'The range must end after it starts')
  if (b.to - b.from > SMOOTH_MAX_SECONDS) throw new HttpError(400, 'invalid', `Smooth slow motion works on up to ${SMOOTH_MAX_SECONDS / 60} minutes of a clip at a time: split it first`)
  await assertProjectInWorkspace(b.projectId, a.workspaceId)
  await assertQueueRoom(a.workspaceId)
  const projectId = b.projectId ?? a.projectId
  const j = await enqueue('media.smooth', { assetId: a.id, workspaceId: a.workspaceId, projectId, from: b.from, to: b.to, fps: Math.round(b.fps) }, { workspaceId: a.workspaceId, userId: u.id, projectId, message: `Smoothing the slow motion of ${a.name}` })
  return c.json(jobDto(j))
})
