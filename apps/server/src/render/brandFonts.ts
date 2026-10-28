// Fonts uploaded to a space for its brand kits (A-21), in the export: the families a project uses that aren't bundled
// are looked up among the space's uploaded fonts, copied next to the page and declared, as the editor preview does.
import path from 'node:path'
import { and, eq, inArray } from 'drizzle-orm'
import type { BrandFontFormat } from '@producer/core'
import { ctx } from '../context'
import { brandFonts } from '../db/schema'
import { log } from '../log'
import { PREVIEW_FACES, type FontUse } from './fonts'

const CSS_FORMAT: Record<BrandFontFormat, string> = { woff2: 'woff2', woff: 'woff', ttf: 'truetype', otf: 'opentype' }

/** @font-face rules for the uploaded fonts among `uses`, their files copied into `outDir/fontsDirName`. */
export async function brandFontFaces(workspaceId: string, uses: FontUse[], outDir: string, fontsDirName = 'fonts'): Promise<{ css: string; files: string[] }> {
  const families = [...new Set(uses.map((u) => u.family).filter((f) => !PREVIEW_FACES[f]))]
  if (!families.length) return { css: '', files: [] }
  const rows = await ctx().db.select().from(brandFonts).where(and(eq(brandFonts.workspaceId, workspaceId), inArray(brandFonts.family, families)))
  const css: string[] = []
  const files: string[] = []
  for (const r of rows) {
    const file = `${fontsDirName}/brand-${r.id}.${r.format}`
    try {
      await ctx().storage.download(r.storageKey, path.join(outDir, file))
    } catch (err) {
      // the text falls back to Inter, as it would in a preview that couldn't load it
      log.warn('export: a brand font file is missing', { fontId: r.id, err })
      continue
    }
    files.push(file)
    const family = r.family.replace(/['\\]/g, '')
    css.push(`@font-face{font-family:'${family}';font-style:${r.italic ? 'italic' : 'normal'};font-display:block;font-weight:${r.weight};src:url('${file}') format('${CSS_FORMAT[r.format as BrandFontFormat] ?? 'woff2'}');}`)
  }
  return { css: css.join('\n'), files }
}
