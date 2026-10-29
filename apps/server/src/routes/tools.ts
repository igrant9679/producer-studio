// GET /api/tools/health: the desktop's bundled tools (D-13), for Settings and the app's start-up check. Desktop only
// (it names paths on this computer); the local session, like every desktop route.
import { Hono } from 'hono'
import { type AppEnv, requireUser } from '../auth'
import { ctx } from '../context'
import { notFound } from '../http'
import { toolHealth } from '../services/tool-health'

export const toolRoutes = new Hono<AppEnv>()

toolRoutes.get('/health', async (c) => {
  if (ctx().config.mode !== 'desktop') throw notFound()
  requireUser(c)
  return c.json(await toolHealth(ctx().config, c.req.query('refresh') === '1'))
})
