// Typed client for the Producer Studio API (contract: packages/core/src/api.ts).
import type {
  ApiError,
  AssetRecord,
  AssistantRequest,
  AssistantResult,
  BrandKitDoc,
  CreateProjectRequest,
  ExportRecord,
  ExportRequest,
  ExportResult,
  Job,
  MeResponse,
  Member,
  ProduceScriptRequest,
  Project,
  ProjectDocResponse,
  ProjectSummary,
  ScriptScene,
  TemplateSummary,
  Transcript,
  TtsRequest,
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

async function req<T>(method: string, path: string, body?: unknown, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method,
    credentials: 'include',
    headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    ...init,
  })
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

/** Stream an SSE response from a POST endpoint; calls onEvent for each `event:`/`data:` pair. */
export async function postStream(path: string, body: unknown, onEvent: (event: string, data: unknown) => void, signal?: AbortSignal): Promise<void> {
  const res = await fetch(`/api${path}`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
    body: JSON.stringify(body),
    signal,
  })
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

export const mediaUrl = (assetId: string, variant: 'source' | 'proxy' | 'thumb' | 'filmstrip' | 'audio' = 'source') => `/api/media/${encodeURIComponent(assetId)}/${variant}`

export const api = {
  // auth
  me: () => req<MeResponse>('GET', '/auth/me'),
  login: (email: string, password: string) => req<MeResponse>('POST', '/auth/login', { email, password }),
  signup: (email: string, password: string, name: string) => req<MeResponse>('POST', '/auth/signup', { email, password, name }),
  logout: () => req<{ ok: true }>('POST', '/auth/logout'),

  // workspaces
  workspaces: () => req<Workspace[]>('GET', '/workspaces'),
  createWorkspace: (name: string) => req<Workspace>('POST', '/workspaces', { name }),
  members: (id: string) => req<Member[]>('GET', `/workspaces/${id}/members`),
  invite: (id: string, email: string, role: string) => req<{ ok: true; inviteUrl: string }>('POST', `/workspaces/${id}/invites`, { email, role }),
  brand: (id: string) => req<BrandKitDoc>('GET', `/workspaces/${id}/brand`),
  saveBrand: (id: string, doc: BrandKitDoc) => req<BrandKitDoc>('PUT', `/workspaces/${id}/brand`, doc),

  // projects
  projects: (workspaceId: string, opts: { trashed?: boolean; templates?: boolean } = {}) =>
    req<ProjectSummary[]>('GET', `/projects${qs({ workspaceId, trashed: opts.trashed ? 1 : 0, templates: opts.templates ? 1 : undefined })}`),
  createProject: (body: CreateProjectRequest) => req<ProjectDocResponse>('POST', '/projects', body),
  project: (id: string) => req<ProjectDocResponse>('GET', `/projects/${id}`),
  saveProject: (id: string, project: Project, baseVersion: number) => req<{ version: number; updatedAt: number }>('PUT', `/projects/${id}`, { project, baseVersion }),
  patchProject: (id: string, patch: { name?: string; trashed?: boolean; isTemplate?: boolean }) => req<ProjectSummary>('PATCH', `/projects/${id}`, patch),
  duplicateProject: (id: string) => req<ProjectSummary>('POST', `/projects/${id}/duplicate`),
  deleteProject: (id: string) => req<{ ok: true }>('DELETE', `/projects/${id}`),

  // assets
  assets: (workspaceId: string, kind?: string) => req<AssetRecord[]>('GET', `/assets${qs({ workspaceId, kind })}`),
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
    await new Promise<void>((resolve, reject) => {
      const xhr = new XMLHttpRequest()
      xhr.open('PUT', ticket.url)
      xhr.withCredentials = ticket.url.startsWith('/')
      for (const [k, v] of Object.entries(ticket.headers)) xhr.setRequestHeader(k, v)
      xhr.upload.onprogress = (e) => e.lengthComputable && onProgress?.(e.loaded / e.total)
      xhr.onload = () => (xhr.status < 300 ? resolve() : reject(new Error(`Upload failed (${xhr.status})`)))
      xhr.onerror = () => reject(new Error('Upload failed'))
      xhr.send(file)
    })
    return req<AssetRecord>('POST', `/assets/${ticket.assetId}/complete`)
  },

  // jobs
  job: <R = unknown>(id: string) => req<Job<R>>('GET', `/jobs/${id}`),
  jobs: (opts: { projectId?: string; workspaceId?: string }) => req<Job[]>('GET', `/jobs${qs(opts)}`),
  cancelJob: (id: string) => req<Job>('POST', `/jobs/${id}/cancel`),

  // ai
  transcribe: (assetId: string, language?: string) => req<Job<{ assetId: string; transcript: Transcript }>>('POST', '/ai/transcribe', { assetId, language }),
  tts: (body: TtsRequest) => req<Job<{ asset: AssetRecord; duration: number }>>('POST', '/ai/tts', body),
  voices: () => req<Voice[]>('GET', '/ai/voices'),
  voiceSampleUrl: (id: string) => `/api/ai/voices/${encodeURIComponent(id)}/sample`,
  write: (body: WriteRequest, onDelta: (text: string) => void, signal?: AbortSignal) =>
    postStream('/ai/write', body, (ev, data) => {
      if (ev === 'delta') onDelta((data as { text: string }).text)
    }, signal),
  produceScript: (body: ProduceScriptRequest) => req<Job<{ script: { scenes: ScriptScene[] } }>>('POST', '/ai/produce/script', body),
  produceAssemble: (projectId: string, scenes: ScriptScene[]) => req<Job<{ version: number }>>('POST', '/ai/produce/assemble', { projectId, scenes }),
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
  share: (id: string, exportId?: string) => req<{ url: string; token: string }>('POST', `/projects/${id}/share`, { exportId }),
  templates: (workspaceId: string) => req<TemplateSummary[]>('GET', `/templates${qs({ workspaceId })}`),
}

/** Subscribe to server events for a workspace. Returns an unsubscribe function. */
export function subscribeEvents(workspaceId: string, handlers: { job?: (j: Job) => void; asset?: (a: AssetRecord) => void; project?: (p: { id: string; version: number }) => void }): () => void {
  const es = new EventSource(`/api/events?workspaceId=${encodeURIComponent(workspaceId)}`, { withCredentials: true })
  if (handlers.job) es.addEventListener('job', (e) => handlers.job!(JSON.parse((e as MessageEvent).data)))
  if (handlers.asset) es.addEventListener('asset', (e) => handlers.asset!(JSON.parse((e as MessageEvent).data)))
  if (handlers.project) es.addEventListener('project', (e) => handlers.project!(JSON.parse((e as MessageEvent).data)))
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
