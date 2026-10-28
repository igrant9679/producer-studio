// Small JSON settings documents (migration v14): one per space (space_settings: the pronunciation dictionary, the
// sample project) and one per member of a space (member_settings: Voice Studio draft, favourite voices, onboarding).
// A patch merges top-level keys; reads always give an object.
import { and, eq } from 'drizzle-orm'
import { ctx } from '../context'
import { memberSettings, spaceSettings } from '../db/schema'

type Doc = Record<string, unknown>

export async function getSpaceSettings(workspaceId: string): Promise<Doc> {
  const row = (await ctx().db.select().from(spaceSettings).where(eq(spaceSettings.workspaceId, workspaceId)).limit(1))[0]
  return row?.doc ?? {}
}

export async function patchSpaceSettings(workspaceId: string, patch: Doc): Promise<Doc> {
  const doc = { ...(await getSpaceSettings(workspaceId)), ...patch }
  const now = Date.now()
  await ctx().db.insert(spaceSettings).values({ workspaceId, doc, updatedAt: now }).onConflictDoUpdate({ target: spaceSettings.workspaceId, set: { doc, updatedAt: now } })
  return doc
}

export async function getMemberSettings(userId: string, workspaceId: string): Promise<Doc> {
  const row = (await ctx().db.select().from(memberSettings).where(and(eq(memberSettings.userId, userId), eq(memberSettings.workspaceId, workspaceId))).limit(1))[0]
  return row?.doc ?? {}
}

export async function patchMemberSettings(userId: string, workspaceId: string, patch: Doc): Promise<Doc> {
  const doc = { ...(await getMemberSettings(userId, workspaceId)), ...patch }
  const now = Date.now()
  await ctx()
    .db.insert(memberSettings)
    .values({ userId, workspaceId, doc, updatedAt: now })
    .onConflictDoUpdate({ target: [memberSettings.userId, memberSettings.workspaceId], set: { doc, updatedAt: now } })
  return doc
}
