// A library clip "in your brand" (21 Nov 2026, the owner: "the branding doesn't need to affect the animations so much as
// the Narrative Text, Titles, Thumbnail, company stamp/logo"): the clip goes on the timeline as it is, with the brand
// kit's words and mark laid over it as ordinary editor items, all editable afterwards: a title in the brand's headline
// font on its colours, a line of narrative text in its body font, and its logo stamped in a corner (or its name, while
// the kit has no logo). No AI and no cost.
import { type Asset, type BrandKitDoc, type ImageItem, type Item, type TextItem, addAsset, addItem, clone, contrastRatio, createImageItem, createTextItem, insertTrack, itemEnd, logoStamp, stampCorner } from '@producer/core'
import * as A from './actions'
import { useEditor } from './store'

export interface BrandOverlay {
  title?: string
  text?: string
  /** Stamp the logo (or the brand's name) over the clip. */
  stamp: boolean
}

/** The kit's colours by their place (Brand kit page: background, accent, text, then extras). */
export function brandColours(b: Pick<BrandKitDoc, 'colors'>) {
  const [canvas = '#0b1830', accent = '#ff5a5f', ink = '#ffffff'] = b.colors
  return { canvas, accent, ink }
}

/** White or near-black, whichever reads better on `bg`. */
export function textOn(bg: string): string {
  return contrastRatio(bg, '#ffffff') >= contrastRatio(bg, '#111111') ? '#ffffff' : '#111111'
}

/**
 * Puts `clip` at the playhead with the brand laid over it; returns the clip's timeline id. The overlays span the clip:
 * the title over its first half (all of it without a text), the text over the rest, the stamp over the whole clip.
 */
export function addClipInBrand(clip: Asset, brand: BrandKitDoc, o: BrandOverlay, logo?: Asset): string | undefined {
  const clipId = A.addAssetAt(clip, useEditor.getState().playhead)
  if (!clipId) return undefined
  const s = useEditor.getState()
  let p = s.project
  const placed = p.tracks.flatMap((t) => t.items).find((i) => i.id === clipId)
  if (!placed) return clipId
  const start = placed.start
  const end = itemEnd(placed)
  const span = end - start
  const canvas = { width: p.width, height: p.height }
  const { canvas: bg, accent, ink } = brandColours(brand)
  const title = o.title?.trim()
  const text = o.text?.trim()
  const added: Item[] = []
  const lower = (words: string, at: number, until: number, kind: 'title' | 'text'): TextItem => {
    const box = kind === 'title' ? bg : accent
    const it = createTextItem(at, kind === 'title' ? 'lower-third' : 'lower-accent', {}, canvas)
    return {
      ...it,
      name: words,
      text: words,
      duration: Math.max(1, until - at),
      style: {
        ...it.style,
        fontFamily: kind === 'title' ? brand.fonts.headline : brand.fonts.body,
        fontWeight: kind === 'title' ? 700 : 500,
        color: kind === 'title' && contrastRatio(ink, box) >= 3 ? ink : textOn(box),
        background: { ...(it.style.background ?? { radius: 10, padding: 20, opacity: 0.92 }), color: box },
      },
    }
  }
  const lead = Math.min(0.3, span / 10)
  if (title && text) {
    const mid = start + span / 2
    added.push(lower(title, start + lead, mid, 'title'), lower(text, mid, end - lead, 'text'))
  } else if (title) added.push(lower(title, start + lead, end - lead, 'title'))
  else if (text) added.push(lower(text, start + lead, end - lead, 'text'))
  if (o.stamp) {
    if (logo && logo.width && logo.height) {
      // the logo, about 12% of the frame across (or tall, for a tall logo), in the corner
      const { scale, x, y } = logoStamp(canvas, { width: logo.width, height: logo.height })
      const img: ImageItem = createImageItem(logo, start, { name: `${brand.name} logo`, duration: span, opacity: 0.9 })
      img.transform = { ...img.transform, x, y, scale }
      added.push(img)
    } else {
      // no logo in the kit yet: its name, small, in the headline font
      const size = Math.round(Math.min(canvas.width, canvas.height) * 0.035)
      const it = createTextItem(start, 'body', {}, canvas)
      const name = brand.name || 'Your brand'
      const w = Math.min(canvas.width * 0.5, name.length * size * 0.6)
      added.push({ ...it, name: `${name} stamp`, text: name, duration: span, opacity: 0.85, style: { ...it.style, fontFamily: brand.fonts.headline, fontSize: size, fontWeight: 700, color: '#ffffff' }, transform: { ...it.transform, ...stampCorner(canvas, w, size * 1.3) }, animations: {} })
    }
  }
  if (!added.length) return clipId
  for (const it of added) {
    if (it.type === 'image') {
      // a picture with no track named would go onto the main track: the logo gets its own track, on top
      p = clone(p)
      if (logo && !p.assets[logo.id]) p = addAsset(p, logo)
      const t = insertTrack(p, 'overlay')
      p = addItem(p, it, t.id)
    } else p = addItem(p, it)
  }
  s.commit(p, 'Add the brand over the clip', { selection: [clipId] })
  return clipId
}
