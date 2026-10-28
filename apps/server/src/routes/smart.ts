// Smart tools (E-21): what this server can do, and the jobs that make a stabilised, denoised or background-removed copy
// of a clip's media (editors). The editor swaps the copy in when the job is done.
import { Hono } from 'hono'
import * as z from 'zod/v4'
import type { JobKind, SmartTool } from '@producer/core'
import { type AppEnv, requireUser } from '../auth'
import { jobDto } from '../dto'
import { HttpError, body, requireRole } from '../http'
import { enqueue } from '../jobs/queue'
import { assertQueueRoom } from '../limits'
import { smartToolsInfo } from '../media/smartTools'
import { loadAsset } from '../services/assets'

/** Mounted at /api/smart-tools. */
export const smartToolsRoutes = new Hono<AppEnv>()

smartToolsRoutes.get('/', async (c) => {
  requireUser(c)
  return c.json(await smartToolsInfo())
})

/** Mounted at /api/assets. */
export const smartRoutes = new Hono<AppEnv>()

const Range = { from: z.number().min(0).max(1e6).optional(), to: z.number().min(0).max(1e6).optional() }
const Level = z.number().min(0).max(100).optional()

const TOOLS: Record<string, { tool: SmartTool; kind: JobKind; schema: z.ZodObject; what: string; kinds: string[] }> = {
  stabilise: { tool: 'stabilise', kind: 'media.stabilise', schema: z.object({ ...Range, smoothing: Level }), what: 'Stabilising', kinds: ['video'] },
  denoise: {
    tool: 'denoise',
    kind: 'media.denoise',
    schema: z.object({ ...Range, target: z.enum(['audio', 'video']), method: z.enum(['afftdn', 'arnndn', 'hqdn3d', 'nlmeans']).optional(), strength: Level, soundOnly: z.boolean().optional() }),
    what: 'Denoising',
    kinds: ['video', 'audio'],
  },
  'remove-background': { tool: 'removeBackground', kind: 'media.bgremove', schema: z.object(Range), what: 'Removing the background of', kinds: ['video'] },
}

smartRoutes.post('/:id/:tool{stabilise|denoise|remove-background}', async (c) => {
  const u = requireUser(c)
  const t = TOOLS[c.req.param('tool')]
  const a = await loadAsset(c.req.param('id'))
  await requireRole(u.id, a.workspaceId, 'editor')
  const b = (await body(c, t.schema)) as { from?: number; to?: number; target?: 'audio' | 'video'; method?: string }
  if (!t.kinds.includes(a.kind)) throw new HttpError(400, 'invalid', t.tool === 'denoise' ? 'Denoising works on video and sound clips' : `${t.tool === 'stabilise' ? 'Stabilisation' : 'Background removal'} works on video clips`)
  if (a.status !== 'ready') throw new HttpError(409, 'conflict', 'This clip is still being processed')
  if (b.from !== undefined && b.to !== undefined && b.to <= b.from) throw new HttpError(400, 'invalid', 'The range must end after it starts')
  // say what is missing now, not after the job has waited its turn
  const info = await smartToolsInfo()
  if (t.tool === 'stabilise' && !info.stabilise) throw new HttpError(501, 'server', info.why.stabilise!)
  if (t.tool === 'removeBackground' && !info.removeBackground.available) throw new HttpError(501, 'server', info.why.removeBackground!)
  if (t.tool === 'denoise') {
    if (b.target === 'video' && a.kind !== 'video') throw new HttpError(400, 'invalid', 'A sound clip has no picture to clean')
    const offered: string[] = b.target === 'video' ? info.denoise.video : info.denoise.audio
    if (!offered.length) throw new HttpError(501, 'server', info.why.denoise ?? 'Denoising is not available on this server')
    if (b.method && !offered.includes(b.method)) throw new HttpError(400, 'invalid', `This server can't denoise with ${b.method}: it offers ${offered.join(', ')}`)
    if (b.target === 'audio' && a.meta?.hasAudio === false) throw new HttpError(400, 'invalid', 'This clip has no sound to clean')
  }
  await assertQueueRoom(a.workspaceId)
  const j = await enqueue(t.kind, { ...b, assetId: a.id, workspaceId: a.workspaceId }, { workspaceId: a.workspaceId, userId: u.id, projectId: a.projectId, message: `${t.what} ${a.name}` })
  return c.json(jobDto(j))
})
