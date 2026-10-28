// Brand kits (A-21): the space's default kit (brand_kits, synced to desktops) and its other kits (extra_brand_kits),
// and the font files uploaded for them (brand_fonts). Producer AI, templates and new projects take a kit by id.
import { and, asc, eq } from 'drizzle-orm'
import { DEFAULT_KIT_ID, FONTS, type BrandFont, type BrandFontFormat, type BrandKitDoc, type BrandKitSummary } from '@producer/core'
import { ctx } from '../context'
import { brandFonts, brandKits, extraBrandKits } from '../db/schema'
import { etagOf } from '../etag'
import { HttpError, notFound } from '../http'
import { getBrand } from '../routes/workspaces'

export type BrandFontRow = typeof brandFonts.$inferSelect

export function fontDto(r: BrandFontRow): BrandFont {
  return { id: r.id, family: r.family, format: r.format as BrandFontFormat, weight: r.weight, italic: r.italic, sizeBytes: r.sizeBytes, url: `/api/workspaces/${r.workspaceId}/brand/fonts/${r.id}/file` }
}

export async function listBrandFonts(workspaceId: string): Promise<BrandFontRow[]> {
  return ctx().db.select().from(brandFonts).where(eq(brandFonts.workspaceId, workspaceId)).orderBy(asc(brandFonts.family), asc(brandFonts.createdAt))
}

/** The space's uploaded font families. */
export async function brandFamilies(workspaceId: string): Promise<Set<string>> {
  return new Set((await listBrandFonts(workspaceId)).map((r) => r.family))
}

/**
 * A kit as it is saved: its fonts are bundled fonts or families uploaded to the space (400 otherwise), and
 * `customFonts` names the uploaded ones it uses, so the look builders keep them instead of a fallback.
 */
export async function checkKitDoc(workspaceId: string, doc: BrandKitDoc): Promise<BrandKitDoc> {
  const known = new Set<string>(FONTS)
  const uploaded = await brandFamilies(workspaceId)
  for (const f of [doc.fonts.headline, doc.fonts.body])
    if (!known.has(f) && !uploaded.has(f)) throw new HttpError(400, 'invalid', `Unknown font "${f}". Available: ${[...FONTS, ...uploaded].join(', ')}`)
  const custom = [...new Set([doc.fonts.headline, doc.fonts.body].filter((f) => uploaded.has(f) && !known.has(f)))]
  const out: BrandKitDoc = { ...doc }
  if (custom.length) out.customFonts = custom
  else delete out.customFonts
  return out
}

export async function defaultKitSummary(workspaceId: string): Promise<BrandKitSummary> {
  const row = (await ctx().db.select().from(brandKits).where(eq(brandKits.workspaceId, workspaceId)).limit(1))[0]
  const doc = row?.doc ?? (await getBrand(workspaceId))
  return { id: DEFAULT_KIT_ID, default: true, doc, updatedAt: row?.updatedAt ?? null, etag: etagOf(doc) }
}

export function extraSummary(r: typeof extraBrandKits.$inferSelect): BrandKitSummary {
  return { id: r.id, default: false, doc: r.doc, updatedAt: r.updatedAt, etag: etagOf(r.doc) }
}

export async function listKits(workspaceId: string): Promise<BrandKitSummary[]> {
  const rows = await ctx().db.select().from(extraBrandKits).where(eq(extraBrandKits.workspaceId, workspaceId)).orderBy(asc(extraBrandKits.createdAt), asc(extraBrandKits.id))
  return [await defaultKitSummary(workspaceId), ...rows.map(extraSummary)]
}

export async function loadExtraKit(workspaceId: string, kitId: string) {
  const row = (await ctx().db.select().from(extraBrandKits).where(and(eq(extraBrandKits.id, kitId), eq(extraBrandKits.workspaceId, workspaceId))).limit(1))[0]
  if (!row) throw notFound('Brand kit not found')
  return row
}

/**
 * The kit a video or template is made with: `kitId` in this space, else the space's default. A kit that's gone is a
 * 404, or with `fallback` (a job, a saved brief) the default.
 */
export async function getBrandKit(workspaceId: string, kitId?: string | null, opts: { fallback?: boolean } = {}): Promise<BrandKitDoc> {
  if (!kitId || kitId === DEFAULT_KIT_ID) return getBrand(workspaceId)
  try {
    return (await loadExtraKit(workspaceId, kitId)).doc
  } catch (err) {
    if (opts.fallback) return getBrand(workspaceId)
    throw err
  }
}
