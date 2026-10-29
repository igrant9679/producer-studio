// A space's audit log (P-8), for its owners: invites, roles, hand-overs, removals, AI keys. Mounted at /api/workspaces.
// Operators read everything at /api/operator/audit (routes/operator.ts).
import { Hono } from 'hono'
import { SPACE_AUDIT_KINDS } from '@producer/core'
import { type AppEnv, requireUser } from '../auth'
import { invalid, requireRole } from '../http'
import { pageQuery } from '../paging'
import { listAudit } from '../services/audit'

export const spaceAuditRoutes = new Hono<AppEnv>()

spaceAuditRoutes.get('/:id/audit', async (c) => {
  const u = requireUser(c)
  const id = c.req.param('id')
  await requireRole(u.id, id, 'owner')
  const kind = c.req.query('kind')
  if (kind && !(SPACE_AUDIT_KINDS as readonly string[]).includes(kind)) throw invalid('Unknown kind of entry')
  return c.json(await listAudit({ workspaceId: id, kinds: kind ? [kind] : SPACE_AUDIT_KINDS, ...pageQuery(c) }))
})
