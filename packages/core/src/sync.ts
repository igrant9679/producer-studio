// Desktop sync contract (R4-C), beside SyncStatus / SyncChanges in api.ts.
// Desktop-only routes:
// GET  /api/sync/items                       -> SyncItems            (what is waiting, uploading, failed or skipped)
// GET  /api/sync/conflicts/:projectId        -> SyncConflictPreview  (this computer's copy against the cloud's)
// POST /api/sync/link/preview {cloudUrl, email, password} -> LinkPreview  (what linking would merge and upload)
// POST /api/sync/link {previewId, choices}   -> SyncStatus           (link as previewed, a choice per local space)
// POST /api/sync/link/cancel {previewId}     -> {ok}
// GET  /api/sync/offline?workspaceId=        -> OfflineInfo          (projects kept offline, clips only in the cloud)
// PUT  /api/sync/offline/:projectId {pinned} -> OfflineInfo
// Cloud (device token):
// PUT  /api/sync/brand-kits/:kitId {workspaceId, doc}   -> {ok}   (a desktop's brand kit, with its own id)
// POST /api/sync/brand-kits/:kitId/delete               -> {ok}
// PUT  /api/sync/brand-fonts/:fontId?workspaceId=&family=&weight=&italic= <bytes> -> BrandFont
// POST /api/sync/brand-fonts/:fontId/delete             -> {ok}
// GET  /api/sync/brand-fonts/:fontId/file               -> the font file
import type { BrandKitDoc } from './api'
import type { BrandFont } from './brand'

/** Why sync can't carry on right now, for a person. */
export type SyncBlockReason = 'signed-out' | 'offline' | 'storage' | 'conflict' | 'credentials' | 'paused'

export interface SyncBlock {
  reason: SyncBlockReason
  message: string
}

/** A clip's file on its way to the cloud. */
export interface SyncUpload {
  id: string
  name: string
  bytes: number
  sent: number
  startedAt: number
}

export type SyncItemKind = 'project' | 'asset' | 'brand' | 'kit' | 'font' | 'voice'

/** One thing this computer has that the cloud doesn't yet. */
export interface SyncItem {
  kind: SyncItemKind
  id: string
  name: string
  workspaceId: string
  state: 'waiting' | 'uploading' | 'failed' | 'skipped'
  /** A clip's file size (what still has to go up). */
  bytes?: number
  /** Why it failed, or why it waits (a conflict, its space doesn't sync). */
  reason?: string
}

export interface SyncItems {
  items: SyncItem[]
  /** Bytes of clips still to upload. */
  uploadBytes: number
}

/** One side of a conflict, enough to choose between them. */
export interface SyncSideSummary {
  version: number
  name: string
  updatedAt: number
  /** Seconds. */
  duration: number
  tracks: number
  items: number
  clips: number
  trashed: boolean
}

export interface SyncConflictPreview {
  projectId: string
  local: SyncSideSummary
  /** Null when the cloud copy was deleted. */
  cloud: SyncSideSummary | null
  /** What differs, in plain words ("Renamed in the cloud to “Cut 2”", "2 clips only in this computer’s copy"). */
  changes: string[]
}

/** What to do with one of this computer's spaces when linking. */
export type LinkChoice = { action: 'merge'; into: string } | { action: 'new' } | { action: 'local' }

export interface LinkPreviewSpace {
  id: string
  name: string
  personal: boolean
  projects: number
  clips: number
  /** Bytes of clips that would go up. */
  uploadBytes: number
  voices: number
  /** What linking does unless told otherwise. */
  suggested: LinkChoice
  /** Already synced with this account before: it carries on, no choice to make. */
  synced?: boolean
}

export interface LinkPreview {
  previewId: string
  account: string
  cloudUrl: string
  /** The preview (and the device link made for it) lapses at this time. */
  expiresAt: number
  spaces: LinkPreviewSpace[]
  cloudSpaces: Array<{ id: string; name: string; personal: boolean; role: string }>
  /** Another account's spaces that would be set aside (kept here, not synced). */
  setAside?: { account?: string; spaces: string[] }
}

export interface OfflineProject {
  pinned: boolean
  /** Clips it uses whose files aren't on this computer yet. */
  missing: number
  missingBytes: number
}

export interface OfflineInfo {
  projects: Record<string, OfflineProject>
  /** Clips in this space whose original is only in the cloud. */
  cloudOnly: string[]
}

/** Feed records for a space's other brand kits and its font files (SyncChanges). */
export interface SyncKit {
  id: string
  workspaceId: string
  doc: BrandKitDoc
  updatedAt: number
  changeSeq: number
}

export interface SyncFont extends BrandFont {
  workspaceId: string
  changeSeq: number
}
