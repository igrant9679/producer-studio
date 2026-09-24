// Shell-wide live state: background jobs (fed by the workspace SSE stream), in-flight uploads, and a tiny
// event bus so pages can react to `asset` / `project` events without opening their own EventSource.
import type { AssetRecord, Job } from '@producer/core'
import { create } from 'zustand'
import { api } from '../lib/api'

type AssetListener = (a: AssetRecord) => void
type ProjectListener = (p: { id: string; version: number }) => void
type JobListener = (j: Job) => void

const assetListeners = new Set<AssetListener>()
const projectListeners = new Set<ProjectListener>()
const jobListeners = new Set<JobListener>()

export const liveBus = {
  onAsset(fn: AssetListener) {
    assetListeners.add(fn)
    return () => void assetListeners.delete(fn)
  },
  onProject(fn: ProjectListener) {
    projectListeners.add(fn)
    return () => void projectListeners.delete(fn)
  },
  onJob(fn: JobListener) {
    jobListeners.add(fn)
    return () => void jobListeners.delete(fn)
  },
  emitAsset(a: AssetRecord) {
    assetListeners.forEach((f) => f(a))
  },
  emitProject(p: { id: string; version: number }) {
    projectListeners.forEach((f) => f(p))
  },
  emitJob(j: Job) {
    jobListeners.forEach((f) => f(j))
  },
}

interface JobsState {
  jobs: Record<string, Job>
  upsert: (j: Job) => void
  reset: (list: Job[]) => void
  dismiss: (id: string) => void
}

export const useJobs = create<JobsState>((set) => ({
  jobs: {},
  upsert: (j) => set((s) => ({ jobs: { ...s.jobs, [j.id]: { ...s.jobs[j.id], ...j } } })),
  reset: (list) => set({ jobs: Object.fromEntries(list.map((j) => [j.id, j])) }),
  dismiss: (id) =>
    set((s) => {
      const next = { ...s.jobs }
      delete next[id]
      return { jobs: next }
    }),
}))

export const isActive = (j: Job) => j.status === 'queued' || j.status === 'running'

// ---- uploads ----
export interface UploadItem {
  id: string
  name: string
  size: number
  progress: number
  status: 'uploading' | 'processing' | 'ready' | 'error'
  assetId?: string
  error?: string
}

interface UploadsState {
  items: UploadItem[]
  patch: (id: string, p: Partial<UploadItem>) => void
  clearFinished: () => void
}

export const useUploads = create<UploadsState>((set) => ({
  items: [],
  patch: (id, p) =>
    set((s) => {
      const exists = s.items.some((i) => i.id === id)
      const items = exists ? s.items.map((i) => (i.id === id ? { ...i, ...p } : i)) : [...s.items, { id, name: '', size: 0, progress: 0, status: 'uploading', ...p } as UploadItem]
      return { items }
    }),
  clearFinished: () => set((s) => ({ items: s.items.filter((i) => i.status === 'uploading' || i.status === 'processing') })),
}))

let upN = 0
/** Upload files into the workspace library, tracked in the uploads store (and shown in the jobs popover). */
export async function uploadFiles(workspaceId: string, files: File[]): Promise<AssetRecord[]> {
  const { patch } = useUploads.getState()
  const out: AssetRecord[] = []
  await Promise.all(
    files.map(async (file) => {
      const id = `up${++upN}`
      patch(id, { name: file.name, size: file.size, progress: 0, status: 'uploading' })
      try {
        const rec = await api.upload(workspaceId, file, (f) => patch(id, { progress: f }))
        patch(id, { progress: 1, status: rec.status === 'ready' ? 'ready' : 'processing', assetId: rec.asset.id })
        liveBus.emitAsset(rec)
        out.push(rec)
      } catch (e) {
        patch(id, { status: 'error', error: e instanceof Error ? e.message : String(e) })
      }
    }),
  )
  return out
}

// Mark processing uploads ready when the server says so.
liveBus.onAsset((a) => {
  const { items, patch } = useUploads.getState()
  for (const it of items) if (it.assetId === a.asset.id && it.status === 'processing') patch(it.id, { status: a.status === 'error' ? 'error' : a.status === 'ready' ? 'ready' : 'processing', error: a.error })
})

/** Resolve when an asset reaches `ready` (SSE events, with polling as the fallback). */
export function waitForAssetReady(assetId: string, opts: { signal?: AbortSignal; intervalMs?: number; onUpdate?: (a: AssetRecord) => void } = {}): Promise<AssetRecord> {
  return new Promise((resolve, reject) => {
    let done = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const finish = (fn: () => void) => {
      if (done) return
      done = true
      off()
      if (timer) clearTimeout(timer)
      fn()
    }
    const check = (a: AssetRecord) => {
      if (a.asset.id !== assetId) return
      opts.onUpdate?.(a)
      if (a.status === 'ready') finish(() => resolve(a))
      else if (a.status === 'error') finish(() => reject(new Error(a.error || 'Processing failed')))
    }
    const off = liveBus.onAsset(check)
    opts.signal?.addEventListener('abort', () => finish(() => reject(new DOMException('Aborted', 'AbortError'))))
    const poll = async () => {
      if (done) return
      try {
        check(await api.asset(assetId))
      } catch {
        /* transient; keep polling */
      }
      if (!done) timer = setTimeout(poll, opts.intervalMs ?? 2000)
    }
    void poll()
  })
}
