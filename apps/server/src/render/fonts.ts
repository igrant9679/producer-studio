// @font-face CSS for the fonts a project uses, from the bundled @fontsource packages (latin + latin-ext).
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

function availableWeights(dir: string, italic: boolean): number[] {
  const out = new Set<number>()
  for (const f of fs.readdirSync(dir)) {
    const m = f.match(italic ? /^(\d{3})-italic\.css$/ : /^(\d{3})\.css$/)
    if (m) out.add(Number(m[1]))
  }
  return [...out].sort((a, b) => a - b)
}

/**
 * Copy the woff2 files for every used font into `outDir/fontsDirName` and return @font-face CSS pointing at them.
 * Unknown families are skipped (the renderer falls back to Inter).
 */
export function buildFontFaces(uses: FontUse[], outDir: string, fontsDirName = 'fonts'): { css: string; files: string[] } {
  const css: string[] = []
  const files: string[] = []
  const done = new Set<string>()
  fs.mkdirSync(path.join(outDir, fontsDirName), { recursive: true })
  for (const u of uses) {
    const dir = packageDir(u.family)
    if (!dir) continue
    let italic = u.italic
    let weights = availableWeights(dir, italic)
    if (!weights.length && italic) {
      italic = false
      weights = availableWeights(dir, false)
    }
    if (!weights.length) continue
    const weight = weights.reduce((best, w) => (Math.abs(w - u.weight) < Math.abs(best - u.weight) ? w : best), weights[0])
    const key = `${u.family}|${weight}|${italic}`
    if (done.has(key)) continue
    done.add(key)
    const src = fs.readFileSync(path.join(dir, `${weight}${italic ? '-italic' : ''}.css`), 'utf8')
    const blocks = src.match(/\/\*\s*[\w-]+\s*\*\/\s*@font-face\s*\{[^}]*\}/g) ?? []
    for (const b of blocks) {
      const name = b.match(/\/\*\s*([\w-]+)\s*\*\//)?.[1] ?? ''
      if (!/-latin-(ext-)?\d{3}-(normal|italic)$/.test(name)) continue
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
      // declare the requested weight too so the browser doesn't synthesise bold for e.g. Bebas Neue 900
      css.push(
        `@font-face{font-family:'${u.family}';font-style:${italic ? 'italic' : 'normal'};font-display:block;font-weight:${weight === u.weight ? weight : `${Math.min(weight, u.weight)} ${Math.max(weight, u.weight)}`};src:url('${fontsDirName}/${woff2}') format('woff2');${range ? `unicode-range:${range};` : ''}}`,
      )
    }
  }
  return { css: css.join('\n'), files }
}
