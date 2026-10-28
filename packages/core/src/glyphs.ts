// Which characters the export can draw. The export has the bundled fonts (FONTS, each in the script subsets its
// @fontsource package ships) and, on the server, Noto Color Emoji and Noto CJK; anything else comes out as a box,
// although the preview may show it with a font from the viewer's own computer.

/**
 * Code point ranges (hex) each bundled font's @fontsource faces declare in their unicode-range, merged. Generated
 * from node_modules/@fontsource/<font>/<weight>.css; a core test keeps it in step with the installed packages.
 */
export const FONT_RANGES: Record<string, string> = {
  Inter: '0-2cc,2ce-2d7,2da,2dc-301,303-304,308-309,323,329,370-377,37a-37f,384-38a,38c,38e-3a1,3a3-52f,1c80-1c8a,1d00-1dbf,1e00-206f,20a0-20c0,2113,2116,2122,2191,2193,2212,2215,2c60-2c7f,2de0-2dff,a640-a69f,a720-a7ff,fe2e-fe2f,feff,fffd',
  'Space Grotesk': '0-2cc,2ce-2d7,2da,2dc-301,303-304,308-309,323,329,1d00-1dbf,1e00-1eff,2000-206f,20a0-20c0,2113,2122,2191,2193,2212,2215,2c60-2c7f,a720-a7ff,feff,fffd',
  'JetBrains Mono': '0-2cc,2ce-2d7,2da,2dc-301,303-304,308-309,323,329,370-377,37a-37f,384-38a,38c,38e-3a1,3a3-52f,1c80-1c8a,1d00-1dbf,1e00-1eff,2000-206f,20a0-20c0,2113,2116,2122,2191,2193,2212,2215,2c60-2c7f,2de0-2dff,a640-a69f,a720-a7ff,fe2e-fe2f,feff,fffd',
  Montserrat: '0-2cc,2ce-2d7,2da,2dc-301,303-304,308-309,323,329,400-52f,1c80-1c8a,1d00-1dbf,1e00-1eff,2000-206f,20a0-20c0,2113,2116,2122,2191,2193,2212,2215,2c60-2c7f,2de0-2dff,a640-a69f,a720-a7ff,fe2e-fe2f,feff,fffd',
  Poppins: '0-2cc,2ce-2d7,2da,2dc-2ff,304,308,329,900-97f,1cd0-1cf9,1d00-1dbf,1e00-1e9f,1ef2-1eff,2000-206f,20a0-20c0,20f0,2113,2122,2191,2193,2212,2215,25cc,2c60-2c7f,a720-a7ff,a830-a839,a8e0-a8ff,feff,fffd,11b00-11b09',
  'Playfair Display': '0-2cc,2ce-2d7,2da,2dc-301,303-304,308-309,323,329,400-45f,490-491,4b0-4b1,1d00-1dbf,1e00-1eff,2000-206f,20a0-20c0,2113,2116,2122,2191,2193,2212,2215,2c60-2c7f,a720-a7ff,feff,fffd',
  'Bebas Neue': '0-2cc,2ce-2d7,2da,2dc-2ff,304,308,329,1d00-1dbf,1e00-1e9f,1ef2-1eff,2000-206f,20a0-20c0,2113,2122,2191,2193,2212,2215,2c60-2c7f,a720-a7ff,feff,fffd',
  Oswald: '0-2cc,2ce-2d7,2da,2dc-301,303-304,308-309,323,329,400-52f,1c80-1c8a,1d00-1dbf,1e00-1eff,2000-206f,20a0-20c0,2113,2116,2122,2191,2193,2212,2215,2c60-2c7f,2de0-2dff,a640-a69f,a720-a7ff,fe2e-fe2f,feff,fffd',
  'Roboto Slab': '0-2cc,2ce-2d7,2da,2dc-301,303-304,308-309,323,329,370-377,37a-37f,384-38a,38c,38e-3a1,3a3-52f,1c80-1c8a,1d00-1dbf,1e00-206f,20a0-20c0,2113,2116,2122,2191,2193,2212,2215,2c60-2c7f,2de0-2dff,a640-a69f,a720-a7ff,fe2e-fe2f,feff,fffd',
  'DM Serif Display': '0-2cc,2ce-2d7,2da,2dc-2ff,304,308,329,1d00-1dbf,1e00-1e9f,1ef2-1eff,2000-206f,20a0-20c0,2113,2122,2191,2193,2212,2215,2c60-2c7f,a720-a7ff,feff,fffd',
  Caveat: '0-2cc,2ce-2d7,2da,2dc-2ff,301,304,308,329,400-52f,1c80-1c8a,1d00-1dbf,1e00-1e9f,1ef2-1eff,2000-206f,20a0-20c0,2113,2116,2122,2191,2193,2212,2215,2c60-2c7f,2de0-2dff,a640-a69f,a720-a7ff,fe2e-fe2f,feff,fffd',
  'IBM Plex Mono': '0-2cc,2ce-2d7,2da,2dc-301,303-304,308-309,323,329,400-52f,1c80-1c8a,1d00-1dbf,1e00-1eff,2000-206f,20a0-20c0,2113,2116,2122,2191,2193,2212,2215,2c60-2c7f,2de0-2dff,a640-a69f,a720-a7ff,fe2e-fe2f,feff,fffd',
}

/** Emoji (Noto Color Emoji) and Chinese, Japanese and Korean (Noto CJK): the server's system fonts draw these. */
export const SYSTEM_RANGES =
  '2190-21ff,2300-23ff,2460-24ff,25a0-27bf,2900-297f,2b00-2bff,2e80-2fdf,2ff0-303f,3040-30ff,3100-312f,3130-318f,3190-31ff,3200-32ff,3300-33ff,3400-4dbf,4e00-9fff,a960-a97f,ac00-d7ff,f900-faff,fe00-fe0f,fe30-fe4f,ff00-ffef,1f000-1faff,20000-2fa1f,e0020-e007f'

type Ranges = Array<[number, number]>
const parsed = new Map<string, Ranges>()

function ranges(spec: string): Ranges {
  let r = parsed.get(spec)
  if (!r) {
    r = spec.split(',').map((p) => {
      const [a, b] = p.split('-')
      return [parseInt(a, 16), parseInt(b ?? a, 16)] as [number, number]
    })
    parsed.set(spec, r)
  }
  return r
}

const inRanges = (cp: number, r: Ranges) => r.some(([a, b]) => cp >= a && cp <= b)

/** Joiners, variation selectors and other marks that are drawn as part of the character before them. */
const invisible = (cp: number) => cp <= 0x20 || (cp >= 0x7f && cp <= 0xa0) || cp === 0x1680 || (cp >= 0x2000 && cp <= 0x200f) || (cp >= 0x2028 && cp <= 0x202f) || (cp >= 0x205f && cp <= 0x2064) || cp === 0x3000 || cp === 0xfe0e || cp === 0xfe0f || cp === 0xfeff || (cp >= 0xe0020 && cp <= 0xe007f)

export interface GlyphReport {
  /** No font the export has draws these: they come out as boxes. */
  missing: string[]
  /** The chosen font hasn't got these: they are drawn in Inter. */
  fallback: string[]
  /** Emoji and CJK: the server's Noto fonts draw them, so they can look different from the preview. */
  system: string[]
}

/** The characters of `text` the export draws in another font than `family`, or can't draw at all. */
export function glyphReport(text: string, family: string): GlyphReport {
  const own = ranges(FONT_RANGES[family] ?? FONT_RANGES.Inter)
  const inter = ranges(FONT_RANGES.Inter)
  const system = ranges(SYSTEM_RANGES)
  const out: GlyphReport = { missing: [], fallback: [], system: [] }
  const seen = new Set<string>()
  for (const ch of text) {
    const cp = ch.codePointAt(0)!
    if (seen.has(ch) || invisible(cp)) continue
    seen.add(ch)
    if (inRanges(cp, own)) continue
    if (inRanges(cp, inter)) out.fallback.push(ch)
    else if (inRanges(cp, system)) out.system.push(ch)
    else out.missing.push(ch)
  }
  return out
}
