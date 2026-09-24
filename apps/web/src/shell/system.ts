// Server mode (cloud | desktop), AI provider and desktop sync state.
// lib/api.ts doesn't cover these endpoints yet, so the shell calls them with a small fetch helper.
import type { AiKeyProvider, AiKeyTestResult, AiProviderId, AiSettings, AiSettingsUpdate, ApiError, Device, DesktopSettings, SyncStatus, SystemInfo } from '@producer/core'
import { useEffect } from 'react'
import { create } from 'zustand'
import { HttpError } from '../lib/api'
import { useSession } from '../lib/session'

export async function sysFetch<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method,
    credentials: 'include',
    headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  if (!res.ok) {
    let err: ApiError = { error: res.statusText || `HTTP ${res.status}` }
    try {
      err = await res.json()
    } catch {
      /* non-JSON */
    }
    throw new HttpError(res.status, err)
  }
  return (await res.json()) as T
}

export const systemApi = {
  system: () => sysFetch<SystemInfo>('GET', '/system'),
  settings: () => sysFetch<DesktopSettings>('GET', '/settings'),
  saveSettings: (p: Partial<DesktopSettings>) => sysFetch<DesktopSettings>('PUT', '/settings', p),
  syncStatus: () => sysFetch<SyncStatus>('GET', '/sync/status'),
  syncNow: () => sysFetch<SyncStatus>('POST', '/sync/now'),
  link: (cloudUrl: string, email: string, password: string) => sysFetch<SyncStatus>('POST', '/sync/link', { cloudUrl, email, password }),
  unlink: () => sysFetch<SyncStatus>('POST', '/sync/unlink'),
  resolve: (projectId: string, mode: 'keep-local' | 'keep-cloud' | 'keep-both') => sysFetch<SyncStatus>('POST', `/projects/${encodeURIComponent(projectId)}/sync`, { mode }),
  devices: () => sysFetch<Device[]>('GET', '/devices'),
  revokeDevice: (id: string) => sysFetch<{ ok: true }>('DELETE', `/devices/${encodeURIComponent(id)}`),
  // bring-your-own-key AI providers (desktop ignores workspaceId)
  aiSettings: (workspaceId?: string) => sysFetch<AiSettings>('GET', `/ai/settings${workspaceId ? `?workspaceId=${encodeURIComponent(workspaceId)}` : ''}`),
  saveAiSettings: (u: AiSettingsUpdate) => sysFetch<AiSettings>('PUT', '/ai/settings', u),
  saveAiKey: (provider: AiKeyProvider, key: string, workspaceId?: string) => sysFetch<AiKeyTestResult>('PUT', `/ai/keys/${provider}`, { workspaceId, key }),
  deleteAiKey: (provider: AiKeyProvider, workspaceId?: string) => sysFetch<AiSettings>('DELETE', `/ai/keys/${provider}${workspaceId ? `?workspaceId=${encodeURIComponent(workspaceId)}` : ''}`),
  testAiKey: (provider: AiKeyProvider, workspaceId?: string, key?: string) => sysFetch<AiKeyTestResult>('POST', `/ai/keys/${provider}/test`, { workspaceId, key }),
}

/** /api/system for the current workspace (cloud: its effective AI provider). */
export function systemPath(refresh = false): string {
  const ws = useSession.getState().workspaceId
  const q = [ws ? `workspaceId=${encodeURIComponent(ws)}` : '', refresh ? 'refresh=1' : ''].filter(Boolean).join('&')
  return `/system${q ? `?${q}` : ''}`
}

interface SystemState {
  info?: SystemInfo
  loaded: boolean
  error?: string
  sync?: SyncStatus
  load: () => Promise<SystemInfo | undefined>
  setSync: (s: SyncStatus) => void
}

let inflight: Promise<SystemInfo | undefined> | undefined
let inflightPath = ''

export const useSystem = create<SystemState>((set) => ({
  loaded: false,
  load() {
    const path = systemPath()
    if (inflight && inflightPath !== path) inflight = undefined
    inflightPath = path
    if (inflight) return inflight
    const p: Promise<SystemInfo | undefined> = sysFetch<SystemInfo>('GET', path)
      .then((info) => {
        // a newer request (workspace switch) wins
        if (inflight === p || !inflight) set((s) => ({ info, loaded: true, error: undefined, sync: info.sync ?? s.sync }))
        return info
      })
      .catch((e) => {
        // Older servers without /api/system behave like cloud.
        set({ loaded: true, error: e instanceof Error ? e.message : String(e) })
        return undefined
      })
      .finally(() => {
        if (inflight === p) inflight = undefined
      })
    inflight = p
    return p
  },
  setSync: (sync) => set((s) => ({ sync, info: s.info ? { ...s.info, sync } : s.info })),
}))

export const isDesktop = (info?: SystemInfo) => info?.mode === 'desktop'
export const useIsDesktop = () => useSystem((s) => s.info?.mode === 'desktop')

/** In desktop mode: poll sync status every 10 s and listen for SSE `sync` events. */
export function useSyncPolling(workspaceId: string | undefined) {
  const desktop = useIsDesktop()
  const setSync = useSystem((s) => s.setSync)
  useEffect(() => {
    if (!desktop) return
    let alive = true
    const tick = () =>
      systemApi
        .syncStatus()
        .then((s) => alive && setSync(s))
        .catch(() => undefined)
    void tick()
    const iv = setInterval(tick, 10_000)
    // lib/subscribeEvents doesn't expose `sync` yet; desktop is local and single-user, so a second stream is cheap.
    let es: EventSource | undefined
    if (workspaceId && typeof EventSource !== 'undefined') {
      try {
        es = new EventSource(`/api/events?workspaceId=${encodeURIComponent(workspaceId)}`, { withCredentials: true })
        es.addEventListener('sync', (e) => {
          try {
            setSync(JSON.parse((e as MessageEvent).data))
          } catch {
            /* ignore malformed */
          }
        })
      } catch {
        /* ignore */
      }
    }
    return () => {
      alive = false
      clearInterval(iv)
      es?.close()
    }
  }, [desktop, workspaceId, setSync])
}

export type ProjectSyncBadge = 'synced' | 'local' | 'conflict'

/**
 * Per-project cloud state for Library cards (desktop only).
 * TODO: use a per-project sync field once ProjectSummary carries one; for now this is derived from SyncStatus.
 */
export function projectSyncBadge(projectId: string, sync: SyncStatus | undefined): ProjectSyncBadge | undefined {
  if (!sync) return undefined
  if (sync.conflicts.some((c) => c.projectId === projectId)) return 'conflict'
  if (!sync.linked) return 'local'
  return 'synced'
}

const PROVIDER_NAME: Record<AiProviderId, string> = {
  'claude-cli': 'Claude',
  'anthropic-api': 'Claude',
  'anthropic-key': 'Claude',
  openai: 'OpenAI',
  gemini: 'Gemini',
  none: 'AI',
}

export const aiProviderName = (id?: AiProviderId) => (id ? PROVIDER_NAME[id] : 'AI')

/** "Claude · your subscription", "Claude API", "Gemini · gemini-3-pro", "OpenAI · gpt-5.5". */
export function aiProviderLabel(id?: AiProviderId, model?: string): string {
  switch (id) {
    case 'claude-cli':
      return 'Claude · your subscription'
    case 'anthropic-api':
      return 'Claude API'
    case 'anthropic-key':
    case 'openai':
    case 'gemini':
      return model ? `${PROVIDER_NAME[id]} · ${model}` : `${PROVIDER_NAME[id]} API`
    default:
      return 'AI unavailable'
  }
}

export function aiLabel(info?: SystemInfo): string {
  return aiProviderLabel(info?.ai.provider, info?.ai.model)
}

/** True when the label already names the model (key-backed providers). */
export const aiLabelHasModel = (info?: SystemInfo) => ['anthropic-key', 'openai', 'gemini'].includes(info?.ai.provider ?? '') && !!info?.ai.model
