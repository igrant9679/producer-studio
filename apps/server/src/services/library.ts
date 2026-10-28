// The Library's heavier operations (phase 5, release 3): the media trash, what uses a clip, removing clips and exports
// for good (by hand and by retention), and copying clips and projects into another space.
import path from 'node:path'
import { and, eq, inArray, isNotNull, isNull, lt, sql } from 'drizzle-orm'
import { uid, type AssetUsage, type Project } from '@producer/core'
import { ctx } from '../context'
import { assets, exportsTable, projects, shareLinks } from '../db/schema'
import { HttpError } from '../http'
import { newId } from '../ids'
import { cancelJobsOfAsset } from '../jobs/queue'
import { log } from '../log'
import { waveformKey } from '../media/process'
import { type AssetRow, assetDirs, assetPrefix, emitAsset } from './assets'
import { insertProject, type ProjectRow, withFreshIds } from './projects'

const DAY = 24 * 3600 * 1000

/** The space's projects whose document uses the clip (trashed ones too: restoring one would bring the clip back). */
export async function assetUsage(assetId: string, workspaceId: string): Promise<AssetUsage> {
  const rows = await ctx()
    .db.select({ id: projects.id, name: projects.name, trashedAt: projects.trashedAt })
    .from(projects)
    .where(and(eq(projects.workspaceId, workspaceId), sql`${projects.doc} -> 'assets' -> ${assetId} IS NOT NULL`))
    .orderBy(projects.name)
    .limit(500)
  return { assetId, projects: rows.map((r) => ({ id: r.id, name: r.name, trashed: r.trashedAt != null })) }
}

/** How many of the space's projects use each clip. */
export async function usageCounts(ids: string[], workspaceId: string): Promise<Map<string, number>> {
  const out = new Map<string, number>()
  for (const id of ids) out.set(id, (await assetUsage(id, workspaceId)).projects.length)
  return out
}

export async function setAssetTrashed(row: AssetRow, trashed: boolean): Promise<AssetRow> {
  const [saved] = await ctx()
    .db.update(assets)
    .set({ trashedAt: trashed ? Date.now() : null, updatedAt: Date.now() })
    .where(eq(assets.id, row.id))
    .returning()
  emitAsset(saved)
  return saved
}

/**
 * Remove clips for good: their processing stops, exports made of them (and those exports' share links) go, the rows
 * go (a tombstone tells desktops), then the files.
 */
export async function removeAssets(rows: AssetRow[]): Promise<{ removed: number; exports: number }> {
  if (!rows.length) return { removed: 0, exports: 0 }
  const ids = rows.map((r) => r.id)
  for (const id of ids) await cancelJobsOfAsset(id)
  const exs = await ctx().db.select({ id: exportsTable.id }).from(exportsTable).where(inArray(exportsTable.assetId, ids))
  await ctx().db.transaction(async (tx) => {
    if (exs.length) {
      await tx.delete(shareLinks).where(inArray(shareLinks.exportId, exs.map((e) => e.id)))
      await tx.delete(exportsTable).where(inArray(exportsTable.id, exs.map((e) => e.id)))
    }
    await tx.delete(assets).where(inArray(assets.id, ids))
  })
  for (const row of rows) for (const dir of assetDirs(row)) await ctx().storage.deletePrefix(dir).catch(() => undefined)
  return { removed: rows.length, exports: exs.length }
}

/**
 * Delete an export: its share links stop working and its file goes, unless a project uses that file (someone put
 * the render on a timeline): then the file stays in the library as a clip.
 */
export async function deleteExport(ex: typeof exportsTable.$inferSelect): Promise<{ links: number; keptFile: boolean }> {
  const file = (await ctx().db.select().from(assets).where(eq(assets.id, ex.assetId)).limit(1))[0]
  const used = file ? (await assetUsage(file.id, file.workspaceId)).projects.length > 0 : false
  const links = await ctx().db.transaction(async (tx) => {
    const gone = await tx.delete(shareLinks).where(eq(shareLinks.exportId, ex.id)).returning({ token: shareLinks.token })
    await tx.delete(exportsTable).where(eq(exportsTable.id, ex.id))
    return gone.length
  })
  if (file && !used) await removeAssets([file])
  return { links, keptFile: !!file && used }
}

/**
 * Retention (runs with the worker's housekeeping): media that has been in the trash longer than MEDIA_TRASH_DAYS,
 * and exports older than EXPORT_RETENTION_DAYS that no working share link shows. 0 turns either off.
 */
export async function sweepLibrary(now = Date.now()): Promise<{ media: number; exports: number }> {
  const cfg = ctx().config
  const db = ctx().db
  let media = 0
  let exportsGone = 0
  if (cfg.mediaTrashDays > 0) {
    const old = await db
      .select()
      .from(assets)
      .where(and(isNotNull(assets.trashedAt), lt(assets.trashedAt, now - cfg.mediaTrashDays * DAY)))
      .limit(200)
    media = (await removeAssets(old)).removed
  }
  if (cfg.exportRetentionDays > 0) {
    const old = await db
      .select()
      .from(exportsTable)
      .where(
        and(
          lt(exportsTable.createdAt, now - cfg.exportRetentionDays * DAY),
          sql`NOT EXISTS (SELECT 1 FROM share_links l WHERE l.export_id = ${exportsTable.id} AND (l.expires_at IS NULL OR l.expires_at > ${now}))`,
        ),
      )
      .limit(200)
    for (const ex of old) {
      await deleteExport(ex)
      exportsGone++
    }
  }
  if (media || exportsGone) log.info('library retention', { media, exports: exportsGone })
  return { media, exports: exportsGone }
}

// ---------------- copies into another space ----------------

/** Copy one stored object (any size; S3 streams through a temp file). False when there is nothing to copy. */
async function copyObject(from: string, to: string, contentType?: string): Promise<boolean> {
  const storage = ctx().storage
  if (!(await storage.stat(from))) return false
  await storage.put(to, await storage.getStream(from), { contentType })
  return true
}

/** A ready clip copied into another space with all its files: a new id, the same name, metadata and transcript. */
export async function copyAssetTo(row: AssetRow, workspaceId: string, userId: string): Promise<AssetRow> {
  if (row.status !== 'ready') throw new HttpError(409, 'conflict', `“${row.name}” is still ${row.status === 'error' ? 'failed' : 'processing'}: only finished clips can be copied`)
  const id = newId('as')
  const prefix = assetPrefix(workspaceId, id)
  const moved = (key: string | null) => (key ? `${prefix}/${path.posix.basename(key)}` : null)
  if (!(await copyObject(row.sourceKey, moved(row.sourceKey)!, row.mime))) throw new HttpError(409, 'conflict', `“${row.name}” has no file in storage to copy`)
  const keys = { proxyKey: row.proxyKey, thumbKey: row.thumbKey, filmstripKey: row.filmstripKey, audioKey: row.audioKey }
  const out: Partial<typeof keys> = {}
  for (const [k, key] of Object.entries(keys) as Array<[keyof typeof keys, string | null]>) out[k] = key && (await copyObject(key, moved(key)!)) ? moved(key) : null
  const meta = { ...(row.meta ?? {}) }
  delete meta.jobId
  if (meta.waveformFull) await copyObject(waveformKey(row), waveformKey({ workspaceId, id }))
  if (meta.captions) meta.captions = (await copyObject(meta.captions.key, moved(meta.captions.key)!)) ? { ...meta.captions, key: moved(meta.captions.key)! } : undefined
  const now = Date.now()
  const [saved] = await ctx()
    .db.insert(assets)
    .values({ ...row, ...out, id, workspaceId, projectId: null, sourceKey: moved(row.sourceKey)!, meta, trashedAt: null, createdBy: userId, createdAt: now, updatedAt: now, changeSeq: undefined })
    .returning()
  emitAsset(saved)
  return saved
}

/** A document with clip ids swapped for their copies' (every place an id is written, and the media URLs). */
export function remapAssetIds(doc: Project, map: Map<string, string>): Project {
  let json = JSON.stringify(doc)
  for (const [from, to] of map) json = json.split(`"${from}"`).join(`"${to}"`).split(`/api/media/${from}/`).join(`/api/media/${to}/`)
  return JSON.parse(json) as Project
}

/**
 * A project copied into another space: fresh ids, and a copy of every clip it uses there (a project only plays
 * clips of its own space). Clips that aren't finished, or have no file, are left out of the copy's library and show
 * as missing; the answer says how many.
 */
export async function copyProjectTo(row: ProjectRow, workspaceId: string, userId: string): Promise<{ copy: ProjectRow; missing: number }> {
  const used = Object.keys(row.doc.assets ?? {})
  const clips = used.length ? await ctx().db.select().from(assets).where(and(eq(assets.workspaceId, row.workspaceId), inArray(assets.id, used))) : []
  const map = new Map<string, string>()
  let missing = used.length - clips.length
  for (const clip of clips) {
    try {
      map.set(clip.id, (await copyAssetTo(clip, workspaceId, userId)).id)
    } catch (err) {
      if (!(err instanceof HttpError)) throw err
      missing++
    }
  }
  const doc = remapAssetIds(withFreshIds(row.doc, uid('p')), map)
  const copy = await insertProject({ workspaceId, userId, doc, kind: row.kind, isTemplate: row.isTemplate })
  return { copy, missing }
}

/** Trashed clips of a space (all, or only `ids`). */
export async function trashedAssets(workspaceId: string, ids?: string[]): Promise<AssetRow[]> {
  const conds = [eq(assets.workspaceId, workspaceId), isNotNull(assets.trashedAt)]
  if (ids) conds.push(inArray(assets.id, ids.length ? ids : ['']))
  return ctx().db.select().from(assets).where(and(...conds))
}

/** Rows not in the trash (lists, search). */
export const notTrashed = isNull(assets.trashedAt)
