// Client for VoiceStudio inside Producer Studio. Desktop: /api/voicestudio/* (engine lifecycle, voices, imports) and the
// allow-listed proxy to VoiceStudio's own API at /api/voicestudio/x/<path>. Both editions: /api/voice/profiles.
import type { ApiError, Job, VoiceProfile, VoiceStudioStatus } from '@producer/core'
import { useEffect } from 'react'
import { create } from 'zustand'
import { HttpError } from '../../lib/api'
import { sysFetch } from '../system'

export const VS_PROXY = '/api/voicestudio/x'

/** URL of a VoiceStudio resource through the proxy (for <audio src> / downloads). */
export const vsUrl = (vsPath: string) => `${VS_PROXY}${vsPath.startsWith('/') ? '' : '/'}${vsPath}`

/** A model VoiceStudio wants its licence accepted for before it uses it (0.5.7+: its 403 `model_licence_required`). */
export interface LicenceModel {
  repo_id: string
  license?: string
  category?: string
  fingerprint?: string
}

/** GET /models/licenses/details/{repo}: the terms, and whether they are accepted on this computer. */
export interface LicenceDetails {
  repo_id: string
  info?: { license?: string; credit?: string; notes?: string; source_url?: string; evidence_url?: string; commercial_inference?: string; commercial_outputs?: string; license_category?: string }
  acceptance: { required: boolean; accepted: boolean; state: string; fingerprint: string; license?: string; category?: string; accepted_at?: string | number | null }
}

/** Models a refused request asked a licence for: ModelLicences' LicenceAsk shows the terms and Accept. */
export const useLicenceAsk = create<{ models?: LicenceModel[]; ask: (m: LicenceModel[]) => void; clear: () => void }>((set) => ({
  ask: (models) => set({ models }),
  clear: () => set({ models: undefined }),
}))

async function readError(res: Response): Promise<HttpError> {
  let err: ApiError = { error: res.statusText || `HTTP ${res.status}` }
  try {
    const j = (await res.json()) as ApiError & { detail?: unknown }
    // VoiceStudio errors come through the proxy as {detail}
    const d = j.detail
    const licence = d && typeof d === 'object' && (d as { code?: unknown }).code === 'model_licence_required' ? ((d as { models?: LicenceModel[] }).models ?? []) : undefined
    if (licence) {
      if (licence.length) useLicenceAsk.getState().ask(licence)
      return new HttpError(res.status, { error: `Accept the licence of ${licence.map((m) => m.repo_id).join(', ') || 'this model'} first (Voice Studio → Engine), then try again.` })
    }
    err = j.error ? j : { error: typeof d === 'string' ? d : (d as { message?: string } | undefined)?.message ?? JSON.stringify(d ?? j).slice(0, 300) }
  } catch {
    /* non-JSON */
  }
  return new HttpError(res.status, err)
}

/** Call VoiceStudio's API through the proxy. `body`: FormData or a JSON-able object. */
export async function vsFetch(vsPath: string, init: { method?: string; body?: FormData | object; signal?: AbortSignal; query?: Record<string, string | number | boolean | undefined> } = {}): Promise<Response> {
  const q = init.query ? Object.entries(init.query).filter(([, v]) => v !== undefined) : []
  const url = vsUrl(vsPath) + (q.length ? `${vsPath.includes('?') ? '&' : '?'}${new URLSearchParams(q.map(([k, v]) => [k, String(v)])).toString()}` : '')
  const isForm = init.body instanceof FormData
  const res = await fetch(url, {
    method: init.method ?? (init.body ? 'POST' : 'GET'),
    credentials: 'include',
    headers: init.body && !isForm ? { 'content-type': 'application/json' } : undefined,
    body: init.body ? (isForm ? (init.body as FormData) : JSON.stringify(init.body)) : undefined,
    signal: init.signal,
  })
  if (!res.ok) throw await readError(res)
  return res
}

export async function vsGet<T>(vsPath: string, init?: Parameters<typeof vsFetch>[1]): Promise<T> {
  return (await (await vsFetch(vsPath, init)).json()) as T
}

/** Read an SSE response body (VoiceStudio task / transcribe / audiobook streams). */
export async function* readSse(res: Response, signal?: AbortSignal): AsyncGenerator<{ event: string; data: any }> {
  if (!res.body) return
  const reader = res.body.getReader()
  const dec = new TextDecoder()
  let buf = ''
  try {
    for (;;) {
      if (signal?.aborted) return
      const { done, value } = await reader.read()
      if (done) break
      buf += dec.decode(value, { stream: true })
      let i: number
      while ((i = buf.search(/\r?\n\r?\n/)) >= 0) {
        const block = buf.slice(0, i)
        buf = buf.slice(i).replace(/^\r?\n\r?\n/, '')
        let event = 'message'
        const data: string[] = []
        for (const line of block.split(/\r?\n/)) {
          if (line.startsWith('event:')) event = line.slice(6).trim()
          else if (line.startsWith('data:')) data.push(line.slice(5).trimStart())
        }
        if (!data.length) continue
        const raw = data.join('\n')
        let parsed: unknown = raw
        try {
          parsed = JSON.parse(raw)
        } catch {
          /* raw text */
        }
        yield { event, data: parsed }
      }
    }
  } finally {
    reader.cancel().catch(() => undefined)
  }
}

export type VsStatus = VoiceStudioStatus & { sourceUrl?: string; log?: string[] }

/** GET /api/sfx/status (0.5.8): the MOSS-SoundEffect sidecar, installed through /engines/sidecar/moss-soundeffect/install. */
export interface SfxStatus {
  engine_id: string
  installed: boolean
  available: boolean
  /** This computer can run it (an NVIDIA graphics card). */
  supported: boolean
  reason?: string | null
  reason_code?: string | null
  install_allowed?: boolean
  download_bytes?: number
  license?: string
  min_seconds: number
  max_seconds: number
  default_seconds: number
  max_prompt_chars: number
}

/** POST /api/sfx/generate: the take, served from /audio. */
export interface SfxTake {
  id: string
  audio_url: string
  duration_s: number
  gen_time_s?: number
  seed: number
  engine?: string
}

/** POST /convert (the voice changer): the take, and for a video the video with its voice swapped. */
export interface ConvertTake {
  id: string
  audio_url: string
  video_url?: string | null
  duration_s: number
  text?: string
  engine?: string
  notes?: string[]
  message?: string
}

export const vsApi = {
  status: () => sysFetch<VsStatus>('GET', '/voicestudio/status'),
  install: () => sysFetch<Job>('POST', '/voicestudio/install'),
  start: () => sysFetch<VsStatus>('POST', '/voicestudio/start'),
  stop: () => sysFetch<VsStatus>('POST', '/voicestudio/stop'),
  importOutput: (b: { workspaceId: string; projectId?: string; source: string; name: string; kind: 'audio' | 'video'; ext?: string; origin?: 'tts' | 'voicestudio' | 'dub' }) => sysFetch<Job<{ asset: import('@producer/core').AssetRecord }>>('POST', '/voicestudio/import', b),
  /** Create a cloned (with `audio`) or designed voice. */
  async createVoice(fields: Record<string, string | Blob | undefined>): Promise<VoiceProfile> {
    const f = new FormData()
    for (const [k, v] of Object.entries(fields)) if (v !== undefined) f.set(k, v)
    const res = await fetch('/api/voicestudio/voices', { method: 'POST', credentials: 'include', body: f })
    if (!res.ok) throw await readError(res)
    return (await res.json()) as VoiceProfile
  },
  adoptVoice: (b: { workspaceId: string; vsProfileId: string; name: string; kind?: 'clone' | 'design'; engine?: string; language?: string; description?: string; consent: { agreed: true; speaker?: string; statement: string } }) =>
    sysFetch<VoiceProfile>('POST', '/voicestudio/voices/adopt', b),
  licenceDetails: (repo: string) => vsGet<LicenceDetails>(`/models/licenses/details/${repo}`),
  acceptLicence: (repo_id: string, fingerprint: string) => vsGet<LicenceDetails['acceptance']>('/models/licenses/accept', { body: { repo_id, fingerprint, accepted: true } }),
  sfxStatus: () => vsGet<SfxStatus>('/api/sfx/status'),
  sfxGenerate: (b: { prompt: string; duration: number; seed?: number }, signal?: AbortSignal) => vsGet<SfxTake>('/api/sfx/generate', { body: b, signal }),
  /** Send a library asset into VoiceStudio (dub upload, vocal isolation, transcription, audiobook import, the voice changer). */
  async assetTo(target: 'dub' | 'batch' | 'gallery' | 'clean-audio' | 'transcribe' | 'audiobook-import' | 'convert', assetId: string, fields: Record<string, string | undefined> = {}, signal?: AbortSignal): Promise<Response> {
    const q = new URLSearchParams({ assetId })
    for (const [k, v] of Object.entries(fields)) if (v !== undefined) q.set(k, v)
    const res = await fetch(`/api/voicestudio/asset-to/${target}?${q}`, { method: 'POST', credentials: 'include', signal })
    if (!res.ok) throw await readError(res)
    return res
  },
  profiles: (workspaceId: string) => sysFetch<VoiceProfile[]>('GET', `/voice/profiles?workspaceId=${encodeURIComponent(workspaceId)}`),
  updateProfile: (id: string, patch: Partial<Pick<VoiceProfile, 'name' | 'description' | 'gender' | 'language'>>) => sysFetch<VoiceProfile>('PATCH', `/voice/profiles/${encodeURIComponent(id)}`, patch),
  deleteProfile: (id: string) => sysFetch<{ ok: true }>('DELETE', `/voice/profiles/${encodeURIComponent(id)}`),
}

// ---------------- live engine status ----------------

interface StatusState {
  status?: VsStatus
  loaded: boolean
  set: (s: VsStatus) => void
}

export const useVsStatusStore = create<StatusState>((set) => ({ loaded: false, set: (s) => set((cur) => ({ status: { ...cur.status, ...s }, loaded: true })) }))

let subscribers = 0
let es: EventSource | undefined

/** Engine status for the desktop, kept live over SSE while any component uses it. `enabled=false` on the cloud. */
export function useVsStatus(enabled: boolean): VsStatus | undefined {
  const status = useVsStatusStore((s) => s.status)
  useEffect(() => {
    if (!enabled) return
    subscribers++
    if (subscribers === 1) {
      vsApi
        .status()
        .then((s) => useVsStatusStore.getState().set(s))
        .catch(() => undefined)
      try {
        es = new EventSource('/api/voicestudio/status/stream', { withCredentials: true })
        es.addEventListener('status', (e) => {
          try {
            useVsStatusStore.getState().set(JSON.parse((e as MessageEvent).data) as VsStatus)
          } catch {
            /* ignore */
          }
        })
      } catch {
        /* EventSource unavailable */
      }
    }
    return () => {
      subscribers--
      if (subscribers === 0) {
        es?.close()
        es = undefined
      }
    }
  }, [enabled])
  return enabled ? status : undefined
}

export const vsRunning = (s?: VoiceStudioStatus) => s?.state === 'running'

/** Licence notes for engines/models whose weights restrict use (shown as warnings; the user chose to allow all). */
/** `commercial: null` = depends on the model chosen (check its card). */
export const LICENSE_NOTES: Record<string, { license: string; commercial: boolean | null; note?: string }> = {
  omnivoice: { license: 'CC-BY-NC (weights) · Apache-2.0 (code)', commercial: false, note: 'Default VoiceStudio model. Non-commercial use only.' },
  'omnivoice-subprocess': { license: 'CC-BY-NC (weights)', commercial: false },
  'omnivoice-gguf': { license: 'CC-BY-NC-4.0 (weights)', commercial: false },
  cosyvoice: { license: 'Apache-2.0', commercial: true },
  'cosyvoice-gguf': { license: 'Apache-2.0', commercial: true },
  'ming-tts': { license: 'MIT', commercial: true },
  'audiocpp-dots': { license: 'Apache-2.0', commercial: true },
  'moss-soundeffect': { license: 'Apache-2.0', commercial: true, note: 'Sound effects, not speech. NVIDIA graphics cards only.' },
  voxcpm2: { license: 'Apache-2.0', commercial: true },
  'moss-tts-nano': { license: 'Apache-2.0', commercial: true },
  'moss-tts-v15': { license: 'Apache-2.0', commercial: true },
  'dots-tts': { license: 'Apache-2.0', commercial: true },
  'confucius4-tts': { license: 'Apache-2.0', commercial: true },
  'gpt-sovits': { license: 'MIT', commercial: true },
  kittentts: { license: 'Apache-2.0', commercial: true, note: 'No voice cloning.' },
  indextts2: { license: 'IndexTTS licence (custom)', commercial: false, note: 'Check the IndexTTS licence before commercial use.' },
  supertonic3: { license: 'OpenRAIL', commercial: false, note: 'Requires accepting its licence.' },
  pockettts: { license: 'CC-BY-4.0', commercial: true, note: 'Requires accepting its licence.' },
  'mlx-audio': { license: 'Varies by model', commercial: null, note: 'Apple Silicon only.' },
  audiocpp: { license: 'Other (unreviewed)', commercial: false },
  'sherpa-onnx': { license: 'Varies by model', commercial: null },
  'sherpa-onnx-asr': { license: 'Varies by model', commercial: null },
  'faster-whisper': { license: 'MIT', commercial: true },
  'faster-whisper-isolated': { license: 'MIT', commercial: true },
  whisperx: { license: 'MIT (model) · BSD (code)', commercial: true },
  'pytorch-whisper': { license: 'Apache-2.0 / MIT', commercial: true },
  moonshine: { license: 'MIT', commercial: true },
  'nemo-parakeet': { license: 'CC-BY-4.0', commercial: true },
}
