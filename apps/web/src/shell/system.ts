// Server mode (cloud | desktop), AI provider and desktop sync state.
// lib/api.ts doesn't cover these endpoints yet, so the shell calls them with a small fetch helper.
import type { StoredKeyProvider, AiKeyTestResult, AiProviderId, AiSettings, AiSettingsUpdate, ApiError, Device, DesktopSettings, LinkChoice, LinkPreview, OfflineInfo, SyncConflictPreview, SyncFailure, SyncItems, SyncStatus, SystemInfo } from '@producer/core'
import { useEffect } from 'react'
import { create } from 'zustand'
import { HttpError, noteStatus, subscribeEvents } from '../lib/api'
import { useSession } from '../lib/session'

export async function sysFetch<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method,
    credentials: 'include',
    headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  noteStatus(path, res.status)
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
  /** The connection is back: sync now if sync was waiting for it (instead of at the end of its backoff). */
  syncOnline: () => sysFetch<SyncStatus>('POST', '/sync/online'),
  link: (cloudUrl: string, email: string, password: string) => sysFetch<SyncStatus>('POST', '/sync/link', { cloudUrl, email, password }),
  unlink: () => sysFetch<SyncStatus>('POST', '/sync/unlink'),
  /** What linking would merge and upload, before anything changes (the device link it makes lapses unless used). */
  linkPreview: (cloudUrl: string, email: string, password: string) => sysFetch<LinkPreview>('POST', '/sync/link/preview', { cloudUrl, email, password }),
  linkAsPreviewed: (previewId: string, choices: Record<string, LinkChoice>) => sysFetch<SyncStatus>('POST', '/sync/link', { previewId, choices }),
  cancelLinkPreview: (previewId: string) => sysFetch<{ ok: true }>('POST', '/sync/link/cancel', { previewId }),
  /** Everything waiting to go up, uploading, failed or skipped. */
  syncItems: () => sysFetch<SyncItems>('GET', '/sync/items'),
  /** This computer's copy of a conflicted project against the cloud's. */
  conflictPreview: (projectId: string) => sysFetch<SyncConflictPreview>('GET', `/sync/conflicts/${encodeURIComponent(projectId)}`),
  /** Projects kept available offline in a space, and its clips whose files are only in the cloud. */
  offline: (workspaceId: string) => sysFetch<OfflineInfo>('GET', `/sync/offline?workspaceId=${encodeURIComponent(workspaceId)}`),
  setOffline: (projectId: string, pinned: boolean) => sysFetch<OfflineInfo>('PUT', `/sync/offline/${encodeURIComponent(projectId)}`, { pinned }),
  resolve: (projectId: string, mode: 'keep-local' | 'keep-cloud' | 'keep-both') => sysFetch<SyncStatus>('POST', `/projects/${encodeURIComponent(projectId)}/sync`, { mode }),
  /** An item that keeps failing to sync: try again now, or skip it (it stays on this computer). */
  syncFailure: (f: Pick<SyncFailure, 'kind' | 'id'>, action: 'retry' | 'skip') => sysFetch<SyncStatus>('POST', `/sync/failures/${f.kind}/${encodeURIComponent(f.id)}`, { action }),
  /** What sync did to keep work safe: dismiss it, or take the one thing it offers. */
  syncNotice: (id: string, action: 'dismiss' | 'apply') => sysFetch<SyncStatus>('POST', `/sync/notices/${encodeURIComponent(id)}`, { action }),
  devices: () => sysFetch<Device[]>('GET', '/devices'),
  revokeDevice: (id: string) => sysFetch<{ ok: true }>('DELETE', `/devices/${encodeURIComponent(id)}`),
  // bring-your-own-key AI providers (desktop ignores workspaceId)
  aiSettings: (workspaceId?: string) => sysFetch<AiSettings>('GET', `/ai/settings${workspaceId ? `?workspaceId=${encodeURIComponent(workspaceId)}` : ''}`),
  saveAiSettings: (u: AiSettingsUpdate) => sysFetch<AiSettings>('PUT', '/ai/settings', u),
  saveAiKey: (provider: StoredKeyProvider, key: string, workspaceId?: string) => sysFetch<AiKeyTestResult>('PUT', `/ai/keys/${provider}`, { workspaceId, key }),
  deleteAiKey: (provider: StoredKeyProvider, workspaceId?: string) => sysFetch<AiSettings>('DELETE', `/ai/keys/${provider}${workspaceId ? `?workspaceId=${encodeURIComponent(workspaceId)}` : ''}`),
  testAiKey: (provider: StoredKeyProvider, workspaceId?: string, key?: string) => sysFetch<AiKeyTestResult>('POST', `/ai/keys/${provider}/test`, { workspaceId, key }),
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

/** Latest Windows installer (GitHub release page; always the newest version). */
export const DESKTOP_DOWNLOAD_URL = 'https://github.com/igrant9679/producer-studio/releases/latest'

export const isDesktop = (info?: SystemInfo) => info?.mode === 'desktop'
export const useIsDesktop = () => useSystem((s) => s.info?.mode === 'desktop')

/**
 * In desktop mode: poll sync status every 10 s and follow `sync` live updates (the resumable stream: it reconnects,
 * replays what it missed, and reloads the status when it can't). When the connection comes back while sync waits
 * offline, sync starts at once.
 */
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
    const online = () => {
      if (useSystem.getState().sync?.state !== 'offline') return
      systemApi
        .syncOnline()
        .then((s) => alive && setSync(s))
        .catch(() => undefined)
    }
    window.addEventListener('online', online)
    const unsubscribe = workspaceId && typeof EventSource !== 'undefined' ? subscribeEvents(workspaceId, { sync: (s) => alive && setSync(s), resync: () => void tick() }) : undefined
    return () => {
      alive = false
      clearInterval(iv)
      window.removeEventListener('online', online)
      unsubscribe?.()
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
