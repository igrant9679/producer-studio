// Audio tools (desktop): vocal isolation (VoiceStudio's demucs /clean-audio) and multilingual transcription
// (/transcribe), from a library clip or a file. Results go back into the library or download as text/SRT.
import type { AssetRecord } from '@producer/core'
import { AudioLines, Copy, FileAudio, FileText, Library, Upload, Wand2 } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { api } from '../../lib/api'
import { useSession } from '../../lib/session'
import { toast, toastError } from '../../lib/toast'
import { uploadFiles } from '../stores'
import { Spinner, useAsync } from '../ui'
import { formatDuration } from '../util'
import { DesktopOnly, EngineGate, LANGUAGES, useElapsed, useEngine } from './shared'
import { vsApi, vsFetch } from './vsApi'

type Src = { file?: File; asset?: AssetRecord; label: string }

export default function AudioTools({ onOpenEngine }: { onOpenEngine: () => void }) {
  const { desktop, status, running } = useEngine()
  if (!desktop) return <DesktopOnly feature="Audio tools" />
  return (
    <EngineGate status={status} onOpenEngine={onOpenEngine}>
      {running && (
        <div className="vs-engine">
          <Isolate />
          <Transcribe />
        </div>
      )}
    </EngineGate>
  )
}

function SourceRow({ src, setSrc, accept = 'audio/*,video/*' }: { src?: Src; setSrc: (s: Src) => void; accept?: string }) {
  const workspaceId = useSession((s) => s.workspaceId)!
  const fileRef = useRef<HTMLInputElement>(null)
  const [picking, setPicking] = useState(false)
  const lib = useAsync(async () => (picking ? (await api.assets(workspaceId)).filter((a) => (a.asset.kind === 'audio' || a.asset.kind === 'video') && a.status === 'ready') : []), [workspaceId, picking])
  return (
    <div>
      <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
        <button className="btn sm" onClick={() => fileRef.current?.click()}><Upload size={13} /> Choose a file</button>
        <button className="btn sm" onClick={() => setPicking((v) => !v)}><Library size={13} /> From the library</button>
        {src && <span className="vs-chip"><FileAudio size={11} /> {src.label}</span>}
        <input ref={fileRef} type="file" accept={accept} hidden onChange={(e) => {
          const f = e.target.files?.[0]
          if (f) setSrc({ file: f, label: f.name })
          e.target.value = ''
        }} />
      </div>
      {picking && (
        <div className="vs-lib" style={{ marginTop: 8 }}>
          {lib.loading && !lib.data ? <span className="muted"><Spinner size={13} /> Loading…</span> : null}
          {(lib.data ?? []).slice(0, 40).map((a) => (
            <button key={a.asset.id} className={`vs-lib-row ${src?.asset?.asset.id === a.asset.id ? 'on' : ''}`} onClick={() => {
              setSrc({ asset: a, label: a.asset.name })
              setPicking(false)
            }}>
              <FileAudio size={14} /> <span className="ellipsis">{a.asset.name}</span>
              <span className="muted">{a.asset.duration ? formatDuration(a.asset.duration) : ''}</span>
            </button>
          ))}
          {lib.data && !lib.data.length && <span className="muted">No audio or video in this space.</span>}
        </div>
      )}
    </div>
  )
}

function Isolate() {
  const workspaceId = useSession((s) => s.workspaceId)!
  const [src, setSrc] = useState<Src>()
  const [busy, setBusy] = useState(false)
  const [out, setOut] = useState<{ url: string; blob: Blob; name: string }>()
  const elapsed = useElapsed(busy)
  useEffect(() => () => {
    if (out) URL.revokeObjectURL(out.url)
  }, [out])
  async function run() {
    if (!src) return
    setBusy(true)
    try {
      let res: Response
      if (src.asset) res = await vsApi.assetTo('clean-audio', src.asset.asset.id)
      else {
        const f = new FormData()
        f.set('audio', src.file!, src.file!.name)
        res = await vsFetch('/clean-audio', { body: f })
      }
      const blob = await res.blob()
      setOut({ url: URL.createObjectURL(blob), blob, name: `${src.label.replace(/\.[^.]+$/, '')} — voice only.wav` })
    } catch (e) {
      toastError(e)
    } finally {
      setBusy(false)
    }
  }
  return (
    <section className="card vs-engine-card">
      <div className="row" style={{ gap: 8 }}><AudioLines size={15} /> <strong>Isolate vocals</strong></div>
      <p className="muted" style={{ fontSize: '0.8125rem', margin: '6px 0 12px' }}>Removes music, effects and background noise and keeps the voice — useful for cleaning a reference clip before cloning, or rescuing a noisy recording.</p>
      <SourceRow src={src} setSrc={(s) => {
        setSrc(s)
        setOut(undefined)
      }} />
      <div className="row" style={{ gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
        <button className="btn primary sm" disabled={!src || busy} onClick={run}>{busy ? <><Spinner size={13} /> Separating… {elapsed}s</> : <><Wand2 size={13} /> Isolate vocals</>}</button>
        {out && (
          <>
            <audio src={out.url} controls style={{ height: 32 }} />
            <button className="btn sm" onClick={async () => {
              const recs = await uploadFiles(workspaceId, [new File([out.blob], out.name, { type: 'audio/wav' })])
              if (recs.length) toast('Added the clean voice track to the library')
            }}><Library size={13} /> Add to library</button>
          </>
        )}
      </div>
    </section>
  )
}

interface TranscribeResult {
  text: string
  segments: Array<{ start: number; end: number; text: string }>
  language?: string
  duration_s?: number
  engine?: string
}

const srtTime = (s: number) => {
  const ms = Math.round(s * 1000)
  const h = Math.floor(ms / 3_600_000)
  const m = Math.floor((ms % 3_600_000) / 60_000)
  const sec = Math.floor((ms % 60_000) / 1000)
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')},${String(ms % 1000).padStart(3, '0')}`
}

function Transcribe() {
  const [src, setSrc] = useState<Src>()
  const [language, setLanguage] = useState('Auto')
  const [mode, setMode] = useState<'fast' | 'accurate'>('accurate')
  const [busy, setBusy] = useState(false)
  const [res, setRes] = useState<TranscribeResult>()
  const elapsed = useElapsed(busy)
  async function run() {
    if (!src) return
    setBusy(true)
    try {
      const fields = { mode, language: language === 'Auto' ? undefined : language }
      let r: Response
      if (src.asset) r = await vsApi.assetTo('transcribe', src.asset.asset.id, fields)
      else {
        const f = new FormData()
        f.set('audio', src.file!, src.file!.name)
        for (const [k, v] of Object.entries(fields)) if (v) f.set(k, v)
        r = await vsFetch('/transcribe', { body: f })
      }
      setRes((await r.json()) as TranscribeResult)
    } catch (e) {
      toastError(e)
    } finally {
      setBusy(false)
    }
  }
  const download = (name: string, body: string) => {
    const a = document.createElement('a')
    a.href = URL.createObjectURL(new Blob([body], { type: 'text/plain;charset=utf-8' }))
    a.download = name
    a.click()
    setTimeout(() => URL.revokeObjectURL(a.href), 2000)
  }
  const base = src?.label.replace(/\.[^.]+$/, '') ?? 'transcript'
  return (
    <section className="card vs-engine-card">
      <div className="row" style={{ gap: 8 }}><FileText size={15} /> <strong>Transcribe</strong></div>
      <p className="muted" style={{ fontSize: '0.8125rem', margin: '6px 0 12px' }}>Speech to text in 90+ languages with VoiceStudio’s speech recognition (needs an ASR model from the Engine tab).</p>
      <SourceRow src={src} setSrc={(s) => {
        setSrc(s)
        setRes(undefined)
      }} />
      <div className="row" style={{ gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
        <select className="input" style={{ width: 'auto' }} value={language} onChange={(e) => setLanguage(e.target.value)} aria-label="Language">{LANGUAGES.map((l) => <option key={l}>{l}</option>)}</select>
        <div className="ps-seg">
          <button className={mode === 'accurate' ? 'on' : ''} onClick={() => setMode('accurate')}>Accurate</button>
          <button className={mode === 'fast' ? 'on' : ''} onClick={() => setMode('fast')}>Fast</button>
        </div>
        <button className="btn primary sm" disabled={!src || busy} onClick={run}>{busy ? <><Spinner size={13} /> Transcribing… {elapsed}s</> : <><FileText size={13} /> Transcribe</>}</button>
      </div>
      {res && (
        <div style={{ marginTop: 14 }}>
          <div className="row" style={{ gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
            <span className="vs-chip">{res.language ?? 'auto'}</span>
            {res.duration_s ? <span className="vs-chip muted">{formatDuration(res.duration_s)}</span> : null}
            {res.engine && <span className="vs-chip muted">{res.engine}</span>}
            <span className="spacer" />
            <button className="btn ghost sm" onClick={() => navigator.clipboard.writeText(res.text).then(() => toast('Copied'))}><Copy size={13} /> Copy</button>
            <button className="btn ghost sm" onClick={() => download(`${base}.txt`, res.text)}>TXT</button>
            <button className="btn ghost sm" onClick={() => download(`${base}.srt`, res.segments.map((s, i) => `${i + 1}\n${srtTime(s.start)} --> ${srtTime(s.end)}\n${s.text.trim()}\n`).join('\n'))}>SRT</button>
          </div>
          <div className="vs-log" style={{ whiteSpace: 'pre-wrap', fontFamily: 'inherit', fontSize: '0.875rem', maxHeight: 320 }}>{res.text}</div>
        </div>
      )}
    </section>
  )
}
