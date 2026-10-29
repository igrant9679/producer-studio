// Orphaned storage (P-10): objects under ws/<space>/ that nothing in the database points at any more, because their
// space, clip, brand font or project preview was deleted and the files stayed (a crash between the row delete and
// the file delete, a job that wrote after its clip went). The operator looks first (a dry run) and then removes what
// that run listed, each object checked again just before it goes. Anything touched in the last day is left alone:
// it may be an upload or a job still writing.
import { inArray } from 'drizzle-orm'
import type { OrphanObject, OrphanScan } from '@producer/core'
import { ctx } from '../context'
import { assets, brandFonts, projects, workspaces } from '../db/schema'
import { HttpError } from '../http'
import { newId } from '../ids'

/** Objects newer than this are never called orphans. */
export const ORPHAN_MIN_AGE_MS = 24 * 3600_000
/** A dry run's list is kept this long for its confirmation. */
const SCAN_TTL_MS = 30 * 60_000
/** At most this many objects are listed in an answer (all of them are removed). */
const SHOWN = 300

interface Candidate {
  key: string
  size: number
  mtimeMs: number
  ws: string
  kind: 'asset' | 'font' | 'preview' | 'other'
  id?: string
}

function parse(key: string, size: number, mtimeMs: number): Candidate | null {
  const m = key.match(/^ws\/([^/]+)\/(.+)$/)
  if (!m) return null
  const [, ws, rest] = m
  const asset = rest.match(/^assets\/([^/]+)\//)
  if (asset) return { key, size, mtimeMs, ws, kind: 'asset', id: asset[1] }
  const font = rest.match(/^brand-fonts\/([^/.]+)\.[a-z0-9]+$/i)
  if (font) return { key, size, mtimeMs, ws, kind: 'font', id: font[1] }
  const preview = rest.match(/^previews\/([^/]+)\//)
  if (preview) return { key, size, mtimeMs, ws, kind: 'preview', id: preview[1] }
  return { key, size, mtimeMs, ws, kind: 'other' }
}

async function existing(table: typeof assets | typeof brandFonts | typeof projects | typeof workspaces, ids: string[]): Promise<Set<string>> {
  const out = new Set<string>()
  for (let i = 0; i < ids.length; i += 500) {
    const part = ids.slice(i, i + 500)
    const rows = await ctx().db.select({ id: table.id }).from(table).where(inArray(table.id, part))
    for (const r of rows) out.add(r.id)
  }
  return out
}

/** Which of these candidates nothing points at, and why. */
async function judge(cands: Candidate[]): Promise<OrphanObject[]> {
  const ids = (k: Candidate['kind']) => [...new Set(cands.filter((c) => c.kind === k).map((c) => c.id!))]
  const [spaces, clips, fonts, previews] = await Promise.all([
    existing(workspaces, [...new Set(cands.map((c) => c.ws))]),
    existing(assets, ids('asset')),
    existing(brandFonts, ids('font')),
    existing(projects, ids('preview')),
  ])
  const out: OrphanObject[] = []
  for (const c of cands) {
    // a clip's files can sit in another space's folder (a desktop merged spaces without moving them): the clip row
    // anywhere keeps them
    if (c.kind === 'asset') {
      if (!clips.has(c.id!)) out.push({ key: c.key, size: c.size, mtimeMs: c.mtimeMs, reason: spaces.has(c.ws) ? 'asset' : 'workspace' })
    } else if (!spaces.has(c.ws)) out.push({ key: c.key, size: c.size, mtimeMs: c.mtimeMs, reason: 'workspace' })
    else if (c.kind === 'font' && !fonts.has(c.id!)) out.push({ key: c.key, size: c.size, mtimeMs: c.mtimeMs, reason: 'font' })
    else if (c.kind === 'preview' && !previews.has(c.id!)) out.push({ key: c.key, size: c.size, mtimeMs: c.mtimeMs, reason: 'preview' })
  }
  return out
}

/** Walk every object under ws/ and list the orphans (nothing is removed). */
export async function findOrphans(now = Date.now()): Promise<{ orphans: OrphanObject[]; scanned: number }> {
  const s = ctx().storage
  if (!s.list) throw new HttpError(501, 'server', 'This storage can’t list its objects.')
  const cands: Candidate[] = []
  let scanned = 0
  for await (const o of s.list('ws/')) {
    scanned++
    if (o.mtimeMs > now - ORPHAN_MIN_AGE_MS) continue
    const c = parse(o.key, o.size, o.mtimeMs)
    if (c) cands.push(c)
  }
  return { orphans: await judge(cands), scanned }
}

const scans = new Map<string, { at: number; by: string; keys: Set<string> }>()

function summary(scanId: string, dryRun: boolean, orphans: OrphanObject[], scanned: number, removed?: number): OrphanScan {
  const sorted = [...orphans].sort((a, b) => b.size - a.size)
  return { scanId, dryRun, objects: sorted.slice(0, SHOWN), count: orphans.length, bytes: orphans.reduce((n, o) => n + o.size, 0), scanned, ...(removed !== undefined ? { removed } : {}) }
}

/** A dry run: what would be removed. Its scanId confirms the removal. */
export async function dryRunOrphans(by: string, now = Date.now()): Promise<OrphanScan> {
  for (const [id, s] of scans) if (now - s.at > SCAN_TTL_MS) scans.delete(id)
  const { orphans, scanned } = await findOrphans(now)
  const scanId = newId('scan')
  scans.set(scanId, { at: now, by, keys: new Set(orphans.map((o) => o.key)) })
  return summary(scanId, true, orphans, scanned)
}

/** Remove what the dry run `scanId` listed that is still orphaned now; the scan is used up. */
export async function removeOrphans(scanId: string, by: string, now = Date.now()): Promise<OrphanScan> {
  const scan = scans.get(scanId)
  if (!scan || now - scan.at > SCAN_TTL_MS || scan.by !== by) throw new HttpError(410, 'conflict', 'That dry run expired or isn’t yours. Run it again, check the list, then remove.')
  scans.delete(scanId)
  const { orphans, scanned } = await findOrphans(now)
  const go = orphans.filter((o) => scan.keys.has(o.key))
  let removed = 0
  for (const o of go) {
    await ctx().storage.delete(o.key)
    removed++
  }
  return summary(scanId, false, go, scanned, removed)
}
