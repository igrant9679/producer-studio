// My voices: VoiceStudio voice profiles of this space (cloned and designed). Desktop: clone from a recording / file /
// library clip with a consent record, design from a description, browse preset voices. Web: list, rename, delete, use.
import type { AssetRecord, VoiceProfile } from '@producer/core'
import clsx from 'clsx'
import { AudioLines, Check, Circle, FileAudio, Library, Mic, MoreHorizontal, Package, Pencil, Play, Plus, RefreshCw, ShieldCheck, Square, Trash2, Upload, Wand2 } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { api, mediaUrl } from '../../lib/api'
import { useSession } from '../../lib/session'
import { toast, toastError } from '../../lib/toast'
import { PlaySample, useVoicesVersion } from '../components/VoiceCard'
import { EmptyState, MenuList, Modal, Popover, Spinner, useAsync, useAudioPreview } from '../ui'
import { relativeTime } from '../util'
import { DesktopOnly, EngineGate, LANGUAGES, LicenseChip, canDesign, engineName, saveBlob, useEngine, useElapsed, useTtsEngines, type TtsBackend } from './shared'
import { PresetVoices } from './PresetVoices'
import { vsApi, vsFetch } from './vsApi'

export function MyVoices({ onUse, onOpenEngine }: { onUse: (voiceId: string) => void; onOpenEngine: () => void }) {
  const workspaceId = useSession((s) => s.workspaceId)
  const { desktop, status, running } = useEngine()
  const list = useAsync(() => (workspaceId ? vsApi.profiles(workspaceId) : Promise.resolve([] as VoiceProfile[])), [workspaceId])
  const [modal, setModal] = useState<'clone' | 'design' | 'presets'>()
  const [editing, setEditing] = useState<VoiceProfile>()
  const [deleting, setDeleting] = useState<VoiceProfile>()
  const [deleteBusy, setDeleteBusy] = useState(false)

  const bump = useVoicesVersion((s) => s.bump)
  const added = (v: VoiceProfile) => {
    list.setData((cur) => [...(cur ?? []).filter((x) => x.id !== v.id), v])
    bump()
    setModal(undefined)
    toast(`“${v.name}” is ready — find it under My voices in every voice picker`)
  }

  return (
    <div>
      <div className="ps-section-head" style={{ marginBottom: 14 }}>
        <h2 className="ps-h2">My voices</h2>
        <span className="muted" style={{ fontSize: '0.8125rem' }}>{list.data ? `${list.data.length} in this space` : ''}</span>
        <span className="spacer" />
        {desktop && (
          <>
            <button className="btn sm" onClick={() => setModal('presets')} disabled={!running}><Library size={14} /> Preset voices</button>
            <button className="btn sm" onClick={() => setModal('design')} disabled={!running}><Wand2 size={14} /> Design a voice</button>
            <button className="btn primary sm" onClick={() => setModal('clone')} disabled={!running}><Plus size={14} /> Clone a voice</button>
          </>
        )}
      </div>

      {desktop ? (
        !running && <EngineGate status={status} onOpenEngine={onOpenEngine}>{null}</EngineGate>
      ) : (
        <DesktopOnly feature="Voice cloning" />
      )}

      {list.loading && !list.data ? (
        <div className="vs-voice-grid">{[0, 1, 2].map((i) => <div key={i} className="skeleton" style={{ height: 112, borderRadius: 14 }} />)}</div>
      ) : list.data?.length ? (
        <div className="vs-voice-grid" style={{ marginTop: 14 }}>
          {list.data.map((v) => (
            <ProfileCard key={v.id} v={v} desktop={desktop} onUse={() => onUse(`vs:${v.id}`)} onRename={() => setEditing(v)} onDelete={() => setDeleting(v)} />
          ))}
        </div>
      ) : (
        <div style={{ marginTop: 14 }}>
          <EmptyState
            icon={<AudioLines size={24} />}
            title="No custom voices yet"
            body={desktop ? 'Clone your own voice from a short recording, design one from a description, or start from a preset.' : 'Voices you clone or design in Producer Studio for desktop appear here.'}
          />
        </div>
      )}

      {modal === 'clone' && <CloneVoiceModal onClose={() => setModal(undefined)} onCreated={added} />}
      {modal === 'design' && <DesignVoiceModal onClose={() => setModal(undefined)} onCreated={added} />}
      {modal === 'presets' && <PresetVoices onClose={() => setModal(undefined)} onCreated={added} />}
      {editing && (
        <RenameVoiceModal
          v={editing}
          onClose={() => setEditing(undefined)}
          onSaved={(n) => {
            list.setData((cur) => (cur ?? []).map((x) => (x.id === n.id ? n : x)))
            bump()
            setEditing(undefined)
          }}
        />
      )}
      {deleting && (
        <Modal
          title={`Delete “${deleting.name}”?`}
          subtitle="The voice is removed from this space on every device. Voiceovers already generated with it stay in the library."
          onClose={() => setDeleting(undefined)}
          width={480}
          footer={
            <>
              <button className="btn ghost" autoFocus onClick={() => setDeleting(undefined)}>Cancel</button>
              <button
                className="btn danger"
                // one delete at a time: a second click while it's on its way does nothing
                disabled={deleteBusy}
                onClick={async () => {
                  setDeleteBusy(true)
                  try {
                    await vsApi.deleteProfile(deleting.id)
                    list.setData((cur) => (cur ?? []).filter((x) => x.id !== deleting.id))
                    bump()
                    toast(`Deleted “${deleting.name}”`)
                  } catch (e) {
                    toastError(e)
                  } finally {
                    setDeleteBusy(false)
                  }
                  setDeleting(undefined)
                }}
              >
                {deleteBusy ? <Spinner size={14} /> : <Trash2 size={14} />} Delete voice
              </button>
            </>
          }
        >
          {deleting.kind === 'clone' && <p className="muted" style={{ margin: 0 }}>The reference recording is deleted from VoiceStudio on the computer that holds it.</p>}
        </Modal>
      )}
    </div>
  )
}

async function exportPack(v: VoiceProfile) {
  try {
    const res = await vsFetch(`/personas/export/${encodeURIComponent(v.vsProfileId!)}`, { method: 'POST', query: { include_reference: true } })
    saveBlob(await res.blob(), `${v.name.replace(/[^\w .-]+/g, '_')}.ovsvoice`)
  } catch (e) {
    toastError(e)
  }
}

function ProfileCard({ v, desktop, onUse, onRename, onDelete }: { v: VoiceProfile; desktop: boolean; onUse: () => void; onRename: () => void; onDelete: () => void }) {
  return (
    <div className="vs-voice-card">
      <div className="row" style={{ gap: 10 }}>
        <span className={clsx('vs-voice-av', v.kind)}>{v.name.slice(0, 1).toUpperCase()}</span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <strong className="ellipsis">{v.name}</strong>
          <span className="muted" style={{ fontSize: '0.75rem' }}>
            {v.kind === 'design' ? 'Designed' : 'Cloned'} · {v.language || 'Any language'} · {v.engine || 'default engine'}
          </span>
        </div>
        {desktop && v.local && <PlaySample voiceId={`vs:${v.id}`} />}
        <Popover align="right" trigger={({ toggle }) => <button className="btn ghost icon sm" onClick={toggle} aria-label="Voice actions"><MoreHorizontal size={15} /></button>}>
          {(close) => (
            <MenuList
              close={close}
              items={[
                { label: 'Use for a voiceover', icon: <AudioLines size={14} />, onClick: onUse },
                { label: 'Rename', icon: <Pencil size={14} />, onClick: onRename },
                ...(desktop && v.local && v.vsProfileId ? [{ label: 'Export voice pack', icon: <Package size={14} />, onClick: () => void exportPack(v) }] : []),
                { label: 'Delete', icon: <Trash2 size={14} />, danger: true, onClick: onDelete },
              ]}
            />
          )}
        </Popover>
      </div>
      <div className="row" style={{ gap: 6, flexWrap: 'wrap', marginTop: 10 }}>
        {v.engine && <LicenseChip engine={v.engine} />}
        <span className="vs-chip" title={`${v.consent.statement}\n— recorded ${new Date(v.consent.attestedAt).toLocaleString()}`}>
          <ShieldCheck size={11} /> Consent recorded
        </span>
        {!v.local && desktop && <span className="vs-chip muted">On another computer</span>}
      </div>
      {v.description && <p className="vs-voice-desc">{v.description}</p>}
      <div className="row" style={{ marginTop: 'auto', paddingTop: 10 }}>
        <span className="muted" style={{ fontSize: '0.7188rem' }}>Added {relativeTime(v.createdAt)}</span>
        <span className="spacer" />
        <button className="btn sm" onClick={onUse}><AudioLines size={13} /> Use</button>
      </div>
    </div>
  )
}

function RenameVoiceModal({ v, onClose, onSaved }: { v: VoiceProfile; onClose: () => void; onSaved: (v: VoiceProfile) => void }) {
  const [name, setName] = useState(v.name)
  const [desc, setDesc] = useState(v.description ?? '')
  const [busy, setBusy] = useState(false)
  return (
    <Modal title="Edit voice" onClose={onClose} width={480}>
      <form
        onSubmit={async (e) => {
          e.preventDefault()
          if (!name.trim()) return
          setBusy(true)
          try {
            onSaved(await vsApi.updateProfile(v.id, { name: name.trim(), description: desc.trim() }))
          } catch (err) {
            toastError(err)
          } finally {
            setBusy(false)
          }
        }}
      >
        <label className="label" htmlFor="vp-name">Name</label>
        <input id="vp-name" className="input" autoFocus value={name} onChange={(e) => setName(e.target.value)} maxLength={80} />
        <label className="label" htmlFor="vp-desc" style={{ marginTop: 12 }}>Notes</label>
        <textarea id="vp-desc" className="input" rows={3} value={desc} onChange={(e) => setDesc(e.target.value)} maxLength={2000} />
        <div className="row" style={{ justifyContent: 'flex-end', marginTop: 18 }}>
          <button type="button" className="btn ghost" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={busy || !name.trim()}>{busy && <Spinner />} Save</button>
        </div>
      </form>
    </Modal>
  )
}

// ---------------- clone ----------------

type Source = { blob: Blob; filename: string; label: string; url: string }

function useRecorder() {
  const [recording, setRecording] = useState(false)
  const [level, setLevel] = useState(0)
  const rec = useRef<{ mr: MediaRecorder; stream: MediaStream; ctx: AudioContext; raf: number; chunks: Blob[] }>()
  const elapsed = useElapsed(recording)
  async function start() {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: true, autoGainControl: true }, video: false })
    const ctx = new AudioContext()
    const an = ctx.createAnalyser()
    an.fftSize = 1024
    ctx.createMediaStreamSource(stream).connect(an)
    const buf = new Float32Array(an.fftSize)
    const tick = () => {
      an.getFloatTimeDomainData(buf)
      let sum = 0
      for (const x of buf) sum += x * x
      setLevel(Math.min(1, Math.sqrt(sum / buf.length) * 4))
      if (rec.current) rec.current.raf = requestAnimationFrame(tick)
    }
    const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : ''
    const mr = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined)
    const chunks: Blob[] = []
    mr.ondataavailable = (e) => e.data.size && chunks.push(e.data)
    rec.current = { mr, stream, ctx, raf: requestAnimationFrame(tick), chunks }
    mr.start(250)
    setRecording(true)
  }
  function stop(): Promise<Blob | undefined> {
    const r = rec.current
    if (!r) return Promise.resolve(undefined)
    return new Promise((resolve) => {
      r.mr.onstop = () => {
        cancelAnimationFrame(r.raf)
        r.stream.getTracks().forEach((t) => t.stop())
        void r.ctx.close()
        rec.current = undefined
        setRecording(false)
        setLevel(0)
        resolve(new Blob(r.chunks, { type: r.mr.mimeType || 'audio/webm' }))
      }
      r.mr.stop()
    })
  }
  useEffect(() => () => void stop(), [])
  return { recording, level, elapsed, start, stop }
}

const READ_ALOUD =
  'The quick brown fox jumps over the lazy dog. I’m recording this sample so Producer Studio can learn how I sound — my pace, my tone, and the way I say everyday words. Sunday mornings are for long walks, strong coffee, and good conversations.'

function CloneVoiceModal({ onClose, onCreated }: { onClose: () => void; onCreated: (v: VoiceProfile) => void }) {
  const workspaceId = useSession((s) => s.workspaceId)!
  const userName = useSession((s) => s.user?.name ?? '')
  const engines = useTtsEngines(true)
  const [src, setSrc] = useState<Source>()
  const [mode, setMode] = useState<'record' | 'upload' | 'library'>('record')
  const [name, setName] = useState('')
  const [language, setLanguage] = useState('English')
  const [refText, setRefText] = useState('')
  const [engine, setEngine] = useState('')
  const [whose, setWhose] = useState<'me' | 'other'>('me')
  const [speaker, setSpeaker] = useState('')
  const [agreed, setAgreed] = useState(false)
  const [busy, setBusy] = useState(false)
  const recorder = useRecorder()
  const fileRef = useRef<HTMLInputElement>(null)
  const cloning = useMemo(() => (engines.data?.backends ?? []).filter((b) => b.supports_cloning !== false && b.available !== false), [engines.data])
  useEffect(() => {
    if (!engine && engines.data) setEngine(cloning.some((b) => b.id === engines.data!.active) ? engines.data.active : (cloning[0]?.id ?? engines.data.active))
  }, [engines.data, cloning, engine])
  useEffect(() => () => {
    if (src) URL.revokeObjectURL(src.url)
  }, [src])

  const speakerName = whose === 'me' ? userName || 'me' : speaker.trim()
  const statement =
    whose === 'me'
      ? `I, ${speakerName}, am the person speaking in this recording and I consent to Producer Studio cloning my voice. I will not use it to deceive or impersonate anyone.`
      : `I have ${speakerName || 'the speaker'}’s explicit permission to clone their voice from this recording for use in our videos, and I will not use it to deceive or impersonate anyone.`
  const ready = !!src && !!name.trim() && agreed && (whose === 'me' || !!speaker.trim())

  async function create() {
    if (!src || !ready) return
    setBusy(true)
    try {
      const v = await vsApi.createVoice({
        workspaceId,
        name: name.trim(),
        kind: 'clone',
        engine,
        language,
        refText: refText.trim() || undefined,
        audio: new File([src.blob], src.filename, { type: src.blob.type || 'audio/wav' }),
        consent: JSON.stringify({ agreed: true, speaker: whose === 'me' ? 'me' : speakerName, statement }),
      })
      onCreated(v)
    } catch (e) {
      toastError(e)
    } finally {
      setBusy(false)
    }
  }

  const setBlob = (blob: Blob, filename: string, label: string) => setSrc({ blob, filename, label, url: URL.createObjectURL(blob) })

  return (
    <Modal title="Clone a voice" subtitle="10–30 seconds of clean speech in a quiet room works best. No music or other voices." onClose={onClose} width={720}>
      <div className="ps-seg" style={{ marginBottom: 14 }}>
        <button className={mode === 'record' ? 'on' : ''} onClick={() => setMode('record')}><Mic size={14} /> Record</button>
        <button className={mode === 'upload' ? 'on' : ''} onClick={() => setMode('upload')}><Upload size={14} /> Upload a file</button>
        <button className={mode === 'library' ? 'on' : ''} onClick={() => setMode('library')}><FileAudio size={14} /> From the library</button>
      </div>

      {mode === 'record' && (
        <div className="vs-rec">
          <p className="vs-read-aloud"><span className="muted">Read this aloud:</span> {READ_ALOUD}</p>
          <div className="row" style={{ gap: 12 }}>
            {recorder.recording ? (
              <button
                className="btn danger"
                onClick={async () => {
                  const b = await recorder.stop()
                  if (b && b.size > 2000) setBlob(b, 'recording.webm', `Recording · ${recorder.elapsed || ''}s`)
                }}
              >
                <Square size={14} /> Stop · {recorder.elapsed}s
              </button>
            ) : (
              <button className="btn primary" onClick={() => recorder.start().catch((e) => toastError(new Error(`Microphone unavailable: ${e instanceof Error ? e.message : e}`)))}>
                <Circle size={14} fill="currentColor" /> {src ? 'Record again' : 'Start recording'}
              </button>
            )}
            <div className="vs-meter" aria-hidden><i style={{ width: `${Math.round(recorder.level * 100)}%` }} /></div>
          </div>
          {recorder.recording && recorder.elapsed > 0 && recorder.elapsed < 8 && <div className="muted" style={{ fontSize: '0.75rem', marginTop: 6 }}>Keep going — at least 10 seconds.</div>}
        </div>
      )}
      {mode === 'upload' && (
        <div className="vs-drop" onClick={() => fileRef.current?.click()} onDragOver={(e) => e.preventDefault()} onDrop={(e) => {
          e.preventDefault()
          const f = e.dataTransfer.files[0]
          if (f) setBlob(f, f.name, f.name)
        }}>
          <Upload size={20} />
          <span>Drop an audio or video file, or click to choose (WAV, MP3, M4A, WebM, MP4…)</span>
          <input ref={fileRef} type="file" accept="audio/*,video/*" hidden onChange={(e) => {
            const f = e.target.files?.[0]
            if (f) setBlob(f, f.name, f.name)
            e.target.value = ''
          }} />
        </div>
      )}
      {mode === 'library' && <LibraryPicker workspaceId={workspaceId} onPick={(blob, a) => setBlob(blob, `${a.asset.name.replace(/[^\w.-]+/g, '_')}.audio`, a.asset.name)} />}

      {src && (
        <div className="vs-src">
          <Check size={14} style={{ color: 'var(--green, #2f9e44)' }} /> <span className="ellipsis">{src.label}</span>
          <audio src={src.url} controls style={{ height: 32, marginLeft: 'auto' }} />
        </div>
      )}

      <div className="vs-form-grid">
        <div>
          <label className="label" htmlFor="cv-name">Voice name</label>
          <input id="cv-name" className="input" placeholder={whose === 'me' ? `${userName.split(' ')[0] || 'My'} voice` : 'e.g. Maya — narrator'} value={name} onChange={(e) => setName(e.target.value)} maxLength={80} />
        </div>
        <div>
          <label className="label" htmlFor="cv-lang">Language</label>
          <select id="cv-lang" className="input" value={language} onChange={(e) => setLanguage(e.target.value)}>
            {LANGUAGES.map((l) => <option key={l}>{l}</option>)}
          </select>
        </div>
        <div style={{ gridColumn: '1 / -1' }}>
          <label className="label" htmlFor="cv-engine">Engine</label>
          <select id="cv-engine" className="input" value={engine} onChange={(e) => setEngine(e.target.value)} disabled={!cloning.length}>
            {cloning.map((b: TtsBackend) => <option key={b.id} value={b.id}>{engineName(b)}{b.id === engines.data?.active ? ' (default)' : ''}</option>)}
          </select>
          {engine && <div style={{ marginTop: 6 }}><LicenseChip engine={engine} /></div>}
        </div>
        <div style={{ gridColumn: '1 / -1' }}>
          <label className="label" htmlFor="cv-text">What’s said in the recording <span className="muted">(optional — left blank, VoiceStudio transcribes it)</span></label>
          <textarea id="cv-text" className="input" rows={2} value={refText} onChange={(e) => setRefText(e.target.value)} placeholder={mode === 'record' ? READ_ALOUD.slice(0, 80) + '…' : ''} />
          {mode === 'record' && !refText && src && <button className="btn ghost sm" style={{ marginTop: 4 }} onClick={() => setRefText(READ_ALOUD)}>I read the sample text exactly</button>}
        </div>
      </div>

      <div className="vs-consent">
        <strong><ShieldCheck size={15} /> Consent</strong>
        <div className="ps-seg" style={{ margin: '8px 0' }}>
          <button className={whose === 'me' ? 'on' : ''} onClick={() => setWhose('me')}>It’s my voice</button>
          <button className={whose === 'other' ? 'on' : ''} onClick={() => setWhose('other')}>Someone else’s (with permission)</button>
        </div>
        {whose === 'other' && <input className="input" placeholder="Speaker’s full name" value={speaker} onChange={(e) => setSpeaker(e.target.value)} maxLength={120} style={{ marginBottom: 8 }} />}
        <label className="vs-check">
          <input type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} />
          <span>{statement}</span>
        </label>
        <span className="muted" style={{ fontSize: '0.7188rem' }}>This statement is saved with the voice, with your name and the date.</span>
      </div>

      <div className="row" style={{ justifyContent: 'flex-end', marginTop: 16 }}>
        <button className="btn ghost" onClick={onClose}>Cancel</button>
        <button className="btn primary" disabled={!ready || busy} onClick={create}>{busy ? <><Spinner /> Cloning — the first one can take a minute…</> : <><Mic size={14} /> Clone voice</>}</button>
      </div>
    </Modal>
  )
}

function LibraryPicker({ workspaceId, onPick }: { workspaceId: string; onPick: (blob: Blob, a: AssetRecord) => void }) {
  const list = useAsync(async () => (await api.assets(workspaceId)).filter((a) => (a.asset.kind === 'audio' || a.asset.kind === 'video') && a.status === 'ready'), [workspaceId])
  const [busy, setBusy] = useState<string>()
  if (list.loading && !list.data) return <div className="muted"><Spinner size={13} /> Loading the library…</div>
  if (!list.data?.length) return <div className="muted">No audio or video in this space’s library yet.</div>
  return (
    <div className="vs-lib">
      {list.data.slice(0, 60).map((a) => (
        <button
          key={a.asset.id}
          className="vs-lib-row"
          disabled={!!busy}
          onClick={async () => {
            setBusy(a.asset.id)
            try {
              // the extracted audio track when there is one (smaller than the video)
              let res = await fetch(mediaUrl(a.asset.id, 'audio'), { credentials: 'include' })
              if (!res.ok) res = await fetch(mediaUrl(a.asset.id, 'source'), { credentials: 'include' })
              if (!res.ok) throw new Error(`Couldn’t read ${a.asset.name}`)
              onPick(await res.blob(), a)
            } catch (e) {
              toastError(e)
            } finally {
              setBusy(undefined)
            }
          }}
        >
          {busy === a.asset.id ? <Spinner size={13} /> : <FileAudio size={14} />} <span className="ellipsis">{a.asset.name}</span>
          <span className="muted">{a.asset.duration ? `${Math.round(a.asset.duration)}s` : ''}</span>
        </button>
      ))}
    </div>
  )
}

// ---------------- design ----------------

interface Described {
  attrs: Record<string, string>
  instruct: string
  matched?: string[]
  unmatched?: string[]
}

const DESIGN_SAMPLE = 'Hello! This is how I sound. Let me read your next script — clearly, warmly, and right on time.'

function DesignVoiceModal({ onClose, onCreated }: { onClose: () => void; onCreated: (v: VoiceProfile) => void }) {
  const workspaceId = useSession((s) => s.workspaceId)!
  const engines = useTtsEngines(true)
  const [desc, setDesc] = useState('')
  const [d, setD] = useState<Described>()
  const [language, setLanguage] = useState('English')
  const [seed, setSeed] = useState(() => Math.floor(Math.random() * 1_000_000))
  const [name, setName] = useState('')
  const [preview, setPreview] = useState<string>()
  const [busy, setBusy] = useState<'preview' | 'save'>()
  const designers = (engines.data?.backends ?? []).filter((b) => canDesign(b) && b.available !== false)
  const engine = designers.find((b) => b.id === engines.data?.active)?.id ?? designers[0]?.id ?? ''

  useEffect(() => {
    if (!desc.trim()) return setD(undefined)
    const t = setTimeout(() => {
      vsFetch('/design/describe', { body: { description: desc.trim() } })
        .then((r) => r.json())
        .then((j: Described) => setD(j))
        .catch(() => undefined)
    }, 350)
    return () => clearTimeout(t)
  }, [desc])
  useEffect(() => () => {
    if (preview) URL.revokeObjectURL(preview)
  }, [preview])

  async function listen() {
    if (!d) return
    setBusy('preview')
    try {
      const f = new FormData()
      f.set('text', DESIGN_SAMPLE)
      f.set('instruct', d.instruct)
      f.set('seed', String(seed))
      if (language !== 'Auto') f.set('language', language)
      if (engine) f.set('engine', engine)
      const res = await vsFetch('/generate', { body: f })
      const url = URL.createObjectURL(await res.blob())
      setPreview(url)
      useAudioPreview.getState().toggle(`design:${seed}`, url)
    } catch (e) {
      toastError(e)
    } finally {
      setBusy(undefined)
    }
  }

  async function save() {
    if (!d || !name.trim()) return
    setBusy('save')
    try {
      const v = await vsApi.createVoice({
        workspaceId,
        name: name.trim(),
        kind: 'design',
        engine,
        language,
        instruct: d.instruct,
        vdStates: JSON.stringify(d.attrs),
        seed: String(seed),
        description: desc.trim(),
        consent: JSON.stringify({ agreed: true, speaker: 'designed', statement: 'Designed from a text description; not based on a recording of a real person.' }),
      })
      onCreated(v)
    } catch (e) {
      toastError(e)
    } finally {
      setBusy(undefined)
    }
  }

  return (
    <Modal title="Design a voice" subtitle="Describe the voice you want. Listen, re-roll until it’s right, then save it." onClose={onClose} width={640}>
      {!engine && engines.data && <div className="ps-alert" style={{ marginBottom: 12 }}>No installed engine supports voice design. Install VoiceStudio’s default model in the Engine tab.</div>}
      <label className="label" htmlFor="dv-desc">Description</label>
      <textarea id="dv-desc" className="input" rows={3} autoFocus value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="e.g. A calm, middle-aged woman with a low, warm voice and a slight British accent — like a documentary narrator" maxLength={2000} />
      {d && (
        <div className="row" style={{ gap: 6, flexWrap: 'wrap', marginTop: 8 }}>
          {Object.entries(d.attrs)
            .filter(([, v]) => v && v !== 'Auto')
            .map(([k, v]) => <span key={k} className="vs-chip">{k}: {v}</span>)}
          {!!d.unmatched?.length && <span className="muted" style={{ fontSize: '0.7188rem' }}>Not understood: {d.unmatched.join(', ')}</span>}
        </div>
      )}
      <div className="vs-form-grid" style={{ marginTop: 12 }}>
        <div>
          <label className="label" htmlFor="dv-lang">Language</label>
          <select id="dv-lang" className="input" value={language} onChange={(e) => setLanguage(e.target.value)}>
            {LANGUAGES.map((l) => <option key={l}>{l}</option>)}
          </select>
        </div>
        <div>
          <label className="label">Variation</label>
          <div className="row" style={{ gap: 6 }}>
            <button className="btn sm" onClick={() => setSeed(Math.floor(Math.random() * 1_000_000))}><RefreshCw size={13} /> Re-roll</button>
            <span className="kbd">#{seed}</span>
          </div>
        </div>
      </div>
      <div className="row" style={{ gap: 8, marginTop: 14 }}>
        <button className="btn" disabled={!d || !!busy || !engine} onClick={listen}>{busy === 'preview' ? <Spinner size={13} /> : <Play size={13} />} Listen</button>
        {preview && <audio src={preview} controls style={{ height: 32 }} />}
      </div>
      <div style={{ marginTop: 16 }}>
        <label className="label" htmlFor="dv-name">Name</label>
        <input id="dv-name" className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Documentary narrator" maxLength={80} />
      </div>
      {engine && <div style={{ marginTop: 8 }}><LicenseChip engine={engine} /></div>}
      <div className="row" style={{ justifyContent: 'flex-end', marginTop: 16 }}>
        <button className="btn ghost" onClick={onClose}>Cancel</button>
        <button className="btn primary" disabled={!d || !name.trim() || !!busy || !engine} onClick={save}>{busy === 'save' && <Spinner />} Save voice</button>
      </div>
    </Modal>
  )
}

