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
  /** The address was confirmed through mail (absent: older servers, or not confirmed). */
  emailVerified?: boolean
}

export type Role = 'owner' | 'editor' | 'viewer'

export interface Workspace {
  id: string
  name: string
  role: Role
  personal: boolean
  memberCount: number
  /** Base version of its name: send as If-Match with PATCH /api/workspaces/:id (412 if renamed since). */
  etag?: string
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
// PATCH  /api/workspaces/:id {name}                   -> Workspace   (owner)
// DELETE /api/workspaces/:id                          -> {ok: true}  (owner; personal spaces can't be deleted.
//        Permanently removes the space's projects, media, exports, brand kit and AI keys for every member.)
// GET  /api/workspaces/:id/members                    -> Member[]
// POST /api/workspaces/:id/invites {email, role}      -> {ok, inviteUrl, expiresAt, emailed}  (owner; emailed when mail is on)
// GET  /api/workspaces/:id/invites                    -> PendingInvite[]  (owner; not accepted or withdrawn; expired ones for 30 days)
// DELETE /api/workspaces/:id/invites/:token           -> {ok: true}       (owner; the link stops working)
// GET  /api/invites/:token                            -> InviteInfo       (signed in)
// POST /api/invites/:token/accept                     -> Workspace        (signed in as the invited email; single use)
// GET  /api/workspaces/:id/brand                      -> BrandKitDoc
// PUT  /api/workspaces/:id/brand  BrandKitDoc         -> BrandKitDoc
export interface Member {
  userId: string
  name: string
  email: string
  role: Role
}

/** How long an invite link works. */
export const INVITE_TTL_MS = 7 * 24 * 3600 * 1000

export interface PendingInvite {
  token: string
  email: string
  role: Role
  createdAt: number
  expiresAt: number
  inviteUrl: string
  /** 'expired' ones stay listed for 30 days so an owner can Resend them (absent: pending). */
  status?: 'pending' | 'expired'
  /** When it was last emailed (absent: never, e.g. mail is off). */
  sentAt?: number
  /** POST …/invites only: whether the invite went out by email (false: copy the link and send it yourself). */
  emailed?: boolean
}

export type InviteStatus = 'pending' | 'accepted' | 'expired' | 'revoked'

export interface InviteInfo {
  workspaceId: string
  workspaceName: string
  role: Role
  /** The address it was sent to; only that account can accept it. */
  email: string
  status: InviteStatus
  expiresAt: number
  acceptedAt?: number
  /** The signed-in account's email is the invited one. */
  forYou: boolean
  /** The signed-in account is already a member of the space. */
  member: boolean
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

// ---- lists ----
// The list routes page: `?limit=` (default 200, at most 500) and `?cursor=` (the previous page's `nextCursor`), newest
// first. No `nextCursor`: that was the last page.
export interface Page<T> {
  items: T[]
  nextCursor?: string
}

// ---- projects ----
// GET    /api/projects?workspaceId=&trashed=0|1&templates=0|1&cursor=&limit=  -> Page<ProjectSummary>
// POST   /api/projects  CreateProjectRequest                    -> ProjectDocResponse
// GET    /api/projects/:id                                     -> ProjectDocResponse
// PUT    /api/projects/:id  SaveProjectRequest                 -> {version, updatedAt} | 409 {error, code:'conflict', details:{version}}
// PATCH  /api/projects/:id  {name?, trashed?, isTemplate?}     -> ProjectSummary & {version}  (a rename is one SQL
//        update of the stored row and bumps the version; trash/template keep it)
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
  /** The saved version this summary describes: the base for a rename from a list (PATCH baseVersion). */
  version?: number
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

// ---- version history (P-15) ----
// GET  /api/projects/:id/versions                  -> ProjectVersionSummary[] (newest first; viewers)
// GET  /api/projects/:id/versions/:vid             -> ProjectVersionResponse (viewers)
// GET  /api/projects/:id/versions/at/:version      -> ProjectVersionResponse (the version holding that project version)
// POST /api/projects/:id/versions {name}           -> ProjectVersionSummary (name what's saved now; editors)
// PATCH /api/projects/:id/versions/:vid {name}     -> ProjectVersionSummary (name or unname one; editors)
// POST /api/projects/:id/versions/:vid/restore {baseVersion?} -> { version, updatedAt } (a new save; editors)
export type ProjectVersionLabel = 'autosave' | 'named' | 'before-restore' | 'before-ai'

export interface ProjectVersionSummary {
  id: string
  /** The project version this is a copy of. */
  version: number
  label: ProjectVersionLabel
  name?: string
  /** What made it ("Restored from …", "Producer AI assembly"). */
  note?: string
  sizeBytes: number
  createdAt: number
  createdBy?: string
  authorName?: string
  /** It is what's saved now. */
  current?: true
}

export interface ProjectVersionResponse {
  summary: ProjectVersionSummary
  project: Project
}

export interface SaveProjectRequest {
  project: Project
  baseVersion: number
}

// ---- assets ----
// POST /api/uploads  UploadRequest            -> UploadTicket   (then PUT bytes to ticket.url with ticket.headers)
// POST /api/assets/:id/complete               -> AssetRecord    (queues asset.process)
// GET  /api/assets?workspaceId=&kind=&cursor=&limit= -> Page<AssetRecord>  (light records: no transcripts)
// GET  /api/assets/:id                        -> AssetRecord   (the full record)
// PATCH /api/assets/:id {name?, transcript?}  -> AssetRecord
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
  /**
   * A copy from a list or a live update: the clip's transcript is left out (its waveform is the inline one, as
   * always). GET /api/assets/:id has the full record.
   */
  light?: true
  /** On a light copy of a transcribed clip: which transcript it has (a different value means a different one). */
  transcriptRev?: string
  /** Base version of its name and transcript: send as If-Match with PATCH /api/assets/:id (412 if changed since). */
  etag?: string
}

/** Tells one transcript from another without sending it (cheap: no hashing of what can be an hour of words). */
export function transcriptRev(t: Transcript): string {
  const words = t.segments.reduce((n, s) => n + s.words.length, 0)
  const rev = `${t.language}:${t.engine}:${t.segments.length}:${words}:${t.segments[t.segments.length - 1]?.end ?? 0}`
  // speaker labels change without changing the words (a rename): they count too
  let spk = 0
  for (const s of t.segments) if (s.speaker) for (let i = 0; i < s.speaker.length; i++) spk = (Math.imul(spk, 31) + s.speaker.charCodeAt(i) + Math.round(s.start * 100)) >>> 0
  return spk ? `${rev}:${spk.toString(36)}` : rev
}

// ---- jobs ----
// GET /api/jobs/:id                    -> Job
// GET /api/jobs?projectId=&workspaceId=&cursor=&limit= -> Page<Job>
// POST /api/jobs/:id/cancel            -> Job
// GET /api/events?workspaceId=         -> text/event-stream, events: `job` (Job), `asset` (AssetRecord), `project`
//   ({id, version, deleted?}: created, saved, renamed, trashed/restored, template flag, deleted), `workspace`
//   ({id, name?, deleted, members?, brand?}: renamed, deleted, members changed, brand kit saved), `sync`
export type JobKind = 'asset.process' | 'ai.transcribe' | 'ai.tts' | 'ai.produce.script' | 'ai.produce.assemble' | 'export.render' | 'voice.relay' | 'voicestudio.install' | 'voicestudio.task' | 'media.scenes' | 'media.stabilise' | 'media.denoise' | 'media.bgremove' | 'media.smooth'
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
  /** asset.process: the clip being processed (so the media panel can show its progress). */
  assetId?: string
  result?: R
  error?: string
  createdAt: number
  updatedAt: number
  /** Who started it (their own jobs end with a notification). */
  startedBy?: string
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
  /** 'kokoro' (built-in) or a VoiceStudio voice profile ('clone' | 'design'); absent = kokoro. */
  source?: 'kokoro' | 'clone' | 'design'
  /** VoiceStudio engine id for profile voices. */
  engine?: string
  /** False when this replica can't generate it right now (cloud with no linked desktop online, runtime stopped…). */
  available?: boolean
  /** Why it isn't available, or where it runs ("Generated on Idris's desktop"). */
  detail?: string
}

// ---- VoiceStudio voices (engine runs on the desktop edition only) ----
// GET    /api/voice/profiles?workspaceId=          -> VoiceProfile[]              (both editions; synced metadata)
// PATCH  /api/voice/profiles/:id {name?, description?, gender?, language?} -> VoiceProfile   (editor+)
// DELETE /api/voice/profiles/:id                   -> {ok}                         (editor+; desktop also deletes it in VoiceStudio)
// Desktop only (404 on cloud): GET /api/voicestudio/status, POST install|start|stop, and the /api/voicestudio/* feature
// routes documented in docs/voicestudio.md. Cloud: TTS with a `vs:` voice becomes a `voice.relay` job that the desktop
// owning the voice claims (GET /api/voice/relay/claim, POST /api/voice/relay/:id/progress|done|fail; device token).
export interface VoiceProfile {
  id: string
  workspaceId: string
  name: string
  kind: 'clone' | 'design'
  engine: string
  language?: string
  gender?: string
  description?: string
  consent: { statement: string; attestedBy: string; attestedAt: number; speaker?: string }
  /** Desktop device that holds the reference audio and can generate it. */
  deviceId?: string
  /** True on the replica that can generate it locally (the owning desktop with VoiceStudio installed). */
  local: boolean
  /** Desktop only, when `local`: the VoiceStudio profile id (for dubbing / audiobook voice maps). Never synced. */
  vsProfileId?: string
  sampleAssetId?: string
  createdBy: string
  createdAt: number
  updatedAt: number
  /** Stamped by the server that holds it: +1 on every change it accepts (replicas compare these, not clocks). */
  version?: number
}

export interface VoiceStudioStatus {
  /** False on the cloud edition. */
  supported: boolean
  state: 'not-installed' | 'installing' | 'stopped' | 'starting' | 'running' | 'error'
  /** Pinned VoiceStudio source revision this app installs. */
  version: string
  installedVersion?: string
  device?: string
  /** Install / start progress (0..1, -1 indeterminate). */
  progress?: number
  message?: string
  error?: string
  /** Where runtime, models and VoiceStudio data live. */
  dir?: string
}

/** Voice ids of VoiceStudio profiles are `vs:<profileId>`; everything else is a Kokoro voice. */
export const VOICE_PROFILE_PREFIX = 'vs:'
export const isProfileVoice = (id: string | undefined): id is string => !!id && id.startsWith(VOICE_PROFILE_PREFIX)
export const profileVoiceId = (profileId: string) => `${VOICE_PROFILE_PREFIX}${profileId}`
export const profileIdOf = (voiceId: string) => voiceId.slice(VOICE_PROFILE_PREFIX.length)

export interface WriteRequest {
  kind: 'voiceover' | 'script' | 'headline' | 'caption' | 'rewrite'
  /** Workspace whose AI settings apply (cloud). Defaults to the user's personal workspace; ignored on desktop. */
  workspaceId?: string
  prompt: string
  context?: string
  maxWords?: number
}

/**
 * What Producer AI accepts: the server refuses more, and the wizard stops at the same numbers instead of sending a
 * script that comes back as a raw validation error after a long wait.
 */
export const PRODUCE_LIMITS = {
  /** Recordings one script is written from. */
  recordings: 20,
  /** Scenes one assembly takes. */
  scenes: 40,
  /** Footage windows in one scene. */
  footagePerScene: 20,
  /** Characters of narration in one scene. */
  narrationChars: 5000,
  /** Characters of the idea a video is made from. */
  ideaChars: 20000,
} as const

export interface ProduceScriptRequest {
  projectId: string
  /** Recordings to build from; empty when brief.source is 'idea'. */
  assetIds: string[]
  brief: NonNullable<ProducerMeta['brief']>
}

// POST /api/ai/produce/assemble -> Job<{ version, notes? }>; 409 { details: { reason: 'edited' } } when the timeline was
// edited since the last assembly and neither `replace` nor `intoCopy` is set
export interface ProduceAssembleRequest {
  projectId: string
  scenes: ScriptScene[]
  /** The brief as it is now (voice, look, title): assembly uses it, not the one the script was written from. */
  brief?: NonNullable<ProducerMeta['brief']>
  /** Replace a timeline that was edited since the last assembly. */
  replace?: boolean
  /** Assemble into a copy of the project and leave this one as it is (the job's projectId is the copy). */
  intoCopy?: boolean
}

// PUT /api/ai/produce/draft -> { version }: the wizard's brief and script edits, saved to the project's `ai` as you type
export interface ProduceDraftRequest {
  projectId: string
  brief: NonNullable<ProducerMeta['brief']>
  scenes: ScriptScene[]
  /** The brief the script was written from. */
  scriptBrief?: NonNullable<ProducerMeta['brief']>
}

// GET /api/ai/produce/capabilities?workspaceId=   -> ProduceCapabilities  (what a video made from an idea can use here)
export interface ProduceCapabilities {
  /** AI stills: the workspace has an OpenAI or Gemini key that can make them (billed to that key). */
  image?: { provider: 'openai' | 'gemini'; model: string }
  /** AI video clips (billed per second to the workspace's key). */
  video?: { provider: 'openai' | 'gemini'; model: string; maxSeconds: number }
  /** Stock footage search (the server has a Pexels key). */
  stock: boolean
  /** Scene visuals available here (motion and diagram always). */
  kinds: import('./types').VisualKind[]
  /** AI clips made per video at most. */
  maxAiClips: number
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
// GET  /api/exports/:id/captions                  -> the export's sidecar captions (viewer)
// GET  /api/projects/:id/previews/:jobId          -> the draft preview video (viewer)
// POST /api/assets/:id/scenes {from?, to?, threshold?} -> Job<SceneCuts> (editor; ffmpeg scene detection)
// POST /api/projects/:id/share   {exportId?}      -> ShareLink  (editor; the given or latest export; reuses that
//        export's existing link; 409 when nothing has been exported yet)
// GET  /api/projects/:id/shares                   -> ShareLink[]  (viewer)
// DELETE /api/share/:token                        -> {ok: true}   (editor; the link stops working)
// GET  /api/share/:token                          -> SharedVideo  (public, no auth: only what the page shows)
export interface ShareLink {
  token: string
  url: string
  exportId: string
  createdAt: number
}

export interface SharedVideo {
  project: { name: string; width: number; height: number; duration: number; updatedAt: number }
  videoUrl?: string
  /** GET /api/share/:token/poster (public): the export's thumbnail, when it has one. */
  posterUrl?: string
}
export interface ExportRequest {
  resolution: '720p' | '1080p' | '1440p' | '4k'
  fps: 24 | 25 | 30 | 50 | 60
  quality: 'draft' | 'standard' | 'high'
  /** mp3 / wav: the sound only. */
  format: 'mp4' | 'webm' | 'gif' | 'mp3' | 'wav'
  name?: string
  /** Loudness normalisation of the exported sound (see LOUDNESS_TARGETS); absent or 'off' leaves the mix as it is. */
  loudness?: 'off' | 'youtube' | 'podcast' | 'broadcast'
  /** Only this part of the timeline (seconds), starting at 0 in the file. */
  range?: { from: number; to: number }
  /** Reframe a copy to this ASPECT_RATIOS shape for the export (a platform preset); the project keeps its own. */
  aspect?: string
  /** Captions drawn on the picture (default), written to a sidecar file beside it, or left out. */
  captions?: 'burn' | 'sidecar' | 'none'
  captionFormat?: 'srt' | 'vtt'
  /** The caption track burned in or written out (default: every track burned, the first written). */
  captionTrackId?: string
  /** The frame (seconds into the export) used for its thumbnail and share-page poster. */
  coverAt?: number
  /** A quick draft for the export dialog's player: small and fast, kept only until the next one, not an export. */
  preview?: boolean
}

export interface ExportResult {
  exportId: string
  url: string
  sizeBytes: number
  duration: number
  /** The sidecar caption file (GET, `?download=1` saves it). */
  captionsUrl?: string
  format?: ExportRequest['format']
}

/** A draft preview (`preview: true`): GET previewUrl plays it. */
export interface ExportPreviewResult {
  previewUrl: string
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

/** media.scenes: where the picture changes, in seconds into the file, inside the range asked for. */
export interface SceneCuts {
  assetId: string
  cuts: number[]
}

// POST /api/assets/:id/smooth {from, to, fps, projectId?} -> Job<SmoothCopyResult> (editor; ffmpeg minterpolate)
/** media.smooth (E-17): the smooth slow-motion copy, a library asset, and the source range it really covers. */
export interface SmoothCopyResult {
  asset: Asset
  from: number
  to: number
  fps: number
}

// ---- templates ----
// GET /api/templates?workspaceId=&cursor=&limit= -> Page<TemplateSummary>   (the built-in Producer looks on the first
//     page, then the workspace's templates)
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
// POST /api/sync/failures/:kind/:id {action:'retry'|'skip'} -> SyncStatus  (an item that keeps failing)
// POST /api/sync/notices/:id {action:'dismiss'|'apply'}    -> SyncStatus
// Cloud sync surface (used by desktop replicas; Bearer device token or cookie):
// POST /api/devices {name}                 -> {deviceId, token}   (token shown once; stored hashed)
// GET  /api/devices                        -> Device[]
// DELETE /api/devices/:id                  -> {ok}
// GET  /api/sync/changes?since=<cursor>&limit=&maxBytes= -> SyncChanges  (all workspaces the user belongs to; a page
//      ends at `limit` changes or about `maxBytes` of JSON, default 4 MB, whichever comes first)
// POST /api/sync/projects/:id/delete {baseVersion, trashed?} -> {ok}  (a replica's delete: only while the cloud copy is
//      still the version it last saw, and still trashed if it saw it trashed; else 409 details {reason, version, trashed})
// POST /api/projects accepts optional `id` (client-generated) so desktop-created projects keep their id;
// PUT  /api/projects/:id with baseVersion is the push path (409 on conflict, details.version = cloud version).
// POST /api/uploads accepts optional `assetId` and `sha256`; returns 409 {code:'conflict'} with details
//      {exists: true} when that asset already exists in the cloud (nothing to upload). An earlier upload of the same
//      id that never arrived (still uploading, or failed without its file) gets a fresh ticket instead.
// Every project/asset/workspace write bumps a server-wide monotonic `change_seq`; `cursor` is that number.
export interface SystemInfo {
  mode: 'cloud' | 'desktop'
  version: string
  /** Effective default AI provider (for `?workspaceId=` on cloud, that workspace's settings). */
  ai: { provider: AiProviderId; available: boolean; detail: string; model?: string }
  /** Local capabilities (true on desktop; on cloud reflects the worker image). */
  capabilities: { transcribe: boolean; tts: boolean; render: boolean }
  sync?: SyncStatus
  /** Whether the server can use its object storage right now (checked every few minutes). */
  storage?: StorageHealth
  /** What this server accepts (MAX_UPLOAD_MB), for screens that state a limit. Optional: older servers omit it. */
  limits?: { uploadBytes: number }
  /** The server sends mail (invites, password reset, job notices). Optional: older servers omit it. */
  mail?: boolean
}

/** Result of the server's storage self-check: write, read back and delete a small object. */
export interface StorageHealth {
  status: 'unknown' | 'ok' | 'error'
  /** What failed and what to do about it (for a person, not a stack trace). */
  error?: string
  checkedAt?: number
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
  /** Items that keep failing to sync while everything else carries on (Retry or Skip each). Optional: older desktops omit it. */
  failures?: SyncFailure[]
  /** What sync did to keep someone's work safe (a delete undone, spaces set aside, work recovered). Optional. */
  notices?: SyncNotice[]
  error?: string
}

/** One item the desktop couldn't push. It is retried on its own schedule; Skip keeps it on this computer only. */
export interface SyncFailure {
  kind: 'project' | 'asset' | 'brand' | 'voice' | 'project-delete' | 'asset-delete' | 'voice-delete'
  id: string
  name: string
  /** The cloud's (or this computer's) reason, for a person. */
  error: string
  attempts: number
  skipped: boolean
  at: number
  /** Next automatic retry (absent when skipped). */
  nextAt?: number
}

/** Something sync did to keep work safe, shown until dismissed. */
export interface SyncNotice {
  id: string
  message: string
  at: number
  /** Label of the one thing the notice offers (POST /api/sync/notices/:id {action:'apply'}). */
  action?: string
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
  /** VoiceStudio runtime folder; empty = %LOCALAPPDATA%\Producer Studio\VoiceStudio. Takes effect after a reinstall. */
  voiceStudioDir: string
  /** Start the VoiceStudio engine when Producer Studio opens (once installed). */
  voiceStudioAutoStart: boolean
  /** System-wide dictation: a global shortcut dictates into any app (desktop, needs VoiceStudio + an ASR model). */
  dictationGlobal: boolean
  /** Electron accelerator for system-wide dictation (press to start, press again to insert). */
  dictationShortcut: string
  /** Paste the result into the focused app (else only copy it to the clipboard). */
  dictationPaste: boolean
  /** VoiceStudio dictation model id ('' = VoiceStudio's default). */
  dictationModel: string
}

export interface Device {
  id: string
  name: string
  createdAt: number
  lastSeenAt?: number
  /** The link stops working if it isn't used before this (90 days after it was last used). */
  expiresAt?: number
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
  /** VoiceStudio voice profiles (metadata only; `local` is always false here). Optional: older clouds omit it. */
  voiceProfiles?: Array<VoiceProfile & { changeSeq: number }>
  /** `workspaces`: spaces the user no longer belongs to (deleted, or membership removed). Optional: older clouds omit it. */
  deleted: { projects: string[]; assets: string[]; workspaces?: string[]; voiceProfiles?: string[] }
  /** True when more changes remain after `cursor` (page again). */
  more: boolean
  /**
   * Where the next pull must start (≤ cursor): below every change that may still be uncommitted, so a slow transaction
   * that commits after newer changes is still delivered. Page with `cursor`, resume with `safe`. Optional: older clouds
   * omit it.
   */
  safe?: number
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
