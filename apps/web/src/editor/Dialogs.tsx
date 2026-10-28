// Export dialog and keyboard shortcuts dialog.
import type { ExportRecord, ExportRequest, ExportResult, Job } from '@producer/core'
import { EXPORT_FPS, EXPORT_RESOLUTIONS, projectDuration } from '@producer/core'
import clsx from 'clsx'
import { Check, Copy, Download, Film, Loader2, TriangleAlert, X } from 'lucide-react'
import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { api, waitForJob } from '../lib/api'
import { toast, toastError } from '../lib/toast'
import { downloadUrl } from '../shell/util'
import { Field, Segmented, useFieldIds } from './controls'
import { saveForExport } from './persistence'
import { useEditor } from './store'
import { timecode } from './timelineMath'

const FOCUSABLE = 'a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])'
/** Editor dialogs open now, the topmost last: Escape closes only that one. */
const open: HTMLElement[] = []

/**
 * A modal dialog named by its heading. Focus moves into it (to `[data-autofocus]`, else its first control) and stays
 * there; Escape closes the topmost dialog only, unless `canClose` is false; focus goes back where it was.
 */
function EditorDialog({ title, onClose, canClose = true, className, style, children }: { title: string; onClose: () => void; canClose?: boolean; className?: string; style?: React.CSSProperties; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null)
  const titleId = useId()
  const live = useRef({ onClose, canClose })
  live.current = { onClose, canClose }
  useEffect(() => {
    const box = ref.current!
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null
    ;(box.querySelector<HTMLElement>('[data-autofocus]') ?? box.querySelector<HTMLElement>(FOCUSABLE) ?? box).focus()
    open.push(box)
    // Escape while focus is outside every dialog
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && !e.defaultPrevented && open.at(-1) === box && live.current.canClose && live.current.onClose()
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
      open.splice(open.indexOf(box), 1)
      if (opener?.isConnected) opener.focus()
    }
  }, [])
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      if (open.at(-1) === ref.current && canClose) onClose()
    } else if (e.key === 'Tab') {
      // Tab and Shift+Tab go round the dialog's own controls
      const f = [...ref.current!.querySelectorAll<HTMLElement>(FOCUSABLE)]
      if (!f.length) return e.preventDefault()
      const at = f.indexOf(document.activeElement as HTMLElement)
      if (e.shiftKey && at <= 0) {
        e.preventDefault()
        f[f.length - 1].focus()
      } else if (!e.shiftKey && at === f.length - 1) {
        e.preventDefault()
        f[0].focus()
      }
    }
  }
  return (
    <div className="modal-backdrop" onPointerDown={(e) => e.target === e.currentTarget && canClose && onClose()}>
      <div ref={ref} className={clsx('modal ed-dialog', className)} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} style={style} onKeyDown={onKeyDown}>
        <header>
          <h2 id={titleId}>{title}</h2>
          <button className="btn sm ghost icon" onClick={onClose} title="Close" aria-label="Close"><X size={16} /></button>
        </header>
        {children}
      </div>
    </div>
  )
}

function fmtBytes(n: number) {
  if (n > 1e9) return `${(n / 1e9).toFixed(1)} GB`
  if (n > 1e6) return `${(n / 1e6).toFixed(1)} MB`
  return `${Math.round(n / 1e3)} KB`
}

export function ExportDialog() {
  const project = useEditor((s) => s.project)
  const demo = useEditor((s) => s.demo)
  const projectId = useEditor((s) => s.projectId)
  const close = () => useEditor.setState({ exportOpen: false })
  const [name, setName] = useState(project.name)
  const [resolution, setRes] = useState<ExportRequest['resolution']>('1080p')
  const [fps, setFps] = useState<ExportRequest['fps']>(([24, 25, 30, 50, 60].includes(project.fps) ? project.fps : 30) as ExportRequest['fps'])
  const [quality, setQuality] = useState<ExportRequest['quality']>('standard')
  const [format, setFormat] = useState<ExportRequest['format']>('mp4')
  const [job, setJob] = useState<Job<ExportResult> | null>(null)
  const [result, setResult] = useState<ExportResult | null>(null)
  const [running, setRunning] = useState(false)
  const [prev, setPrev] = useState<ExportRecord[]>([])
  const [shareUrl, setShareUrl] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  /** Why the export didn't start (the latest changes couldn't be saved). */
  const [blocked, setBlocked] = useState<string | null>(null)
  const duration = projectDuration(project)
  const short = Math.min(project.width, project.height)
  const scale = (EXPORT_RESOLUTIONS.find((r) => r.id === resolution)?.short ?? 1080) / short
  const outW = Math.round((project.width * scale) / 2) * 2
  const outH = Math.round((project.height * scale) / 2) * 2
  // rough H.264 size: bits-per-pixel-per-frame by quality
  const bpp = quality === 'high' ? 0.16 : quality === 'draft' ? 0.04 : 0.09
  const estMb = ((outW * outH * fps * duration * bpp) / 8 / 1e6) * (format === 'gif' ? 4 : format === 'webm' ? 0.8 : 1)

  useEffect(() => {
    if (demo) return
    api.exports(projectId).then(setPrev).catch(() => undefined)
  }, [demo, projectId])

  const start = async () => {
    if (demo) {
      toast('Sign in to use AI and export — the demo runs offline.')
      return
    }
    setRunning(true)
    setResult(null)
    setShareUrl(null)
    setJob(null)
    setBlocked(null)
    try {
      // the render reads the saved project: never let it render an older version than the one on screen
      setSaving(true)
      const why = await saveForExport()
      setSaving(false)
      if (why) {
        setBlocked(why)
        return
      }
      const j = await api.exportProject(projectId, { resolution, fps, quality, format, name })
      setJob(j)
      const done = await waitForJob<ExportResult>(j.id, setJob)
      setResult(done.result ?? null)
      api.exports(projectId).then(setPrev).catch(() => undefined)
    } catch (e) {
      toastError(e)
    } finally {
      setSaving(false)
      setRunning(false)
    }
  }

  const copyShare = async (exportId?: string) => {
    try {
      const r = await api.share(projectId, exportId)
      const url = r.url.startsWith('http') ? r.url : `${location.origin}${r.url}`
      setShareUrl(url)
      await navigator.clipboard.writeText(url).catch(() => undefined)
      toast('Share link copied')
    } catch (e) {
      toastError(e)
    }
  }

  const pct = job ? (job.progress < 0 ? null : Math.round(job.progress * 100)) : 0
  // mid-render, Escape and the backdrop don't throw away the progress (Cancel still closes)
  return (
    <EditorDialog title="Export video" onClose={close} canClose={!running}>
      <div className="ed-export">
        <div className="ed-export-form">
          <Field label="Name"><NameInput value={name} onChange={setName} /></Field>
          <Field label="Resolution">
            <Segmented size="sm" value={resolution} options={EXPORT_RESOLUTIONS.map((r) => ({ value: r.id, label: r.id === '4k' ? '4K' : r.id }))} onChange={setRes} />
          </Field>
          <Field label="Frame rate">
            <Segmented size="sm" value={String(fps)} options={EXPORT_FPS.map((f) => ({ value: String(f), label: String(f) }))} onChange={(v) => setFps(+v as ExportRequest['fps'])} />
          </Field>
          <Field label="Quality">
            <Segmented size="sm" value={quality} options={[{ value: 'draft', label: 'Draft' }, { value: 'standard', label: 'Standard' }, { value: 'high', label: 'High' }]} onChange={setQuality} />
          </Field>
          <Field label="Format">
            <Segmented size="sm" value={format} options={[{ value: 'mp4', label: 'MP4' }, { value: 'webm', label: 'WebM' }, { value: 'gif', label: 'GIF' }]} onChange={setFormat} />
          </Field>
          <div className="ed-export-sum">
            <span><Film size={13} /> {outW}×{outH}</span>
            <span>{timecode(duration, project.fps)}</span>
            <span>≈ {estMb < 1 ? '<1' : estMb.toFixed(0)} MB</span>
          </div>
          {demo && <p className="ed-note">Exports render on the server. Sign in to export this edit.</p>}
          {!demo && <p className="ed-note">Export saves your latest changes first and renders exactly what’s on screen.</p>}
          {blocked && (
            <p className="ed-note ed-note-warn" role="alert">
              <TriangleAlert size={13} /> Not exported: {blocked}
            </p>
          )}
        </div>
        <div className="ed-export-side">
          {running || job ? (
            <div className="ed-export-prog">
              <div className="row">
                {result ? <Check size={16} color="var(--green)" /> : <Loader2 size={16} className="spin" />}
                <b>{result ? 'Export ready' : job?.message || (saving ? 'Saving your latest changes…' : 'Queued…')}</b>
                <div className="spacer" />
                <span className="mono">{result ? '100%' : pct === null ? '' : `${pct}%`}</span>
              </div>
              <div className={clsx('ed-bar', pct === null && !result && 'ind')}>
                <div style={{ width: `${result ? 100 : pct ?? 30}%` }} />
              </div>
              {result && (
                <div className="row" style={{ gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
                  <a className="btn sm primary" href={downloadUrl(result.url)} download><Download size={14} /> Download · {fmtBytes(result.sizeBytes)}</a>
                  <button className="btn sm" onClick={() => copyShare(result.exportId)}><Copy size={14} /> Copy share link</button>
                </div>
              )}
              {shareUrl && <input className="ed-input" readOnly value={shareUrl} style={{ marginTop: 8 }} onFocus={(e) => e.target.select()} />}
            </div>
          ) : (
            <div className="ed-export-prev">
              <div className="eyebrow">Previous exports</div>
              {demo || !prev.length ? <p className="ed-note">No exports yet.</p> : null}
              {prev.slice(0, 6).map((r) => (
                <div key={r.exportId} className="ed-prevexp">
                  <div>
                    <div className="nm">{r.name}</div>
                    <div className="sub">{r.resolution} · {r.fps} fps · {fmtBytes(r.sizeBytes)} · {new Date(r.createdAt).toLocaleString()}</div>
                  </div>
                  <a className="btn sm icon" href={r.url} target="_blank" rel="noreferrer" title="Download"><Download size={13} /></a>
                  <button className="btn sm icon" title="Copy share link" onClick={() => copyShare(r.exportId)}><Copy size={13} /></button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
      <footer>
        <button className="btn sm" onClick={close}>{result ? 'Done' : 'Cancel'}</button>
        <button className="btn sm primary" onClick={start} disabled={running}>
          {running ? <Loader2 size={14} className="spin" /> : <Download size={14} />} {running ? 'Exporting…' : result ? 'Export again' : 'Export'}
        </button>
      </footer>
    </EditorDialog>
  )
}

/** The export's name field, named by its Field label; focused first when the dialog opens. */
function NameInput({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const field = useFieldIds()
  return <input className="ed-input" id={field?.control} data-autofocus value={value} onChange={(e) => onChange(e.target.value)} />
}

const SHORTCUTS: Array<[string, Array<[string, string]>]> = [
  ['Playback', [['Space', 'Play / pause'], ['← / →', 'Previous / next frame'], ['Shift ← / →', 'Back / forward 1 s'], ['Home / End', 'Go to start / end'], ['Ctrl Shift F', 'Full-screen preview'], ['Ctrl Shift L', 'Cycle theme']]],
  ['Editing', [['Ctrl B', 'Split at playhead'], ['Delete', 'Delete'], ['Shift Delete', 'Ripple delete'], ['Ctrl C / X / V', 'Copy / cut / paste'], ['Ctrl D', 'Duplicate'], ['Ctrl L', 'Link / unlink clips (a video and its audio)'], ['Ctrl A', 'Select all'], ['Ctrl Z', 'Undo'], ['Ctrl Shift Z', 'Redo']]],
  ['Timeline', [['Ctrl = / Ctrl -', 'Zoom in / out'], ['Ctrl wheel', 'Zoom (the playhead stays put)'], ['Shift wheel', 'Scroll sideways'], ['Shift Z', 'Fit the whole project'], ['S', 'Toggle snapping'], ['M', 'Add a marker at the playhead'], ['Shift M / Alt M', 'Next / previous marker'],['Alt drag', 'Move without snapping'], ['Ctrl / Shift click', 'Multi-select']]],
  ['Timeline clip focused', [['← → ↑ ↓', 'Next clip / track'], ['Alt ← / →', 'Move a frame (Shift: a second)'], ['Alt ↑ / ↓', 'Move to the track above / below'], ['[ / ]', 'Trim start / end to playhead'], ['Shift F10', 'Clip menu']]],
  ['Marker focused (on the ruler)', [['← / →', 'Previous / next marker'], ['Alt ← / →', 'Move a frame (Shift: a second)'], ['F2', 'Rename'], ['Delete', 'Remove'], ['Shift F10', 'Marker menu']]],
  ['Canvas', [['V', 'Select tool'], ['H', 'Hand tool'], ['Arrows', 'Nudge 1 px (canvas focused)'], ['Shift arrows', 'Nudge 10 px'], ['Double-click text', 'Edit text inline'], ['Shift drag', 'Constrain / 15° rotate']]],
]

export function ShortcutsDialog() {
  const close = () => useEditor.setState({ shortcutsOpen: false })
  return (
    <EditorDialog title="Keyboard shortcuts" onClose={close} style={{ maxWidth: 760 }}>
      <div className="ed-keys">
        {SHORTCUTS.map(([group, list]) => (
          <div key={group}>
            <div className="eyebrow">{group}</div>
            {list.map(([k, d]) => (
              <div key={k} className="ed-keyrow">
                <span>{d}</span>
                <span className="keys">{k.split(' ').map((x, i) => (x === '/' ? <span key={i} className="muted"> / </span> : <span key={i} className="kbd">{x}</span>))}</span>
              </div>
            ))}
          </div>
        ))}
      </div>
    </EditorDialog>
  )
}
