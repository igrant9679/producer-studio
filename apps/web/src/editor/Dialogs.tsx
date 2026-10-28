// Export dialog and keyboard shortcuts dialog.
import type { ExportPreviewResult, ExportRecord, ExportRequest, Job, Project } from '@producer/core'
import { EXPORT_FPS, EXPORT_PRESETS, EXPORT_RESOLUTIONS, StageRenderer, aspectOf, filledCaptionTracks, isAudioFormat, presetCanvasSize, projectDuration, projectForExport, selectionRange } from '@producer/core'
import clsx from 'clsx'
import { Captions, Check, Copy, Download, Film, Loader2, Music, Play, TriangleAlert, X } from 'lucide-react'
import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react'
import { api, waitForJob } from '../lib/api'
import { toast, toastError } from '../lib/toast'
import { downloadUrl } from '../shell/util'
import { LoudnessField, type Loudness } from './audio/LoudnessField'
import { Field, Segmented, useFieldIds } from './controls'
import { askToNotify, cancelExport, dismissExport, startExport, useExports } from './exportJobs'
import { makeResolver } from './media'
import { saveForExport } from './persistence'
import { useEditor } from './store'
import { timecode } from './timelineMath'
import { inOutRange, useTransport } from './transport'

const FOCUSABLE = 'a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])'
/** Editor dialogs open now, the topmost last: Escape closes only that one. */
const open: HTMLElement[] = []

/**
 * A modal dialog named by its heading. Focus moves into it (to `[data-autofocus]`, else its first control) and stays
 * there; Escape closes the topmost dialog only, unless `canClose` is false; focus goes back where it was.
 */
export function EditorDialog({ title, onClose, canClose = true, className, style, children }: { title: string; onClose: () => void; canClose?: boolean; className?: string; style?: React.CSSProperties; children: ReactNode }) {
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

type RangeMode = 'all' | 'inout' | 'selection'
type CaptionMode = NonNullable<ExportRequest['captions']>

const FORMATS: Array<{ value: ExportRequest['format']; label: string; title: string }> = [
  { value: 'mp4', label: 'MP4', title: 'MP4 video' },
  { value: 'webm', label: 'WebM', title: 'WebM video' },
  { value: 'gif', label: 'GIF', title: 'Animated GIF' },
  { value: 'mp3', label: 'MP3', title: 'MP3, sound only' },
  { value: 'wav', label: 'WAV', title: 'WAV, sound only' },
]

/**
 * Export: settings or a platform preset, the whole video or a part of it (in to out, the selection), captions burned
 * in or as a file, the cover frame; a quick draft of the part to check it; then the render, which carries on in the
 * background if the dialog is closed (see exportJobs).
 */
export function ExportDialog() {
  const project = useEditor((s) => s.project)
  const demo = useEditor((s) => s.demo)
  const projectId = useEditor((s) => s.projectId)
  const selection = useEditor((s) => s.selection)
  const transport = useTransport()
  const tracked = useExports((s) => s.byProject[projectId])
  const [name, setName] = useState(project.name)
  const [preset, setPreset] = useState('custom')
  const [resolution, setRes] = useState<ExportRequest['resolution']>('1080p')
  const [fps, setFps] = useState<ExportRequest['fps']>(([24, 25, 30, 50, 60].includes(project.fps) ? project.fps : 30) as ExportRequest['fps'])
  const [quality, setQuality] = useState<ExportRequest['quality']>('standard')
  const [format, setFormat] = useState<ExportRequest['format']>('mp4')
  const [loudness, setLoudness] = useState<Loudness>('off')
  const [rangeMode, setRangeMode] = useState<RangeMode>('all')
  const [captions, setCaptions] = useState<CaptionMode>('burn')
  const [captionFormat, setCaptionFormat] = useState<'srt' | 'vtt'>('srt')
  const [captionTrackId, setCaptionTrackId] = useState('')
  const [coverAt, setCoverAt] = useState<number | undefined>(undefined)
  const [prev, setPrev] = useState<ExportRecord[]>([])
  const [shareUrl, setShareUrl] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  /** Why the export didn't start (the latest changes couldn't be saved). */
  const [blocked, setBlocked] = useState<string | null>(null)
  const draft = useDraftPreview(projectId)

  const close = () => {
    dismissExport(projectId)
    useEditor.setState({ exportOpen: false })
  }
  const duration = projectDuration(project)
  const audio = isAudioFormat(format)
  const io = inOutRange(transport, duration)
  const sel = selectionRange(project, selection)
  const range = rangeMode === 'inout' ? io : rangeMode === 'selection' ? sel : undefined
  const outDuration = range ? range.to - range.from : duration
  const presetDef = EXPORT_PRESETS.find((p) => p.id === preset)
  const aspect = presetDef && presetDef.aspect !== aspectOf(project) ? presetDef.aspect : undefined
  const tracks = filledCaptionTracks(project)
  // the shape and size the file comes out at
  const shape = aspect ? presetCanvasSize(aspect, Math.min(project.width, project.height)) : { width: project.width, height: project.height }
  const scale = (EXPORT_RESOLUTIONS.find((r) => r.id === resolution)?.short ?? 1080) / Math.min(shape.width, shape.height)
  const outW = Math.round((shape.width * scale) / 2) * 2
  const outH = Math.round((shape.height * scale) / 2) * 2
  // rough H.264 size: bits-per-pixel-per-frame by quality; sound only: its bit rate
  const bpp = quality === 'high' ? 0.16 : quality === 'draft' ? 0.04 : 0.09
  const estMb = audio ? (outDuration * (format === 'mp3' ? 24_000 : 192_000)) / 1e6 : ((outW * outH * fps * outDuration * bpp) / 8 / 1e6) * (format === 'gif' ? 4 : format === 'webm' ? 0.8 : 1)

  useEffect(() => {
    if (demo) return
    api.exports(projectId).then(setPrev).catch(() => undefined)
  }, [demo, projectId, tracked?.result])

  // a range that went away (selection cleared, in and out cleared) falls back to the whole video
  useEffect(() => {
    if ((rangeMode === 'inout' && !io) || (rangeMode === 'selection' && !sel)) setRangeMode('all')
  }, [rangeMode, io, sel])

  const pickPreset = (id: string) => {
    setPreset(id)
    const p = EXPORT_PRESETS.find((x) => x.id === id)
    if (!p) return
    setRes(p.resolution)
    setFps(p.fps)
    setQuality(p.quality)
    if (isAudioFormat(format) || format === 'gif') setFormat('mp4')
  }

  const request = (): ExportRequest => ({
    resolution,
    fps,
    quality,
    format,
    name,
    ...(range ? { range } : {}),
    ...(aspect && !audio ? { aspect } : {}),
    ...(tracks.length && !audio ? { captions, ...(captions === 'sidecar' ? { captionFormat } : {}), ...(captionTrackId && tracks.some((t) => t.id === captionTrackId) ? { captionTrackId } : {}) } : {}),
    ...(coverAt !== undefined && !audio ? { coverAt: Math.min(coverAt, outDuration) } : {}),
    ...(loudness !== 'off' && format !== 'gif' ? { loudness } : {}),
  })

  /** The render reads the saved project: never let it render an older version than the one on screen. */
  const saved = async (): Promise<boolean> => {
    setBlocked(null)
    setSaving(true)
    const why = await saveForExport().finally(() => setSaving(false))
    if (why) setBlocked(why)
    return !why
  }

  const start = async () => {
    if (demo) {
      toast('Sign in to use AI and export — the demo runs offline.')
      return
    }
    setShareUrl(null)
    try {
      if (!(await saved())) return
      await startExport(projectId, request())
    } catch (e) {
      toastError(e)
    }
  }

  const startDraft = async () => {
    if (demo) return toast('Sign in to render a draft — the demo runs offline.')
    try {
      if (!(await saved())) return
      await draft.start({ ...request(), format: 'mp4', preview: true })
    } catch (e) {
      toastError(e)
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

  const job = tracked?.job
  const result = tracked?.result
  const failed = tracked?.error
  const running = !!job && !result && !failed
  const busy = saving || running
  const pct = job ? (job.progress < 0 ? null : Math.round(job.progress * 100)) : 0
  const rangeOptions: Array<{ value: RangeMode; label: string; title: string }> = [
    { value: 'all', label: 'Whole video', title: 'Whole video' },
    ...(io ? [{ value: 'inout' as const, label: 'In to out', title: `In to out (${timecode(io.from, project.fps)} – ${timecode(io.to, project.fps)})` }] : []),
    ...(sel ? [{ value: 'selection' as const, label: 'Selection', title: `Selected clips (${timecode(sel.from, project.fps)} – ${timecode(sel.to, project.fps)})` }] : []),
  ]
  const exportProject = useMemo(() => projectForExport(project, { range, aspect, captions, captionTrackId: captionTrackId || undefined }), [project, range?.from, range?.to, aspect, captions, captionTrackId])
  return (
    <EditorDialog title="Export video" onClose={close} className="ed-export-dialog">
      <div className="ed-export">
        <div className="ed-export-form">
          <Field label="Name"><NameInput value={name} onChange={setName} /></Field>
          <Field label="Part">
            <Segmented size="sm" value={rangeMode} options={rangeOptions} onChange={setRangeMode} />
          </Field>
          <Field label="Format">
            <Segmented size="sm" value={format} options={FORMATS} onChange={setFormat} />
          </Field>
          <LoudnessField value={loudness} onChange={setLoudness} format={format} />
          {!audio && (
            <>
              <Field label="Preset">
                <FieldSelect value={preset} onChange={pickPreset}>
                  <option value="custom">Custom (this project’s shape)</option>
                  {EXPORT_PRESETS.map((p) => (
                    <option key={p.id} value={p.id}>{p.name} · {p.hint}</option>
                  ))}
                </FieldSelect>
              </Field>
              <Field label="Resolution">
                <Segmented size="sm" value={resolution} options={EXPORT_RESOLUTIONS.map((r) => ({ value: r.id, label: r.id === '4k' ? '4K' : r.id }))} onChange={setRes} />
              </Field>
              <Field label="Frame rate">
                <Segmented size="sm" value={String(fps)} options={EXPORT_FPS.map((f) => ({ value: String(f), label: String(f) }))} onChange={(v) => setFps(+v as ExportRequest['fps'])} />
              </Field>
              <Field label="Quality">
                <Segmented size="sm" value={quality} options={[{ value: 'draft', label: 'Draft' }, { value: 'standard', label: 'Standard' }, { value: 'high', label: 'High' }]} onChange={setQuality} />
              </Field>
              {tracks.length > 0 && (
                <Field label="Captions">
                  <Segmented size="sm" value={captions} options={[{ value: 'burn', label: 'Burn in', title: 'Burn in' }, { value: 'sidecar', label: 'File', title: 'Caption file beside the video' }, { value: 'none', label: 'None', title: 'No captions' }]} onChange={setCaptions} />
                </Field>
              )}
              {tracks.length > 0 && captions === 'sidecar' && (
                <Field label="Caption file">
                  <Segmented size="sm" value={captionFormat} options={[{ value: 'srt', label: 'SRT' }, { value: 'vtt', label: 'WebVTT' }]} onChange={setCaptionFormat} />
                </Field>
              )}
              {tracks.length > 1 && captions !== 'none' && (
                <Field label="Caption track">
                  <FieldSelect value={captionTrackId} onChange={setCaptionTrackId}>
                    <option value="">{captions === 'burn' ? 'Every caption track' : `${tracks[0].name} (first)`}</option>
                    {tracks.map((t) => (
                      <option key={t.id} value={t.id}>{t.name}</option>
                    ))}
                  </FieldSelect>
                </Field>
              )}
              <Field label="Cover">
                <CoverPicker project={exportProject} value={coverAt} duration={outDuration} onChange={setCoverAt} offset={range?.from ?? 0} />
              </Field>
            </>
          )}
          <div className="ed-export-sum">
            {audio ? <span><Music size={13} /> Sound only</span> : <span><Film size={13} /> {outW}×{outH}</span>}
            <span>{timecode(outDuration, project.fps)}</span>
            <span>≈ {estMb < 1 ? '<1' : estMb.toFixed(0)} MB</span>
          </div>
          {aspect && !audio && <p className="ed-note">Reframed to {presetDef!.aspect} for this export, as the ratio menu would; the project stays {aspectOf(project) ?? `${project.width}×${project.height}`}.</p>}
          {demo && <p className="ed-note">Exports render on the server. Sign in to export this edit.</p>}
          {!demo && <p className="ed-note">Export saves your latest changes first and renders exactly what’s on screen. You can keep working while it renders.</p>}
          {blocked && (
            <p className="ed-note ed-note-warn" role="alert">
              <TriangleAlert size={13} /> Not exported: {blocked}
            </p>
          )}
        </div>
        <div className="ed-export-side">
          {job || saving ? (
            <div className="ed-export-prog">
              <div className="row">
                {result ? <Check size={16} color="var(--green)" /> : failed ? <TriangleAlert size={16} color="var(--danger)" /> : <Loader2 size={16} className="spin" />}
                <b>{result ? 'Export ready' : failed ? 'Export stopped' : saving && !job ? 'Saving your latest changes…' : job?.message || 'Queued…'}</b>
                <div className="spacer" />
                <span className="mono">{result ? '100%' : failed || pct === null ? '' : `${pct}%`}</span>
              </div>
              <div className={clsx('ed-bar', pct === null && !result && 'ind')} role="progressbar" aria-label="Export progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={result ? 100 : pct ?? undefined}>
                <div style={{ width: `${result ? 100 : pct ?? 30}%` }} />
              </div>
              {failed && <p className="ed-note ed-note-warn" role="alert"><TriangleAlert size={13} /> {failed}</p>}
              {result && (
                <div className="row" style={{ gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
                  <a className="btn sm primary" href={downloadUrl(result.url)} download><Download size={14} /> Download · {fmtBytes(result.sizeBytes)}</a>
                  {result.captionsUrl && <a className="btn sm" href={downloadUrl(result.captionsUrl)} download><Captions size={14} /> Caption file</a>}
                  <button className="btn sm" onClick={() => copyShare(result.exportId)}><Copy size={14} /> Copy share link</button>
                </div>
              )}
              {shareUrl && <input className="ed-input" readOnly value={shareUrl} style={{ marginTop: 8 }} onFocus={(e) => e.target.select()} aria-label="Share link" />}
            </div>
          ) : (
            <div className="ed-export-prev">
              <div className="eyebrow">Previous exports</div>
              {demo || !prev.length ? <p className="ed-note">No exports yet.</p> : null}
              {prev.slice(0, 6).map((r) => (
                <div key={r.exportId} className="ed-prevexp">
                  <div>
                    <div className="nm">{r.name}</div>
                    <div className="sub">{r.resolution === 'audio' ? (r.format ?? 'audio').toUpperCase() : `${r.resolution} · ${r.fps} fps`} · {fmtBytes(r.sizeBytes)} · {new Date(r.createdAt).toLocaleString()}</div>
                  </div>
                  <a className="btn sm icon" href={r.url} target="_blank" rel="noreferrer" title="Download" aria-label={`Download ${r.name}`}><Download size={13} /></a>
                  {r.captionsUrl && <a className="btn sm icon" href={downloadUrl(r.captionsUrl)} download title="Caption file" aria-label={`Caption file for ${r.name}`}><Captions size={13} /></a>}
                  <button className="btn sm icon" title="Copy share link" aria-label={`Copy share link for ${r.name}`} onClick={() => copyShare(r.exportId)}><Copy size={13} /></button>
                </div>
              ))}
            </div>
          )}
          {!audio && <DraftPreview draft={draft} busy={saving} range={range} fps={project.fps} onStart={startDraft} />}
        </div>
      </div>
      <footer>
        {running ? (
          <>
            <button className="btn sm" onClick={() => void cancelExport(projectId)}>Cancel export</button>
            <button
              className="btn sm"
              onClick={() => {
                askToNotify()
                close()
              }}
            >
              Keep working
            </button>
          </>
        ) : (
          <button className="btn sm" onClick={close}>{result ? 'Done' : 'Cancel'}</button>
        )}
        <button className="btn sm primary" onClick={start} disabled={busy}>
          {busy ? <Loader2 size={14} className="spin" /> : <Download size={14} />} {busy ? 'Exporting…' : result ? 'Export again' : 'Export'}
        </button>
      </footer>
    </EditorDialog>
  )
}

/** A select named by its Field label. */
function FieldSelect({ value, onChange, children }: { value: string; onChange: (v: string) => void; children: ReactNode }) {
  const field = useFieldIds()
  return (
    <select className="ed-select" id={field?.control} value={value} onChange={(e) => onChange(e.target.value)}>
      {children}
    </select>
  )
}

/**
 * The export's cover frame (its library thumbnail and share-page poster): a slider over the exported part, the
 * playhead's frame, or automatic. The picture is the export's own (its range, shape and captions) at that moment.
 */
function CoverPicker({ project, value, duration, offset, onChange }: { project: Project; value: number | undefined; duration: number; offset: number; onChange: (v: number | undefined) => void }) {
  const playhead = useEditor((s) => s.playhead)
  const fps = project.fps
  const t = value ?? Math.min(1, duration / 2)
  const atPlayhead = playhead - offset
  return (
    <div className="ed-cover-pick">
      <CoverPreview project={project} t={t} />
      <div className="ed-cover-ctl">
        <input
          type="range"
          className="ed-range"
          min={0}
          max={Math.max(0, duration)}
          step={1 / fps}
          value={t}
          aria-label="Cover frame"
          aria-valuetext={timecode(t, fps)}
          style={{ ['--pct' as string]: `${duration > 0 ? (t / duration) * 100 : 0}%` }}
          onChange={(e) => onChange(parseFloat(e.target.value))}
        />
        <div className="row" style={{ gap: 6 }}>
          <span className="mono ed-cover-t">{value === undefined ? 'Auto' : timecode(t, fps)}</span>
          <button type="button" className="btn sm" disabled={atPlayhead < 0 || atPlayhead > duration} onClick={() => onChange(Math.max(0, Math.min(duration, atPlayhead)))}>
            Use playhead
          </button>
          {value !== undefined && (
            <button type="button" className="btn sm ghost" onClick={() => onChange(undefined)}>
              Auto
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

const COVER_W = 132

/** One frame of `project` at `t`, drawn by the preview renderer at thumbnail size. */
function CoverPreview({ project, t }: { project: Project; t: number }) {
  const ref = useRef<HTMLDivElement>(null)
  const renderer = useRef<StageRenderer | null>(null)
  const scale = COVER_W / project.width
  useEffect(() => {
    const r = new StageRenderer(ref.current!, project, { mode: 'preview', resolveUrl: makeResolver(() => project) })
    renderer.current = r
    return () => {
      renderer.current = null
      r.destroy()
    }
  }, [project])
  useEffect(() => {
    renderer.current?.render(t)
  }, [project, t])
  return (
    <div className="ed-cover" style={{ width: COVER_W, height: Math.round(project.height * scale) }} aria-hidden="true">
      <div ref={ref} className="ed-cover-stage" style={{ width: project.width, height: project.height, background: project.background, transform: `scale(${scale})` }} />
    </div>
  )
}

interface DraftState {
  job: Job<ExportPreviewResult> | null
  result: ExportPreviewResult | null
  error: string | null
  start: (body: ExportRequest) => Promise<void>
}

/** A quick draft render for the dialog's player (E-23): the latest one only, never an export. */
function useDraftPreview(projectId: string): DraftState {
  const [job, setJob] = useState<Job<ExportPreviewResult> | null>(null)
  const [result, setResult] = useState<ExportPreviewResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const live = useRef(true)
  useEffect(() => {
    live.current = true
    return () => {
      live.current = false
    }
  }, [])
  const start = async (body: ExportRequest) => {
    setResult(null)
    setError(null)
    const j = (await api.exportProject(projectId, body)) as unknown as Job<ExportPreviewResult>
    setJob(j)
    try {
      const done = await waitForJob<ExportPreviewResult>(j.id, (x) => live.current && setJob(x))
      if (live.current) setResult(done.result ?? null)
    } catch (e) {
      if (live.current) setError(e instanceof Error ? e.message : String(e))
    }
  }
  return { job, result, error, start }
}

function DraftPreview({ draft, busy, range, fps, onStart }: { draft: DraftState; busy: boolean; range?: { from: number; to: number }; fps: number; onStart: () => void }) {
  const running = !!draft.job && !draft.result && !draft.error
  const pct = draft.job && draft.job.progress >= 0 ? Math.round(draft.job.progress * 100) : null
  return (
    <section className="ed-draft" aria-label="Draft preview">
      <div className="row">
        <div className="eyebrow">Draft preview</div>
        <div className="spacer" />
        <button type="button" className="btn sm" onClick={onStart} disabled={running || busy}>
          {running ? <Loader2 size={13} className="spin" /> : <Play size={13} />} {running ? `Rendering${pct === null ? '…' : ` ${pct}%`}` : draft.result ? 'Render again' : 'Render draft'}
        </button>
      </div>
      <p className="ed-note">
        {range ? `${timecode(range.from, fps)} – ${timecode(range.to, fps)}` : 'The whole video'} at 360p, rendered the way the export renders: check transitions and captions before the full export.
      </p>
      {draft.error && <p className="ed-note ed-note-warn" role="alert"><TriangleAlert size={13} /> {draft.error}</p>}
      {draft.result && <video className="ed-draft-player" src={draft.result.previewUrl} controls autoPlay playsInline aria-label="Draft preview player" />}
    </section>
  )
}

/** The export's name field, named by its Field label; focused first when the dialog opens. */
function NameInput({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const field = useFieldIds()
  return <input className="ed-input" id={field?.control} data-autofocus value={value} onChange={(e) => onChange(e.target.value)} />
}

const SHORTCUTS: Array<[string, Array<[string, string]>]> = [
  ['Playback', [['Space', 'Play / pause'], ['J / K / L', 'Shuttle back / stop / forward (again: faster)'], ['I / O', 'Mark in / out'], ['Alt X', 'Clear in and out'], ['← / →', 'Previous / next frame'], ['Shift ← / →', 'Back / forward 1 s'], ['Home / End', 'Go to start / end'], ['Ctrl Shift F', 'Full-screen preview'], ['Ctrl Shift L', 'Cycle theme']]],
  ['Editing', [['Ctrl B', 'Split at playhead'], ['Delete', 'Delete'], ['Shift Delete', 'Ripple delete'], ['Ctrl C / X / V', 'Copy / cut / paste'], ['Ctrl D', 'Duplicate'], ['Ctrl L', 'Link / unlink clips (a video and its audio)'], ['Ctrl A', 'Select all'], ['Ctrl Z', 'Undo'], ['Ctrl Shift Z', 'Redo']]],
  ['Timeline', [['Ctrl = / Ctrl -', 'Zoom in / out'], ['Ctrl wheel', 'Zoom (the playhead stays put)'], ['Shift wheel', 'Scroll sideways'], ['Shift Z', 'Fit the whole project'], ['S', 'Toggle snapping'], ['M', 'Add a marker at the playhead'], ['Shift M / Alt M', 'Next / previous marker'],['Alt drag', 'Move without snapping'], ['Alt drop on a clip', 'Replace its media'], ['Ctrl / Shift click', 'Multi-select']]],
  ['Timeline clip focused', [['← → ↑ ↓', 'Next clip / track'], ['Alt ← / →', 'Move a frame (Shift: a second)'], ['Alt ↑ / ↓', 'Move to the track above / below'], ['[ / ]', 'Trim start / end to playhead'], ['Shift F10', 'Clip menu']]],
  ['Marker focused (on the ruler)', [['← / →', 'Previous / next marker'], ['Alt ← / →', 'Move a frame (Shift: a second)'], ['F2', 'Rename'], ['Delete', 'Remove'], ['Shift F10', 'Marker menu']]],
  ['Sound', [['Shift drag audio edge', 'J / L cut: the sound only (the next sound rolls)'], ['Shift [ / ]', 'J / L cut to playhead (audio clip)'], ['Double-click volume line', 'Add a volume keyframe'], ['Double-click keyframe', 'Remove it']]],
  ['Canvas', [['V', 'Select tool'], ['H', 'Hand tool'], ['Arrows', 'Nudge 1 px (canvas focused)'], ['Shift arrows', 'Nudge 10 px'], ['Double-click text', 'Edit text inline'], ['Shift drag', 'Constrain / 15° rotate']]],
  ['Transcript words focused', [['← / →', 'Previous / next word'], ['Shift ← / →', 'Extend the selection'], ['Delete', 'Cut the words (they stay struck through)'], ['R', 'Restore struck-through words']]],
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
