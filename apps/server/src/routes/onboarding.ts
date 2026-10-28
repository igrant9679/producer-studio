// First-run onboarding routes (A-6), mounted at /api/workspaces.
import { Hono } from 'hono'
import * as z from 'zod/v4'
import { type AppEnv, requireUser } from '../auth'
import { body, requireRole } from '../http'
import { onboardingState } from '../services/onboarding'
import { getMemberSettings, patchMemberSettings } from '../services/settings'

export const onboardingRoutes = new Hono<AppEnv>()

onboardingRoutes.get('/:id/onboarding', async (c) => {
  const u = requireUser(c)
  const id = c.req.param('id')
  await requireRole(u.id, id, 'viewer')
  return c.json(await onboardingState(u.id, id))
})

/** Hide (or show again) this person's checklist in this space. */
onboardingRoutes.put('/:id/onboarding', async (c) => {
  const u = requireUser(c)
  const id = c.req.param('id')
  await requireRole(u.id, id, 'viewer')
  const b = await body(c, z.object({ dismissed: z.boolean() }))
  const cur = (await getMemberSettings(u.id, id)).onboarding as Record<string, unknown> | undefined
  await patchMemberSettings(u.id, id, { onboarding: { ...(cur ?? {}), dismissed: b.dismissed } })
  return c.json(await onboardingState(u.id, id))
})
