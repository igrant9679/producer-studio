// HTTP API contract shared by apps/web and apps/server. All routes are under /api, JSON bodies,
// cookie auth (httpOnly `ps_session`). Errors: non-2xx with `ApiError` body.
import type { Asset, Project, ProducerMeta, ScriptScene, Transcript } from './types'

export interface ApiError {
  error: string
  code?: 'unauthorized' | 'forbidden' | 'not_found' | 'conflict' | 'invalid' | 'quota' | 'server'
  details?: unknown
}

/** `details` of a 409 from PUT /api/projects/:id. */
export interface ProjectConflictDetails {
  version: number
  project?: Project
  summary?: ProjectSummary
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

// ---- per-user appearance preferences ----
// GET /api/me/preferences                             -> PreferencesResponse (defaults until first saved)
// PUT /api/me/preferences  Partial<UserPreferences>   -> PreferencesResponse (partial merge; unknown keys rejected)
// Same routes on desktop (the one local user). Not part of the desktop/cloud sync change feed: each replica keeps
// its own copy, and the browser also caches the last value in localStorage (`ps.appearance`).
export type ThemePreference = 'system' | 'dark' | 'light'
export type TextSize = 'sm' | 'md' | 'lg' | 'xl'
export type AccentPreset = 'coral' | 'violet' | 'blue' | 'teal' | 'amber' | 'pink'
export type Density = 'comfortable' | 'compact'

export interface UserPreferences {
  theme: ThemePreference
  /** UI text scale: sm 0.9, md 1, lg 1.125, xl 1.25 (TEXT_SCALE). */
  textSize: TextSize
  accent: AccentPreset
  density: Density
  reduceMotion: boolean
}

export interface PreferencesResponse {
  preferences: UserPreferences
  /** Epoch ms of the last save; null = never saved (the defaults). */
  updatedAt: number | null
}

export const THEME_PREFERENCES: readonly ThemePreference[] = ['system', 'dark', 'light']
export const TEXT_SIZES: readonly TextSize[] = ['sm', 'md', 'lg', 'xl']
export const ACCENT_PRESETS: readonly AccentPreset[] = ['coral', 'violet', 'blue', 'teal', 'amber', 'pink']
export const DENSITIES: readonly Density[] = ['comfortable', 'compact']
export const TEXT_SCALE: Readonly<Record<TextSize, number>> = { sm: 0.9, md: 1, lg: 1.125, xl: 1.25 }

export const DEFAULT_PREFERENCES: Readonly<UserPreferences> = Object.freeze({
  theme: 'system',
  textSize: 'md',
  accent: 'coral',
  density: 'comfortable',
  reduceMotion: false,
})

/** Coerce anything (stored JSON, localStorage) into valid preferences, falling back to the defaults per field. */
export function normalizePreferences(raw: unknown): UserPreferences {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const pick = <T extends string>(v: unknown, list: readonly T[], d: T): T => (typeof v === 'string' && (list as readonly string[]).includes(v) ? (v as T) : d)
  return {
    theme: pick(o.theme, THEME_PREFERENCES, DEFAULT_PREFERENCES.theme),
    textSize: pick(o.textSize, TEXT_SIZES, DEFAULT_PREFERENCES.textSize),
    accent: pick(o.accent, ACCENT_PRESETS, DEFAULT_PREFERENCES.accent),
    density: pick(o.density, DENSITIES, DEFAULT_PREFERENCES.density),
    reduceMotion: typeof o.reduceMotion === 'boolean' ? o.reduceMotion : DEFAULT_PREFERENCES.reduceMotion,
  }
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
  /** Client-generated project id (desktop-created projects keep their id in the cloud). */
  id?: string
  /** Full document to create from (desktop push of a locally created project). */
  project?: Project
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
  /** Client-generated id (desktop sync keeps ids identical across replicas). */
  assetId?: string
  sha256?: string
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
  sha256?: string
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
  /** Workspace whose AI settings apply (cloud). Defaults to the user's personal workspace; ignored on desktop. */
  workspaceId?: string
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

// ---- system, AI provider, desktop/cloud sync ----
// The same server runs in two modes:
//   cloud   — hosted, multi-user; AI via the Anthropic API (server key).
//   desktop — bundled in the Electron app for one local user; AI via the locally installed Claude Code CLI
//             (the user's own subscription); local PGlite + local storage; syncs with a cloud account.
// Ids of projects, assets and items are globally unique (uuid-like), so the same id refers to the same object
// on every replica.
//
// GET  /api/system                         -> SystemInfo   (public)
// Desktop-only (mode === 'desktop'):
// GET  /api/settings                       -> DesktopSettings
// PUT  /api/settings  Partial<DesktopSettings> -> DesktopSettings
// POST /api/sync/link {cloudUrl, email, password} -> SyncStatus   (exchanges credentials for a device token)
// POST /api/sync/unlink                    -> SyncStatus
// POST /api/sync/now                       -> SyncStatus
// GET  /api/sync/status                    -> SyncStatus
// POST /api/projects/:id/sync {mode:'keep-local'|'keep-cloud'|'keep-both'} -> SyncStatus  (resolve a conflict)
// Cloud sync surface (used by desktop replicas; Bearer device token or cookie):
// POST /api/devices {name}                 -> {deviceId, token}   (token shown once; stored hashed)
// GET  /api/devices                        -> Device[]
// DELETE /api/devices/:id                  -> {ok}
// GET  /api/sync/changes?since=<cursor>    -> SyncChanges  (all workspaces the user belongs to)
// POST /api/projects accepts optional `id` (client-generated) so desktop-created projects keep their id;
// PUT  /api/projects/:id with baseVersion is the push path (409 on conflict, details.version = cloud version).
// POST /api/uploads accepts optional `assetId` and `sha256`; returns 409 {code:'conflict'} with details
//      {exists: true} when that asset already exists in the cloud (nothing to upload).
// Every project/asset/workspace write bumps a server-wide monotonic `change_seq`; `cursor` is that number.
export interface SystemInfo {
  mode: 'cloud' | 'desktop'
  version: string
  /** Effective default AI provider (for `?workspaceId=` on cloud, that workspace's settings). */
  ai: { provider: AiProviderId; available: boolean; detail: string; model?: string }
  /** Local capabilities (true on desktop; on cloud reflects the worker image). */
  capabilities: { transcribe: boolean; tts: boolean; render: boolean }
  sync?: SyncStatus
}

export interface SyncStatus {
  linked: boolean
  cloudUrl?: string
  account?: string
  state: 'unlinked' | 'idle' | 'syncing' | 'offline' | 'error'
  lastSyncAt?: number
  /** Local changes not yet pushed (projects + assets). */
  pending: number
  /** Projects edited on both sides since the last sync. */
  conflicts: Array<{ projectId: string; name: string; localVersion: number; cloudVersion: number }>
  error?: string
}

export interface DesktopSettings {
  /** Path to the Claude Code CLI; empty = auto-detect (Claude desktop bundle, ~/.local/bin, PATH). */
  claudePath: string
  /** Optional model override passed to the CLI (`--model`). */
  claudeModel: string
  /** Where local media and renders live. */
  dataDir: string
  /** Download cloud media eagerly ('all') or when first opened ('on-demand'). */
  mediaSync: 'all' | 'on-demand'
  autoSync: boolean
}

export interface Device {
  id: string
  name: string
  createdAt: number
  lastSeenAt?: number
}

export interface SyncProject {
  summary: ProjectSummary
  project: Project
  version: number
  changeSeq: number
}

export interface SyncChanges {
  cursor: number
  workspaces: Workspace[]
  projects: SyncProject[]
  assets: Array<AssetRecord & { sha256?: string; changeSeq: number }>
  brandKits: Array<{ workspaceId: string; doc: BrandKitDoc; changeSeq: number }>
  deleted: { projects: string[]; assets: string[] }
  /** True when more changes remain after `cursor` (page again). */
  more: boolean
}

// ---- AI providers (bring your own key) ----
// Keys are stored server-side only (cloud: per workspace, AES-256-GCM; desktop: encrypted with the OS keystore key)
// and never returned: responses carry `hasKey` and `keyLast4`. Desktop ignores `workspaceId`.
// GET    /api/ai/settings?workspaceId=                        -> AiSettings            (viewer+)
// PUT    /api/ai/settings        AiSettingsUpdate             -> AiSettings            (owner)
// PUT    /api/ai/keys/:provider  {workspaceId?, key}          -> AiKeyTestResult       (owner; stores, then tests)
// DELETE /api/ai/keys/:provider?workspaceId=                  -> AiSettings            (owner)
// POST   /api/ai/keys/:provider/test {workspaceId?, key?}     -> AiKeyTestResult       (owner; given key or the stored one)
/** Provider implementations: server Anthropic key, workspace/user Anthropic key, OpenAI, Gemini, local Claude CLI. */
export type AiProviderId = 'anthropic-api' | 'anthropic-key' | 'openai' | 'gemini' | 'claude-cli' | 'none'
/** Providers configured with a user-supplied API key. */
export type AiKeyProvider = 'openai' | 'gemini' | 'anthropic'
/** What a feature can be pointed at: the built-in provider (desktop: Claude CLI; cloud: the server's key) or a key. */
export type AiChoice = 'builtin' | AiKeyProvider
export type AiFeature = 'writer' | 'script' | 'assistant'

export interface AiKeyProviderSettings {
  /** Model id sent to the provider (free text; defaults picked from the live model list). */
  model: string
  hasKey: boolean
  keyLast4?: string
  /** Model ids the key could use at the last successful test. */
  models?: string[]
  /** Result of the last key test (undefined = never tested). */
  valid?: boolean
  /** User-facing reason when the last test failed. */
  error?: string
  checkedAt?: number
  updatedAt?: number
}

export interface AiSettings {
  /** null = automatic (the built-in provider). */
  defaultProvider: AiChoice | null
  perFeature: Partial<Record<AiFeature, AiChoice>>
  providers: Partial<Record<AiKeyProvider, AiKeyProviderSettings>>
  /** The built-in provider for this edition and whether it's usable. */
  builtin: { id: AiProviderId; available: boolean; detail: string; model?: string }
  /** Effective provider per feature after resolution. */
  effective: Record<AiFeature, { provider: AiProviderId; model?: string }>
  /** True when the caller may change keys and settings (workspace owner; always on desktop). */
  canEdit: boolean
}

export interface AiSettingsUpdate {
  workspaceId?: string
  defaultProvider?: AiChoice | null
  perFeature?: Partial<Record<AiFeature, AiChoice | null>>
  models?: Partial<Record<AiKeyProvider, string>>
}

export interface AiKeyTestResult {
  ok: boolean
  /** Chat/text-capable model ids the key can use (newest first). */
  models: string[]
  /** "✓ valid · N models" style detail or a user-facing error. */
  detail: string
  /** Suggested default model from the live list. */
  defaultModel?: string
  settings?: AiSettings
}

export type { Transcript, ScriptScene }
