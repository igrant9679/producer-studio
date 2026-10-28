// Exports run in the background (E-5): the dialog can close while the render goes on, and when it finishes the
// person hears about it wherever they are in the app (a toast with Open, and a browser notification when the tab is
// in the background and notifications are allowed).
import type { ExportRequest, ExportResult, Job } from '@producer/core'
import { create } from 'zustand'
import { api } from '../lib/api'
import { toast, toastError } from '../lib/toast'
import { useEditor } from './store'

export interface TrackedExport {
  projectId: string
  name: string
  job: Job<ExportResult>
  result?: ExportResult
  error?: string
}

/** The latest export of each project started in this tab. */
export const useExports = create<{ byProject: Record<string, TrackedExport> }>(() => ({ byProject: {} }))

const patch = (projectId: string, p: Partial<TrackedExport>) => {
  const cur = useExports.getState().byProject[projectId]
  if (cur) useExports.setState({ byProject: { ...useExports.getState().byProject, [projectId]: { ...cur, ...p } } })
}

/** Start an export and follow it to the end, whether or not the dialog stays open. */
export async function startExport(projectId: string, body: ExportRequest): Promise<Job<ExportResult>> {
  const job = await api.exportProject(projectId, body)
  const name = body.name?.trim() || 'Your export'
  useExports.setState({ byProject: { ...useExports.getState().byProject, [projectId]: { projectId, name, job } } })
  void follow(projectId, name, job.id)
  return job
}

/** Seconds between looks at a running export. */
const POLL_MS = 1000

async function follow(projectId: string, name: string, jobId: string) {
  const mine = () => useExports.getState().byProject[projectId]?.job.id === jobId
  try {
    // like waitForJob, but stops looking once this export is no longer the one followed (a newer one, or cleared)
    let done: Job<ExportResult>
    for (;;) {
      if (!mine()) return
      const j = await api.job<ExportResult>(jobId)
      if (!mine()) return
      patch(projectId, { job: j })
      if (j.status === 'done') {
        done = j
        break
      }
      if (j.status === 'error' || j.status === 'cancelled') throw new Error(j.error || `Job ${j.status}`)
      await new Promise((r) => setTimeout(r, POLL_MS))
    }
    patch(projectId, { job: done, result: done.result })
    if (done.result) announce(projectId, name, done.result)
  } catch (e) {
    if (!mine()) return
    const msg = e instanceof Error ? e.message : String(e)
    patch(projectId, { error: msg })
    if (/cancel/i.test(msg)) return toast(`Export cancelled: ${name}`)
    toastError(e, `Export failed: ${name}`, { label: 'Open', run: () => openExport(projectId) })
    notify('Export failed', `${name}: ${msg}`, () => openExport(projectId))
  }
}

function announce(projectId: string, name: string, r: ExportResult) {
  toast(`Export ready: ${name}`, { label: 'Open', run: () => openExport(projectId, r) })
  notify('Export ready', name, () => openExport(projectId, r))
}

/** Show a finished export: its dialog when that project is open here, else the file itself. */
export function openExport(projectId: string, r?: ExportResult) {
  if (useEditor.getState().projectId === projectId && useEditor.getState().loaded) {
    useEditor.setState({ exportOpen: true, playing: false })
    return
  }
  if (r) window.open(r.url, '_blank', 'noopener')
}

/** A system notification, only when the person isn't looking at this tab and has allowed them. */
function notify(title: string, body: string, onClick: () => void) {
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return
  if (typeof document !== 'undefined' && document.visibilityState === 'visible' && document.hasFocus()) return
  try {
    const n = new Notification(title, { body, tag: 'producer-export' })
    n.onclick = () => {
      window.focus()
      onClick()
      n.close()
    }
  } catch {
    /* some browsers only allow notifications from a service worker */
  }
}

/** Ask once, when the person chooses to keep working while an export renders. */
export function askToNotify() {
  if (typeof Notification === 'undefined' || Notification.permission !== 'default') return
  void Notification.requestPermission().catch(() => undefined)
}

/** The dialog closed on a finished (or failed) export: the next opening starts fresh. */
export function dismissExport(projectId: string) {
  const cur = useExports.getState().byProject[projectId]
  if (!cur || (!cur.result && !cur.error)) return
  const { [projectId]: _gone, ...rest } = useExports.getState().byProject
  useExports.setState({ byProject: rest })
}

export async function cancelExport(projectId: string) {
  const cur = useExports.getState().byProject[projectId]
  if (!cur) return
  try {
    await api.cancelJob(cur.job.id)
  } catch (e) {
    toastError(e, 'Couldn’t cancel the export')
  }
}
