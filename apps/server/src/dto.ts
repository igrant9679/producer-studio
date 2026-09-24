// Row -> API DTO mappers (shapes from packages/core/src/api.ts).
import type { Asset, AssetRecord, AssetStatus, ExportRecord, Job, JobKind, JobStatus, ProjectSummary, User } from '@producer/core'
import type { assets, exportsTable, jobs, projects, users } from './db/schema'

export const mediaPath = (assetId: string, variant: 'source' | 'proxy' | 'thumb' | 'filmstrip' | 'audio') => `/api/media/${encodeURIComponent(assetId)}/${variant}`

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

/** Core Asset as embedded in project docs. URLs are the auth-checked media routes. */
export function assetDoc(a: typeof assets.$inferSelect): Asset {
  const m = a.meta ?? {}
  return {
    id: a.id,
    kind: a.kind as Asset['kind'],
    name: a.name,
    src: mediaPath(a.id, 'source'),
    proxySrc: a.proxyKey ? mediaPath(a.id, 'proxy') : undefined,
    mime: a.mime,
    duration: m.duration,
    width: m.width,
    height: m.height,
    fps: m.fps,
    hasAudio: m.hasAudio,
    sizeBytes: a.size,
    filmstrip: a.filmstripKey && m.filmstrip ? { src: mediaPath(a.id, 'filmstrip'), ...m.filmstrip } : undefined,
    thumbnail: a.thumbKey ? mediaPath(a.id, 'thumb') : undefined,
    waveform: m.waveform,
    transcript: m.transcript,
    silences: m.silences,
    createdAt: a.createdAt,
  }
}

export function assetRecord(a: typeof assets.$inferSelect): AssetRecord {
  return {
    asset: assetDoc(a),
    workspaceId: a.workspaceId,
    status: a.status as AssetStatus,
    error: a.error ?? undefined,
    origin: a.origin,
    createdAt: a.createdAt,
  }
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
