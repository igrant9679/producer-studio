// Scene detection for "Split at scene changes" (E-10): a short job that returns the cut times in a clip's file.
import { Hono } from 'hono'
import * as z from 'zod/v4'
import { type AppEnv, requireUser } from '../auth'
import { jobDto } from '../dto'
import { HttpError, body, requireRole } from '../http'
import { enqueue } from '../jobs/queue'
import { assertQueueRoom } from '../limits'
import { loadAsset } from '../services/assets'

/** Mounted at /api/assets. */
export const sceneRoutes = new Hono<AppEnv>()

sceneRoutes.post('/:id/scenes', async (c) => {
  const u = requireUser(c)
  const a = await loadAsset(c.req.param('id'))
  await requireRole(u.id, a.workspaceId, 'editor')
  const b = await body(c, z.object({ from: z.number().min(0).max(1e6).optional(), to: z.number().min(0).max(1e6).optional(), threshold: z.number().min(0.05).max(0.95).optional() }))
  if (a.kind !== 'video') throw new HttpError(400, 'invalid', 'Scene detection works on video clips')
  if (a.status !== 'ready') throw new HttpError(409, 'conflict', 'This clip is still being processed')
  if (b.from !== undefined && b.to !== undefined && b.to <= b.from) throw new HttpError(400, 'invalid', 'The range must end after it starts')
  await assertQueueRoom(a.workspaceId)
  const j = await enqueue('media.scenes', { ...b, assetId: a.id, workspaceId: a.workspaceId }, { workspaceId: a.workspaceId, userId: u.id, projectId: a.projectId, message: `Finding scene changes in ${a.name}` })
  return c.json(jobDto(j))
})
