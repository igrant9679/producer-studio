// Row -> API DTO mappers (shapes from packages/core/src/api.ts).
import { transcriptRev, type Asset, type AssetRecord, type AssetStatus, type ExportRecord, type Job, type JobKind, type JobStatus, type ProjectSummary, type User } from '@producer/core'
import type { AssetMeta, assets, exportsTable, jobs, projects, users } from './db/schema'
import { WAVEFORM_RATE, inlineWaveform } from './media/waveform'

export const mediaPath = (assetId: string, variant: 'source' | 'proxy' | 'thumb' | 'filmstrip' | 'audio' | 'waveform') => `/api/media/${encodeURIComponent(assetId)}/${variant}`

export function userDto(u: typeof users.$inferSelect): User {
  return { id: u.id, email: u.email, name: u.name, avatarColor: u.avatarColor, createdAt: u.createdAt }
}

export function projectSummary(p: typeof projects.$inferSelect): ProjectSummary {
  return {
    id: p.id,
    workspaceId: p.workspaceId,
    name: p.name,
    width: p.width,
    height: p.height,
    duration: p.duration,
    thumbnailUrl: p.thumbnail ? mediaPath(p.thumbnail, 'thumb') : undefined,
    isTemplate: p.isTemplate,
    trashed: p.trashedAt != null,
    kind: (p.kind as ProjectSummary['kind']) ?? 'edit',
    updatedAt: p.updatedAt,
    createdAt: p.createdAt,
    createdBy: p.createdBy,
  }
}

/**
 * The waveform a clip record carries: at most ~4,000 peaks, and where to fetch all of them when there are more. A clip
 * processed before the full waveform became a file still holds every peak in its metadata: it is shortened here and
 * the waveform route serves the rest from the metadata.
 */
function waveformDoc(id: string, m: AssetMeta): Pick<Asset, 'waveform' | 'waveformRate' | 'waveformSrc'> {
  if (!m.waveform) return {}
  if (m.waveformFull) return { waveform: m.waveform, waveformRate: m.waveformRate, waveformSrc: mediaPath(id, 'waveform') }
  const short = inlineWaveform(m.waveform, m.waveformRate ?? WAVEFORM_RATE)
  if (short.peaks === m.waveform) return { waveform: m.waveform, ...(m.waveformRate ? { waveformRate: m.waveformRate } : {}) }
  return { waveform: short.peaks, waveformRate: short.rate, waveformSrc: mediaPath(id, 'waveform') }
}

/** Core Asset as embedded in project docs. URLs are the auth-checked media routes. */
export function assetDoc(a: typeof assets.$inferSelect): Asset {
  const m = a.meta ?? {}
  return {
    id: a.id,
    kind: a.kind as Asset['kind'],
    name: a.name,
    src: mediaPath(a.id, 'source'),
    // also a picture's or a sound's playable copy (TIFF → PNG, AIFF → AAC): the editor plays that instead of src
    proxySrc: a.proxyKey || (a.kind === 'audio' && a.audioKey) ? mediaPath(a.id, 'proxy') : undefined,
    mime: a.mime,
    duration: m.duration,
    width: m.width,
    height: m.height,
    fps: m.fps,
    hasAudio: m.hasAudio,
    sizeBytes: a.size,
    filmstrip: a.filmstripKey && m.filmstrip ? { src: mediaPath(a.id, 'filmstrip'), ...m.filmstrip } : undefined,
    thumbnail: a.thumbKey ? mediaPath(a.id, 'thumb') : undefined,
    ...waveformDoc(a.id, m),
    transcript: m.transcript,
    silences: m.silences,
    createdAt: a.createdAt,
  }
}

/**
 * A clip's record. `light` (lists and live updates): no transcript, only a mark of which one it has (`transcriptRev`),
 * and the waveform at its inline size as always; GET /api/assets/:id answers the full record.
 */
export function assetRecord(a: typeof assets.$inferSelect, opts: { light?: boolean } = {}): AssetRecord {
  const doc = assetDoc(a)
  const rec: AssetRecord = {
    asset: doc,
    workspaceId: a.workspaceId,
    status: a.status as AssetStatus,
    error: a.error ?? undefined,
    origin: a.origin,
    createdAt: a.createdAt,
  }
  if (!opts.light) return rec
  const { transcript, ...rest } = doc
  return { ...rec, asset: rest, light: true, ...(transcript ? { transcriptRev: transcriptRev(transcript) } : {}) }
}


export function jobDto(j: typeof jobs.$inferSelect): Job {
  return {
    id: j.id,
    kind: j.kind as JobKind,
    status: j.status as JobStatus,
    progress: j.progress,
    message: j.message,
    projectId: j.projectId ?? undefined,
    workspaceId: j.workspaceId,
    ...(j.kind === 'asset.process' && typeof (j.input as { assetId?: unknown })?.assetId === 'string' ? { assetId: (j.input as { assetId: string }).assetId } : {}),
    result: j.result ?? undefined,
    error: j.error ?? undefined,
    createdAt: j.createdAt,
    updatedAt: j.updatedAt,
  }
}

export function exportDto(e: typeof exportsTable.$inferSelect): ExportRecord {
  return {
    exportId: e.id,
    url: mediaPath(e.assetId, 'source'),
    sizeBytes: e.sizeBytes,
    duration: e.duration,
    projectId: e.projectId,
    name: e.name,
    resolution: e.resolution,
    fps: e.fps,
    createdAt: e.createdAt,
  }
}
