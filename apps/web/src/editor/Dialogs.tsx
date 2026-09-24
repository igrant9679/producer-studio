// Export dialog and keyboard shortcuts dialog.
import type { ExportRecord, ExportRequest, ExportResult, Job } from '@producer/core'
import { EXPORT_FPS, EXPORT_RESOLUTIONS, projectDuration } from '@producer/core'
import clsx from 'clsx'
import { Check, Copy, Download, Film, Loader2, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { api, waitForJob } from '../lib/api'
import { toast, toastError } from '../lib/toast'
import { Field, Segmented } from './controls'
import { flush } from './persistence'
import { useEditor } from './store'
import { timecode } from './timelineMath'

function useEsc(close: () => void) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && close()
    window.addEventListener('keydown', k)
    return () => window.removeEventListener('keydown', k)
  }, [close])
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
  useEsc(close)
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
    try {
      await flush()
      const j = await api.exportProject(projectId, { resolution, fps, quality, format, name })
      setJob(j)
      const done = await waitForJob<ExportResult>(j.id, setJob)
      setResult(done.result ?? null)
      api.exports(projectId).then(setPrev).catch(() => undefined)
    } catch (e) {
      toastError(e)
    } finally {
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
  return (
    <div className="modal-backdrop" onPointerDown={(e) => e.target === e.currentTarget && !running && close()}>
      <div className="modal ed-dialog" role="dialog" aria-label="Export">
        <header>
          <h2>Export video</h2>
          <button className="btn sm ghost icon" onClick={close} title="Close"><X size={16} /></button>
        </header>
        <div className="ed-export">
          <div className="ed-export-form">
            <Field label="Name"><input className="ed-input" value={name} onChange={(e) => setName(e.target.value)} /></Field>
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
          </div>
          <div className="ed-export-side">
            {running || job ? (
              <div className="ed-export-prog">
                <div className="row">
                  {result ? <Check size={16} color="var(--green)" /> : <Loader2 size={16} className="spin" />}
                  <b>{result ? 'Export ready' : job?.message || 'Queued…'}</b>
                  <div className="spacer" />
                  <span className="mono">{result ? '100%' : pct === null ? '' : `${pct}%`}</span>
                </div>
                <div className={clsx('ed-bar', pct === null && !result && 'ind')}>
                  <div style={{ width: `${result ? 100 : pct ?? 30}%` }} />
                </div>
                {result && (
                  <div className="row" style={{ gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
                    <a className="btn sm primary" href={result.url} download={`${name}.${format}`} target="_blank" rel="noreferrer"><Download size={14} /> Download · {fmtBytes(result.sizeBytes)}</a>
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
      </div>
    </div>
  )
}

const SHORTCUTS: Array<[string, Array<[string, string]>]> = [
  ['Playback', [['Space', 'Play / pause'], ['← / →', 'Previous / next frame'], ['Shift ← / →', 'Back / forward 1 s'], ['Home / End', 'Go to start / end'], ['Ctrl Shift F', 'Full-screen preview']]],
  ['Editing', [['Ctrl B', 'Split at playhead'], ['Delete', 'Delete'], ['Shift Delete', 'Ripple delete'], ['Ctrl C / X / V', 'Copy / cut / paste'], ['Ctrl D', 'Duplicate'], ['Ctrl A', 'Select all'], ['Ctrl Z', 'Undo'], ['Ctrl Shift Z', 'Redo']]],
  ['Timeline', [['Ctrl = / Ctrl -', 'Zoom in / out'], ['Ctrl wheel', 'Zoom at pointer'], ['S', 'Toggle snapping'], ['Alt drag', 'Move without snapping'], ['Ctrl / Shift click', 'Multi-select']]],
  ['Canvas', [['V', 'Select tool'], ['H', 'Hand tool'], ['Arrows', 'Nudge 1 px (canvas focused)'], ['Shift arrows', 'Nudge 10 px'], ['Double-click text', 'Edit text inline'], ['Shift drag', 'Constrain / 15° rotate']]],
]

export function ShortcutsDialog() {
  const close = () => useEditor.setState({ shortcutsOpen: false })
  useEsc(close)
  return (
    <div className="modal-backdrop" onPointerDown={(e) => e.target === e.currentTarget && close()}>
      <div className="modal ed-dialog" role="dialog" aria-label="Keyboard shortcuts" style={{ maxWidth: 760 }}>
        <header>
          <h2>Keyboard shortcuts</h2>
          <button className="btn sm ghost icon" onClick={close} title="Close"><X size={16} /></button>
        </header>
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
      </div>
    </div>
  )
}
