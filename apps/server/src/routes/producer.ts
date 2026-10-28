// Producer AI wizard routes beyond the jobs (A-7), mounted at /api/ai: the script's versions, read from the project's
// version history (every saved draft is a project version, thinned by the same rule).
import { Hono } from 'hono'
import { desc, eq, sql } from 'drizzle-orm'
import type { ProducerMeta, ScriptVersion } from '@producer/core'
import { type AppEnv, requireUser } from '../auth'
import { ctx } from '../context'
import { projectVersions, users } from '../db/schema'
import { requireRole } from '../http'
import { loadProjectRow } from '../services/projects'

export const producerRoutes = new Hono<AppEnv>()

const words = (s: string) => s.trim().split(/\s+/).filter(Boolean).length

/** What makes two scripts the same for this list: the brief and what each scene says and shows. */
function scriptKey(ai: ProducerMeta | null | undefined): string {
  const scenes = (ai?.script?.scenes ?? []).map((s) => [s.title, s.headline, s.narration, s.footage, s.visual ?? null, s.narrator ?? null])
  return JSON.stringify([ai?.brief ?? null, scenes])
}

producerRoutes.get('/produce/:projectId/script-versions', async (c) => {
  const u = requireUser(c)
  const row = await loadProjectRow(c.req.param('projectId'))
  await requireRole(u.id, row.workspaceId, 'viewer')
  const rows = await ctx()
    .db.select({
      id: projectVersions.id,
      version: projectVersions.version,
      label: projectVersions.label,
      name: projectVersions.name,
      createdAt: projectVersions.createdAt,
      authorName: users.name,
      ai: sql<ProducerMeta | null>`${projectVersions.doc}->'ai'`,
    })
    .from(projectVersions)
    .leftJoin(users, eq(users.id, projectVersions.createdBy))
    .where(eq(projectVersions.projectId, row.id))
    .orderBy(desc(projectVersions.createdAt), desc(projectVersions.version))
    .limit(200)
  const out: ScriptVersion[] = []
  let last: string | undefined
  for (const r of rows) {
    const ai = (typeof r.ai === 'string' ? JSON.parse(r.ai) : r.ai) as ProducerMeta | null
    const scenes = ai?.script?.scenes ?? []
    if (!scenes.length) continue
    // newest first: an older version with the same script as the one listed after it adds nothing
    const key = scriptKey(ai)
    if (key === last) continue
    last = key
    out.push({ versionId: r.id, version: r.version, createdAt: r.createdAt, authorName: r.authorName, name: r.name, label: r.label, ...(ai?.brief ? { brief: ai.brief } : {}), scenes, words: scenes.reduce((t, s) => t + words(s.narration), 0) })
    if (out.length >= 30) break
  }
  return c.json(out)
})
