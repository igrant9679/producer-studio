import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { FONTS } from '@producer/core'
import { REPO_ROOT } from '../config'
import { PREVIEW_FACES, buildFontFaces, fontSlug } from '../render/fonts'

/** The @font-face rules for one family: weight, style and file. */
function faces(css: string, family: string) {
  return [...css.matchAll(/@font-face\{([^}]*)\}/g)]
    .map((m) => m[1])
    .filter((b) => b.includes(`font-family:'${family}'`))
    .map((b) => ({ weight: b.match(/font-weight:([^;]+);/)![1], style: b.match(/font-style:(\w+)/)![1], file: b.match(/url\('fonts\/([^']+)'\)/)![1] }))
}

describe('export fonts (PIP-15)', () => {
  const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ps-fonts-'))

  it('carries the Cyrillic, Greek and Vietnamese subsets, not only Latin', () => {
    const out = dir()
    const { css, files } = buildFontFaces([{ family: 'Inter', weight: 700, italic: false }], out)
    const inter700 = faces(css, 'Inter').filter((f) => f.weight === '700').map((f) => f.file)
    for (const subset of ['latin', 'latin-ext', 'cyrillic', 'cyrillic-ext', 'greek', 'greek-ext', 'vietnamese']) {
      expect(inter700).toContain(`inter-${subset}-700-normal.woff2`)
      expect(fs.existsSync(path.join(out, 'fonts', `inter-${subset}-700-normal.woff2`))).toBe(true)
    }
    expect(files.length).toBe(new Set(files).size)
  })

  it('declares exactly the faces the preview loads, so both pick (or synthesise) the same one', () => {
    const { css } = buildFontFaces(
      [
        { family: 'Montserrat', weight: 600, italic: false },
        { family: 'Bebas Neue', weight: 900, italic: false },
        { family: 'Playfair Display', weight: 700, italic: true },
      ],
      dir(),
    )
    const weights = (family: string, style = 'normal') => [...new Set(faces(css, family).filter((f) => f.style === style).map((f) => f.weight))].sort()
    // the preview has Montserrat 500/700/900: a 600 title renders as 700 in both
    expect(weights('Montserrat')).toEqual(['500', '700', '900'])
    // the preview has only Bebas Neue 400 and lets the browser embolden it for 900: the export must too
    expect(weights('Bebas Neue')).toEqual(['400'])
    expect(weights('Playfair Display', 'italic')).toEqual(['600', '700'])
    // Inter is every text's fallback
    expect(weights('Inter')).toEqual(['400', '500', '600', '700', '800', '900'])
  })

  it("matches the web app's font imports", () => {
    const src = fs.readFileSync(path.join(REPO_ROOT, 'apps', 'web', 'src', 'lib', 'fonts.ts'), 'utf8')
    const loaded = [...src.matchAll(/@fontsource\/([\w-]+)\/(\d{3})(-italic)?\.css/g)].map((m) => `${m[1]} ${m[2]}${m[3] ?? ''}`).sort()
    const declared = Object.entries(PREVIEW_FACES)
      .flatMap(([family, f]) => [...f.normal.map((w) => `${fontSlug(family)} ${w}`), ...(f.italic ?? []).map((w) => `${fontSlug(family)} ${w}-italic`)])
      .sort()
    expect(declared).toEqual(loaded)
    expect(Object.keys(PREVIEW_FACES).sort()).toEqual([...FONTS].sort())
  })
})
