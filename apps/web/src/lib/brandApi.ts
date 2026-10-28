// Brand kits, their font files and colours from a logo (A-21). Contract: packages/core/src/brand.ts.
import type { BrandFont, BrandKitDoc, BrandKitList, BrandKitSummary, Project, TemplateSummary } from '@producer/core'
import { HttpError, noteStatus, req } from './api'

const base = (ws: string) => `/workspaces/${ws}`

export const brandApi = {
  kits: (ws: string) => req<BrandKitList>('GET', `${base(ws)}/brand-kits`),
  /** A new kit: `doc`, or a copy of kit `from` (the default when neither is given). */
  createKit: (ws: string, body: { doc?: BrandKitDoc; from?: string; name?: string }) => req<BrandKitSummary>('POST', `${base(ws)}/brand-kits`, body),
  /** `etag`: the kit's base; a save made elsewhere since is refused (412). */
  saveKit: (ws: string, kitId: string, doc: BrandKitDoc, etag?: string) => req<BrandKitSummary>('PUT', `${base(ws)}/brand-kits/${kitId}`, doc, { ifMatch: etag ?? null }),
  deleteKit: (ws: string, kitId: string) => req<{ ok: true }>('DELETE', `${base(ws)}/brand-kits/${kitId}`),
  makeDefault: (ws: string, kitId: string) => req<BrandKitList>('POST', `${base(ws)}/brand-kits/${kitId}/default`),
  /** The main colours of a logo image in the space. */
  palette: (ws: string, assetId: string) => req<{ colors: string[] }>('POST', `${base(ws)}/brand/palette`, { assetId }),
  fonts: (ws: string) => req<BrandFont[]>('GET', `${base(ws)}/brand/fonts`),
  deleteFont: (ws: string, fontId: string) => req<{ ok: true }>('DELETE', `${base(ws)}/brand/fonts/${fontId}`),
  /** Upload a font file as `family` (the server checks it is a WOFF2, WOFF, TTF or OTF). */
  async uploadFont(ws: string, file: Blob, opts: { family: string; weight?: number; italic?: boolean }): Promise<BrandFont> {
    const q = new URLSearchParams({ family: opts.family, weight: String(opts.weight ?? 400), italic: opts.italic ? '1' : '0' })
    const path = `${base(ws)}/brand/fonts?${q}`
    const res = await fetch(`/api${path}`, { method: 'POST', credentials: 'include', headers: { 'content-type': 'application/octet-stream' }, body: file })
    noteStatus(path, res.status)
    if (!res.ok) {
      let err = { error: res.statusText }
      try {
        err = await res.json()
      } catch {
        /* non-JSON error */
      }
      throw new HttpError(res.status, err)
    }
    return (await res.json()) as BrandFont
  },
}

const docs = new Map<string, Promise<Project>>()

/** Templates made from looks and kits (A-22). */
export const templateApi = {
  /** A built-in look's starter project, as `aspect` with the space's kit `kitId` (cached for the page's life). */
  doc(id: string, o: { workspaceId?: string; aspect?: string; kitId?: string } = {}): Promise<Project> {
    const q = new URLSearchParams()
    if (o.workspaceId) q.set('workspaceId', o.workspaceId)
    if (o.aspect) q.set('aspect', o.aspect)
    if (o.kitId) q.set('kitId', o.kitId)
    const s = q.toString()
    const path = `/templates/${id.replace(/[^A-Za-z0-9:_-]/g, '')}/doc${s ? `?${s}` : ''}`
    let p = docs.get(path)
    if (!p) {
      p = req<Project>('GET', path)
      p.catch(() => docs.delete(path))
      docs.set(path, p)
    }
    return p
  },
  /** A team template from a built-in look and a brand kit. */
  fromBrand: (body: { workspaceId: string; lookId: string; kitId?: string; aspect?: string; name?: string }) => req<TemplateSummary>('POST', '/templates/from-brand', body),
}

/** A family name from a font file's name: "AcmeSans-Bold.woff2" → "AcmeSans". */
export function familyFromFileName(name: string): string {
  return name
    .replace(/\.[a-z0-9]+$/i, '')
    .replace(/[-_ ](thin|extralight|light|regular|book|medium|semibold|bold|extrabold|black|heavy|italic|oblique|\d{3})+$/i, '')
    .replace(/[-_]+/g, ' ')
    .trim()
}

/** A weight from a font file's name ("…-Bold" → 700), else 400. */
export function weightFromFileName(name: string): number {
  const n = name.toLowerCase()
  const table: Array<[RegExp, number]> = [
    [/extrabold|ultrabold/, 800],
    [/semibold|demibold/, 600],
    [/extralight|ultralight/, 200],
    [/thin/, 100],
    [/light/, 300],
    [/medium/, 500],
    [/black|heavy/, 900],
    [/bold/, 700],
  ]
  return table.find(([re]) => re.test(n))?.[1] ?? 400
}

const loaded = new Map<string, Promise<void>>()

/**
 * Make a space's uploaded fonts usable on this page (FontFace API), once each. The preview then draws text in them
 * as the export does (the export embeds the same files).
 */
export function registerBrandFonts(fonts: BrandFont[]): Promise<void> {
  if (typeof document === 'undefined' || typeof FontFace === 'undefined') return Promise.resolve()
  return Promise.all(
    fonts.map((f) => {
      let p = loaded.get(f.id)
      if (!p) {
        const face = new FontFace(f.family, `url(${f.url})`, { weight: String(f.weight), style: f.italic ? 'italic' : 'normal' })
        p = face.load().then(
          (ff) => void document.fonts.add(ff),
          () => void loaded.delete(f.id),
        )
        loaded.set(f.id, p)
      }
      return p
    }),
  ).then(() => undefined)
}
