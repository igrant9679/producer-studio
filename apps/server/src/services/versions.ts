// Project version history (P-15): every save the server accepts is kept as a version, then thinned with age — the
// last PROJECT_VERSIONS_KEEP saves (default 50), the newest of each hour for the last 7 days, the newest of each day
// for the 30 days after that, and every version someone named. A restore is itself a new save; what it replaced is
// kept, labelled "before restore" (and what a Producer AI assembly replaced, "before AI").
import { and, desc, eq, inArray } from 'drizzle-orm'
import { uid, type Project, type ProjectVersionLabel, type ProjectVersionSummary } from '@producer/core'
import { ctx } from '../context'
import { projectVersions, users } from '../db/schema'
import { log } from '../log'
import type { ProjectRow } from './projects'

export type VersionRow = typeof projectVersions.$inferSelect

const HOUR = 3600_000
const DAY = 24 * HOUR
/** One version per hour is kept this long… */
export const HOURLY_FOR_MS = 7 * DAY
/** …then one per day until this age; older ones go (named ones stay). */
export const DAILY_UNTIL_MS = 37 * DAY

export function versionsKeep(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.PROJECT_VERSIONS_KEEP)
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 50
}

/**
 * Which versions to keep, newest first in `rows` order or not: the newest `keep`, every named one, a "before …"
 * safety copy younger than the hourly window, and the newest of each hour (last 7 days) and of each day (after).
 */
export function versionsToKeep(rows: Array<Pick<VersionRow, 'id' | 'label' | 'createdAt'>>, now: number, keep = versionsKeep()): Set<string> {
  const sorted = [...rows].sort((a, b) => b.createdAt - a.createdAt)
  const out = new Set<string>()
  const buckets = new Set<string>()
  sorted.forEach((r, i) => {
    const age = now - r.createdAt
    if (i < keep || r.label === 'named' || (r.label.startsWith('before-') && age < HOURLY_FOR_MS)) out.add(r.id)
    let bucket: string | null = null
    if (age < HOURLY_FOR_MS) bucket = `h${Math.floor(r.createdAt / HOUR)}`
    else if (age < DAILY_UNTIL_MS) bucket = `d${Math.floor(r.createdAt / DAY)}`
    // newest first: the first row seen in a bucket is its newest
    if (bucket && !buckets.has(bucket)) {
      buckets.add(bucket)
      out.add(r.id)
    }
  })
  return out
}

const sizeOf = (doc: Project) => Buffer.byteLength(JSON.stringify(doc))

/** Drop what the thinning rule no longer keeps. */
export async function pruneVersions(projectId: string, now = Date.now()): Promise<void> {
  const db = ctx().db
  const rows = await db.select({ id: projectVersions.id, label: projectVersions.label, createdAt: projectVersions.createdAt }).from(projectVersions).where(eq(projectVersions.projectId, projectId))
  const keep = versionsToKeep(rows, now)
  const drop = rows.filter((r) => !keep.has(r.id)).map((r) => r.id)
  for (let i = 0; i < drop.length; i += 500) await db.delete(projectVersions).where(inArray(projectVersions.id, drop.slice(i, i + 500)))
}

/**
 * Keep a project row's current document as a version (after a save). Never fails the save it follows: history is a
 * safety net, so a failure to write it is logged.
 */
export async function recordVersion(row: ProjectRow, opts: { userId?: string | null; label?: ProjectVersionLabel; note?: string; name?: string } = {}): Promise<VersionRow | null> {
  try {
    const [v] = await ctx()
      .db.insert(projectVersions)
      .values({
        id: uid('pv'),
        projectId: row.id,
        workspaceId: row.workspaceId,
        version: row.version,
        doc: row.doc,
        label: opts.label ?? 'autosave',
        name: opts.name ?? null,
        note: opts.note ?? null,
        sizeBytes: sizeOf(row.doc),
        createdBy: opts.userId ?? null,
        createdAt: Date.now(),
      })
      .returning()
    await pruneVersions(row.id)
    return v
  } catch (err) {
    log.warn('version history: could not keep a version', { projectId: row.id, err })
    return null
  }
}

/** The version row holding exactly this project version, if history has it. */
export async function versionAt(projectId: string, version: number): Promise<VersionRow | null> {
  const rows = await ctx()
    .db.select()
    .from(projectVersions)
    .where(and(eq(projectVersions.projectId, projectId), eq(projectVersions.version, version)))
    .orderBy(desc(projectVersions.createdAt))
    .limit(1)
  return rows[0] ?? null
}

/**
 * About to replace the stored document (a restore, a Producer AI assembly): make sure what's there now is in history
 * and says why it was kept. Its own version row is relabelled (a named one keeps its name); a project saved before
 * history existed gets one.
 */
export async function keepBefore(row: ProjectRow, label: 'before-restore' | 'before-ai'): Promise<void> {
  try {
    const at = await versionAt(row.id, row.version)
    if (!at) {
      await recordVersion(row, { label })
      return
    }
    if (at.label === 'autosave') await ctx().db.update(projectVersions).set({ label }).where(eq(projectVersions.id, at.id))
  } catch (err) {
    log.warn('version history: could not keep the version before a change', { projectId: row.id, err })
  }
}

export async function listVersions(projectId: string, currentVersion: number): Promise<ProjectVersionSummary[]> {
  const rows = await ctx()
    .db.select({
      id: projectVersions.id,
      version: projectVersions.version,
      label: projectVersions.label,
      name: projectVersions.name,
      note: projectVersions.note,
      sizeBytes: projectVersions.sizeBytes,
      createdBy: projectVersions.createdBy,
      createdAt: projectVersions.createdAt,
      authorName: users.name,
    })
    .from(projectVersions)
    .leftJoin(users, eq(users.id, projectVersions.createdBy))
    .where(eq(projectVersions.projectId, projectId))
    .orderBy(desc(projectVersions.createdAt), desc(projectVersions.version))
  let currentSeen = false
  return rows.map((r) => {
    const current = !currentSeen && r.version === currentVersion
    if (current) currentSeen = true
    return versionSummary(r, current)
  })
}

export function versionSummary(r: Omit<VersionRow, 'doc' | 'projectId' | 'workspaceId'> & { authorName?: string | null }, current = false): ProjectVersionSummary {
  return {
    id: r.id,
    version: r.version,
    label: r.label as ProjectVersionLabel,
    ...(r.name ? { name: r.name } : {}),
    ...(r.note ? { note: r.note } : {}),
    sizeBytes: r.sizeBytes,
    createdAt: r.createdAt,
    ...(r.createdBy ? { createdBy: r.createdBy } : {}),
    ...(r.authorName ? { authorName: r.authorName } : {}),
    ...(current ? { current: true } : {}),
  }
}

export async function loadVersion(projectId: string, id: string): Promise<VersionRow | null> {
  const rows = await ctx()
    .db.select()
    .from(projectVersions)
    .where(and(eq(projectVersions.projectId, projectId), eq(projectVersions.id, id)))
    .limit(1)
  return rows[0] ?? null
}
