// What the sync panel shows (D-1): every item waiting to go up, uploading, failed or skipped, with its reason and
// size; a side-by-side summary of each conflict; why sync can't carry on right now.
import fsp from 'node:fs/promises'
import type { Project, SyncBlock, SyncConflictPreview, SyncFailure, SyncItem, SyncItems, SyncSideSummary, SyncStatus } from '@producer/core'
import { ctx } from '../context'
import { assets, brandFonts, brandKits, extraBrandKits, projects, voiceProfiles } from '../db/schema'
import { projectDuration } from '@producer/core'
import { failureKey, kvGet, syncRows, type SyncRow } from './db'

/** Below this much free space on the data folder's drive, downloads of cloud media wait. */
export const LOW_DISK_BYTES = 1024 ** 3

type ProjectFlags = { version: number; trashedAt: number | null; isTemplate: boolean }

/** Local copy changed since the last sync (or never synced). */
export function projectDirty(p: ProjectFlags, s: SyncRow | undefined): boolean {
  if (!s || s.cloudVersion == null) return true
  if (s.localVersion !== p.version) return true
  if (s.cloudTrashed != null && s.cloudTrashed !== (p.trashedAt != null)) return true
  if (s.cloudTemplate != null && s.cloudTemplate !== p.isTemplate) return true
  return false
}

const mb = (n: number) => (n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(1)} GB` : `${Math.max(1, Math.round(n / 1024 ** 2))} MB`)

/** Everything this computer still has to send, in the order a person cares about: failed, uploading, waiting, skipped. */
export async function syncItems(failures: Map<string, SyncFailure>, uploading: Set<string>): Promise<SyncItems> {
  const db = ctx().db
  const cloudWs = new Set((await kvGet<string[]>('cloudWorkspaces')) ?? [])
  const items: SyncItem[] = []
  const add = (kind: SyncItem['kind'], id: string, name: string, workspaceId: string, extra: Partial<SyncItem> = {}) => {
    const f = failures.get(failureKey(kind, id))
    const state: SyncItem['state'] = f?.skipped ? 'skipped' : f ? 'failed' : uploading.has(id) ? 'uploading' : 'waiting'
    items.push({ kind, id, name, workspaceId, state, ...(f ? { reason: f.skipped ? 'Skipped: stays on this computer only' : f.error } : {}), ...extra })
  }
  const [pr, ar, br, kr, fr, vr] = await Promise.all([syncRows('project'), syncRows('asset'), syncRows('brand'), syncRows('kit'), syncRows('font'), syncRows('voice')])
  for (const p of await db.select({ id: projects.id, name: projects.name, ws: projects.workspaceId, version: projects.version, trashedAt: projects.trashedAt, isTemplate: projects.isTemplate }).from(projects)) {
    if (!cloudWs.has(p.ws)) continue
    const s = pr.get(p.id)
    if (s?.conflictVersion != null) add('project', p.id, p.name, p.ws, { reason: 'Edited here and in the cloud: choose which to keep' })
    else if (projectDirty(p, s)) add('project', p.id, p.name, p.ws)
  }
  for (const a of await db.select({ id: assets.id, name: assets.name, ws: assets.workspaceId, size: assets.size, origin: assets.origin, status: assets.status, trashedAt: assets.trashedAt }).from(assets)) {
    const s = ar.get(a.id)
    if (!cloudWs.has(a.ws) || a.origin === 'render' || a.status === 'uploading' || a.trashedAt != null || s?.uploaded || s?.remote) continue
    add('asset', a.id, a.name, a.ws, { bytes: a.size })
  }
  for (const b of await db.select({ ws: brandKits.workspaceId, updatedAt: brandKits.updatedAt, doc: brandKits.doc }).from(brandKits)) {
    if (cloudWs.has(b.ws) && br.get(b.ws)?.localVersion !== b.updatedAt) add('brand', b.ws, `Brand kit “${b.doc.name}”`, b.ws)
  }
  for (const k of await db.select({ id: extraBrandKits.id, ws: extraBrandKits.workspaceId, updatedAt: extraBrandKits.updatedAt, doc: extraBrandKits.doc }).from(extraBrandKits)) {
    if (cloudWs.has(k.ws) && kr.get(k.id)?.localVersion !== k.updatedAt) add('kit', k.id, `Brand kit “${k.doc.name}”`, k.ws)
  }
  for (const f of await db.select({ id: brandFonts.id, ws: brandFonts.workspaceId, family: brandFonts.family, size: brandFonts.sizeBytes }).from(brandFonts)) {
    if (cloudWs.has(f.ws) && !fr.get(f.id)?.uploaded) add('font', f.id, `Font “${f.family}”`, f.ws, { bytes: f.size })
  }
  for (const v of await db.select({ id: voiceProfiles.id, ws: voiceProfiles.workspaceId, name: voiceProfiles.name, updatedAt: voiceProfiles.updatedAt }).from(voiceProfiles)) {
    const s = vr.get(v.id)
    if (cloudWs.has(v.ws) && !(s?.localVersion === v.updatedAt && s.cloudVersion != null)) add('voice', v.id, v.name, v.ws)
  }
  // deletes that keep failing (the item itself is gone from this computer)
  for (const f of failures.values()) {
    if (!f.kind.endsWith('-delete')) continue
    items.push({ kind: f.kind.slice(0, -'-delete'.length) as SyncItem['kind'], id: f.id, name: f.name, workspaceId: '', state: f.skipped ? 'skipped' : 'failed', reason: f.skipped ? 'Skipped: stays on this computer only' : f.error })
  }
  const order = { failed: 0, uploading: 1, waiting: 2, skipped: 3 }
  items.sort((x, y) => order[x.state] - order[y.state] || x.name.localeCompare(y.name))
  return { items, uploadBytes: items.filter((i) => i.kind === 'asset' && i.state !== 'skipped').reduce((n, i) => n + (i.bytes ?? 0), 0) }
}

export function sideSummary(doc: Project, o: { version: number; updatedAt: number; trashed: boolean }): SyncSideSummary {
  return {
    version: o.version,
    name: doc.name,
    updatedAt: o.updatedAt,
    duration: projectDuration(doc),
    tracks: doc.tracks.length,
    items: doc.tracks.reduce((n, t) => n + t.items.length, 0),
    clips: Object.keys(doc.assets ?? {}).length,
    trashed: o.trashed,
  }
}

const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`

/** What differs between this computer's copy and the cloud's, in plain words. */
export function compareSides(local: Project, cloud: Project | null, l: SyncSideSummary, c: SyncSideSummary | null): string[] {
  if (!cloud || !c) return ['Deleted in the cloud since this computer last synced it']
  const out: string[] = []
  if (l.name !== c.name) out.push(`Named “${l.name}” here and “${c.name}” in the cloud`)
  if (Math.abs(l.duration - c.duration) >= 0.05) out.push(`${clock(l.duration)} long here, ${clock(c.duration)} in the cloud`)
  if (l.tracks !== c.tracks) out.push(`${l.tracks} track${l.tracks === 1 ? '' : 's'} here, ${c.tracks} in the cloud`)
  if (l.items !== c.items) out.push(`${l.items} item${l.items === 1 ? '' : 's'} on the timeline here, ${c.items} in the cloud`)
  const lc = new Set(Object.keys(local.assets ?? {}))
  const cc = new Set(Object.keys(cloud.assets ?? {}))
  const onlyHere = [...lc].filter((x) => !cc.has(x)).length
  const onlyThere = [...cc].filter((x) => !lc.has(x)).length
  if (onlyHere) out.push(`${onlyHere} clip${onlyHere === 1 ? '' : 's'} only in this computer’s copy`)
  if (onlyThere) out.push(`${onlyThere} clip${onlyThere === 1 ? '' : 's'} only in the cloud’s copy`)
  if (l.trashed !== c.trashed) out.push(l.trashed ? 'In the trash here, not in the cloud' : 'In the trash in the cloud, not here')
  if (!out.length) out.push('Both copies have the same timeline length and clips; the edits differ in detail (text, timing, effects)')
  return out
}

/** Free space on the drive holding `dir` (undefined where it can't be told). */
export async function freeBytes(dir: string): Promise<number | undefined> {
  try {
    const s = await fsp.statfs(dir)
    return Number(s.bavail) * Number(s.bsize)
  } catch {
    return undefined
  }
}

/** Why sync can't carry on, most pressing first. */
export function blockedBy(s: Pick<SyncStatus, 'linked' | 'state' | 'conflicts'>, o: { signedOut: boolean; credentials: boolean; autoSync: boolean; diskFree?: number; cloudStorage?: string }): SyncBlock | undefined {
  if (!s.linked) return undefined
  if (o.credentials) return { reason: 'credentials', message: 'The saved cloud credentials can’t be read on this computer. Link your account again.' }
  if (o.signedOut) return { reason: 'signed-out', message: 'The cloud signed this computer out (its link was revoked or expired). Unlink and link again to carry on.' }
  if (s.state === 'offline') return { reason: 'offline', message: 'The cloud can’t be reached from here. Your work is safe on this computer, and sync starts again by itself as soon as the connection is back.' }
  if (o.cloudStorage) return { reason: 'storage', message: `The cloud’s storage isn’t working right now, so clips wait to upload (${o.cloudStorage}).` }
  if (o.diskFree != null && o.diskFree < LOW_DISK_BYTES) return { reason: 'storage', message: `This computer has only ${mb(o.diskFree)} free where Producer Studio keeps its data, so cloud media isn’t downloaded. Free up space or move the data folder.` }
  if (s.conflicts.length) return { reason: 'conflict', message: `${s.conflicts.length} project${s.conflicts.length === 1 ? ' was' : 's were'} edited here and in the cloud and wait${s.conflicts.length === 1 ? 's' : ''} for your choice; everything else syncs.` }
  if (!o.autoSync) return { reason: 'paused', message: 'Automatic sync is off: changes go up when you choose Sync now.' }
  return undefined
}
