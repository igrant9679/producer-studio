// Gallery (desktop): VoiceStudio's voice-clip library and import sources — files, library clips, video URLs and YouTube
// search (yt-dlp, online), the community catalog (online), and .ovsvoice voice packs. Clips become voices of this space
// through the same consent step as cloning; presets and verified packs are adopted directly.
import type { AssetRecord, VoiceProfile } from '@producer/core'
import clsx from 'clsx'
import { AudioLines, Check, Download, FileAudio, Globe, Link2, Mic, Package, Pause, Pencil, Play, Plus, Scissors, Search, Trash2, Upload, Users, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { api } from '../../lib/api'
import { useSession } from '../../lib/session'
import { decodeMono, encodeWav, safeFileName, trimSamples } from '../../lib/storyStems'
import { toast, toastError } from '../../lib/toast'
import { useVoicesVersion } from '../components/VoiceCard'
import { EmptyState, Modal, Spinner, useAsync, useAudioPreview } from '../ui'
import { formatDuration, relativeTime } from '../util'
import { ConsentFields, DesktopOnly, EngineGate, consentPayload, consentReady, useEngine, useTtsEngines, type ConsentState } from './shared'
import { vsApi, vsFetch, vsGet, vsUrl } from './vsApi'

interface GalleryVoice {
  id: string
  name: string
  character?: string
  category?: string
  source_type?: 'youtube' | 'upload'
  source_url?: string | null
  duration?: number
  description?: string
  tags?: string[]
  created_at: number
}

interface CommunityItem {
  id: string
  name: string
  type: 'preset' | 'voice'
  use_case?: string
  language?: string
  facets?: { gender?: string; age?: string; accent?: string }
  icon?: string
  _source_repo?: string
}

type View = 'clips' | 'community' | 'packs'

export default function Gallery({ onOpenEngine }: { onOpenEngine: () => void }) {
  const { desktop, status, running } = useEngine()
  if (!desktop) return <DesktopOnly feature="The voice gallery" />
  return (
    <EngineGate status={status} onOpenEngine={onOpenEngine}>
      {running && <GalleryHome />}
    </EngineGate>
  )
}

function GalleryHome() {
  const [view, setView] = useState<View>('clips')
  return (
    <div>
      <div className="ps-seg" style={{ marginBottom: 16 }}>
        <button className={view === 'clips' ? 'on' : ''} onClick={() => setView('clips')}><FileAudio size={14} /> My clips</button>
        <button className={view === 'community' ? 'on' : ''} onClick={() => setView('community')}><Globe size={14} /> Community</button>
        <button className={view === 'packs' ? 'on' : ''} onClick={() => setView('packs')}><Package size={14} /> Voice packs</button>
      </div>
      {view === 'clips' && <Clips />}
      {view === 'community' && <Community />}
      {view === 'packs' && <Packs />}
    </div>
  )
}

// ---------------- my clips ----------------

/** Consent starts blank for every voice: never the previous voice's speaker or tick. */
const freshConsent = (speaker = ''): ConsentState => ({ whose: 'other', speaker, agreed: false })

function Clips() {
  const [q, setQ] = useState('')
  const [debounced, setDebounced] = useState('')
  const [importing, setImporting] = useState<'file' | 'url' | 'search' | 'library'>()
  const [trimming, setTrimming] = useState<GalleryVoice>()
  const [making, setMaking] = useState<GalleryVoice>()
  const [renaming, setRenaming] = useState<GalleryVoice>()
  const [deleting, setDeleting] = useState<GalleryVoice>()
  const [deleteBusy, setDeleteBusy] = useState(false)
  const playing = useAudioPreview((s) => s.playing)
  const loadingKey = useAudioPreview((s) => s.loading)
  const toggle = useAudioPreview((s) => s.toggle)
  useEffect(() => {
    const t = setTimeout(() => setDebounced(q.trim()), 250)
    return () => clearTimeout(t)
  }, [q])
  const list = useAsync(() => vsGet<GalleryVoice[]>('/gallery/voices', { query: { search: debounced || undefined, limit: 200 } }), [debounced])

  const remove = async (v: GalleryVoice) => {
    setDeleteBusy(true)
    try {
      await vsFetch(`/gallery/voices/${v.id}`, { method: 'DELETE' })
      list.setData((cur) => (cur ?? []).filter((x) => x.id !== v.id))
      setDeleting(undefined)
    } catch (e) {
      toastError(e)
    } finally {
      setDeleteBusy(false)
    }
  }

  return (
    <div>
      <div className="row" style={{ gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
        <div style={{ position: 'relative', flex: 1, minWidth: 200 }}>
          <Search size={14} style={{ position: 'absolute', left: 11, top: 11, color: 'var(--text-3)' }} />
          <input className="input" style={{ paddingLeft: 32 }} placeholder="Search clips" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <button className="btn sm" onClick={() => setImporting('file')}><Upload size={13} /> Upload</button>
        <button className="btn sm" onClick={() => setImporting('library')}><FileAudio size={13} /> From library</button>
        <button className="btn sm" onClick={() => setImporting('url')}><Link2 size={13} /> From a video link</button>
        <button className="btn sm" onClick={() => setImporting('search')}><Search size={13} /> Search YouTube</button>
      </div>
      <p className="muted" style={{ fontSize: '0.8125rem', margin: '0 0 12px' }}>
        Collect reference clips here, trim them to the cleanest 5–30 seconds, then turn the best into voices. Clips stay on this computer.
      </p>
      {list.loading && !list.data ? (
        <Spinner />
      ) : !list.data?.length ? (
        <EmptyState icon={<FileAudio size={24} />} title={debounced ? 'No clips match' : 'No clips yet'} body="Import a recording, a library clip, or a short section of an online video." />
      ) : (
        <div className="vs-engine-list">
          {list.data.map((v) => {
            const key = `gal:${v.id}`
            return (
              <div key={v.id} className="vs-engine-row">
                <button className="btn ghost icon sm" onClick={() => toggle(key, vsUrl(`/gallery/voices/${v.id}/preview`))} aria-label={`Play ${v.name}`}>
                  {loadingKey === key ? <Spinner size={12} /> : playing === key ? <Pause size={13} /> : <Play size={13} />}
                </button>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <strong className="ellipsis">{v.name}</strong>
                  <span className="muted" style={{ fontSize: '0.75rem' }}>
                    {v.duration ? formatDuration(v.duration) : ''} · {v.source_type === 'youtube' ? 'from a video link' : 'uploaded'} · {relativeTime(v.created_at * 1000)}
                  </span>
                </div>
                <button className="btn sm" onClick={() => setMaking(v)}><Mic size={12} /> Make a voice</button>
                <button className="btn ghost sm icon" onClick={() => setTrimming(v)} title="Trim" aria-label={`Trim ${v.name}`}><Scissors size={13} /></button>
                <button className="btn ghost sm icon" onClick={() => setRenaming(v)} title="Rename" aria-label={`Rename ${v.name}`}><Pencil size={13} /></button>
                <button className="btn ghost sm icon" onClick={() => setDeleting(v)} title="Delete" aria-label={`Delete ${v.name}`}><Trash2 size={13} /></button>
              </div>
            )
          })}
        </div>
      )}
      {importing && <ImportClip mode={importing} onClose={() => setImporting(undefined)} onDone={() => list.reload()} />}
      {trimming && <TrimClip clip={trimming} onClose={() => setTrimming(undefined)} onDone={() => list.reload()} />}
      {making && <MakeVoice clip={making} onClose={() => setMaking(undefined)} />}
      {deleting && (
        <Modal
          title={`Delete “${deleting.name}”?`}
          subtitle={`The ${deleting.duration ? `${formatDuration(deleting.duration)} ` : ''}clip is removed from this computer’s gallery. This can’t be undone.`}
          onClose={() => setDeleting(undefined)}
          width={460}
          footer={
            <>
              <button className="btn ghost" autoFocus onClick={() => setDeleting(undefined)}>Cancel</button>
              <button className="btn danger" disabled={deleteBusy} onClick={() => void remove(deleting)}>{deleteBusy && <Spinner size={13} />} Delete clip</button>
            </>
          }
        >
          <span />
        </Modal>
      )}
      {renaming && (
        <RenameClip
          clip={renaming}
          onClose={() => setRenaming(undefined)}
          onDone={(name) => list.setData((cur) => (cur ?? []).map((x) => (x.id === renaming.id ? { ...x, name } : x)))}
        />
      )}
    </div>
  )
}

function RenameClip({ clip, onClose, onDone }: { clip: GalleryVoice; onClose: () => void; onDone: (name: string) => void }) {
  const [name, setName] = useState(clip.name)
  return (
    <Modal title="Rename clip" onClose={onClose} width={440}>
      <form
        onSubmit={async (e) => {
          e.preventDefault()
          try {
            await vsFetch(`/gallery/voices/${clip.id}`, { method: 'PATCH', body: { name: name.trim() } })
            onDone(name.trim())
            onClose()
          } catch (err) {
            toastError(err)
          }
        }}
      >
        <input className="input" autoFocus value={name} onChange={(e) => setName(e.target.value)} maxLength={80} />
        <div className="row" style={{ justifyContent: 'flex-end', marginTop: 14 }}>
          <button type="button" className="btn ghost" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={!name.trim()}>Save</button>
        </div>
      </form>
    </Modal>
  )
}

function ImportClip({ mode, onClose, onDone }: { mode: 'file' | 'url' | 'search' | 'library'; onClose: () => void; onDone: () => void }) {
  const workspaceId = useSession((s) => s.workspaceId)!
  const [name, setName] = useState('')
  const [url, setUrl] = useState('')
  const [start, setStart] = useState(0)
  const [dur, setDur] = useState(15)
  const [q, setQ] = useState('')
  const [results, setResults] = useState<Array<{ title: string; video_id: string; duration?: string | null; thumbnail?: string }>>()
  const [busy, setBusy] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)
  const lib = useAsync(async () => (mode === 'library' ? (await api.assets(workspaceId)).filter((a) => (a.asset.kind === 'audio' || a.asset.kind === 'video') && a.status === 'ready') : []), [workspaceId, mode])

  const done = (label: string) => {
    toast(`Imported “${label}”`)
    onDone()
    onClose()
  }
  const run = async (fn: () => Promise<string>) => {
    setBusy(true)
    try {
      done(await fn())
    } catch (e) {
      toastError(e)
    } finally {
      setBusy(false)
    }
  }
  const upload = (f: File) =>
    run(async () => {
      const form = new FormData()
      form.set('audio', f, f.name)
      form.set('name', name.trim() || f.name.replace(/\.[^.]+$/, ''))
      form.set('category', 'import')
      await vsFetch('/gallery/upload', { body: form })
      return name.trim() || f.name
    })
  const fromUrl = (videoUrl: string, label: string) =>
    run(async () => {
      await vsFetch('/gallery/download', { method: 'POST', query: { video_url: videoUrl, start_time: start, duration: Math.min(30, Math.max(1, dur)), character_name: label, category: 'import' } })
      return label
    })
  const fromAsset = (a: AssetRecord) =>
    run(async () => {
      await vsApi.assetTo('gallery', a.asset.id, { name: name.trim() || a.asset.name.replace(/\.[^.]+$/, ''), category: 'import' })
      return a.asset.name
    })

  const title = { file: 'Upload a clip', url: 'Import from a video link', search: 'Search YouTube', library: 'Import from the library' }[mode]
  return (
    <Modal title={title} subtitle={mode === 'url' || mode === 'search' ? 'Downloads only the section you choose (up to 30 seconds) with yt-dlp. Needs an internet connection.' : undefined} onClose={onClose} width={620}>
      {mode !== 'search' && (
        <>
          <label className="label">Clip name</label>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Maya — interview" maxLength={80} style={{ marginBottom: 12 }} />
        </>
      )}
      {mode === 'file' && (
        <div className="vs-drop" onClick={() => fileRef.current?.click()} onDragOver={(e) => e.preventDefault()} onDrop={(e) => {
          e.preventDefault()
          const f = e.dataTransfer.files[0]
          if (f) void upload(f)
        }}>
          {busy ? <Spinner /> : <Upload size={20} />}
          <span>Drop an audio or video file, or click to choose</span>
          <input ref={fileRef} type="file" accept="audio/*,video/*" hidden onChange={(e) => {
            const f = e.target.files?.[0]
            e.target.value = ''
            if (f) void upload(f)
          }} />
        </div>
      )}
      {mode === 'library' && (
        <div className="vs-lib">
          {lib.loading && !lib.data && <span className="muted"><Spinner size={13} /> Loading…</span>}
          {(lib.data ?? []).map((a) => (
            <button key={a.asset.id} className="vs-lib-row" disabled={busy} onClick={() => void fromAsset(a)}>
              <FileAudio size={14} /> <span className="ellipsis">{a.asset.name}</span>
              <span className="muted">{a.asset.duration ? formatDuration(a.asset.duration) : ''}</span>
            </button>
          ))}
        </div>
      )}
      {(mode === 'url' || mode === 'search') && (
        <div className="vs-form-grid" style={{ marginTop: 0 }}>
          <div>
            <label className="label">Start at (seconds)</label>
            <input className="input" type="number" min={0} value={start} onChange={(e) => setStart(Math.max(0, Number(e.target.value)))} />
          </div>
          <div>
            <label className="label">Length (seconds, max 30)</label>
            <input className="input" type="number" min={1} max={30} value={dur} onChange={(e) => setDur(Number(e.target.value))} />
          </div>
        </div>
      )}
      {mode === 'url' && (
        <form className="row" style={{ gap: 8, marginTop: 12 }} onSubmit={(e) => {
          e.preventDefault()
          if (url.trim()) void fromUrl(url.trim(), name.trim() || 'Imported clip')
        }}>
          <input className="input" placeholder="https://www.youtube.com/watch?v=…" value={url} onChange={(e) => setUrl(e.target.value)} />
          <button className="btn primary" disabled={busy || !/^https?:\/\//.test(url.trim())}>{busy ? <Spinner size={13} /> : <Download size={14} />} Import</button>
        </form>
      )}
      {mode === 'search' && (
        <>
          <form className="row" style={{ gap: 8, marginTop: 12 }} onSubmit={async (e) => {
            e.preventDefault()
            if (!q.trim()) return
            setBusy(true)
            try {
              const r = await vsGet<{ results: typeof results }>('/gallery/search/youtube', { method: 'POST', query: { query: q.trim(), max_results: 10 } })
              setResults(r.results ?? [])
            } catch (err) {
              toastError(err)
            } finally {
              setBusy(false)
            }
          }}>
            <input className="input" placeholder="e.g. documentary narrator interview" value={q} onChange={(e) => setQ(e.target.value)} autoFocus />
            <button className="btn primary" disabled={busy || !q.trim()}>{busy ? <Spinner size={13} /> : <Search size={14} />} Search</button>
          </form>
          {results && (
            <div className="vs-lib" style={{ marginTop: 10 }}>
              {!results.length && <span className="muted">No results.</span>}
              {results.map((r) => (
                <button key={r.video_id} className="vs-lib-row" disabled={busy} onClick={() => void fromUrl(`https://www.youtube.com/watch?v=${r.video_id}`, r.title.slice(0, 80))}>
                  <Plus size={14} /> <span className="ellipsis">{r.title}</span>
                  <span className="muted">{r.duration ?? ''}</span>
                </button>
              ))}
            </div>
          )}
        </>
      )}
    </Modal>
  )
}

/** Trim a clip to its best section in the browser and save it as a new clip. */
function TrimClip({ clip, onClose, onDone }: { clip: GalleryVoice; onClose: () => void; onDone: () => void }) {
  const [samples, setSamples] = useState<Float32Array>()
  const [start, setStart] = useState(0)
  const [end, setEnd] = useState(0)
  const [url, setUrl] = useState<string>()
  const [busy, setBusy] = useState(false)
  const RATE = 24000
  useEffect(() => {
    vsFetch(`/gallery/voices/${clip.id}/preview`)
      .then((r) => r.arrayBuffer())
      .then((b) => decodeMono(b, RATE))
      .then((s) => {
        setSamples(s)
        setEnd(Math.min(30, s.length / RATE))
      })
      .catch(toastError)
  }, [clip.id])
  useEffect(() => {
    if (!samples) return
    const u = URL.createObjectURL(new Blob([encodeWav(trimSamples(samples, RATE, start, end), RATE)], { type: 'audio/wav' }))
    setUrl(u)
    return () => URL.revokeObjectURL(u)
  }, [samples, start, end])
  const total = samples ? samples.length / RATE : 0
  return (
    <Modal title={`Trim “${clip.name}”`} subtitle="Keep one clean stretch of a single speaker; 5–30 seconds is ideal." onClose={onClose} width={560}>
      {!samples ? (
        <Spinner />
      ) : (
        <>
          <div className="vs-form-grid" style={{ marginTop: 0 }}>
            <div>
              <label className="label">Start {start.toFixed(1)}s</label>
              <input type="range" className="ps-range" min={0} max={total} step={0.1} value={start} onChange={(e) => setStart(Math.min(Number(e.target.value), end - 0.5))} />
            </div>
            <div>
              <label className="label">End {end.toFixed(1)}s</label>
              <input type="range" className="ps-range" min={0} max={total} step={0.1} value={end} onChange={(e) => setEnd(Math.max(Number(e.target.value), start + 0.5))} />
            </div>
          </div>
          <div className="muted" style={{ fontSize: '0.75rem', margin: '6px 0' }}>{(end - start).toFixed(1)} s selected of {total.toFixed(1)} s</div>
          {url && <audio src={url} controls style={{ width: '100%' }} />}
          <div className="row" style={{ justifyContent: 'flex-end', marginTop: 14 }}>
            <button className="btn ghost" onClick={onClose}>Cancel</button>
            <button className="btn primary" disabled={busy || end - start < 1} onClick={async () => {
              setBusy(true)
              try {
                const f = new FormData()
                f.set('audio', new Blob([encodeWav(trimSamples(samples, RATE, start, end), RATE)], { type: 'audio/wav' }), `${safeFileName(clip.name)}-trim.wav`)
                f.set('name', `${clip.name} (trimmed)`)
                f.set('character', clip.character ?? '')
                f.set('category', clip.category ?? 'import')
                await vsFetch('/gallery/upload', { body: f })
                toast('Saved the trimmed clip')
                onDone()
                onClose()
              } catch (e) {
                toastError(e)
              } finally {
                setBusy(false)
              }
            }}>{busy ? <Spinner size={13} /> : <Scissors size={13} />} Save trimmed clip</button>
          </div>
        </>
      )}
    </Modal>
  )
}

/** Turn a clip into a cloned voice of this space (consent required). */
function MakeVoice({ clip, onClose }: { clip: GalleryVoice; onClose: () => void }) {
  const workspaceId = useSession((s) => s.workspaceId)!
  const userName = useSession((s) => s.user?.name ?? '')
  const engines = useTtsEngines(true)
  const bump = useVoicesVersion((s) => s.bump)
  const [name, setName] = useState(clip.name.replace(/ \(trimmed\)$/, ''))
  const [consent, setConsent] = useState<ConsentState>({ whose: 'other', speaker: clip.character || '', agreed: false })
  const [busy, setBusy] = useState(false)
  return (
    <Modal title="Make a voice from this clip" subtitle={clip.source_url ? `Source: ${clip.source_url}` : undefined} onClose={onClose} width={580}>
      {(clip.duration ?? 0) > 30 && <div className="ps-alert info" style={{ marginBottom: 12 }}>This clip is {formatDuration(clip.duration)} long. Trim it to one clean 5–30 second stretch first for the best clone.</div>}
      <label className="label">Voice name</label>
      <input className="input" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} />
      <div style={{ marginTop: 12 }}>
        <ConsentFields value={consent} onChange={setConsent} defaultSpeaker={clip.character} />
      </div>
      <div className="row" style={{ justifyContent: 'flex-end', marginTop: 16 }}>
        <button className="btn ghost" onClick={onClose}>Cancel</button>
        <button className="btn primary" disabled={busy || !name.trim() || !consentReady(consent)} onClick={async () => {
          setBusy(true)
          try {
            const r = await vsGet<{ profile_id: string; name: string }>(`/gallery/voices/${clip.id}/save-as-profile`, { method: 'POST', query: { profile_name: name.trim() } })
            const v: VoiceProfile = await vsApi.adoptVoice({ workspaceId, vsProfileId: r.profile_id, name: name.trim(), kind: 'clone', engine: engines.data?.active ?? 'omnivoice', description: clip.source_url ? `From ${clip.source_url}` : undefined, consent: consentPayload(consent, userName) })
            bump()
            toast(`“${v.name}” added to My voices`)
            onClose()
          } catch (e) {
            toastError(e)
          } finally {
            setBusy(false)
          }
        }}>{busy ? <Spinner size={13} /> : <Mic size={13} />} Make voice</button>
      </div>
    </Modal>
  )
}

// ---------------- community ----------------

function Community() {
  const workspaceId = useSession((s) => s.workspaceId)!
  const userName = useSession((s) => s.user?.name ?? '')
  const engines = useTtsEngines(true)
  const bump = useVoicesVersion((s) => s.bump)
  const [q, setQ] = useState('')
  const [type, setType] = useState<'' | 'preset' | 'voice'>('')
  const [debounced, setDebounced] = useState('')
  const [adding, setAdding] = useState<CommunityItem>()
  const [consent, setConsent] = useState<ConsentState>(freshConsent)
  const openAdding = (it: CommunityItem) => {
    setConsent(freshConsent(it.name))
    setAdding(it)
  }
  const [busy, setBusy] = useState<string>()
  const playing = useAudioPreview((s) => s.playing)
  const loadingKey = useAudioPreview((s) => s.loading)
  const toggle = useAudioPreview((s) => s.toggle)
  useEffect(() => {
    const t = setTimeout(() => setDebounced(q.trim()), 250)
    return () => clearTimeout(t)
  }, [q])
  const items = useAsync(() => vsGet<{ total: number; items: CommunityItem[]; offline?: boolean }>('/community/items', { query: { q: debounced || undefined, type: type || undefined, limit: 120 } }), [debounced, type])

  const add = async (it: CommunityItem, withConsent: boolean) => {
    setBusy(it.id)
    try {
      const r = await vsGet<{ profile_id: string; name: string }>(`/community/items/${encodeURIComponent(it.id)}/use`, { method: 'POST', query: { name: it.name } })
      await vsApi.adoptVoice({
        workspaceId,
        vsProfileId: r.profile_id,
        name: it.name,
        kind: it.type === 'voice' ? 'clone' : 'design',
        engine: engines.data?.active ?? 'omnivoice',
        language: it.language,
        description: [it.use_case, it._source_repo && `community: ${it._source_repo}`].filter(Boolean).join(' — '),
        consent: withConsent ? consentPayload(consent, userName) : { agreed: true, speaker: 'preset', statement: `Community preset “${it.name}”; designed, not based on a recording of a real person.` },
      })
      bump()
      toast(`“${it.name}” added to My voices`)
      setAdding(undefined)
    } catch (e) {
      toastError(e)
    } finally {
      setBusy(undefined)
    }
  }

  return (
    <div>
      <div className="row" style={{ gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
        <div style={{ position: 'relative', flex: 1, minWidth: 200 }}>
          <Search size={14} style={{ position: 'absolute', left: 11, top: 11, color: 'var(--text-3)' }} />
          <input className="input" style={{ paddingLeft: 32 }} placeholder="Search community voices" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <div className="ps-seg">
          <button className={type === '' ? 'on' : ''} onClick={() => setType('')}>All</button>
          <button className={type === 'preset' ? 'on' : ''} onClick={() => setType('preset')}>Designed presets</button>
          <button className={type === 'voice' ? 'on' : ''} onClick={() => setType('voice')}>Recorded voices</button>
        </div>
      </div>
      {items.data?.offline && <div className="ps-alert info" style={{ marginBottom: 12 }}>Offline — showing the last downloaded catalog.</div>}
      {items.loading && !items.data ? (
        <Spinner />
      ) : items.error ? (
        <div className="ps-alert">Couldn’t load the community catalog (it needs an internet connection the first time). <button className="btn sm" onClick={items.reload}>Retry</button></div>
      ) : !items.data?.items.length ? (
        <EmptyState icon={<Users size={24} />} title="Nothing here" body="No community voices match." />
      ) : (
        <div className="vs-presets">
          {items.data.items.map((it) => {
            const key = `com:${it.id}`
            return (
              <div key={it.id} className="vs-preset">
                <div className="row" style={{ gap: 6 }}>
                  <strong className="ellipsis" style={{ flex: 1 }}>{it.icon ? `${it.icon} ` : ''}{it.name}</strong>
                  <button className="btn ghost icon sm" aria-label={`Preview ${it.name}`} onClick={() => toggle(key, vsUrl(`/community/items/${encodeURIComponent(it.id)}/preview?local=true`))}>
                    {loadingKey === key ? <Spinner size={12} /> : playing === key ? <Pause size={13} /> : <Play size={13} />}
                  </button>
                </div>
                <span className="muted" style={{ fontSize: '0.7188rem' }}>{[it.type === 'voice' ? 'Recorded voice' : 'Designed preset', it.use_case, it.facets?.gender, it.language].filter(Boolean).join(' · ')}</span>
                <button className="btn sm" style={{ marginTop: 6 }} disabled={!!busy} onClick={() => (it.type === 'voice' ? openAdding(it) : void add(it, false))}>
                  {busy === it.id ? <Spinner size={12} /> : <Plus size={13} />} Add to my voices
                </button>
              </div>
            )
          })}
        </div>
      )}
      {adding && (
        <Modal title={`Add “${adding.name}”`} subtitle="This is a recording of a real person shared by the community. Only use it with the speaker’s permission." onClose={() => setAdding(undefined)} width={560}>
          <ConsentFields value={consent} onChange={setConsent} defaultSpeaker={adding.name} />
          <div className="row" style={{ justifyContent: 'flex-end', marginTop: 16 }}>
            <button className="btn ghost" onClick={() => setAdding(undefined)}>Cancel</button>
            <button className="btn primary" disabled={!!busy || !consentReady(consent)} onClick={() => void add(adding, true)}>{busy ? <Spinner size={13} /> : <Check size={13} />} Add voice</button>
          </div>
        </Modal>
      )}
    </div>
  )
}

// ---------------- voice packs (.ovsvoice) ----------------

interface PackInfo {
  name: string
  kind?: string
  language?: string
  license_spdx?: string
  preview_only?: boolean
  watermarked_preview?: boolean
  consent?: { verified_claimed?: boolean; would_verify?: boolean; has_recording?: boolean } | null
}

function Packs() {
  const workspaceId = useSession((s) => s.workspaceId)!
  const userName = useSession((s) => s.user?.name ?? '')
  const engines = useTtsEngines(true)
  const bump = useVoicesVersion((s) => s.bump)
  const [file, setFile] = useState<File>()
  const [info, setInfo] = useState<PackInfo>()
  const [consent, setConsent] = useState<ConsentState>(freshConsent)
  const [busy, setBusy] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)
  const verified = !!info?.consent?.would_verify
  const designed = info?.kind === 'design'

  const pick = async (f: File) => {
    setFile(f)
    setInfo(undefined)
    try {
      const form = new FormData()
      form.set('file', f, f.name)
      const i = (await (await vsFetch('/personas/inspect', { body: form })).json()) as PackInfo
      setInfo(i)
      // each pack is its own speaker: the last one's consent never carries over
      setConsent(freshConsent(i.name))
    } catch (e) {
      toastError(e)
      setFile(undefined)
    }
  }

  const doImport = async () => {
    if (!file || !info) return
    setBusy(true)
    try {
      const form = new FormData()
      form.set('file', file, file.name)
      const r = (await (await vsFetch('/personas/import', { body: form })).json()) as { profile_id: string; name: string; kind: string; verified_own_voice: boolean }
      await vsApi.adoptVoice({
        workspaceId,
        vsProfileId: r.profile_id,
        name: r.name,
        kind: r.kind === 'design' ? 'design' : 'clone',
        engine: engines.data?.active ?? 'omnivoice',
        language: info.language,
        description: `Imported voice pack ${file.name}${info.license_spdx ? ` · licence ${info.license_spdx}` : ''}`,
        consent: designed
          ? { agreed: true, speaker: 'designed', statement: `Designed voice from pack ${file.name}; not based on a recording of a real person.` }
          : verified && !consent.agreed
            ? { agreed: true, speaker: info.name, statement: `Voice pack ${file.name} carries a recorded consent statement from the speaker (verified by VoiceStudio).` }
            : consentPayload(consent, userName),
      })
      bump()
      toast(`“${r.name}” added to My voices`)
      setFile(undefined)
      setInfo(undefined)
    } catch (e) {
      toastError(e)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div>
      <p className="muted" style={{ fontSize: '0.8125rem', marginTop: 0 }}>
        Voice packs (<code>.ovsvoice</code>) carry a voice made in VoiceStudio — its reference audio, settings and, if recorded, the speaker’s consent. Export your own from My voices.
      </p>
      <div className="vs-drop" onClick={() => fileRef.current?.click()} onDragOver={(e) => e.preventDefault()} onDrop={(e) => {
        e.preventDefault()
        const f = e.dataTransfer.files[0]
        if (f) void pick(f)
      }}>
        <Package size={20} />
        <span>{file ? file.name : 'Drop a .ovsvoice file, or click to choose'}</span>
        <input ref={fileRef} type="file" accept=".ovsvoice,.omnivoice" hidden onChange={(e) => {
          const f = e.target.files?.[0]
          e.target.value = ''
          if (f) void pick(f)
        }} />
      </div>
      {file && !info && <div className="muted" style={{ marginTop: 10 }}><Spinner size={13} /> Reading the pack…</div>}
      {info && (
        <div className="vs-panel" style={{ marginTop: 14 }}>
          <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
            <strong>{info.name}</strong>
            <span className="vs-chip">{designed ? 'Designed' : 'Cloned'}</span>
            {info.language && <span className="vs-chip muted">{info.language}</span>}
            {info.license_spdx && <span className="vs-chip muted">Licence: {info.license_spdx}</span>}
            {!designed && <span className={clsx('vs-chip', verified ? 'ok' : 'warn')}>{verified ? 'Speaker consent recorded in the pack' : 'No verified consent'}</span>}
            {info.preview_only && <span className="vs-chip warn">Preview audio only (lower quality)</span>}
          </div>
          {!designed && !verified && (
            <div style={{ marginTop: 12 }}>
              <ConsentFields value={consent} onChange={setConsent} defaultSpeaker={info.name} />
            </div>
          )}
          <div className="row" style={{ justifyContent: 'flex-end', marginTop: 14 }}>
            <button className="btn ghost" onClick={() => (setFile(undefined), setInfo(undefined))}><X size={13} /> Cancel</button>
            <button className="btn primary" disabled={busy || (!designed && !verified && !consentReady(consent))} onClick={doImport}>{busy ? <Spinner size={13} /> : <AudioLines size={13} />} Import voice</button>
          </div>
        </div>
      )}
    </div>
  )
}
