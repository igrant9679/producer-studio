// Typed client for the Producer Studio API (contract: packages/core/src/api.ts).
import type {
  ApiError,
  AssetRecord,
  AssistantRequest,
  AssistantResult,
  BrandKitDoc,
  CreateProjectRequest,
  DesktopSettings,
  Device,
  ExportRecord,
  ExportRequest,
  ExportResult,
  InviteInfo,
  Job,
  MeResponse,
  Page,
  PendingInvite,
  PreferencesResponse,
  Member,
  ProduceAssembleRequest,
  ProduceCapabilities,
  ProduceDraftRequest,
  ProduceScriptRequest,
  Project,
  ProjectDocResponse,
  ProjectSummary,
  ScriptScene,
  ShareLink,
  SyncStatus,
  SystemInfo,
  TemplateSummary,
  Transcript,
  TtsRequest,
  UserPreferences,
  Voice,
  Workspace,
  WriteRequest,
} from '@producer/core'

export class HttpError extends Error {
  status: number
  body: ApiError
  constructor(status: number, body: ApiError) {
    super(body.error || `HTTP ${status}`)
    this.status = status
    this.body = body
  }
}

let onUnauthorized: (() => void) | undefined

/** lib/session listens here: a 401 may mean the session ended. */
export function setUnauthorizedHandler(fn: (() => void) | undefined) {
  onUnauthorized = fn
}

/** Call after any /api response: a 401 outside sign-in itself has the session checked (it may have expired). */
export function noteStatus(path: string, status: number) {
  if (status === 401 && !path.startsWith('/auth/')) onUnauthorized?.()
}

async function req<T>(method: string, path: string, body?: unknown, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method,
    credentials: 'include',
    headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    ...init,
  })
  noteStatus(path, res.status)
  if (!res.ok) {
    let err: ApiError = { error: res.statusText }
    try {
      err = await res.json()
    } catch {
      /* non-JSON error */
    }
    throw new HttpError(res.status, err)
  }
  if (res.status === 204) return undefined as T
  return (await res.json()) as T
}

const qs = (o: Record<string, string | number | boolean | undefined>) => {
  const p = new URLSearchParams()
  for (const [k, v] of Object.entries(o)) if (v !== undefined) p.set(k, String(v))
  const s = p.toString()
  return s ? `?${s}` : ''
}

/**
 * A whole list from a paged route: each page asks for the next (`cursor` = the last page's `nextCursor`) until there is
 * none, so a long list never quietly stops at the first page. (A plain array, from an older server, is the whole list.)
 */
async function listAll<T>(path: string): Promise<T[]> {
  const out: T[] = []
  let cursor: string | undefined
  for (let pages = 0; pages < 1000; pages++) {
    const sep = path.includes('?') ? '&' : '?'
    const page = await req<Page<T> | T[]>('GET', `${path}${sep}limit=${LIST_PAGE}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`)
    if (Array.isArray(page)) return page
    out.push(...page.items)
    if (!page.nextCursor || page.nextCursor === cursor) break
    cursor = page.nextCursor
  }
  return out
}

/** Items per page when reading a whole list (the server's largest page). */
export const LIST_PAGE = 500

/** Stream an SSE response from a POST endpoint; calls onEvent for each `event:`/`data:` pair. */
export async function postStream(path: string, body: unknown, onEvent: (event: string, data: unknown) => void, signal?: AbortSignal): Promise<void> {
  const res = await fetch(`/api${path}`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
    body: JSON.stringify(body),
    signal,
  })
  noteStatus(path, res.status)
  if (!res.ok || !res.body) {
    let err: ApiError = { error: res.statusText }
    try {
      err = await res.json()
    } catch {
      /* ignore */
    }
    throw new HttpError(res.status, err)
  }
  const reader = res.body.getReader()
  const dec = new TextDecoder()
  let buf = ''
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    buf += dec.decode(value, { stream: true })
    let idx: number
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const chunk = buf.slice(0, idx)
      buf = buf.slice(idx + 2)
      let event = 'message'
      const data: string[] = []
      for (const line of chunk.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim()
        else if (line.startsWith('data:')) data.push(line.slice(5).trimStart())
      }
      if (!data.length) continue
      let parsed: unknown = data.join('\n')
      try {
        parsed = JSON.parse(parsed as string)
      } catch {
        /* plain text */
      }
      onEvent(event, parsed)
    }
  }
}

export const mediaUrl = (assetId: string, variant: 'source' | 'proxy' | 'thumb' | 'filmstrip' | 'audio' | 'waveform' = 'source') => `/api/media/${encodeURIComponent(assetId)}/${variant}`

/** Why a PUT to storage was refused, in words — S3 answers with an XML <Code> (e.g. InvalidAccessKeyId). */
function storageRefusal(xhr: XMLHttpRequest): string {
  let code = ''
  try {
    code = xhr.responseText.match(/<Code>([^<]+)<\/Code>/)?.[1] ?? ''
  } catch {
    /* response not readable */
  }
  const what = `${xhr.status}${code ? ` ${code}` : ''}`
  if (xhr.status === 403) return `storage refused the upload (${what}) — the server's storage credentials may have been rotated`
  if (xhr.status === 413) return `the file is too large for storage (${what})`
  return `storage answered ${what}`
}

export const api = {
  // auth
  me: () => req<MeResponse>('GET', '/auth/me'),
  login: (email: string, password: string) => req<MeResponse>('POST', '/auth/login', { email, password }),
  signup: (email: string, password: string, name: string) => req<MeResponse>('POST', '/auth/signup', { email, password, name }),
  logout: () => req<{ ok: true }>('POST', '/auth/logout'),
  preferences: () => req<PreferencesResponse>('GET', '/me/preferences'),
  savePreferences: (p: Partial<UserPreferences>) => req<PreferencesResponse>('PUT', '/me/preferences', p),

  // workspaces
  workspaces: () => req<Workspace[]>('GET', '/workspaces'),
  createWorkspace: (name: string) => req<Workspace>('POST', '/workspaces', { name }),
  renameWorkspace: (id: string, name: string) => req<Workspace>('PATCH', `/workspaces/${id}`, { name }),
  deleteWorkspace: (id: string) => req<{ ok: true }>('DELETE', `/workspaces/${id}`),
  members: (id: string) => req<Member[]>('GET', `/workspaces/${id}/members`),
  invite: (id: string, email: string, role: string) => req<{ ok: true; inviteUrl: string; expiresAt: number }>('POST', `/workspaces/${id}/invites`, { email, role }),
  setMemberRole: (id: string, userId: string, role: Member['role']) => req<{ ok: true; role: Member['role'] }>('PATCH', `/workspaces/${id}/members/${encodeURIComponent(userId)}`, { role }),
  /** Remove a member (owner), or leave when `userId` is your own. */
  removeMember: (id: string, userId: string) => req<{ ok: true }>('DELETE', `/workspaces/${id}/members/${encodeURIComponent(userId)}`),
  invites: (id: string) => req<PendingInvite[]>('GET', `/workspaces/${id}/invites`),
  revokeInvite: (id: string, token: string) => req<{ ok: true }>('DELETE', `/workspaces/${id}/invites/${encodeURIComponent(token)}`),
  inviteInfo: (token: string) => req<InviteInfo>('GET', `/invites/${encodeURIComponent(token)}`),
  acceptInvite: (token: string) => req<Workspace>('POST', `/invites/${encodeURIComponent(token)}/accept`),
  brand: (id: string) => req<BrandKitDoc>('GET', `/workspaces/${id}/brand`),
  saveBrand: (id: string, doc: BrandKitDoc) => req<BrandKitDoc>('PUT', `/workspaces/${id}/brand`, doc),

  // projects
  projects: (workspaceId: string, opts: { trashed?: boolean; templates?: boolean } = {}) =>
    listAll<ProjectSummary>(`/projects${qs({ workspaceId, trashed: opts.trashed ? 1 : 0, templates: opts.templates ? 1 : undefined })}`),
  createProject: (body: CreateProjectRequest) => req<ProjectDocResponse>('POST', '/projects', body),
  project: (id: string) => req<ProjectDocResponse>('GET', `/projects/${id}`),
  saveProject: (id: string, project: Project, baseVersion: number) => req<{ version: number; updatedAt: number }>('PUT', `/projects/${id}`, { project, baseVersion }),
  patchProject: (id: string, patch: { name?: string; trashed?: boolean; isTemplate?: boolean }) => req<ProjectSummary>('PATCH', `/projects/${id}`, patch),
  duplicateProject: (id: string) => req<ProjectSummary>('POST', `/projects/${id}/duplicate`),
  deleteProject: (id: string) => req<{ ok: true }>('DELETE', `/projects/${id}`),

  // assets
  /** Light records (no transcripts): `asset(id)` has the full one. */
  assets: (workspaceId: string, kind?: string) => listAll<AssetRecord>(`/assets${qs({ workspaceId, kind })}`),
  asset: (id: string) => req<AssetRecord>('GET', `/assets/${id}`),
  renameAsset: (id: string, name: string) => req<AssetRecord>('PATCH', `/assets/${id}`, { name }),
  deleteAsset: (id: string) => req<{ ok: true }>('DELETE', `/assets/${id}`),
  /** Upload a File: ticket -> PUT bytes -> complete. onProgress 0..1. */
  async upload(workspaceId: string, file: File, onProgress?: (f: number) => void): Promise<AssetRecord> {
    const ticket = await req<{ assetId: string; url: string; method: 'PUT'; headers: Record<string, string> }>('POST', '/uploads', {
      workspaceId,
      filename: file.name,
      mime: file.type || 'application/octet-stream',
      size: file.size,
    })
    try {
      await new Promise<void>((resolve, reject) => {
        const xhr = new XMLHttpRequest()
        xhr.open('PUT', ticket.url)
        xhr.withCredentials = ticket.url.startsWith('/')
        for (const [k, v] of Object.entries(ticket.headers)) xhr.setRequestHeader(k, v)
        xhr.upload.onprogress = (e) => e.lengthComputable && onProgress?.(e.loaded / e.total)
        xhr.onload = () => (xhr.status < 300 ? resolve() : reject(new Error(storageRefusal(xhr))))
        xhr.onerror = () => reject(new Error("the file couldn't be sent to storage (it refused the connection or the network dropped)"))
        xhr.send(file)
      })
    } catch (e) {
      // Tell the server, or the clip sits on "Processing" in everyone's library for good.
      const reason = e instanceof Error ? e.message : String(e)
      await req('POST', `/assets/${ticket.assetId}/abort`, { reason }).catch(() => undefined)
      throw new Error(`${file.name}: upload failed — ${reason}`)
    }
    return req<AssetRecord>('POST', `/assets/${ticket.assetId}/complete`)
  },
  /** Re-run processing for a clip that failed (its file must already be in storage). */
  retryAsset: (id: string) => req<AssetRecord>('POST', `/assets/${id}/complete`),

  // jobs
  job: <R = unknown>(id: string) => req<Job<R>>('GET', `/jobs/${id}`),
  jobs: (opts: { projectId?: string; workspaceId?: string }) => listAll<Job>(`/jobs${qs(opts)}`),
  cancelJob: (id: string) => req<Job>('POST', `/jobs/${id}/cancel`),

  // ai
  transcribe: (assetId: string, language?: string) => req<Job<{ assetId: string; transcript: Transcript }>>('POST', '/ai/transcribe', { assetId, language }),
  tts: (body: TtsRequest) => req<Job<{ asset: AssetRecord; duration: number }>>('POST', '/ai/tts', body),
  voices: (workspaceId?: string) => req<Voice[]>('GET', `/ai/voices${workspaceId ? `?workspaceId=${encodeURIComponent(workspaceId)}` : ''}`),
  voiceSampleUrl: (id: string) => `/api/ai/voices/${encodeURIComponent(id)}/sample`,
  write: (body: WriteRequest, onDelta: (text: string) => void, signal?: AbortSignal) =>
    postStream('/ai/write', body, (ev, data) => {
      if (ev === 'delta') onDelta((data as { text: string }).text)
    }, signal),
  produceScript: (body: ProduceScriptRequest) => req<Job<{ script: { scenes: ScriptScene[] } }>>('POST', '/ai/produce/script', body),
  /** 409 { details: { reason: 'edited' } }: the timeline was edited since the last assembly (send replace or intoCopy). */
  produceAssemble: (body: ProduceAssembleRequest) => req<Job<{ version: number; notes?: string[] }>>('POST', '/ai/produce/assemble', body),
  saveProducerDraft: (body: ProduceDraftRequest) => req<{ version: number }>('PUT', '/ai/produce/draft', body),
  produceCapabilities: (workspaceId: string) => req<ProduceCapabilities>('GET', `/ai/produce/capabilities${qs({ workspaceId })}`),
  assistant: (body: AssistantRequest, on: { text?: (d: string) => void; tool?: (name: string, summary: string) => void }, signal?: AbortSignal) =>
    new Promise<AssistantResult>((resolve, reject) => {
      let result: AssistantResult | undefined
      postStream('/ai/assistant', body, (ev, data) => {
        if (ev === 'text') on.text?.((data as { delta: string }).delta)
        else if (ev === 'tool') on.tool?.((data as { name: string }).name, (data as { summary: string }).summary)
        else if (ev === 'done') result = data as AssistantResult
        else if (ev === 'error') reject(new Error((data as { error: string }).error))
      }, signal)
        .then(() => (result ? resolve(result) : reject(new Error('Assistant ended without a result'))))
        .catch(reject)
    }),

  // export / share / templates
  exportProject: (id: string, body: ExportRequest) => req<Job<ExportResult>>('POST', `/projects/${id}/export`, body),
  exports: (projectId: string) => req<ExportRecord[]>('GET', `/exports${qs({ projectId })}`),
  share: (id: string, exportId?: string) => req<ShareLink>('POST', `/projects/${id}/share`, { exportId }),
  shares: (id: string) => req<ShareLink[]>('GET', `/projects/${id}/shares`),
  unshare: (token: string) => req<{ ok: true }>('DELETE', `/share/${encodeURIComponent(token)}`),
  templates: (workspaceId: string) => listAll<TemplateSummary>(`/templates${qs({ workspaceId })}`),

  // system / desktop / sync
  system: () => req<SystemInfo>('GET', '/system'),
  settings: () => req<DesktopSettings>('GET', '/settings'),
  saveSettings: (p: Partial<DesktopSettings>) => req<DesktopSettings>('PUT', '/settings', p),
  syncStatus: () => req<SyncStatus>('GET', '/sync/status'),
  syncNow: () => req<SyncStatus>('POST', '/sync/now'),
  syncLink: (cloudUrl: string, email: string, password: string) => req<SyncStatus>('POST', '/sync/link', { cloudUrl, email, password }),
  syncUnlink: () => req<SyncStatus>('POST', '/sync/unlink'),
  resolveSync: (id: string, mode: 'keep-local' | 'keep-cloud' | 'keep-both') => req<SyncStatus>('POST', `/projects/${id}/sync`, { mode }),
  devices: () => req<Device[]>('GET', '/devices'),
  revokeDevice: (id: string) => req<{ ok: true }>('DELETE', `/devices/${id}`),
}

/** Subscribe to server events for a workspace. Returns an unsubscribe function. */
export function subscribeEvents(
  workspaceId: string,
  handlers: {
    job?: (j: Job) => void
    /** A light record (no transcript; see AssetRecord.light). */
    asset?: (a: AssetRecord) => void
    project?: (p: { id: string; version: number }) => void
    sync?: (s: SyncStatus) => void
    workspace?: (w: { id: string; name?: string; deleted: boolean }) => void
  },
): () => void {
  const es = new EventSource(`/api/events?workspaceId=${encodeURIComponent(workspaceId)}`, { withCredentials: true })
  if (handlers.sync) es.addEventListener('sync', (e) => handlers.sync!(JSON.parse((e as MessageEvent).data)))
  if (handlers.job) es.addEventListener('job', (e) => handlers.job!(JSON.parse((e as MessageEvent).data)))
  if (handlers.asset) es.addEventListener('asset', (e) => handlers.asset!(JSON.parse((e as MessageEvent).data)))
  if (handlers.project) es.addEventListener('project', (e) => handlers.project!(JSON.parse((e as MessageEvent).data)))
  if (handlers.workspace) es.addEventListener('workspace', (e) => handlers.workspace!(JSON.parse((e as MessageEvent).data)))
  return () => es.close()
}

/** Poll/await a job until it finishes (uses GET; SSE listeners update UI in parallel). */
export async function waitForJob<R>(id: string, onUpdate?: (j: Job<R>) => void, intervalMs = 1000): Promise<Job<R>> {
  for (;;) {
    const j = await api.job<R>(id)
    onUpdate?.(j)
    if (j.status === 'done') return j
    if (j.status === 'error' || j.status === 'cancelled') throw new Error(j.error || `Job ${j.status}`)
    await new Promise((r) => setTimeout(r, intervalMs))
  }
}
