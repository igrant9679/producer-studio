// Dubbing & voice changer (desktop): VoiceStudio's dub pipeline — upload/prepare → transcribe + diarize → translate
// (or keep the language to re-voice) → choose a voice per speaker → generate → add the results to the library.
import type { AssetRecord, VoiceProfile } from '@producer/core'
import clsx from 'clsx'
import { Captions, Check, Download, FileVideo, Languages, Library, Mic, Play, RotateCcw, Square, Upload, Wand2 } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../../lib/api'
import { useSession } from '../../lib/session'
import { toast, toastError } from '../../lib/toast'
import { useJobs } from '../stores'
import { Progress, Spinner, useAsync } from '../ui'
import { formatDuration } from '../util'
import { DUB_LANGUAGES, DesktopOnly, EngineGate, useEngine } from './shared'
import { readSse, vsApi, vsFetch, vsGet, vsUrl } from './vsApi'

interface Segment {
  id: string
  start: number
  end: number
  text: string
  text_original?: string
  speaker_id?: string
  profile_id?: string
  target?: string
}

type Stage = 'source' | 'prepare' | 'transcribe' | 'script' | 'generate' | 'done'
const STAGES: Array<[Stage, string]> = [
  ['source', 'Source'],
  ['prepare', 'Prepare'],
  ['transcribe', 'Transcribe'],
  ['script', 'Script & voices'],
  ['generate', 'Generate'],
  ['done', 'Results'],
]

const PROVIDERS = [
  { id: 'argos', label: 'Argos (offline)' },
  { id: 'nllb', label: 'NLLB (offline, 2.4 GB, non-commercial)' },
  { id: 'google', label: 'Google Translate (online)' },
  { id: 'mymemory', label: 'MyMemory (online)' },
]

const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`).replace(/[^\w-]/g, '')

export default function Dubbing({ onOpenEngine }: { onOpenEngine: () => void }) {
  const { desktop, status, running } = useEngine()
  if (!desktop) return <DesktopOnly feature="Dubbing" />
  return (
    <EngineGate status={status} onOpenEngine={onOpenEngine}>
      {running && <DubSession />}
    </EngineGate>
  )
}

function DubSession() {
  const workspaceId = useSession((s) => s.workspaceId)!
  const [stage, setStage] = useState<Stage>('source')
  const [job, setJob] = useState<{ id: string; filename: string; duration?: number; audioOnly: boolean }>()
  const [log, setLog] = useState<string>('')
  const [pct, setPct] = useState(-1)
  const [segments, setSegments] = useState<Segment[]>([])
  const [sourceLang, setSourceLang] = useState('auto')
  const [mode, setMode] = useState<'translate' | 'revoice'>('translate')
  const [target, setTarget] = useState('es')
  const [provider, setProvider] = useState('argos')
  const [speakers, setSpeakers] = useState<Record<string, string>>({})
  const [numSpeakers, setNumSpeakers] = useState('')
  const [tracks, setTracks] = useState<string[]>([])
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)
  const abort = useRef<AbortController>()
  const task = useRef<string>()
  const profiles = useAsync(() => vsApi.profiles(workspaceId), [workspaceId])
  const myVoices = (profiles.data ?? []).filter((p): p is VoiceProfile & { vsProfileId: string } => !!p.local && !!p.vsProfileId)

  useEffect(() => () => abort.current?.abort(), [])
  const fail = (e: unknown) => {
    setError(e instanceof Error ? e.message : String(e))
    setBusy(false)
  }
  const reset = async () => {
    abort.current?.abort()
    if (job) await vsFetch(`/dub/abort/${job.id}`, { method: 'POST' }).catch(() => undefined)
    if (task.current) await vsFetch(`/tasks/cancel/${task.current}`, { method: 'POST' }).catch(() => undefined)
    setStage('source')
    setJob(undefined)
    setSegments([])
    setTracks([])
    setError(undefined)
    setBusy(false)
  }

  /** Follow /tasks/stream until one of `until`; returns that event's data. */
  async function followTask(taskId: string, until: string[], onEvent: (d: any) => void): Promise<any> {
    task.current = taskId
    const ac = new AbortController()
    abort.current = ac
    const res = await vsFetch(`/tasks/stream/${taskId}`, { signal: ac.signal })
    for await (const ev of readSse(res, ac.signal)) {
      const d = ev.data ?? {}
      const type = d.type ?? ev.event
      if (type === 'error') throw new Error(d.error || d.reason || d.detail || 'VoiceStudio reported an error')
      if (type === 'cancelled') throw new Error('Cancelled')
      onEvent({ ...d, type })
      if (until.includes(type)) return d
    }
    throw new Error('The task ended without finishing')
  }

  // ---- 1. source → 2. prepare
  async function start(upload: { file?: File; asset?: AssetRecord }) {
    setError(undefined)
    setBusy(true)
    const id = uuid()
    const audioOnly = (upload.file ? upload.file.type.startsWith('audio') : upload.asset?.asset.kind === 'audio') ?? false
    try {
      let r: { job_id: string; task_id: string; filename: string }
      const fields = { job_id: id, input_type: audioOnly ? 'audio' : 'video', source_lang: sourceLang }
      if (upload.file) {
        const f = new FormData()
        f.set('video', upload.file, upload.file.name)
        for (const [k, v] of Object.entries(fields)) f.set(k, v)
        r = await (await vsFetch('/dub/upload', { body: f })).json()
      } else {
        r = await (await vsApi.assetTo('dub', upload.asset!.asset.id, fields)).json()
      }
      setJob({ id: r.job_id, filename: r.filename, audioOnly })
      setStage('prepare')
      setLog('Extracting audio')
      setPct(-1)
      const ready = await followTask(r.task_id, ['ready'], (d) => {
        if (d.type === 'demucs_start') setLog('Separating the voice from music and effects')
        if (d.type === 'demucs_progress') {
          setLog('Separating the voice from music and effects')
          setPct((d.percent ?? 0) / 100)
        }
        if (d.type === 'scene_start') setLog('Finding scene changes')
        if (d.type === 'extract_done') setLog('Audio extracted')
      })
      setJob({ id: r.job_id, filename: r.filename, duration: ready.duration, audioOnly })
      await transcribe(r.job_id)
    } catch (e) {
      fail(e)
    }
  }

  // ---- 3. transcribe + diarize
  async function transcribe(jobId: string) {
    setStage('transcribe')
    setLog('Transcribing and identifying speakers')
    setPct(-1)
    const ac = new AbortController()
    abort.current = ac
    const res = await vsFetch(`/dub/transcribe-stream/${jobId}`, { signal: ac.signal, query: { num_speakers: numSpeakers || undefined, per_segment_refs: true } })
    let final: { segments: Segment[]; source_lang?: string } | undefined
    for await (const ev of readSse(res, ac.signal)) {
      if (ev.event === 'segments') {
        setPct(ev.data?.progress ?? -1)
        setLog(`Transcribing · part ${ev.data?.chunk ?? '?'} of ${ev.data?.total_chunks ?? '?'}`)
      } else if (ev.event === 'warning') setLog(String(ev.data?.detail ?? ''))
      else if (ev.event === 'error') throw new Error(ev.data?.detail || 'Transcription failed')
      else if (ev.event === 'aborted') throw new Error('Cancelled')
      else if (ev.event === 'final') final = ev.data
      else if (ev.event === 'done') break
    }
    if (!final?.segments?.length) throw new Error('No speech was found in this file')
    const segs = final.segments.map((s) => ({ ...s, target: s.text }))
    setSegments(segs)
    if (final.source_lang) setSourceLang(final.source_lang)
    const spk = [...new Set(segs.map((s) => s.speaker_id || 'Speaker 1'))]
    setSpeakers(Object.fromEntries(spk.map((s) => [s, `auto:${s}`])))
    if (mode === 'revoice' && final.source_lang) setTarget(final.source_lang)
    setStage('script')
    setBusy(false)
  }

  // ---- 4. translate
  async function translate() {
    setBusy(true)
    setError(undefined)
    try {
      if (provider === 'argos' && sourceLang && sourceLang !== 'auto') {
        // offline packs per language pair; installs on first use
        const st = await vsGet<{ pairs?: Array<{ installed?: boolean }> }>('/engines/translation/argos/packs/status', { method: 'POST', body: { source_lang: sourceLang, target_langs: [target], job_id: job?.id } }).catch(() => undefined)
        if (st?.pairs?.some((p) => !p.installed)) {
          toast('Downloading the offline translation pack for this language pair…')
          await vsFetch('/engines/translation/argos/packs/install', { body: { source_lang: sourceLang, target_langs: [target], job_id: job?.id } })
        }
      }
      const r = await vsGet<{ translated: Array<{ id: string; text: string; error?: string }> }>('/dub/translate', {
        method: 'POST',
        body: { segments: segments.map((s) => ({ id: s.id, text: s.text, start: s.start, end: s.end, slot_seconds: s.end - s.start })), target_lang: target, source_lang: sourceLang === 'auto' ? undefined : sourceLang, provider, quality: 'fast', job_id: job?.id },
      })
      const byId = new Map(r.translated.map((t) => [String(t.id), t]))
      setSegments((cur) => cur.map((s) => ({ ...s, target: byId.get(String(s.id))?.text ?? s.target })))
      const errs = r.translated.filter((t) => t.error).length
      toast(errs ? `Translated, with ${errs} line${errs === 1 ? '' : 's'} left as-is` : 'Translated — review the lines, then generate')
    } catch (e) {
      toastError(e)
    } finally {
      setBusy(false)
    }
  }

  // ---- 5. generate
  async function generate() {
    if (!job) return
    setBusy(true)
    setError(undefined)
    setStage('generate')
    setPct(0)
    setLog('Generating speech')
    const code = mode === 'revoice' ? (sourceLang === 'auto' ? 'en' : sourceLang) : target
    const label = DUB_LANGUAGES.find((l) => l.code === code)?.label ?? 'Auto'
    try {
      const r = await vsGet<{ task_id: string }>(`/dub/generate/${job.id}`, {
        method: 'POST',
        body: {
          segments: segments.map((s) => ({ start: s.start, end: s.end, text: (mode === 'translate' ? s.target : s.text) || s.text, profile_id: speakers[s.speaker_id || 'Speaker 1'] || `auto:${s.speaker_id || 'Speaker 1'}`, effect_preset: 'broadcast' })),
          language: label,
          language_code: code,
          timing_strategy: 'smart_fit',
          voice_match: 'per_line',
        },
      })
      const done = await followTask(r.task_id, ['done'], (d) => {
        if (d.type === 'progress' && d.total) {
          setPct(d.current / d.total)
          setLog(`Line ${d.current} of ${d.total}${d.text ? ` — “${String(d.text).slice(0, 60)}”` : ''}`)
        }
        if (d.type === 'assembling') setLog('Mixing the new voice track with the original background')
      })
      setTracks([done.language_code || code])
      setStage('done')
    } catch (e) {
      fail(e)
      setStage('script')
    } finally {
      setBusy(false)
    }
  }

  const code = tracks[0]
  async function importOut(kind: 'video' | 'audio') {
    if (!job || !code) return
    const label = DUB_LANGUAGES.find((l) => l.code === code)?.label ?? code
    const base = job.filename.replace(/\.[^.]+$/, '')
    try {
      const source = kind === 'video' && !job.audioOnly
        ? `/dub/download/${job.id}?default_track=${encodeURIComponent(code)}&include_tracks=${encodeURIComponent(code)}&preserve_bg=true`
        : job.audioOnly && kind === 'video'
          ? `/dub/download/${job.id}?out_format=m4a`
          : `/dub/download-audio/${job.id}?lang=${encodeURIComponent(code)}&preserve_bg=true`
      const j = await vsApi.importOutput({ workspaceId, source, kind: job.audioOnly ? 'audio' : kind, name: `${base} — ${mode === 'revoice' ? 're-voiced' : label}${kind === 'audio' && !job.audioOnly ? ' (audio)' : ''}`, ext: kind === 'video' && !job.audioOnly ? '.mp4' : job.audioOnly && kind === 'video' ? '.m4a' : '.wav', origin: 'dub' })
      useJobs.getState().upsert(j)
      toast('Adding to the library — it appears in Library when processed')
    } catch (e) {
      toastError(e)
    }
  }

  const speakerList = useMemo(() => Object.keys(speakers), [speakers])
  const stageIdx = STAGES.findIndex(([s]) => s === stage)

  return (
    <div className="vs-panel">
      <div className="vs-steps-bar">
        {STAGES.map(([s, label], i) => (
          <span key={s} className={clsx('vs-step', s === stage && 'on', i < stageIdx && 'done')}>{i < stageIdx ? <Check size={12} /> : null} {label}</span>
        ))}
        <span className="spacer" />
        {stage !== 'source' && <button className="btn ghost sm" onClick={reset}><RotateCcw size={13} /> Start over</button>}
      </div>
      {error && <div className="ps-alert" style={{ marginBottom: 12 }}>{error}</div>}

      {stage === 'source' && (
        <SourcePicker
          mode={mode}
          setMode={setMode}
          sourceLang={sourceLang}
          setSourceLang={setSourceLang}
          numSpeakers={numSpeakers}
          setNumSpeakers={setNumSpeakers}
          busy={busy}
          onPick={start}
        />
      )}

      {(stage === 'prepare' || stage === 'transcribe' || stage === 'generate') && (
        <div style={{ padding: '18px 0' }}>
          <div className="row" style={{ gap: 8, marginBottom: 10 }}><Spinner size={14} /> <strong>{job?.filename}</strong>{job?.duration ? <span className="muted">· {formatDuration(job.duration)}</span> : null}</div>
          <Progress value={pct} />
          <div className="muted" style={{ fontSize: '0.8125rem', marginTop: 8 }}>{log}</div>
          <button className="btn ghost sm" style={{ marginTop: 12 }} onClick={reset}><Square size={12} /> Cancel</button>
        </div>
      )}

      {stage === 'script' && (
        <div>
          <div className="row" style={{ gap: 10, flexWrap: 'wrap', marginBottom: 12 }}>
            <span className="muted" style={{ fontSize: '0.8125rem' }}>{segments.length} lines · source: {DUB_LANGUAGES.find((l) => l.code === sourceLang)?.label ?? sourceLang}</span>
            <span className="spacer" />
            {mode === 'translate' ? (
              <>
                <select className="input" style={{ width: 'auto' }} value={target} onChange={(e) => setTarget(e.target.value)} aria-label="Dub into">
                  {DUB_LANGUAGES.map((l) => <option key={l.code} value={l.code}>{l.label}</option>)}
                </select>
                <select className="input" style={{ width: 'auto' }} value={provider} onChange={(e) => setProvider(e.target.value)} aria-label="Translator">
                  {PROVIDERS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
                </select>
                <button className="btn" disabled={busy} onClick={translate}>{busy ? <Spinner size={13} /> : <Languages size={14} />} Translate</button>
              </>
            ) : (
              <span className="vs-chip">Voice changer: same language, new voice</span>
            )}
          </div>

          <div className="vs-form-grid" style={{ marginTop: 0, marginBottom: 12 }}>
            {speakerList.map((spk) => (
              <div key={spk}>
                <label className="label">{spk}</label>
                <select className="input" value={speakers[spk]} onChange={(e) => setSpeakers((cur) => ({ ...cur, [spk]: e.target.value }))}>
                  <option value={`auto:${spk}`}>Clone this speaker’s own voice</option>
                  {myVoices.map((v) => <option key={v.id} value={v.vsProfileId}>{v.name} ({v.kind === 'design' ? 'designed' : 'my voice'})</option>)}
                </select>
              </div>
            ))}
          </div>

          <div className="vs-seg-wrap">
            <table className="vs-seg-table">
              <thead>
                <tr><th style={{ width: 70 }}>Time</th><th style={{ width: 90 }}>Speaker</th><th style={{ width: mode === 'translate' ? '42%' : undefined }}>Original</th>{mode === 'translate' && <th style={{ width: '42%' }}>Dub line</th>}</tr>
              </thead>
              <tbody>
                {segments.map((s, i) => (
                  <tr key={s.id}>
                    <td className="muted">{formatDuration(s.start)}</td>
                    <td className="muted">{s.speaker_id ?? ''}</td>
                    <td>
                      {mode === 'revoice' ? (
                        <textarea className="input" value={s.text} onChange={(e) => setSegments((cur) => cur.map((x, j) => (j === i ? { ...x, text: e.target.value } : x)))} />
                      ) : (
                        s.text
                      )}
                    </td>
                    {mode === 'translate' && (
                      <td><textarea className="input" value={s.target ?? ''} onChange={(e) => setSegments((cur) => cur.map((x, j) => (j === i ? { ...x, target: e.target.value } : x)))} /></td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="row" style={{ justifyContent: 'flex-end', marginTop: 14 }}>
            <button className="btn primary" disabled={busy} onClick={generate}><Wand2 size={14} /> {mode === 'revoice' ? 'Re-voice' : 'Generate dub'}</button>
          </div>
        </div>
      )}

      {stage === 'done' && job && code && (
        <div>
          <div className="row" style={{ gap: 8, marginBottom: 12 }}><Check size={16} style={{ color: 'var(--green)' }} /> <strong>{mode === 'revoice' ? 'Re-voiced' : `Dubbed into ${DUB_LANGUAGES.find((l) => l.code === code)?.label ?? code}`}</strong></div>
          {!job.audioOnly ? (
            <video src={vsUrl(`/dub/download/${job.id}?default_track=${encodeURIComponent(code)}&include_tracks=${encodeURIComponent(code)}&preserve_bg=true`)} controls style={{ width: '100%', maxHeight: 420, borderRadius: 12, background: '#000' }} />
          ) : (
            <audio src={vsUrl(`/dub/download-audio/${job.id}?lang=${encodeURIComponent(code)}&preserve_bg=true`)} controls style={{ width: '100%' }} />
          )}
          <div className="vs-outputs" style={{ marginTop: 12 }}>
            <button className="btn primary" onClick={() => importOut('video')}><Library size={14} /> Add {job.audioOnly ? 'audio' : 'dubbed video'} to library</button>
            {!job.audioOnly && <button className="btn" onClick={() => importOut('audio')}><Mic size={14} /> Add voice track (WAV)</button>}
            <a className="btn" href={vsUrl(`/dub/srt/${job.id}?lang=${encodeURIComponent(code)}`)} download={`${job.filename.replace(/\.[^.]+$/, '')}.${code}.srt`}><Captions size={14} /> Subtitles (SRT)</a>
            <a className="btn ghost" href={vsUrl(`/dub/export-stems/${job.id}?lang=${encodeURIComponent(code)}`)} download><Download size={14} /> Stems (ZIP)</a>
            <button className="btn ghost" onClick={() => setStage('script')}><Play size={14} /> Edit lines and regenerate</button>
          </div>
        </div>
      )}
    </div>
  )
}

function SourcePicker({ mode, setMode, sourceLang, setSourceLang, numSpeakers, setNumSpeakers, busy, onPick }: {
  mode: 'translate' | 'revoice'
  setMode: (m: 'translate' | 'revoice') => void
  sourceLang: string
  setSourceLang: (s: string) => void
  numSpeakers: string
  setNumSpeakers: (s: string) => void
  busy: boolean
  onPick: (u: { file?: File; asset?: AssetRecord }) => void
}) {
  const workspaceId = useSession((s) => s.workspaceId)!
  const fileRef = useRef<HTMLInputElement>(null)
  const lib = useAsync(async () => (await api.assets(workspaceId)).filter((a) => (a.asset.kind === 'video' || a.asset.kind === 'audio') && a.status === 'ready').sort((a, b) => b.createdAt - a.createdAt), [workspaceId])
  return (
    <div>
      <div className="ps-seg" style={{ marginBottom: 14 }}>
        <button className={mode === 'translate' ? 'on' : ''} onClick={() => setMode('translate')}><Languages size={14} /> Dub into another language</button>
        <button className={mode === 'revoice' ? 'on' : ''} onClick={() => setMode('revoice')}><Mic size={14} /> Voice changer (same language)</button>
      </div>
      <div className="vs-form-grid" style={{ marginTop: 0, marginBottom: 14 }}>
        <div>
          <label className="label">Spoken language</label>
          <select className="input" value={sourceLang} onChange={(e) => setSourceLang(e.target.value)}>
            <option value="auto">Detect automatically</option>
            {DUB_LANGUAGES.map((l) => <option key={l.code} value={l.code}>{l.label}</option>)}
          </select>
        </div>
        <div>
          <label className="label">Number of speakers</label>
          <select className="input" value={numSpeakers} onChange={(e) => setNumSpeakers(e.target.value)}>
            <option value="">Detect automatically</option>
            {[1, 2, 3, 4, 5, 6].map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        </div>
      </div>
      <div className="vs-drop" onClick={() => !busy && fileRef.current?.click()} onDragOver={(e) => e.preventDefault()} onDrop={(e) => {
        e.preventDefault()
        const f = e.dataTransfer.files[0]
        if (f && !busy) onPick({ file: f })
      }}>
        {busy ? <Spinner /> : <Upload size={20} />}
        <span>Drop a video or audio file, or click to choose</span>
        <input ref={fileRef} type="file" accept="video/*,audio/*" hidden onChange={(e) => {
          const f = e.target.files?.[0]
          if (f) onPick({ file: f })
          e.target.value = ''
        }} />
      </div>
      <div className="eyebrow" style={{ margin: '16px 0 8px' }}>Or from this space’s library</div>
      {lib.loading && !lib.data ? (
        <div className="muted"><Spinner size={13} /> Loading…</div>
      ) : !lib.data?.length ? (
        <div className="muted">No videos or audio in the library yet.</div>
      ) : (
        <div className="vs-lib">
          {lib.data.slice(0, 50).map((a) => (
            <button key={a.asset.id} className="vs-lib-row" disabled={busy} onClick={() => onPick({ asset: a })}>
              <FileVideo size={14} /> <span className="ellipsis">{a.asset.name}</span>
              <span className="muted">{a.asset.duration ? formatDuration(a.asset.duration) : ''}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
