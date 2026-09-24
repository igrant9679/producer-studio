// Workspace media library + uploads. Server: api.upload with progress, then SSE `asset` events (with a polling
// fallback) until status 'ready'. Demo: files become local blob: assets probed in the browser.
import type { Asset, AssetRecord } from '@producer/core'
import { addAsset, uid } from '@producer/core'
import { create } from 'zustand'
import { api, subscribeEvents } from '../lib/api'
import { toast, toastError } from '../lib/toast'
import { useEditor } from './store'

export interface UploadRow {
  key: string
  name: string
  progress: number
  status: 'uploading' | 'processing' | 'ready' | 'error'
  assetId?: string
  error?: string
}

interface LibState {
  records: AssetRecord[]
  loading: boolean
  uploads: UploadRow[]
  loaded: boolean
}

export const useLibrary = create<LibState>(() => ({ records: [], loading: false, uploads: [], loaded: false }))

function upsertRecord(r: AssetRecord) {
  const recs = useLibrary.getState().records
  const i = recs.findIndex((x) => x.asset.id === r.asset.id)
  const next = i >= 0 ? recs.map((x, j) => (j === i ? r : x)) : [r, ...recs]
  useLibrary.setState({ records: next })
  // keep upload rows in sync
  useLibrary.setState({
    uploads: useLibrary.getState().uploads.map((u) => (u.assetId === r.asset.id ? { ...u, status: r.status === 'uploading' ? 'processing' : r.status, error: r.error } : u)),
  })
  // refresh metadata of assets already used in the project (waveform, filmstrip, transcript arrive later)
  const s = useEditor.getState()
  if (r.status === 'ready' && s.project.assets[r.asset.id]) {
    const p = structuredClone(s.project)
    p.assets[r.asset.id] = { ...p.assets[r.asset.id], ...r.asset }
    s.replaceSilently(p)
  }
}

export async function loadLibrary(workspaceId: string) {
  useLibrary.setState({ loading: true })
  try {
    const recs = await api.assets(workspaceId)
    useLibrary.setState({ records: recs, loaded: true })
  } catch (e) {
    toastError(e)
  } finally {
    useLibrary.setState({ loading: false })
  }
}

/** One SSE connection per workspace: asset status for the library + `project` saves for the open project. */
export function subscribeWorkspace(workspaceId: string, onProject: (p: { id: string; version: number }) => void): () => void {
  try {
    return subscribeEvents(workspaceId, { asset: upsertRecord, project: onProject })
  } catch {
    return () => undefined
  }
}

async function pollUntilReady(assetId: string) {
  for (let i = 0; i < 600; i++) {
    await new Promise((r) => setTimeout(r, 2000))
    const cur = useLibrary.getState().records.find((r) => r.asset.id === assetId)
    if (cur && (cur.status === 'ready' || cur.status === 'error')) return
    try {
      const r = await api.asset(assetId)
      upsertRecord(r)
      if (r.status === 'ready' || r.status === 'error') return
    } catch {
      /* keep polling */
    }
  }
}

function kindOf(file: File): Asset['kind'] | null {
  if (file.type.startsWith('video/')) return 'video'
  if (file.type.startsWith('audio/')) return 'audio'
  if (file.type.startsWith('image/')) return 'image'
  if (/\.(mp4|mov|webm|mkv|m4v)$/i.test(file.name)) return 'video'
  if (/\.(mp3|wav|m4a|aac|ogg|flac)$/i.test(file.name)) return 'audio'
  if (/\.(png|jpe?g|gif|webp|avif)$/i.test(file.name)) return 'image'
  return null
}

/** Probe a local file in the browser (demo mode). */
async function probeLocal(file: File, kind: Asset['kind']): Promise<Asset> {
  const src = URL.createObjectURL(file)
  const base: Asset = { id: uid('local'), kind, name: file.name, src, mime: file.type, sizeBytes: file.size, createdAt: Date.now() }
  if (kind === 'image') {
    const img = new Image()
    img.src = src
    await img.decode().catch(() => undefined)
    return { ...base, width: img.naturalWidth || 1280, height: img.naturalHeight || 720, thumbnail: src }
  }
  if (kind === 'audio') {
    const a = new Audio(src)
    await new Promise((r) => {
      a.onloadedmetadata = r
      a.onerror = r
    })
    return { ...base, duration: Number.isFinite(a.duration) ? a.duration : 5, hasAudio: true }
  }
  const v = document.createElement('video')
  v.muted = true
  v.preload = 'auto'
  v.src = src
  await new Promise((r) => {
    v.onloadeddata = r
    v.onerror = r
  })
  let thumbnail: string | undefined
  try {
    v.currentTime = Math.min(0.5, (v.duration || 1) / 2)
    await new Promise((r) => (v.onseeked = r))
    const c = document.createElement('canvas')
    c.width = 320
    c.height = Math.round((320 * (v.videoHeight || 720)) / (v.videoWidth || 1280))
    c.getContext('2d')?.drawImage(v, 0, 0, c.width, c.height)
    thumbnail = c.toDataURL('image/jpeg', 0.7)
  } catch {
    /* no thumbnail */
  }
  return { ...base, duration: Number.isFinite(v.duration) ? v.duration : 5, width: v.videoWidth || 1280, height: v.videoHeight || 720, hasAudio: true, thumbnail }
}

export async function uploadFiles(files: File[] | FileList) {
  const list = Array.from(files)
  const s = useEditor.getState()
  for (const file of list) {
    const kind = kindOf(file)
    if (!kind) {
      toast(`${file.name}: unsupported file type`)
      continue
    }
    const key = uid('up')
    useLibrary.setState({ uploads: [{ key, name: file.name, progress: 0, status: 'uploading' }, ...useLibrary.getState().uploads] })
    const patch = (p: Partial<UploadRow>) => useLibrary.setState({ uploads: useLibrary.getState().uploads.map((u) => (u.key === key ? { ...u, ...p } : u)) })
    try {
      if (s.demo) {
        const asset = await probeLocal(file, kind)
        const st = useEditor.getState()
        st.commit(addAsset(st.project, asset), 'Import media')
        patch({ progress: 1, status: 'ready', assetId: asset.id })
        toast(`Imported ${file.name} (local to this browser)`)
      } else {
        if (!s.workspaceId) throw new Error('No workspace selected')
        const rec = await api.upload(s.workspaceId, file, (f) => patch({ progress: f }))
        patch({ progress: 1, status: rec.status === 'ready' ? 'ready' : 'processing', assetId: rec.asset.id })
        upsertRecord(rec)
        if (rec.status !== 'ready') void pollUntilReady(rec.asset.id)
      }
    } catch (e) {
      patch({ status: 'error', error: e instanceof Error ? e.message : String(e) })
      toastError(e)
    }
    // clear finished rows after a while
    setTimeout(() => useLibrary.setState({ uploads: useLibrary.getState().uploads.filter((u) => u.key !== key || u.status === 'processing' || u.status === 'uploading') }), 8000)
  }
}

/** Assets to show in the panels: project assets plus ready workspace assets. */
export function libraryAssets(kind?: Asset['kind'][]): Array<{ asset: Asset; status: AssetRecord['status'] }> {
  const s = useEditor.getState()
  const out = new Map<string, { asset: Asset; status: AssetRecord['status'] }>()
  for (const a of Object.values(s.project.assets)) out.set(a.id, { asset: a, status: 'ready' })
  for (const r of useLibrary.getState().records) out.set(r.asset.id, { asset: r.asset, status: r.status })
  return [...out.values()].filter((x) => !kind || kind.includes(x.asset.kind)).sort((a, b) => (b.asset.createdAt ?? 0) - (a.asset.createdAt ?? 0))
}
