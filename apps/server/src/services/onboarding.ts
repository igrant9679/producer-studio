// First-run onboarding (A-6): the checklist's steps read from the space's real state, and the sample project a new
// space starts with.
import { and, count, eq, gt, isNull, or, sql } from 'drizzle-orm'
import { uid, type OnboardingState } from '@producer/core'
import { ctx } from '../context'
import { assets, brandKits, extraBrandKits, invites, memberships, projects } from '../db/schema'
import { log } from '../log'
import { getLook, starterProject } from './looks'
import { insertProject } from './projects'
import { getMemberSettings, getSpaceSettings, patchSpaceSettings } from './settings'

const any = async (q: Promise<Array<{ n: number }>>) => Number((await q)[0]?.n ?? 0) > 0

export async function onboardingState(userId: string, workspaceId: string): Promise<OnboardingState> {
  const db = ctx().db
  const [upload, brand, extra, producer, members, invited, space, mine] = await Promise.all([
    any(db.select({ n: count() }).from(assets).where(and(eq(assets.workspaceId, workspaceId), eq(assets.origin, 'upload')))),
    any(db.select({ n: count() }).from(brandKits).where(eq(brandKits.workspaceId, workspaceId))),
    any(db.select({ n: count() }).from(extraBrandKits).where(eq(extraBrandKits.workspaceId, workspaceId))),
    any(
      db
        .select({ n: count() })
        .from(projects)
        .where(and(eq(projects.workspaceId, workspaceId), eq(projects.kind, 'producer'), isNull(projects.trashedAt), sql`${projects.doc}->'ai'->>'status' = 'assembled'`)),
    ),
    db.select({ n: count() }).from(memberships).where(eq(memberships.workspaceId, workspaceId)),
    any(
      db
        .select({ n: count() })
        .from(invites)
        .where(and(eq(invites.workspaceId, workspaceId), isNull(invites.acceptedAt), isNull(invites.revokedAt), or(isNull(invites.expiresAt), gt(invites.expiresAt, Date.now())))),
    ),
    getSpaceSettings(workspaceId),
    getMemberSettings(userId, workspaceId),
  ])
  const sampleId = typeof space.sampleProjectId === 'string' ? space.sampleProjectId : undefined
  const sample = sampleId ? (await db.select({ id: projects.id }).from(projects).where(and(eq(projects.id, sampleId), isNull(projects.trashedAt))).limit(1))[0] : undefined
  const onboarding = (mine.onboarding ?? {}) as { dismissed?: boolean }
  return {
    steps: { upload, brand: brand || extra, producer, invite: Number(members[0]?.n ?? 0) > 1 || invited },
    dismissed: !!onboarding.dismissed,
    ...(sample ? { sampleProjectId: sample.id } : {}),
  }
}

/** Whether new spaces get a sample project (SAMPLE_PROJECT=0 turns it off; never on a desktop, whose spaces sync). */
export function sampleProjectsOn(): boolean {
  return ctx().config.mode !== 'desktop' && process.env.SAMPLE_PROJECT !== '0'
}

/**
 * A new space's sample project: a Producer look's starter (title card, lower third, close card) in the space's brand,
 * to open and change. Never fails the space it comes with.
 */
export async function addSampleProject(workspaceId: string, userId: string): Promise<string | null> {
  if (!sampleProjectsOn()) return null
  try {
    const doc = starterProject(getLook('studio-dark'), { name: 'Sample project' })
    doc.id = uid('p')
    const row = await insertProject({ workspaceId, userId, doc })
    await patchSpaceSettings(workspaceId, { sampleProjectId: row.id })
    return row.id
  } catch (err) {
    log.warn('could not add the sample project to a new space', { workspaceId, err })
    return null
  }
}
