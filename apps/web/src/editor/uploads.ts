// Workspace media library + uploads. Server: api.upload with progress, then SSE `asset` events (with a polling
// fallback) until status 'ready'. Demo: files become local blob: assets probed in the browser.
import type { Asset, AssetRecord, Job } from '@producer/core'
import { addAsset, transcriptRev, uid } from '@producer/core'
import { create } from 'zustand'
import { api, subscribeEvents } from '../lib/api'
import { toast, toastError } from '../lib/toast'
import { useEditor } from './store'
import { refuseReadOnly } from './viewer'

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
  /** Live processing progress per clip, from asset.process job events. */
  progress: Record<string, { p: number; message: string }>
  /** Bumped when someone saves the space's brand kit: the Brand panel loads it again. */
  brandRev: number
}

export const useLibrary = create<LibState>(() => ({ records: [], loading: false, uploads: [], loaded: false, progress: {}, brandRev: 0 }))

function trackJob(j: Job) {
  if (j.kind !== 'asset.process' || !j.assetId) return
  const { [j.assetId]: _old, ...rest } = useLibrary.getState().progress
  useLibrary.setState({ progress: j.status === 'running' || j.status === 'queued' ? { ...rest, [j.assetId]: { p: j.progress, message: j.message } } : rest })
}

function upsertRecord(r: AssetRecord) {
  const recs = useLibrary.getState().records
  const i = recs.findIndex((x) => x.asset.id === r.asset.id)
  const next = i >= 0 ? recs.map((x, j) => (j === i ? r : x)) : [r, ...recs]
  useLibrary.setState({ records: next })
  // keep upload rows in sync
  useLibrary.setState({
    uploads: useLibrary.getState().uploads.map((u) => (u.assetId === r.asset.id ? { ...u, status: r.status === 'uploading' ? 'processing' : r.status, error: r.error } : u)),
  })
  // refresh metadata of assets the project uses (waveform, filmstrip, transcript arrive later), outside undo history;
  // a light record has no transcript, so a clip this editor knows fetches it when the record says it has a new one
  if (r.status === 'ready') {
    useEditor.getState().updateMedia(r.asset)
    if (r.light && r.transcriptRev) void fetchTranscript(r.asset.id, r.transcriptRev)
  }
}

const fetching = new Map<string, Promise<void>>()

/**
 * Lists and live updates carry light clip records (no transcript). A clip the editor uses gets its full record
 * (GET /api/assets/:id) when the light one names a transcript the editor doesn't have: once per clip and transcript.
 */
export function fetchTranscript(id: string, rev: string): Promise<void> {
  const s = useEditor.getState()
  // only clips this visit uses (the document, or media it has seen), not the whole library
  const known = s.project.assets[id] ?? s.media[id]
  if (!known || (known.transcript && transcriptRev(known.transcript) === rev)) return Promise.resolve()
  const key = `${id}\n${rev}`
  let p = fetching.get(key)
  if (!p) {
    p = api
      .asset(id)
      .then((full) => {
        if (full.asset.transcript) useEditor.getState().updateMedia({ id, transcript: full.asset.transcript })
      })
      .catch(() => undefined)
      .finally(() => fetching.delete(key))
    fetching.set(key, p)
  }
  return p
}

// a clip put into the project from the library (a light record) brings its transcript along
useEditor.subscribe((s, prev) => {
  if (s.project.assets === prev.project.assets || s.demo) return
  for (const id of Object.keys(s.project.assets)) {
    if (prev.project.assets[id] || s.project.assets[id].transcript) continue
    const rec = useLibrary.getState().records.find((r) => r.asset.id === id)
    if (rec?.light && rec.transcriptRev) void fetchTranscript(id, rec.transcriptRev)
  }
})

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

/** A `workspace` live update; `brand` when the brand kit was saved. */
function onWorkspace(w: { id: string; deleted: boolean; brand?: boolean }) {
  if (w.brand) useLibrary.setState({ brandRev: useLibrary.getState().brandRev + 1 })
}

/** One SSE connection per workspace: asset status for the library, `project` saves for the open project, brand kit saves. */
export function subscribeWorkspace(workspaceId: string, onProject: (p: { id: string; version: number }) => void, opts: { onResync?: () => void; on?: Record<string, (data: any) => void> } = {}): () => void {
  // back after missing events that can't be replayed: the library reloads, and the open project checks its version
  const resync = () => {
    void loadLibrary(workspaceId)
    opts.onResync?.()
  }
  try {
    return subscribeEvents(workspaceId, { asset: upsertRecord, project: onProject, job: trackJob, workspace: onWorkspace, resync, on: opts.on })
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

/** What kind of clip a file makes (null: not one the editor takes). */
export function fileKind(file: File): Asset['kind'] | null {
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

/** Upload files to the library. `onUploaded` hears of each clip once the server has it (still processing, maybe). */
export async function uploadFiles(files: File[] | FileList, opts: { onUploaded?: (assetId: string, file: File) => void } = {}) {
  if (refuseReadOnly()) return
  const list = Array.from(files)
  const s = useEditor.getState()
  for (const file of list) {
    const kind = fileKind(file)
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
        opts.onUploaded?.(asset.id, file)
      } else {
        if (!s.workspaceId) throw new Error('No workspace selected')
        const rec = await api.upload(s.workspaceId, file, (f) => patch({ progress: f }))
        patch({ progress: 1, status: rec.status === 'ready' ? 'ready' : 'processing', assetId: rec.asset.id })
        upsertRecord(rec)
        if (rec.status !== 'ready') void pollUntilReady(rec.asset.id)
        opts.onUploaded?.(rec.asset.id, file)
      }
    } catch (e) {
      patch({ status: 'error', error: e instanceof Error ? e.message : String(e) })
      toastError(e)
    }
    // clear finished rows after a while
    setTimeout(() => useLibrary.setState({ uploads: useLibrary.getState().uploads.filter((u) => u.key !== key || u.status === 'processing' || u.status === 'uploading') }), 8000)
  }
}

/** Re-run processing for a failed clip. A clip whose file never reached storage has to be uploaded again. */
export async function retryAsset(id: string) {
  try {
    const r = await api.retryAsset(id)
    upsertRecord(r)
    if (r.status !== 'ready') void pollUntilReady(id)
    toast('Processing again…')
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    if (/has not arrived|not arrived yet/i.test(msg)) toast("This file never reached storage — upload it again (remove this one first).")
    else toastError(e)
  }
}

/** Remove a clip from the workspace library: into the media trash (its files stay until the trash is emptied). */
export async function removeAsset(id: string) {
  try {
    await api.deleteAsset(id)
    useLibrary.setState({ records: useLibrary.getState().records.filter((r) => r.asset.id !== id) })
  } catch (e) {
    toastError(e)
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
