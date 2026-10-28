// Brand kits (A-21): several kits per space, font files uploaded for them, and the colour checks the Brand kit page
// shows (WCAG contrast between the kit's colours).
import type { BrandKitDoc } from './api'

/** The space's default kit is the one Producer AI, templates and new projects use unless another is picked. */
export const DEFAULT_KIT_ID = 'default'

/** Most kits a space keeps besides its default. */
export const MAX_EXTRA_KITS = 24

// GET    /api/workspaces/:id/brand-kits                     -> BrandKitList   (viewer+)
// POST   /api/workspaces/:id/brand-kits  {doc, from?}       -> BrandKitSummary (editor+; `from` copies a kit)
// GET    /api/workspaces/:id/brand-kits/:kitId              -> BrandKitSummary (ETag)
// PUT    /api/workspaces/:id/brand-kits/:kitId  BrandKitDoc -> BrandKitSummary (editor+; If-Match)
// DELETE /api/workspaces/:id/brand-kits/:kitId              -> {ok}  (editor+; not the default)
// POST   /api/workspaces/:id/brand-kits/:kitId/default      -> BrandKitList (editor+; the kit becomes the default, the
//        old default stays as another kit)
// POST   /api/workspaces/:id/brand/palette {assetId}        -> {colors}  colours from a logo image in the space
// GET    /api/workspaces/:id/brand/fonts                    -> BrandFont[]  (viewer+)
// POST   /api/workspaces/:id/brand/fonts?family=&weight=&italic=  raw font bytes -> BrandFont (editor+; ≤ 5 MB)
// DELETE /api/workspaces/:id/brand/fonts/:fontId            -> {ok} (editor+)
// GET    /api/workspaces/:id/brand/fonts/:fontId/file       -> the font file (viewer+)
export interface BrandKitSummary {
  id: string
  default: boolean
  doc: BrandKitDoc
  updatedAt: number | null
  etag?: string
}

export interface BrandKitList {
  items: BrandKitSummary[]
}

export type BrandFontFormat = 'woff2' | 'woff' | 'ttf' | 'otf'

/** A font file uploaded to a space: every kit in the space can use its family. */
export interface BrandFont {
  id: string
  family: string
  format: BrandFontFormat
  weight: number
  italic: boolean
  sizeBytes: number
  /** Where the browser fetches it (`/api/workspaces/:ws/brand/fonts/:id/file`). */
  url: string
}

export const BRAND_FONT_MAX_BYTES = 5 * 1024 * 1024

export const FONT_MIME: Record<BrandFontFormat, string> = { woff2: 'font/woff2', woff: 'font/woff', ttf: 'font/ttf', otf: 'font/otf' }

/** What a font file is, from its first bytes (never its name): woff2, woff, TrueType or OpenType; null for anything else. */
export function sniffFontFormat(bytes: Uint8Array): BrandFontFormat | null {
  if (bytes.length < 4) return null
  const tag = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3])
  if (tag === 'wOF2') return 'woff2'
  if (tag === 'wOFF') return 'woff'
  if (tag === 'OTTO') return 'otf'
  if ((bytes[0] === 0 && bytes[1] === 1 && bytes[2] === 0 && bytes[3] === 0) || tag === 'true') return 'ttf'
  return null
}

/** A family name a font file can be given: letters, digits, spaces and - _ . ' & (no quotes or CSS). */
export function cleanFamily(name: string): string {
  return name
    .replace(/[^\p{L}\p{N} _.&-]/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60)
}

// ---------- colour checks ----------

export function isHexColour(v: string): boolean {
  return /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(v)
}

/** #rgb / #rrggbb to 0..255 channels (null when it isn't one). */
export function hexToRgb(hex: string): [number, number, number] | null {
  if (!isHexColour(hex)) return null
  let h = hex.slice(1)
  if (h.length === 3) h = h.split('').map((c) => c + c).join('')
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) as [number, number, number]
}

export function rgbToHex(r: number, g: number, b: number): string {
  const c = (v: number) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')
  return `#${c(r)}${c(g)}${c(b)}`
}

/** WCAG relative luminance 0..1. */
export function relativeLuminance(hex: string): number {
  const rgb = hexToRgb(hex)
  if (!rgb) return 0
  const [r, g, b] = rgb.map((v) => {
    const c = v / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

/** WCAG contrast ratio between two colours, 1..21. */
export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a)
  const lb = relativeLuminance(b)
  const [hi, lo] = la > lb ? [la, lb] : [lb, la]
  return Math.round(((hi + 0.05) / (lo + 0.05)) * 100) / 100
}

/** What a ratio passes: AAA (7), AA (4.5, body text), AA large (3, headlines and captions over 24 px), or nothing. */
export type ContrastGrade = 'AAA' | 'AA' | 'AA large' | 'Fail'

export function contrastGrade(ratio: number): ContrastGrade {
  if (ratio >= 7) return 'AAA'
  if (ratio >= 4.5) return 'AA'
  if (ratio >= 3) return 'AA large'
  return 'Fail'
}

export interface ContrastPair {
  fg: string
  bg: string
  ratio: number
  grade: ContrastGrade
}

/**
 * Text-on-background pairs worth checking in a kit: each colour as text on the darkest and on the lightest colour
 * (where the two differ), best first. Pairs of a colour on itself are left out.
 */
export function contrastPairs(colors: string[]): ContrastPair[] {
  const hex = [...new Set(colors.filter(isHexColour).map((c) => c.toLowerCase()))]
  if (hex.length < 2) return []
  const byLum = [...hex].sort((a, b) => relativeLuminance(a) - relativeLuminance(b))
  const grounds = [...new Set([byLum[0], byLum[byLum.length - 1]])]
  const out: ContrastPair[] = []
  for (const bg of grounds)
    for (const fg of hex) {
      if (fg === bg) continue
      const ratio = contrastRatio(fg, bg)
      out.push({ fg, bg, ratio, grade: contrastGrade(ratio) })
    }
  return out.sort((a, b) => b.ratio - a.ratio)
}
