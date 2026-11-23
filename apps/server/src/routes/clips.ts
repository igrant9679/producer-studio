// The clip library (21 Nov 2026): CLIP_LIBRARY's animations (drawn by a space's AI) and full-motion clips (Gemini
// video), made once by an operator with a space's keys and kept in storage (services/media-library.ts), for anyone to
// watch in the editor and add to a video.
//   GET  /api/clips              -> the clips, each with `ready` (made) and `seconds`
//   GET  /api/clips/:id/preview  -> a made clip (video/mp4 from storage; Range supported)
//   GET  /api/clips/:id/poster   -> a frame of it (JPEG)
//   POST /api/clips/:id/add      -> { workspaceId, projectId? } -> AssetRecord: the space's clip of it
//   POST /api/clips/:id/customize -> { workspaceId, projectId?, mode: topic, topic, aspect? } -> Job (library.custom):
//                                    the clip remade for the space's topic on its own keys
import { Hono } from 'hono'
import * as z from 'zod/v4'
import { type AppEnv, requireUser } from '../auth'
import { assetRecord, jobDto } from '../dto'
import { body, notFound, requireRole } from '../http'
import { serveObject } from '../media/serve'
import { addLibraryItem, listClips, madeItem, queueCustom, requireItem } from '../services/media-library'
import { assertProjectInWorkspace } from '../services/projects'

export const clipRoutes = new Hono<AppEnv>()

clipRoutes.get('/', async (c) => {
  requireUser(c)
  return c.json(await listClips())
})

clipRoutes.get('/:id/preview', async (c) => {
  requireUser(c)
  const info = await madeItem(requireItem(c.req.param('id'), 'clip'))
  return serveObject(c, { key: info.key, contentType: info.mime }, { cache: 'private, max-age=86400' })
})

clipRoutes.get('/:id/poster', async (c) => {
  requireUser(c)
  const info = await madeItem(requireItem(c.req.param('id'), 'clip'))
  if (!info.poster) throw notFound('This clip has no poster frame')
  return serveObject(c, { key: info.poster, contentType: 'image/jpeg' }, { cache: 'private, max-age=86400' })
})

clipRoutes.post('/:id/add', async (c) => {
  const u = requireUser(c)
  const it = requireItem(c.req.param('id'), 'clip')
  const b = await body(c, z.object({ workspaceId: z.string().min(1), projectId: z.string().max(80).optional() }))
  await requireRole(u.id, b.workspaceId, 'editor')
  if (b.projectId) await assertProjectInWorkspace(b.projectId, b.workspaceId)
  const row = await addLibraryItem({ it, workspaceId: b.workspaceId, userId: u.id, projectId: b.projectId, signal: c.req.raw.signal })
  return c.json(assetRecord(row, { light: true }))
})

clipRoutes.post('/:id/customize', async (c) => {
  const u = requireUser(c)
  const it = requireItem(c.req.param('id'), 'clip')
  const b = await body(c, z.object({ workspaceId: z.string().min(1), projectId: z.string().max(80).optional(), mode: z.literal('topic'), topic: z.string().max(300).optional(), aspect: z.enum(['16:9', '9:16', '1:1']).optional() }))
  await requireRole(u.id, b.workspaceId, 'editor')
  if (b.projectId) await assertProjectInWorkspace(b.projectId, b.workspaceId)
  const job = await queueCustom({ it, mode: b.mode, topic: b.topic, aspect: b.aspect, workspaceId: b.workspaceId, userId: u.id, projectId: b.projectId })
  return c.json(jobDto(job))
})
