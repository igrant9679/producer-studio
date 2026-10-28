import type { AssetRecord } from '@producer/core'
import { addAsset, addItem, createAudioItem, scriptSeconds } from '@producer/core'
import clsx from 'clsx'
import { AudioLines, BookA, BookOpen, Columns3, FileSpreadsheet, Layers, Library, Users, ChevronRight, Clapperboard, Cpu, Download, History, Languages, Mic, MoreHorizontal, Pause, Pencil, Play, Search, SlidersHorizontal, Sparkles, Trash2, Wand2, X } from 'lucide-react'
import { Suspense, lazy, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { api, mediaUrl, waitForJob } from '../../lib/api'
import { useSession } from '../../lib/session'
import { BatchCsvModal, CompareModal, MarkupButtons, PronunciationsModal, compareLine, useVoiceRefresh } from '../voicestudio/ScriptTools'
import { loadSaved, showDraftSpace, toggleFavourite, useTtsDraft } from '../voicestudio/ttsDraft'
import { toast, toastError } from '../../lib/toast'
import { InlineRename } from '../components/ProjectCard'
import { filterVoices, useVoices, VoiceCard, VOICE_FILTERS, type VoiceFilter } from '../components/VoiceCard'
import { liveBus, useJobs } from '../stores'
import { EmptyState, MenuList, Popover, Progress, RadioCards, Spinner, TabPanel, Tabs, useAsync, useAudioPreview, useEditGate, usePageTitle } from '../ui'
import { useIsDesktop } from '../system'
import { MyVoices } from '../voicestudio/MyVoices'

const Dubbing = lazy(() => import('../voicestudio/Dubbing'))
const Audiobooks = lazy(() => import('../voicestudio/Audiobooks'))
const Batch = lazy(() => import('../voicestudio/Batch'))
const Gallery = lazy(() => import('../voicestudio/Gallery'))
const Stories = lazy(() => import('../voicestudio/Stories'))
const AudioTools = lazy(() => import('../voicestudio/AudioTools'))
const EnginePanel = lazy(() => import('../voicestudio/EnginePanel'))
import { downloadUrl, formatDuration, relativeTime } from '../util'

const EXAMPLES: Array<{ label: string; text: string }> = [
  { label: 'Podcast intro', text: "Welcome back to the show. I'm your host, and this week we're digging into the small habits that make remote teams feel close — even when they're oceans apart. Grab a coffee; let's get into it." },
  { label: 'Product demo', text: 'Here’s the dashboard you’ll see every morning. Everything your team is working on sits in one view, and a single click takes you from a question to the answer. Let me show you how it works.' },
  { label: 'Explainer', text: 'So what actually happens when you press play? Your device asks a server for tiny slices of the video, a few seconds at a time, and quietly picks the best quality your connection can handle.' },
  { label: 'Ad read', text: 'Tired of spending your Friday afternoons editing videos? Producer Studio turns a raw recording into a polished, on-brand video in minutes. Try it free today.' },
]

const MAX_CHARS = 5000
const NO_FAVOURITES: string[] = []

export { useTtsDraft }

/** Generate a voiceover from the draft. */
async function generateVoiceover(workspaceId: string, voice: string, voiceName: string) {
  const d = useTtsDraft.getState()
  const text = d.text.trim()
  if (!text || d.gen) return
  d.set({ gen: { progress: -1, message: 'Queued…' } })
  try {
    const job = await api.tts({ workspaceId, text, voice, speed: d.speed, name: d.name.trim() || `${text.split(/\s+/).slice(0, 5).join(' ')}… — ${voiceName}` })
    const done = await waitForJob<{ asset: AssetRecord; duration: number }>(job.id, (j) => {
      useJobs.getState().upsert(j)
      useTtsDraft.getState().set({ gen: { progress: j.progress, message: j.message || 'Generating…' } })
    })
    const rec = done.result?.asset
    if (rec) {
      useTtsDraft.getState().set({ made: rec })
      // play it only while Voice Studio is on screen, never on whatever page the person moved on to
      if (useTtsDraft.getState().shown > 0 && document.visibilityState !== 'hidden') useAudioPreview.getState().toggle(`asset:${rec.asset.id}`, mediaUrl(rec.asset.id, 'source'))
    }
    toast('Voiceover ready')
    useTtsDraft.getState().set({ name: '' })
  } catch (e) {
    toastError(e)
  } finally {
    useTtsDraft.getState().set({ gen: undefined })
  }
}

function AiWriter({ onClose, hasText, onStream }: { onClose: () => void; hasText: boolean; onStream: (kind: 'voiceover' | 'rewrite', prompt: string) => void }) {
  const [kind, setKind] = useState<'voiceover' | 'rewrite'>('voiceover')
  const [prompt, setPrompt] = useState('')
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => ref.current?.focus(), [])
  return (
    <div className="ps-ai-pop" role="dialog" aria-label="AI writer">
      <div className="row" style={{ marginBottom: 10 }}>
        <Sparkles size={15} style={{ color: 'var(--violet)' }} />
        <strong style={{ fontFamily: 'var(--font-display)' }}>AI writer</strong>
        <span className="spacer" />
        <div className="ps-seg">
          <button className={kind === 'voiceover' ? 'on' : ''} onClick={() => setKind('voiceover')}>Write new</button>
          <button className={kind === 'rewrite' ? 'on' : ''} onClick={() => setKind('rewrite')} disabled={!hasText}>Rewrite</button>
        </div>
        <button className="btn ghost sm icon" onClick={onClose} aria-label="Close AI writer"><X size={14} /></button>
      </div>
      <form
        className="row"
        onSubmit={(e) => {
          e.preventDefault()
          if (!prompt.trim() && kind === 'voiceover') return
          onStream(kind, prompt.trim())
        }}
      >
        <input
          ref={ref}
          className="input"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder={kind === 'voiceover' ? 'What should it say? e.g. a 30-second intro for our spring launch' : 'How should it change? e.g. warmer, half the length'}
          onKeyDown={(e) => e.key === 'Escape' && onClose()}
        />
        <button className="btn primary" disabled={kind === 'voiceover' && !prompt.trim()}><Wand2 size={14} /> {kind === 'voiceover' ? 'Write' : 'Rewrite'}</button>
      </form>
      <div className="row" style={{ gap: 6, marginTop: 10, flexWrap: 'wrap' }}>
        {(kind === 'voiceover' ? ['30-second product intro', 'Friendly welcome for new users', 'Upbeat event announcement'] : ['Make it shorter', 'More conversational', 'More confident', 'Fix grammar only']).map((c) => (
          <button key={c} className="chip" onClick={() => onStream(kind, c)}>{c}</button>
        ))}
      </div>
    </div>
  )
}

function HistoryRow({ a, onChange, onRemove }: { a: AssetRecord; onChange: (a: AssetRecord) => void; onRemove: () => void }) {
  const navigate = useNavigate()
  const workspaceId = useSession((s) => s.workspaceId)
  const key = `asset:${a.asset.id}`
  const playing = useAudioPreview((s) => s.playing === key)
  const loadingAudio = useAudioPreview((s) => s.loading === key)
  const toggle = useAudioPreview((s) => s.toggle)
  const [renaming, setRenaming] = useState(false)
  const [confirm, setConfirm] = useState(false)
  const [busy, setBusy] = useState(false)
  const ready = a.status === 'ready'

  async function useInProject() {
    if (!workspaceId) return
    setBusy(true)
    try {
      const res = await api.createProject({ workspaceId, name: a.asset.name.replace(/\.\w+$/, '') })
      let p = addAsset(res.project, a.asset)
      p = addItem(p, createAudioItem(a.asset, 0))
      await api.saveProject(res.summary.id, p, res.version)
      navigate(`/edit/${res.summary.id}?tab=audio`)
    } catch (e) {
      toastError(e)
      setBusy(false)
    }
  }

  return (
    <div className={clsx('ps-hist', playing && 'playing')}>
      <button className={clsx('btn icon ps-play', playing && 'on')} disabled={!ready} onClick={() => toggle(key, mediaUrl(a.asset.id, 'source'))} aria-label={playing ? 'Pause' : `Play ${a.asset.name}`}>
        {loadingAudio ? <Spinner size={14} /> : playing ? <Pause size={15} /> : <Play size={15} />}
      </button>
      <div className="ps-hist-meta">
        {renaming ? (
          <InlineRename
            value={a.asset.name}
            onCancel={() => setRenaming(false)}
            onSave={async (name) => {
              setRenaming(false)
              onChange({ ...a, asset: { ...a.asset, name } })
              try {
                onChange(await api.renameAsset(a.asset.id, name, a.etag))
              } catch (e) {
                onChange(a)
                toastError(e)
              }
            }}
          />
        ) : (
          <strong title={a.asset.name} onDoubleClick={() => setRenaming(true)}>{a.asset.name}</strong>
        )}
        <span>{ready ? formatDuration(a.asset.duration) : a.status} · {relativeTime(a.createdAt)}</span>
      </div>
      {playing && <span className="ps-eq" aria-hidden><i /><i /><i /><i /></span>}
      {confirm ? (
        <span className="row" style={{ gap: 6 }}>
          <button
            className="btn sm"
            style={{ borderColor: 'var(--danger)', color: 'var(--danger)' }}
            onClick={async () => {
              try {
                await api.deleteAsset(a.asset.id)
                onRemove()
              } catch (e) {
                toastError(e)
              }
            }}
          >
            Delete
          </button>
          <button className="btn ghost sm" onClick={() => setConfirm(false)}>Keep</button>
        </span>
      ) : (
        <>
          <button className="btn sm" onClick={useInProject} disabled={!ready || busy} title="Create a project with this voiceover">
            {busy ? <Spinner size={13} /> : <Clapperboard size={13} />} Use in project
          </button>
          <Popover
            align="right"
            style={{ width: 190 }}
            trigger={({ toggle: t, open }) => (
              <button className="btn ghost sm icon" onClick={t} aria-expanded={open} aria-label={`More actions for ${a.asset.name}`}><MoreHorizontal size={15} /></button>
            )}
          >
            {(close) => (
              <>
                <a className="ps-menu-item" href={downloadUrl(mediaUrl(a.asset.id, 'source'))} download onClick={close}>
                  <Download size={15} /> Download
                </a>
                <MenuList
                  close={close}
                  items={[
                    { label: 'Rename', icon: <Pencil size={15} />, onClick: () => setRenaming(true) },
                    { label: 'Delete', icon: <Trash2 size={15} />, danger: true, onClick: () => setConfirm(true) },
                  ]}
                />
              </>
            )}
          </Popover>
        </>
      )}
    </div>
  )
}

function TextToSpeech({ voice, setVoice, onOpenVoices, onOpenTab }: { voice: string; setVoice: (v: string) => void; onOpenVoices: () => void; onOpenTab: (t: Tab) => void }) {
  const workspaceId = useSession((s) => s.workspaceId)
  const voices = useVoices()
  const gate = useEditGate()
  const { text, name, speed, gen, made, set } = useTtsDraft()
  const favourites = useTtsDraft((s) => (workspaceId ? s.favourites[workspaceId] : undefined)) ?? NO_FAVOURITES
  const setText = (t: string | ((t: string) => string)) => set((d) => ({ text: typeof t === 'function' ? t(d.text) : t }))
  const [filter, setFilter] = useState<VoiceFilter>('All')
  const [q, setQ] = useState('')
  const [writer, setWriter] = useState(false)
  const [writing, setWriting] = useState(false)
  const [tool, setTool] = useState<'dict' | 'batch' | 'compare'>()
  // each space keeps its own draft: switching spaces puts this one away and brings that one's back
  useLayoutEffect(() => showDraftSpace(workspaceId), [workspaceId])
  useEffect(() => {
    if (workspaceId) void loadSaved(workspaceId)
  }, [workspaceId])
  // whether a linked desktop is online, kept current while the picker is on screen
  useVoiceRefresh()
  const taRef = useRef<HTMLTextAreaElement>(null)
  const writeCtrl = useRef<AbortController>()
  const history = useAsync(async () => {
    if (!workspaceId) return [] as AssetRecord[]
    const list = await api.assets(workspaceId, 'audio')
    return list.filter((a) => a.origin === 'tts').sort((x, y) => y.createdAt - x.createdAt)
  }, [workspaceId])

  // a voiceover finished (perhaps while another tab was open): top of the History
  useEffect(() => {
    if (made && made.workspaceId === workspaceId) history.setData((cur) => [made, ...(cur ?? []).filter((x) => x.asset.id !== made.asset.id)])
  }, [made, workspaceId, history.setData])

  useEffect(
    () =>
      liveBus.onAsset((a) => {
        if (a.workspaceId !== workspaceId || a.asset.kind !== 'audio' || a.origin !== 'tts') return
        history.setData((cur) => {
          const list = cur ?? []
          return list.some((x) => x.asset.id === a.asset.id) ? list.map((x) => (x.asset.id === a.asset.id ? a : x)) : [a, ...list]
        })
      }),
    [workspaceId, history.setData],
  )
  useEffect(() => () => writeCtrl.current?.abort(), [])

  const shown = useMemo(() => filterVoices(voices, filter, q, favourites), [voices, filter, q, favourites])
  const selected = voices.find((v) => v.id === voice)
  const words = text.trim() ? text.replace(/\[pause[^\]]*\]/gi, ' ').replace(/\*/g, '').trim().split(/\s+/).filter(Boolean).length : 0
  // the pauses written in the script count too
  const estSecs = scriptSeconds(text, speed)
  const favourite = async (id: string) => {
    if (!workspaceId) return
    try {
      await toggleFavourite(workspaceId, id)
    } catch (e) {
      toastError(e)
    }
  }

  async function stream(kind: 'voiceover' | 'rewrite', prompt: string) {
    setWriter(false)
    const ta = taRef.current
    const original = text
    // Voiceover: insert at the cursor (replacing the typed "/"); rewrite: replace the whole text (or selection).
    let before = original
    let after = ''
    let context: string | undefined
    if (kind === 'voiceover') {
      const pos = ta ? ta.selectionStart : original.length
      before = original.slice(0, pos).replace(/\/$/, '')
      after = original.slice(pos)
    } else {
      const s0 = ta?.selectionStart ?? 0
      const s1 = ta?.selectionEnd ?? 0
      if (s1 > s0) {
        before = original.slice(0, s0)
        after = original.slice(s1)
        context = original.slice(s0, s1)
      } else {
        before = ''
        after = ''
        context = original.replace(/\/$/, '')
      }
    }
    setWriting(true)
    writeCtrl.current = new AbortController()
    let acc = ''
    try {
      await api.write(
        { kind, prompt: prompt || 'Improve this voiceover script.', context, maxWords: 300, workspaceId: useSession.getState().workspaceId },
        (d) => {
          acc += d
          setText(before + acc + after)
        },
        writeCtrl.current.signal,
      )
      if (!acc) setText(original)
    } catch (e) {
      setText(original)
      if (!(e instanceof DOMException && e.name === 'AbortError')) toastError(e)
    } finally {
      setWriting(false)
      taRef.current?.focus()
    }
  }

  function generate() {
    if (!workspaceId) return
    void generateVoiceover(workspaceId, voice, selected?.name ?? voice)
  }

  const unavailable = selected?.available === false
  return (
    <div>
      <div className="ps-vs">
        <div className="ps-vs-main">
          <div className={clsx('ps-vs-editor', writing && 'writing')}>
            <input className="ps-vs-name" placeholder="Untitled voiceover" value={name} onChange={(e) => set({ name: e.target.value })} aria-label="Voiceover name" />
            <div style={{ position: 'relative' }}>
              <textarea
                ref={taRef}
                className="ps-vs-text"
                value={text}
                maxLength={MAX_CHARS}
                readOnly={writing}
                aria-label="Voiceover script"
                placeholder="Press / to use the AI writer, or start typing your script…"
                onChange={(e) => {
                  const v = e.target.value
                  const pos = e.target.selectionStart
                  // A "/" typed at the start of a line opens the AI writer (the slash stays until it is replaced).
                  if (v.length === text.length + 1 && v[pos - 1] === '/' && (pos === 1 || v[pos - 2] === '\n')) setWriter(true)
                  setText(v)
                }}
                onKeyDown={(e) => e.key === 'Escape' && setWriter(false)}
              />
              {writer && <AiWriter hasText={!!text.replace(/\/$/, '').trim()} onClose={() => { setWriter(false); setText((t) => t.replace(/\/$/, '')) }} onStream={stream} />}
            </div>
            <div className="ps-vs-bar">
              {!text && (
                <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
                  <span className="muted" style={{ fontSize: '0.75rem' }}>Try an example:</span>
                  {EXAMPLES.map((ex) => (
                    <button key={ex.label} className="chip" onClick={() => setText(ex.text)}>{ex.label}</button>
                  ))}
                </div>
              )}
              {text && (
                <>
                  <button className="btn sm ps-ai-btn" onClick={() => setWriter(true)} disabled={writing}>
                    {writing ? <Spinner size={13} /> : <Sparkles size={13} />} {writing ? 'Writing…' : 'AI writer'}
                  </button>
                  {writing && <button className="btn ghost sm" onClick={() => writeCtrl.current?.abort()}>Stop</button>}
                  <MarkupButtons taRef={taRef} text={text} setText={setText} disabled={writing} />
                  <button className="btn ghost sm" onClick={() => setText('')} disabled={writing}>Clear</button>
                </>
              )}
              <span className="spacer" />
              <span className="muted" style={{ fontSize: '0.75rem', fontFamily: 'var(--font-mono)' }}>
                {words} words · ≈ {formatDuration(estSecs)} · {text.length}/{MAX_CHARS}
              </span>
            </div>
          </div>
          <div className="row" style={{ gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
            <span className="vs-markup-hint">Write <code>[pause]</code> or <code>[pause 2s]</code> for a pause and <code>*words*</code> to stress them.</span>
            <span className="spacer" />
            <button className="btn ghost sm" onClick={() => setTool('dict')}><BookA size={13} /> Pronunciations</button>
            <button className="btn ghost sm" onClick={() => setTool('compare')}><Columns3 size={13} /> Compare voices</button>
            <button className="btn ghost sm" onClick={() => setTool('batch')} {...gate.props}><FileSpreadsheet size={13} /> Batch from CSV</button>
          </div>
          {tool === 'dict' && <PronunciationsModal onClose={() => setTool(undefined)} />}
          {tool === 'batch' && <BatchCsvModal voices={voices} defaultVoice={voice} speed={speed} onClose={() => setTool(undefined)} />}
          {tool === 'compare' && (
            <CompareModal
              voices={voices}
              initial={[voice, ...favourites]}
              text={compareLine(text, taRef.current ? text.slice(taRef.current.selectionStart, taRef.current.selectionEnd) : '')}
              onUse={setVoice}
              onClose={() => setTool(undefined)}
            />
          )}

          <div className="ps-section" style={{ marginTop: 28 }}>
            <div className="ps-section-head">
              <History size={17} style={{ color: 'var(--text-3)' }} />
              <h2 className="ps-h2">History</h2>
              <span className="muted" style={{ fontSize: '0.75rem' }}>{history.data?.length ? `${history.data.length} voiceover${history.data.length === 1 ? '' : 's'} in this space` : ''}</span>
            </div>
            {history.loading && !history.data ? (
              <div className="ps-hist-list">
                {[0, 1, 2].map((i) => <div key={i} className="skeleton" style={{ height: 58, borderRadius: 12 }} />)}
              </div>
            ) : history.data?.length ? (
              <div className="ps-hist-list">
                {history.data.map((a) => (
                  <HistoryRow
                    key={a.asset.id}
                    a={a}
                    onChange={(n) => history.setData((cur) => (cur ?? []).map((x) => (x.asset.id === n.asset.id ? n : x)))}
                    onRemove={() => history.setData((cur) => (cur ?? []).filter((x) => x.asset.id !== a.asset.id))}
                  />
                ))}
              </div>
            ) : (
              <EmptyState icon={<AudioLines size={24} />} title="No voiceovers yet" body="Generated voiceovers are saved to this space’s library so the whole team can reuse them." />
            )}
          </div>
        </div>

        <aside className="ps-vs-side">
          <div className="ps-vs-panel">
            <div className="row" style={{ marginBottom: 12 }}>
              <strong style={{ fontFamily: 'var(--font-display)', fontSize: '0.9375rem' }}>Select a voice</strong>
              <span className="spacer" />
              <span className="muted" style={{ fontSize: '0.75rem' }}>{shown.length} of {voices.length}</span>
            </div>
            <button className="ps-soon-card vs-myvoices-cta" onClick={onOpenVoices}>
              <div>
                <strong><Mic size={13} style={{ verticalAlign: -2 }} /> My voices</strong>
                <span>Clone your voice from a short recording, or design one from a description</span>
              </div>
              <ChevronRight size={16} />
            </button>
            <div style={{ position: 'relative', margin: '12px 0 10px' }}>
              <Search size={14} style={{ position: 'absolute', left: 11, top: 11, color: 'var(--text-3)' }} />
              <input className="input" style={{ paddingLeft: 32 }} placeholder="Search voices" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search voices" />
            </div>
            <div className="row" style={{ flexWrap: 'wrap', gap: 6, marginBottom: 12 }}>
              {VOICE_FILTERS.map((f) => (
                <button key={f} className={clsx('chip', filter === f && 'active')} onClick={() => setFilter(f)}>{f}</button>
              ))}
            </div>
            <RadioCards className="ps-vs-voices" label="Voices">
              {shown.map((v) => (
                <VoiceCard key={v.id} v={v} selected={voice === v.id} onSelect={() => setVoice(v.id)} favourite={favourites.includes(v.id)} onFavourite={() => void favourite(v.id)} />
              ))}
              {!shown.length && <div className="muted" style={{ padding: 16, textAlign: 'center' }}>{filter === 'Favourites' && !q ? 'No favourites yet: star a voice to keep it here.' : 'No voices match.'}</div>}
            </RadioCards>
            <div className="ps-vs-speed">
              <div className="row">
                <label className="label" htmlFor="vs-speed" style={{ margin: 0 }}>Speed</label>
                <span className="spacer" />
                <span className="kbd">{speed.toFixed(2)}×</span>
                {speed !== 1 && <button className="btn ghost sm" onClick={() => set({ speed: 1 })}>Reset</button>}
              </div>
              <input id="vs-speed" type="range" min={0.5} max={2} step={0.05} value={speed} onChange={(e) => set({ speed: Number(e.target.value) })} className="ps-range" />
            </div>
            {gen ? (
              <div className="ps-vs-gen">
                <div className="row" style={{ fontSize: '0.7812rem' }}><Spinner size={13} /> {gen.message}</div>
                <Progress value={gen.progress} />
              </div>
            ) : (
              <button className="btn primary ps-vs-go" disabled={!text.trim() || writing || unavailable || !gate.canEdit} data-tip={gate.tip} onClick={generate}>
                <AudioLines size={16} /> Generate{selected ? ` with ${selected.name}` : ''}
              </button>
            )}
            {!text.trim() && <div className="muted" style={{ fontSize: '0.75rem', textAlign: 'center', marginTop: 8 }}>Write a script to generate a voiceover.</div>}
            {unavailable && selected?.detail && <div className="muted" style={{ fontSize: '0.75rem', textAlign: 'center', marginTop: 8 }}>{selected.detail}</div>}
            {selected?.available && selected.detail && selected.source && <div className="muted" style={{ fontSize: '0.75rem', textAlign: 'center', marginTop: 8 }}>{selected.detail}</div>}
          </div>
          <button className="ps-soon-card vs-myvoices-cta" style={{ marginTop: 12 }} onClick={() => onOpenTab('dub')}>
            <div>
              <strong><Languages size={13} style={{ verticalAlign: -2 }} /> Voice changer &amp; dubbing</strong>
              <span>Re-voice a recording with any of your voices, or dub a video into another language</span>
            </div>
            <ChevronRight size={16} />
          </button>
        </aside>
      </div>
    </div>
  )
}

type Tab = 'tts' | 'voices' | 'gallery' | 'dub' | 'batch' | 'stories' | 'audiobook' | 'tools' | 'engine'

const TABS: Array<{ id: Tab; label: string; icon: React.ReactNode; desktopOnly?: boolean }> = [
  { id: 'tts', label: 'Text to speech', icon: <AudioLines size={14} /> },
  { id: 'voices', label: 'My voices', icon: <Mic size={14} /> },
  { id: 'gallery', label: 'Gallery', icon: <Library size={14} /> },
  { id: 'dub', label: 'Dubbing', icon: <Languages size={14} /> },
  { id: 'batch', label: 'Batch', icon: <Layers size={14} /> },
  { id: 'stories', label: 'Stories', icon: <Users size={14} /> },
  { id: 'audiobook', label: 'Audiobooks', icon: <BookOpen size={14} /> },
  { id: 'tools', label: 'Audio tools', icon: <SlidersHorizontal size={14} /> },
  { id: 'engine', label: 'Engine', icon: <Cpu size={14} />, desktopOnly: true },
]

const HEAD: Record<Tab, { title: string; body: string }> = {
  tts: { title: 'Text to speech', body: 'Write or paste a script, pick a voice — built-in, cloned or designed — and generate a voiceover you can drop into any project.' },
  voices: { title: 'My voices', body: 'Clone a voice from a short recording, design one from a description, or start from a preset. Your voices work everywhere you pick a voice.' },
  dub: { title: 'Dubbing & voice changer', body: 'Dub a video into another language with timed, natural speech — or re-voice a recording with one of your voices.' },
  gallery: { title: 'Voice gallery', body: 'Collect reference clips from files, your library or online videos, browse community voices, and import voice packs — then turn the best into voices.' },
  stories: { title: 'Stories & stems', body: 'Cast a multi-voice script, then export a mix plus perfectly aligned stems per character — or open it as a project with a track per voice.' },
  batch: { title: 'Batch dubbing', body: 'Queue many videos into one or more languages and let them render in the background. Finished dubs land in your library.' },
  audiobook: { title: 'Audiobooks', body: 'Turn a manuscript, EPUB or PDF into a narrated audiobook with chapters, character voices and mastering.' },
  tools: { title: 'Audio tools', body: 'Isolate vocals from music and noise, and transcribe speech in hundreds of languages.' },
  engine: { title: 'VoiceStudio engine', body: 'The local engine behind cloning, design, dubbing and audiobooks: setup, models, licences and status.' },
}

export default function VoiceStudio() {
  usePageTitle('Voice Studio')
  const workspaceId = useSession((s) => s.workspaceId)
  const desktop = useIsDesktop()
  const [params, setParams] = useSearchParams()
  const tab = (TABS.find((t) => t.id === params.get('tab') && (desktop || !t.desktopOnly))?.id ?? 'tts') as Tab
  // each tab is a history entry, like the Library's: Back returns to the previous tab
  const setTab = (t: Tab) => setParams((p) => {
    const n = new URLSearchParams(p)
    if (t === 'tts') n.delete('tab')
    else n.set('tab', t)
    return n
  })
  // the draft's voice (kept with it per space), else the brand kit's default
  const [brandVoice, setBrandVoice] = useState<{ ws?: string; voice?: string }>({})
  const draftVoice = useTtsDraft((s) => (s.ws === workspaceId ? s.voice : undefined))
  const voice = draftVoice ?? (brandVoice.ws === workspaceId ? brandVoice.voice : undefined) ?? 'af_heart'
  const setVoice = (v: string) => useTtsDraft.getState().set({ voice: v })
  // a voiceover that finishes later plays only while Voice Studio is on screen
  useEffect(() => {
    useTtsDraft.getState().set((d) => ({ shown: d.shown + 1 }))
    return () => useTtsDraft.getState().set((d) => ({ shown: d.shown - 1 }))
  }, [])
  useEffect(() => {
    if (!workspaceId) return
    api.brand(workspaceId).then((b) => setBrandVoice({ ws: workspaceId, voice: b.voice })).catch(() => undefined)
  }, [workspaceId])
  const head = HEAD[tab]

  return (
    <div className="ps-page">
      <div className="ps-page-head">
        <div>
          <span className="eyebrow">Voice Studio{desktop ? ' · powered by VoiceStudio' : ''}</span>
          <h1>{head.title}</h1>
          <p>{head.body}</p>
        </div>
      </div>
      <Tabs
        id="vs"
        label="Voice Studio"
        className="vs-tabs"
        tabClassName="vs-tab"
        value={tab}
        onChange={setTab}
        tabs={TABS.filter((t) => desktop || !t.desktopOnly).map((t) => ({ id: t.id, label: t.label, icon: t.icon }))}
      />
      <TabPanel tabs="vs" value={tab}>
        <Suspense fallback={<div className="muted" style={{ padding: 24 }}><Spinner /> Loading…</div>}>
          {tab === 'tts' && <TextToSpeech voice={voice} setVoice={setVoice} onOpenVoices={() => setTab('voices')} onOpenTab={setTab} />}
          {tab === 'voices' && (
            <MyVoices
              onUse={(id) => {
                setVoice(id)
                setTab('tts')
              }}
              onOpenEngine={() => setTab('engine')}
            />
          )}
          {tab === 'dub' && <Dubbing onOpenEngine={() => setTab('engine')} />}
          {tab === 'gallery' && <Gallery onOpenEngine={() => setTab('engine')} />}
          {tab === 'stories' && <Stories onOpenEngine={() => setTab('engine')} />}
          {tab === 'batch' && <Batch onOpenEngine={() => setTab('engine')} />}
          {tab === 'audiobook' && <Audiobooks onOpenEngine={() => setTab('engine')} />}
          {tab === 'tools' && <AudioTools onOpenEngine={() => setTab('engine')} />}
          {tab === 'engine' && <EnginePanel />}
        </Suspense>
      </TabPanel>
    </div>
  )
}
