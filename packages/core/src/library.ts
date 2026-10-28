// The Library's API beyond plain lists (phase 5, release 3): the media trash, replacing a clip's file, copying and
// moving projects between spaces, the space-wide exports list and search.
import type { AssetRecord, ExportRecord, Page, ProjectSummary, UploadTicket } from './api'

// ---- media trash (A-14, P-23) ----
// GET    /api/assets?workspaceId=&trashed=1          -> Page<AssetRecord>  (the trash; without it, the library)
// GET    /api/assets/:id/usage                       -> AssetUsage  (viewer: which projects use the clip)
// DELETE /api/assets/:id                             -> TrashResult (editor: into the trash; nothing is removed)
// POST   /api/assets/:id/restore                     -> AssetRecord (editor: out of the trash)
// POST   /api/assets/trash/empty {workspaceId, ids?} -> EmptyTrashResult (editor: removes trashed clips for good, all
//        of them or only `ids`; exports made of them go too)
// POST   /api/assets/:id/replace {filename, mime, size, sha256?} -> UploadTicket (editor: PUT the new file there, then)
// POST   /api/assets/:id/replace/complete            -> AssetRecord (the clip keeps its id: every project follows)

export interface AssetUsage {
  assetId: string
  projects: Array<{ id: string; name: string; trashed: boolean }>
}

export interface TrashResult {
  ok: true
  trashedAt: number
  /** Projects that use the clip: they keep playing it until the trash is emptied. */
  usedIn: number
}

export interface EmptyTrashResult {
  removed: number
  /** Exports whose file was one of them (their share links stop working). */
  exports: number
}

export type ReplaceTicket = UploadTicket

// ---- projects between spaces (A-13) ----
// POST /api/projects/:id/copy {workspaceId, move?} -> ProjectSummary  (editor in both spaces: a copy with copies of its
//      media in the other space; `move` also puts the original in this space's trash)
export interface CopyProjectRequest {
  workspaceId: string
  move?: boolean
}

// POST /api/assets/:id/copy {workspaceId, move?} -> AssetRecord  (editor in both: the clip's files copied there; `move`
//      also puts this one in the trash)
export type CopyAssetRequest = CopyProjectRequest

// ---- exports (A-19, P-23) ----
// GET    /api/exports?workspaceId=&q=&format=&cursor=&limit= -> Page<SpaceExport>  (every project's, newest first)
// DELETE /api/exports/:id                             -> DeleteExportResult (editor: the export, its links and its file,
//        unless a project uses that file: then the file stays in the library)
export interface SpaceExport extends ExportRecord {
  projectName: string
  projectThumbnailUrl?: string
  /** The export's file (a library clip with origin `render`). */
  assetId: string
  /** Links that show this export. */
  shares: number
}

export interface DeleteExportResult {
  ok: true
  links: number
  /** The file is used in a project, so it stayed in the library. */
  keptFile: boolean
}

export type SpaceExportPage = Page<SpaceExport>

// ---- search (A-11) ----
// GET /api/search?workspaceId=&q=&limit= -> SearchResults  (viewer; case-insensitive, words in any order)
export interface SearchHit {
  kind: 'project' | 'template' | 'media' | 'voice' | 'export' | 'member'
  id: string
  title: string
  /** A line to show under the title: where it matched, in words. */
  detail?: string
  /** Words around the match in a transcript or narration. */
  snippet?: string
  /** Seconds into the clip where the words are said (transcript matches). */
  at?: number
  /** What it belongs to: a project for an export, a clip for a transcript. */
  projectId?: string
  assetId?: string
  thumbnailUrl?: string
  /** For a project: the summary (open it like a Library card). */
  project?: ProjectSummary
  /** For a clip: the light record (preview it like a Library card). */
  asset?: AssetRecord
}

export interface SearchResults {
  q: string
  hits: SearchHit[]
}

/** A search term's words, lowercased (what the server matches each of). */
export function searchWords(q: string): string[] {
  return q
    .toLowerCase()
    .split(/\s+/)
    .map((w) => w.trim())
    .filter(Boolean)
    .slice(0, 8)
}

/** The words around the first place `words` appear in `text` (about `width` characters), for a result line. */
export function searchSnippet(text: string, words: string[], width = 90): string {
  const lower = text.toLowerCase()
  let at = -1
  for (const w of words) {
    const i = lower.indexOf(w)
    if (i >= 0 && (at < 0 || i < at)) at = i
  }
  if (at < 0 || text.length <= width) return text.length <= width ? text : `${text.slice(0, width).trimEnd()}…`
  const start = Math.max(0, at - Math.floor(width / 3))
  const end = Math.min(text.length, start + width)
  return `${start > 0 ? '…' : ''}${text.slice(start, end).trim()}${end < text.length ? '…' : ''}`
}

/** Tags as stored: trimmed, at most 40 characters each, no repeats (case-insensitive), at most 20. */
export function normalizeTags(tags: string[]): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const raw of tags) {
    const t = raw.trim().replace(/\s+/g, ' ').slice(0, 40)
    if (!t || seen.has(t.toLowerCase())) continue
    seen.add(t.toLowerCase())
    out.push(t)
    if (out.length >= 20) break
  }
  return out
}
