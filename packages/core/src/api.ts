// HTTP API contract shared by apps/web and apps/server. All routes are under /api, JSON bodies,
// cookie auth (httpOnly `ps_session`). Errors: non-2xx with `ApiError` body.
import type { Asset, Project, ProducerMeta, ScriptScene, Transcript } from './types'

export interface ApiError {
  error: string
  code?: 'unauthorized' | 'forbidden' | 'not_found' | 'conflict' | 'invalid' | 'quota' | 'server'
  details?: unknown
}

export interface User {
  id: string
  email: string
  name: string
  avatarColor: string
  createdAt: number
}

export type Role = 'owner' | 'editor' | 'viewer'

export interface Workspace {
  id: string
  name: string
  role: Role
  personal: boolean
  memberCount: number
}

// ---- auth ----
// POST /api/auth/signup  {email, password, name}      -> MeResponse (sets cookie)
// POST /api/auth/login   {email, password}            -> MeResponse (sets cookie)
// POST /api/auth/logout                               -> {ok: true}
// GET  /api/auth/me                                   -> MeResponse | 401
export interface MeResponse {
  user: User
  workspaces: Workspace[]
}

// ---- workspaces ----
// GET  /api/workspaces                                -> Workspace[]
// POST /api/workspaces {name}                         -> Workspace
// GET  /api/workspaces/:id/members                    -> Member[]
// POST /api/workspaces/:id/invites {email, role}      -> {ok, inviteUrl}
// GET  /api/workspaces/:id/brand                      -> BrandKitDoc
// PUT  /api/workspaces/:id/brand  BrandKitDoc         -> BrandKitDoc
export interface Member {
  userId: string
  name: string
  email: string
  role: Role
}

export interface BrandKitDoc {
  name: string
  colors: string[]
  fonts: { headline: string; body: string }
  logoAssetId?: string
  /** Default caption preset id, default voice id. */
  captionPreset?: string
  voice?: string
}

// ---- projects ----
// GET    /api/projects?workspaceId=&trashed=0|1&templates=0|1  -> ProjectSummary[]
// POST   /api/projects  CreateProjectRequest                    -> ProjectDocResponse
// GET    /api/projects/:id                                     -> ProjectDocResponse
// PUT    /api/projects/:id  SaveProjectRequest                 -> {version, updatedAt} | 409 {error, code:'conflict', details:{version}}
// PATCH  /api/projects/:id  {name?, trashed?, isTemplate?}     -> ProjectSummary
// POST   /api/projects/:id/duplicate                           -> ProjectSummary
// DELETE /api/projects/:id   (only when trashed)               -> {ok}
export interface ProjectSummary {
  id: string
  workspaceId: string
  name: string
  width: number
  height: number
  duration: number
  thumbnailUrl?: string
  isTemplate: boolean
  trashed: boolean
  kind: 'edit' | 'producer'
  updatedAt: number
  createdAt: number
  createdBy: string
}

export interface CreateProjectRequest {
  workspaceId: string
  name?: string
  width?: number
  height?: number
  fps?: number
  /** Start from a template project (built-in id `tpl:<look>` or a workspace template project id). */
  templateId?: string
  kind?: 'edit' | 'producer'
}

export interface ProjectDocResponse {
  summary: ProjectSummary
  project: Project
  version: number
}

export interface SaveProjectRequest {
  project: Project
  baseVersion: number
}

// ---- assets ----
// POST /api/uploads  UploadRequest            -> UploadTicket   (then PUT bytes to ticket.url with ticket.headers)
// POST /api/assets/:id/complete               -> AssetRecord    (queues asset.process)
// GET  /api/assets?workspaceId=&kind=         -> AssetRecord[]
// GET  /api/assets/:id                        -> AssetRecord
// PATCH /api/assets/:id {name}                -> AssetRecord
// DELETE /api/assets/:id                      -> {ok}
// GET  /api/media/:assetId/:variant           -> 302 signed URL | 200/206 stream   variant: source|proxy|thumb|filmstrip|audio
export interface UploadRequest {
  workspaceId: string
  filename: string
  mime: string
  size: number
}

export interface UploadTicket {
  assetId: string
  url: string
  method: 'PUT'
  headers: Record<string, string>
}

export type AssetStatus = 'uploading' | 'processing' | 'ready' | 'error'

export interface AssetRecord {
  asset: Asset
  workspaceId: string
  status: AssetStatus
  error?: string
  /** 'upload' | 'tts' | 'render' | 'freeze' | 'ai' */
  origin: string
  createdAt: number
}

// ---- jobs ----
// GET /api/jobs/:id                    -> Job
// GET /api/jobs?projectId=&workspaceId= -> Job[]
// POST /api/jobs/:id/cancel            -> Job
// GET /api/events?workspaceId=         -> text/event-stream, events: `job` (Job), `asset` (AssetRecord), `project` ({id, version})
export type JobKind = 'asset.process' | 'ai.transcribe' | 'ai.tts' | 'ai.produce.script' | 'ai.produce.assemble' | 'export.render'
export type JobStatus = 'queued' | 'running' | 'done' | 'error' | 'cancelled'

export interface Job<R = unknown> {
  id: string
  kind: JobKind
  status: JobStatus
  /** 0..1, or -1 when indeterminate */
  progress: number
  message: string
  projectId?: string
  workspaceId: string
  result?: R
  error?: string
  createdAt: number
  updatedAt: number
}

// ---- AI ----
// POST /api/ai/transcribe  {assetId, language?}                     -> Job<{assetId, transcript: Transcript}>
// POST /api/ai/tts         TtsRequest                              -> Job<{asset: AssetRecord, duration: number}>
// GET  /api/ai/voices                                              -> Voice[]
// GET  /api/ai/voices/:id/sample                                   -> audio/wav (cached sample line)
// POST /api/ai/write       WriteRequest                            -> text/event-stream of `delta` {text} then `done` {text}
// POST /api/ai/produce/script   ProduceScriptRequest               -> Job<{script: {scenes: ScriptScene[]}}>
// POST /api/ai/produce/assemble {projectId, scenes: ScriptScene[]} -> Job<{version: number}>  (server writes the project)
// POST /api/ai/assistant   AssistantRequest                        -> text/event-stream: `text` {delta}, `tool` {name, summary}, `done` AssistantResult
export interface TtsRequest {
  workspaceId: string
  projectId?: string
  text: string
  voice: string
  speed?: number
  name?: string
}

export interface Voice {
  id: string
  name: string
  lang: string
  gender: string
  style: string
}

export interface WriteRequest {
  kind: 'voiceover' | 'script' | 'headline' | 'caption' | 'rewrite'
  prompt: string
  context?: string
  maxWords?: number
}

export interface ProduceScriptRequest {
  projectId: string
  assetIds: string[]
  brief: NonNullable<ProducerMeta['brief']>
}

export interface AssistantMessage {
  role: 'user' | 'assistant'
  text: string
}

export interface AssistantRequest {
  projectId: string
  project: Project
  /** Playhead and selection give the assistant context ("split here", "make this bigger"). */
  playhead: number
  selection: string[]
  messages: AssistantMessage[]
}

export interface AssistantResult {
  text: string
  /** Present when the assistant changed the edit. */
  project?: Project
  changes: string[]
}

// ---- export & share ----
// POST /api/projects/:id/export  ExportRequest     -> Job<ExportResult>
// GET  /api/exports?projectId=                    -> ExportRecord[]
// POST /api/projects/:id/share   {exportId?}      -> {url, token}
// GET  /api/share/:token                          -> {project: ProjectSummary, videoUrl?}  (public, no auth)
export interface ExportRequest {
  resolution: '720p' | '1080p' | '1440p' | '4k'
  fps: 24 | 25 | 30 | 50 | 60
  quality: 'draft' | 'standard' | 'high'
  format: 'mp4' | 'webm' | 'gif'
  name?: string
}

export interface ExportResult {
  exportId: string
  url: string
  sizeBytes: number
  duration: number
}

export interface ExportRecord extends ExportResult {
  projectId: string
  name: string
  resolution: string
  fps: number
  createdAt: number
}

// ---- templates ----
// GET /api/templates?workspaceId=   -> TemplateSummary[]   (built-in Producer looks + workspace templates)
export interface TemplateSummary {
  id: string
  name: string
  category: string
  aspect: string
  duration: number
  previewUrl?: string
  thumbnailUrl?: string
  builtIn: boolean
  clipCount: number
  textCount: number
}

export type { Transcript, ScriptScene }
