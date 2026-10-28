// Asset URL resolution and drag payloads shared by panels, timeline and canvas.
import type { Asset, Project } from '@producer/core'
import { mediaUrl } from '../lib/api'

const isDirect = (src?: string) => !!src && (src.startsWith('/') || src.startsWith('http') || src.startsWith('blob:') || src.startsWith('data:'))

const isServerMedia = (src?: string) => !!src && src.startsWith('/api/media/')

/**
 * URL for playing an asset. Demo/bundled assets carry absolute src; server assets go through /api/media. `audio` is
 * the sound of a clip: for a server video that is the small AAC copy made at upload (the server falls back to the
 * original when a clip has none), never the whole original file.
 */
export function assetUrl(asset: Asset | undefined, assetId: string, kind: 'media' | 'proxy' | 'audio'): string {
  if (kind === 'audio' && (!asset || (asset.kind === 'video' && (isServerMedia(asset.src) || !isDirect(asset.src))))) return mediaUrl(assetId, 'audio')
  if (kind === 'audio') kind = 'media'
  if (asset) {
    // a picture's or a sound's proxy is the copy the server made of a format browsers can't use (TIFF → PNG,
    // AIFF/WMA/AMR → AAC): always use that
    if ((kind === 'proxy' || asset.kind !== 'video') && isDirect(asset.proxySrc)) return asset.proxySrc!
    if (isDirect(asset.src)) return asset.src
    if (asset.kind === 'audio') return mediaUrl(asset.id, 'audio')
  }
  return mediaUrl(assetId, kind === 'proxy' ? 'proxy' : 'source')
}

export function makeResolver(get: () => Project) {
  return (assetId: string, kind: 'media' | 'proxy' | 'audio') => assetUrl(get().assets[assetId], assetId, kind)
}

export function thumbUrl(asset: Asset): string | undefined {
  if (asset.kind === 'audio') return undefined
  if (isDirect(asset.thumbnail)) return asset.thumbnail
  if (asset.kind === 'image' && isDirect(asset.proxySrc)) return asset.proxySrc
  if (asset.kind === 'image' && isDirect(asset.src)) return asset.src
  return mediaUrl(asset.id, 'thumb')
}

export function filmstripUrl(asset: Asset): string | undefined {
  if (!asset.filmstrip) return undefined
  return isDirect(asset.filmstrip.src) ? asset.filmstrip.src : mediaUrl(asset.id, 'filmstrip')
}

// ---- drag & drop payloads (module-level: dataTransfer isn't readable during dragover) ----
export type DragPayload =
  | { kind: 'asset'; asset: Asset }
  | { kind: 'text'; templateId: string }
  | { kind: 'transition'; type: string }
  | { kind: 'effect'; type: string }
  | { kind: 'filter'; id: string }

let current: DragPayload | null = null
export const DRAG_MIME = 'application/x-producer-studio'

export function startDrag(e: React.DragEvent, payload: DragPayload) {
  current = payload
  e.dataTransfer.effectAllowed = 'copy'
  e.dataTransfer.setData(DRAG_MIME, payload.kind)
  e.dataTransfer.setData('text/plain', payload.kind)
}
export function endDrag() {
  current = null
}
export function dragPayload(): DragPayload | null {
  return current
}
export function isInternalDrag(e: React.DragEvent | DragEvent): boolean {
  return !!current && !!e.dataTransfer?.types.includes(DRAG_MIME)
}
export function isFileDrag(e: React.DragEvent | DragEvent): boolean {
  return !!e.dataTransfer?.types.includes('Files')
}
