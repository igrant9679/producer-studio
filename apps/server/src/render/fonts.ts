// @font-face CSS for the fonts a project uses, from the bundled @fontsource packages: the same faces the editor
// preview loads, in every script subset they ship (Latin, Cyrillic, Greek, Vietnamese...). Emoji and CJK come from
// the system's Noto fonts (Dockerfile), as the preview's come from the viewer's system.
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import type { Project } from '@producer/core'

const require = createRequire(import.meta.url)

export interface FontUse {
  family: string
  weight: number
  italic: boolean
}

/**
 * The faces the web app loads for each bundled font (apps/web/src/lib/fonts.ts; a test keeps the two in step). The
 * export declares exactly these at their own weights, so for any weight a text asks for the browser picks the same
 * face, or synthesises the same bold or italic, in the preview and the export.
 */
export const PREVIEW_FACES: Record<string, { normal: number[]; italic?: number[] }> = {
  Inter: { normal: [400, 500, 600, 700, 800, 900] },
  'Space Grotesk': { normal: [500, 700] },
  'JetBrains Mono': { normal: [400, 500] },
  Montserrat: { normal: [500, 700, 900] },
  Poppins: { normal: [500, 700] },
  'Playfair Display': { normal: [600, 700], italic: [600, 700] },
  'Bebas Neue': { normal: [400] },
  Oswald: { normal: [500, 700] },
  'Roboto Slab': { normal: [500, 700] },
  'DM Serif Display': { normal: [400] },
  Caveat: { normal: [600] },
  'IBM Plex Mono': { normal: [500] },
}

export function fontSlug(family: string): string {
  return family.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
}

export function fontsUsed(p: Project): FontUse[] {
  const set = new Map<string, FontUse>()
  const add = (family: string, weight: number, italic: boolean) => {
    const k = `${family}|${weight}|${italic}`
    if (!set.has(k)) set.set(k, { family, weight, italic })
  }
  add('Inter', 400, false)
  for (const t of p.tracks) {
    if (t.captionStyle) {
      const s = t.captionStyle.style
      add(s.fontFamily, s.fontWeight, s.italic)
    }
    for (const it of t.items) if (it.type === 'text') add(it.style.fontFamily, it.style.fontWeight, it.style.italic)
  }
  return [...set.values()]
}

function packageDir(family: string): string | null {
  try {
    return path.dirname(require.resolve(`@fontsource/${fontSlug(family)}/package.json`))
  } catch {
    return null
  }
}

/**
 * Copy the woff2 files of every preview face of each used family (and Inter, every text's fallback) into
 * `outDir/fontsDirName` and return @font-face CSS pointing at them. Families the preview doesn't load are skipped
 * (both fall back to Inter).
 */
export function buildFontFaces(uses: FontUse[], outDir: string, fontsDirName = 'fonts'): { css: string; files: string[] } {
  const css: string[] = []
  const files: string[] = []
  fs.mkdirSync(path.join(outDir, fontsDirName), { recursive: true })
  for (const family of new Set(['Inter', ...uses.map((u) => u.family)])) {
    const faces = PREVIEW_FACES[family]
    const dir = faces && packageDir(family)
    if (!faces || !dir) continue
    const styles: Array<[boolean, number[]]> = [
      [false, faces.normal],
      [true, faces.italic ?? []],
    ]
    for (const [italic, weights] of styles)
      for (const weight of weights) {
        const file = path.join(dir, `${weight}${italic ? '-italic' : ''}.css`)
        if (!fs.existsSync(file)) continue
        for (const b of fs.readFileSync(file, 'utf8').match(/@font-face\s*\{[^}]*\}/g) ?? []) {
          const woff2 = b.match(/url\(\.\/files\/([^)]+\.woff2)\)/)?.[1]
          if (!woff2) continue
          const from = path.join(dir, 'files', woff2)
          if (!fs.existsSync(from)) continue
          const to = path.join(outDir, fontsDirName, woff2)
          if (!fs.existsSync(to)) {
            fs.copyFileSync(from, to)
            files.push(`${fontsDirName}/${woff2}`)
          }
          const range = b.match(/unicode-range:\s*([^;]+);/)?.[1]
          css.push(
            `@font-face{font-family:'${family}';font-style:${italic ? 'italic' : 'normal'};font-display:block;font-weight:${weight};src:url('${fontsDirName}/${woff2}') format('woff2');${range ? `unicode-range:${range};` : ''}}`,
          )
        }
      }
  }
  return { css: css.join('\n'), files }
}
