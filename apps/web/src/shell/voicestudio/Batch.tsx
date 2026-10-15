// Batch dubbing (desktop): queue many videos into one or more languages with VoiceStudio's /batch queue. Finished
// dubs can be added to the space's library automatically (the desktop server watches the jobs it tracks).
import type { AssetRecord, VoiceProfile } from '@producer/core'
import clsx from 'clsx'
import { CheckCircle2, Download, FileVideo, Layers, Library, RotateCcw, Square, Trash2, Upload, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../../lib/api'
import { useSession } from '../../lib/session'
import { toast, toastError } from '../../lib/toast'
import { sysFetch } from '../system'
import { useJobs } from '../stores'
import { EmptyState, Progress, Spinner, useAsync } from '../ui'
import { formatDuration, relativeTime } from '../util'
import { DUB_LANGUAGES, DesktopOnly, EngineGate, useEngine } from './shared'
import { vsApi, vsFetch, vsGet, vsUrl } from './vsApi'

interface BatchJob {
  id: string
  status: 'queued' | 'running' | 'done' | 'failed' | 'cancelled'
  filename: string
  langs: string[]
  voice_id?: string | null
  created_at: number
  started_at?: number | null
  finished_at?: number | null
  progress?: { stage?: string; percent?: number; lang?: string } | null
  error?: string | null
  outputs?: Record<string, string>
}

type Item = { file?: File; asset?: AssetRecord; name: string }

const langLabel = (c: string) => DUB_LANGUAGES.find((l) => l.code === c)?.label ?? c
const PROVIDERS = [
  { id: 'argos', label: 'Argos (offline)' },
  { id: 'nllb', label: 'NLLB (offline, non-commercial)' },
  { id: 'google', label: 'Google Translate (online)' },
  { id: 'mymemory', label: 'MyMemory (online)' },
]

export default function Batch({ onOpenEngine }: { onOpenEngine: () => void }) {
  const { desktop, status, running } = useEngine()
  if (!desktop) return <DesktopOnly feature="Batch dubbing" />
  return (
    <EngineGate status={status} onOpenEngine={onOpenEngine}>
      {running && <BatchStudio />}
    </EngineGate>
  )
}

function BatchStudio() {
  const workspaceId = useSession((s) => s.workspaceId)!
  const [items, setItems] = useState<Item[]>([])
  const [langs, setLangs] = useState<string[]>(['es'])
  const [voice, setVoice] = useState('')
  const [provider, setProvider] = useState('argos')
  const [keepBg, setKeepBg] = useState(true)
  const [autoAdd, setAutoAdd] = useState(true)
  const [picking, setPicking] = useState(false)
  const [busy, setBusy] = useState(false)
  const [langQ, setLangQ] = useState('')
  const fileRef = useRef<HTMLInputElement>(null)
  const profiles = useAsync(() => vsApi.profiles(workspaceId), [workspaceId])
  const voices = (profiles.data ?? []).filter((p): p is VoiceProfile & { vsProfileId: string } => !!p.local && !!p.vsProfileId)
  const lib = useAsync(async () => (picking ? (await api.assets(workspaceId, 'video')).filter((a) => a.status === 'ready') : []), [workspaceId, picking])
  const [jobs, setJobs] = useState<BatchJob[]>()
  const [tracked, setTracked] = useState<string[]>([])
  const [tick, setTick] = useState(0)

  // jobs list: poll while anything is queued/running
  useEffect(() => {
    let alive = true
    ;(async () => {
      try {
        const [j, t] = await Promise.all([vsGet<BatchJob[]>('/batch/jobs', { query: { limit: 100 } }), sysFetch<Array<{ jobId: string }>>('GET', '/voicestudio/batch/tracked')])
        if (!alive) return
        setJobs(j)
        setTracked(t.map((x) => x.jobId))
        if (j.some((x) => x.status === 'queued' || x.status === 'running')) setTimeout(() => alive && setTick((n) => n + 1), 3000)
      } catch {
        /* engine restarting */
      }
    })()
    return () => {
      alive = false
    }
  }, [tick])

  const addFiles = (files: FileList | File[]) => {
    // copy now: a FileList is live and empties when the input is reset, before React runs the updater
    const picked = [...files].filter((f) => f.type.startsWith('video') || /\.(mp4|mov|mkv|webm|m4v)$/i.test(f.name)).map((f) => ({ file: f, name: f.name }))
    setItems((cur) => [...cur, ...picked])
  }
  const toggleLang = (c: string) => setLangs((cur) => (cur.includes(c) ? cur.filter((x) => x !== c) : [...cur, c]))
  const shownLangs = useMemo(() => {
    const t = langQ.trim().toLowerCase()
    return DUB_LANGUAGES.filter((l) => !t || l.label.toLowerCase().includes(t) || l.code.toLowerCase().startsWith(t))
  }, [langQ])

  async function queue() {
    if (!items.length || !langs.length) return
    setBusy(true)
    let ok = 0
    for (const it of items) {
      const fields = { langs: langs.join(','), voice_id: voice || undefined, preserve_bg: String(keepBg), translation_provider: provider }
      try {
        let r: { job_id: string }
        if (it.asset) r = await (await vsApi.assetTo('batch', it.asset.asset.id, fields)).json()
        else {
          const f = new FormData()
          f.set('video', it.file!, it.file!.name)
          for (const [k, v] of Object.entries(fields)) if (v !== undefined) f.set(k, v)
          r = await (await vsFetch('/batch/enqueue', { body: f })).json()
        }
        if (autoAdd) await sysFetch('POST', '/voicestudio/batch/track', { jobId: r.job_id, workspaceId, name: it.name.replace(/\.[^.]+$/, ''), langs })
        ok++
      } catch (e) {
        toastError(new Error(`${it.name}: ${e instanceof Error ? e.message : String(e)}`))
      }
    }
    setBusy(false)
    if (ok) {
      toast(`Queued ${ok} video${ok === 1 ? '' : 's'} × ${langs.length} language${langs.length === 1 ? '' : 's'}`)
      setItems([])
      setTick((n) => n + 1)
    }
  }

  const act = async (j: BatchJob, what: 'cancel' | 'retry' | 'delete') => {
    try {
      if (what === 'delete') {
        await vsFetch(`/batch/jobs/${j.id}`, { method: 'DELETE' })
        if (tracked.includes(j.id)) await sysFetch('DELETE', `/voicestudio/batch/track/${j.id}`)
      } else await vsFetch(`/batch/jobs/${j.id}/${what}`, { method: 'POST' })
      setTick((n) => n + 1)
    } catch (e) {
      toastError(e)
    }
  }

  const importOut = async (j: BatchJob, lang: string) => {
    try {
      const job = await vsApi.importOutput({ workspaceId, source: `/batch/download/${j.id}/${encodeURIComponent(lang)}`, name: `${j.filename.replace(/\.[^.]+$/, '')} — ${langLabel(lang)}`, kind: 'video', ext: '.mp4', origin: 'dub' })
      useJobs.getState().upsert(job)
      toast('Adding to the library')
    } catch (e) {
      toastError(e)
    }
  }

  return (
    <div className="vs-batch">
      <div className="vs-panel">
        <div className="row" style={{ gap: 8, marginBottom: 12 }}><Layers size={16} /> <strong>New batch</strong><span className="muted" style={{ fontSize: '0.8125rem' }}>Each video is transcribed, translated and dubbed into every language you pick, one after another.</span></div>
        <div className="vs-drop" onClick={() => fileRef.current?.click()} onDragOver={(e) => e.preventDefault()} onDrop={(e) => {
          e.preventDefault()
          addFiles(e.dataTransfer.files)
        }}>
          <Upload size={20} />
          <span>Drop videos here, or click to choose several</span>
          <input ref={fileRef} type="file" accept="video/*" multiple hidden onChange={(e) => {
            if (e.target.files) addFiles(e.target.files)
            e.target.value = ''
          }} />
        </div>
        <div className="row" style={{ gap: 8, marginTop: 10 }}>
          <button className="btn sm" onClick={() => setPicking((v) => !v)}><Library size={13} /> {picking ? 'Hide library' : 'Add from the library'}</button>
          {items.length > 0 && <span className="muted" style={{ fontSize: '0.8125rem' }}>{items.length} video{items.length === 1 ? '' : 's'} ready</span>}
        </div>
        {picking && (
          <div className="vs-lib" style={{ marginTop: 8 }}>
            {lib.loading && !lib.data && <span className="muted"><Spinner size={13} /> Loading…</span>}
            {(lib.data ?? []).map((a) => {
              const on = items.some((x) => x.asset?.asset.id === a.asset.id)
              return (
                <button key={a.asset.id} className={clsx('vs-lib-row', on && 'on')} onClick={() => setItems((cur) => (on ? cur.filter((x) => x.asset?.asset.id !== a.asset.id) : [...cur, { asset: a, name: a.asset.name }]))}>
                  {on ? <CheckCircle2 size={14} /> : <FileVideo size={14} />} <span className="ellipsis">{a.asset.name}</span>
                  <span className="muted">{a.asset.duration ? formatDuration(a.asset.duration) : ''}</span>
                </button>
              )
            })}
            {lib.data && !lib.data.length && <span className="muted">No videos in this space’s library.</span>}
          </div>
        )}
        {items.length > 0 && (
          <div className="row" style={{ gap: 6, flexWrap: 'wrap', marginTop: 10 }}>
            {items.map((it, i) => (
              <span key={i} className="vs-chip">{it.name}<button className="vs-chip-x" aria-label={`Remove ${it.name}`} onClick={() => setItems((cur) => cur.filter((_, j) => j !== i))}><X size={10} /></button></span>
            ))}
          </div>
        )}

        <div className="vs-form-grid">
          <div style={{ gridColumn: '1 / -1' }}>
            <label className="label">Dub into <span className="muted">({langs.length} selected)</span></label>
            <input className="input" placeholder="Find a language" value={langQ} onChange={(e) => setLangQ(e.target.value)} style={{ marginBottom: 8 }} />
            <div className="vs-langs">
              {shownLangs.map((l) => (
                <button key={l.code} className={clsx('chip', langs.includes(l.code) && 'active')} onClick={() => toggleLang(l.code)}>{l.label}</button>
              ))}
            </div>
          </div>
          <div>
            <label className="label">Voice</label>
            <select className="input" value={voice} onChange={(e) => setVoice(e.target.value)}>
              <option value="">Clone each speaker’s own voice</option>
              {voices.map((v) => <option key={v.id} value={v.vsProfileId}>{v.name}</option>)}
            </select>
          </div>
          <div>
            <label className="label">Translator</label>
            <select className="input" value={provider} onChange={(e) => setProvider(e.target.value)}>
              {PROVIDERS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
            </select>
          </div>
          <label className="vs-check"><input type="checkbox" checked={keepBg} onChange={(e) => setKeepBg(e.target.checked)} /> <span>Keep the original music and effects</span></label>
          <label className="vs-check"><input type="checkbox" checked={autoAdd} onChange={(e) => setAutoAdd(e.target.checked)} /> <span>Add finished dubs to this space’s library</span></label>
        </div>
        <div className="row" style={{ justifyContent: 'flex-end', marginTop: 14 }}>
          <button className="btn primary" disabled={!items.length || !langs.length || busy} onClick={queue}>{busy ? <Spinner size={13} /> : <Layers size={14} />} Queue {items.length || ''} video{items.length === 1 ? '' : 's'}</button>
        </div>
      </div>

      <div className="ps-section" style={{ marginTop: 22 }}>
        <div className="ps-section-head"><h2 className="ps-h2">Queue</h2><span className="muted" style={{ fontSize: '0.75rem' }}>{jobs ? `${jobs.length} job${jobs.length === 1 ? '' : 's'}` : ''}</span></div>
        {!jobs ? (
          <Spinner />
        ) : !jobs.length ? (
          <EmptyState icon={<Layers size={24} />} title="Nothing queued" body="Add videos above to dub them in the background." />
        ) : (
          <div className="vs-engine-list">
            {jobs.map((j) => (
              <div key={j.id} className="vs-engine-row" style={{ alignItems: 'flex-start' }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <strong className="ellipsis">{j.filename}</strong>
                  <div className="row" style={{ gap: 6, flexWrap: 'wrap', marginTop: 4 }}>
                    <span className={clsx('vs-chip', j.status === 'done' && 'ok', j.status === 'failed' && 'warn')}>{j.status}</span>
                    {j.langs.map((l) => <span key={l} className="vs-chip muted">{langLabel(l)}</span>)}
                    {tracked.includes(j.id) && <span className="vs-chip">Auto-adding to library</span>}
                    <span className="muted" style={{ fontSize: '0.7188rem' }}>{relativeTime(j.created_at * 1000)}</span>
                  </div>
                  {j.status === 'running' && (
                    <div style={{ marginTop: 8 }}>
                      <Progress value={j.progress?.percent != null ? j.progress.percent / 100 : -1} />
                      <div className="muted" style={{ fontSize: '0.7188rem', marginTop: 4 }}>{[j.progress?.stage, j.progress?.lang && langLabel(j.progress.lang)].filter(Boolean).join(' · ')}</div>
                    </div>
                  )}
                  {j.error && <div className="muted" style={{ fontSize: '0.75rem', marginTop: 4, color: 'var(--danger)' }}>{j.error}</div>}
                  {j.status === 'done' && (
                    <div className="row" style={{ gap: 6, flexWrap: 'wrap', marginTop: 8 }}>
                      {Object.keys(j.outputs ?? {}).map((l) => (
                        <span key={l} className="row" style={{ gap: 4 }}>
                          <a className="btn sm" href={vsUrl(`/batch/download/${j.id}/${encodeURIComponent(l)}`)} download><Download size={12} /> {langLabel(l)}</a>
                          {!tracked.includes(j.id) && <button className="btn ghost sm" onClick={() => importOut(j, l)} title="Add to library"><Library size={12} /></button>}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
                <div className="row" style={{ gap: 4 }}>
                  {(j.status === 'queued' || j.status === 'running') && <button className="btn ghost sm" onClick={() => act(j, 'cancel')}><Square size={12} /> Cancel</button>}
                  {(j.status === 'failed' || j.status === 'cancelled') && <button className="btn ghost sm" onClick={() => act(j, 'retry')}><RotateCcw size={12} /> Retry</button>}
                  {j.status !== 'running' && <button className="btn ghost sm icon" onClick={() => act(j, 'delete')} aria-label={`Remove ${j.filename}`}><Trash2 size={13} /></button>}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
