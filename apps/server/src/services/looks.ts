// Producer visual looks (from the producer-pipeline skill templates, with a built-in fallback) and the
// starter projects built from them.
import fs from 'node:fs'
import path from 'node:path'
import {
  ASPECT_RATIOS,
  FONTS,
  createProject,
  createShapeItem,
  createTextItem,
  createTrack,
  defaultTextStyle,
  type BrandKitDoc,
  type Project,
  type TextItem,
  type TextStyle,
} from '@producer/core'
import { ctx } from '../context'

export interface Look {
  id: string
  name: string
  tagline: string
  aspect: '16:9' | '9:16' | '1:1'
  dark: boolean
  canvas: string
  accent: string
  ink: string
  headlineFont: string
  labelFont: string
  category: string
  previewPath?: string
}

const CATEGORY: Record<string, string> = {
  'studio-dark': 'Business',
  'boardroom-slate': 'Business',
  'editorial-light': 'Editorial',
  'cinema-fullbleed': 'Cinematic',
  'social-vertical': 'Social',
  'minimal-mono': 'Minimal',
  'sunrise-warm': 'Warm',
  'blueprint-grid': 'Technical',
}

const BUILTIN: Look[] = [
  { id: 'studio-dark', name: 'Studio Dark', tagline: 'Navy canvas, framed footage, story cards. The house look.', aspect: '16:9', dark: true, canvas: '#0b1830', accent: '#ff5a5f', ink: '#f3f5fa', headlineFont: 'Montserrat', labelFont: 'IBM Plex Mono', category: 'Business' },
  { id: 'editorial-light', name: 'Editorial Light', tagline: 'Warm paper canvas, ink type, strong rules.', aspect: '16:9', dark: false, canvas: '#f6f2ea', accent: '#d8232a', ink: '#15171c', headlineFont: 'Montserrat', labelFont: 'IBM Plex Mono', category: 'Editorial' },
  { id: 'cinema-fullbleed', name: 'Cinema Full-Bleed', tagline: 'Footage fills the frame under a dark scrim.', aspect: '16:9', dark: true, canvas: '#07090f', accent: '#ff5a5f', ink: '#f5f6fa', headlineFont: 'Montserrat', labelFont: 'IBM Plex Mono', category: 'Cinematic' },
  { id: 'social-vertical', name: 'Social Vertical', tagline: '9:16 for Reels and Shorts: footage on top, big type below.', aspect: '9:16', dark: true, canvas: '#0b1830', accent: '#ff5a5f', ink: '#f3f5fa', headlineFont: 'Montserrat', labelFont: 'IBM Plex Mono', category: 'Social' },
  { id: 'minimal-mono', name: 'Minimal Mono', tagline: 'Black and white, hairline frames, one enormous headline.', aspect: '16:9', dark: true, canvas: '#0a0a0a', accent: '#ffffff', ink: '#f2f2f2', headlineFont: 'Bebas Neue', labelFont: 'IBM Plex Mono', category: 'Minimal' },
  { id: 'sunrise-warm', name: 'Sunrise Warm', tagline: 'Deep plum canvas with warm glows.', aspect: '16:9', dark: true, canvas: '#1a0f24', accent: '#ff8a3d', ink: '#fff4ea', headlineFont: 'Montserrat', labelFont: 'IBM Plex Mono', category: 'Warm' },
  { id: 'blueprint-grid', name: 'Blueprint Grid', tagline: 'Light technical grid, mono annotations.', aspect: '16:9', dark: false, canvas: '#eef3f8', accent: '#1f6feb', ink: '#0f1a2b', headlineFont: 'Oswald', labelFont: 'JetBrains Mono', category: 'Technical' },
  { id: 'boardroom-slate', name: 'Boardroom Slate', tagline: 'Slate canvas, large numerals, split screen.', aspect: '16:9', dark: true, canvas: '#1e232c', accent: '#4fd1c5', ink: '#eef1f6', headlineFont: 'Montserrat', labelFont: 'IBM Plex Mono', category: 'Business' },
]

/** Map a template font to one the renderer bundles. */
export function mapFont(f: string | undefined, fallback = 'Montserrat'): string {
  if (!f) return fallback
  if ((FONTS as readonly string[]).includes(f)) return f
  const alias: Record<string, string> = { 'League Gothic': 'Bebas Neue', 'Space Mono': 'JetBrains Mono', 'Roboto Mono': 'JetBrains Mono', Anton: 'Bebas Neue', 'DM Sans': 'Inter', Manrope: 'Inter' }
  return alias[f] ?? fallback
}

let cache: { at: number; looks: Look[] } | undefined

export function loadLooks(): Look[] {
  if (cache && Date.now() - cache.at < 60_000) return cache.looks
  const dir = path.join(ctx().config.producerSkillDir, 'templates')
  const out: Look[] = []
  try {
    for (const id of fs.readdirSync(dir).sort()) {
      const f = path.join(dir, id, 'template.json')
      if (!fs.existsSync(f)) continue
      try {
        const t = JSON.parse(fs.readFileSync(f, 'utf8')) as {
          id?: string
          name?: string
          tagline?: string
          aspect?: string
          canvas?: string
          preview?: string
          brand?: { primary?: string; accent?: string; ink?: string; headlineFont?: string; labelFont?: string }
        }
        const fb = BUILTIN.find((b) => b.id === id)
        const preview = t.preview ? path.join(dir, id, t.preview) : undefined
        out.push({
          id,
          name: t.name ?? fb?.name ?? id,
          tagline: t.tagline ?? fb?.tagline ?? '',
          aspect: (t.aspect === '9:16' || t.aspect === '1:1' ? t.aspect : '16:9') as Look['aspect'],
          dark: (t.canvas ?? 'dark') !== 'light',
          canvas: t.brand?.primary ?? fb?.canvas ?? '#0b1830',
          accent: t.brand?.accent ?? fb?.accent ?? '#ff5a5f',
          ink: t.brand?.ink ?? fb?.ink ?? '#ffffff',
          headlineFont: mapFont(t.brand?.headlineFont),
          labelFont: mapFont(t.brand?.labelFont, 'IBM Plex Mono'),
          category: CATEGORY[id] ?? 'Producer',
          previewPath: preview && fs.existsSync(preview) ? preview : undefined,
        })
      } catch {
        /* skip malformed template */
      }
    }
  } catch {
    /* no skill dir */
  }
  const looks = out.length ? out : BUILTIN
  cache = { at: Date.now(), looks }
  return looks
}

export function getLook(id: string | undefined): Look {
  const looks = loadLooks()
  return looks.find((l) => l.id === id) ?? looks.find((l) => l.id === 'studio-dark') ?? looks[0] ?? BUILTIN[0]
}

export function sizeForAspect(aspect: string): { width: number; height: number } {
  const a = ASPECT_RATIOS.find((r) => r.id === aspect)
  return a ? { width: a.width, height: a.height } : { width: 1920, height: 1080 }
}

/** Palette of a look with brand-kit overrides (brand colours: [canvas, accent, ink, ...]). */
export function lookPalette(look: Look, brand?: BrandKitDoc | null) {
  const c = brand?.colors ?? []
  return {
    canvas: c[0] ?? look.canvas,
    accent: c[1] ?? look.accent,
    ink: c[2] ?? look.ink,
    headlineFont: brand?.fonts?.headline ? mapFont(brand.fonts.headline) : look.headlineFont,
    bodyFont: brand?.fonts?.body ? mapFont(brand.fonts.body, 'Inter') : 'Inter',
    labelFont: look.labelFont,
  }
}

export type Palette = ReturnType<typeof lookPalette>

/** Readable text colour on top of `bg` (white, or `dark` when bg is light). */
export function onColor(bg: string, dark = '#111111'): string {
  const h = bg.replace('#', '')
  const f = h.length === 3 ? h.split('').map((c) => c + c).join('') : h.slice(0, 6)
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(f.slice(i, i + 2), 16) / 255)
  const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b
  return lum > 0.6 ? dark : '#ffffff'
}

const weightFor = (font: string, w: number) => (font === 'Bebas Neue' || font === 'DM Serif Display' ? 400 : w)

export function headlineStyle(pal: Palette, width: number, size: number, over: Partial<TextStyle> = {}): TextStyle {
  return defaultTextStyle({ fontFamily: pal.headlineFont, fontSize: size, fontWeight: weightFor(pal.headlineFont, 900), color: pal.ink, letterSpacing: -1, lineHeight: 1.05, boxWidth: Math.round(width * 0.8), ...over })
}

export function labelStyle(pal: Palette, width: number, size: number, over: Partial<TextStyle> = {}): TextStyle {
  return defaultTextStyle({ fontFamily: pal.labelFont, fontSize: size, fontWeight: 600, color: pal.accent, uppercase: true, letterSpacing: Math.round(size * 0.18), boxWidth: Math.round(width * 0.8), ...over })
}

function text(start: number, duration: number, value: string, style: TextStyle, y: number, anim: TextItem['animations'], x = 0): TextItem {
  return createTextItem(start, 'heading', { name: value, text: value, duration, style, transform: { x, y, scale: 1, rotation: 0 }, animations: anim })
}

/** Starter project for a built-in look: title card, lower third, close card (all editable text). */
export function starterProject(look: Look, opts: { name?: string; brand?: BrandKitDoc | null; aspect?: string } = {}): Project {
  const { width, height } = sizeForAspect(opts.aspect ?? look.aspect)
  const pal = lookPalette(look, opts.brand)
  const vertical = height > width
  const p = createProject({ name: opts.name ?? look.name, width, height, background: pal.canvas })
  const bg = createTrack('overlay', { name: 'Cards' })
  const texts = createTrack('text', { name: 'Titles' })
  const scale = Math.min(width, height) / 1080
  // title card 0–4 s
  bg.items.push(createShapeItem(0, { name: 'Title card', duration: 4, width, height, fill: pal.canvas, radius: 0, animations: { out: { preset: 'fade', duration: 0.4 } } }))
  texts.items.push(text(0.3, 3.7, 'Your headline here', headlineStyle(pal, width, Math.round((vertical ? 110 : 128) * scale)), -40 * scale, { in: { preset: 'rise', duration: 0.6 }, out: { preset: 'fade', duration: 0.4 } }))
  texts.items.push(text(0.6, 3.4, 'Subtitle · Presenter', labelStyle(pal, width, Math.round(30 * scale)), 90 * scale, { in: { preset: 'fade', duration: 0.5 }, out: { preset: 'fade', duration: 0.4 } }))
  // lower third 4–8 s
  const ltY = vertical ? height * 0.3 : height * 0.36
  const ltX = vertical ? 0 : -width * 0.22
  texts.items.push(
    text(
      4.4,
      3.4,
      'Jordan Lee · Product Lead',
      defaultTextStyle({ fontFamily: pal.bodyFont, fontSize: Math.round(44 * scale), fontWeight: 700, color: onColor(pal.accent, pal.canvas), align: vertical ? 'center' : 'left', boxWidth: Math.round(width * (vertical ? 0.8 : 0.45)), background: { color: pal.accent, radius: 10, padding: 20, opacity: 0.95 } }),
      ltY,
      { in: { preset: 'wipeRight', duration: 0.5 }, out: { preset: 'fade', duration: 0.4 } },
      ltX,
    ),
  )
  // close card 8–11 s
  bg.items.push(createShapeItem(8, { name: 'Close card', duration: 3, width, height, fill: pal.canvas, radius: 0, animations: { in: { preset: 'fade', duration: 0.5 } } }))
  texts.items.push(text(8.3, 2.7, 'Thanks for watching', headlineStyle(pal, width, Math.round(96 * scale)), -30 * scale, { in: { preset: 'slideUp', duration: 0.6 } }))
  texts.items.push(text(8.6, 2.4, 'yourcompany.com', labelStyle(pal, width, Math.round(30 * scale)), 70 * scale, { in: { preset: 'fade', duration: 0.5 } }))
  p.tracks.push(bg, texts)
  return p
}
