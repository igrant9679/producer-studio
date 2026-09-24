// Left icon rail + collapsible asset panel.
import type { Asset, AssetRecord, AudioItem } from '@producer/core'
import { TEXT_TEMPLATES, VOICES, addAsset, addItem, createAudioItem, createShapeItem, itemEnd } from '@producer/core'
import clsx from 'clsx'
import {
  ArrowLeftRight,
  AudioLines,
  Bot,
  ChevronsLeft,
  Circle,
  Clapperboard,
  FileText,
  Keyboard,
  Loader2,
  Mic,
  Palette,
  Pause,
  Play,
  Plus,
  Sparkles,
  Square,
  Subtitles,
  SwatchBook,
  Type,
  Upload,
  Wand2,
} from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { api, waitForJob } from '../lib/api'
import { toast, toastError } from '../lib/toast'
import * as A from './actions'
import { Empty, Slider } from './controls'
import { endDrag, filmstripUrl, startDrag, thumbUrl, assetUrl } from './media'
import { AssistantPanel } from './panels/AssistantPanel'
import { BrandPanel } from './panels/BrandPanel'
import { CaptionsPanel } from './panels/CaptionsPanel'
import { EffectsPanel, FiltersPanel, TransitionsPanel } from './panels/FxPanels'
import { TranscriptPanel } from './panels/TranscriptPanel'
import { type LeftTab, useEditor } from './store'
import { shortDuration } from './timelineMath'
import { libraryAssets, uploadFiles, useLibrary } from './uploads'

const TABS: Array<{ id: LeftTab; label: string; icon: React.ReactNode }> = [
  { id: 'media', label: 'Media', icon: <Clapperboard size={18} /> },
  { id: 'audio', label: 'Audio', icon: <AudioLines size={18} /> },
  { id: 'text', label: 'Text', icon: <Type size={18} /> },
  { id: 'captions', label: 'Captions', icon: <Subtitles size={18} /> },
  { id: 'transcript', label: 'Transcript', icon: <FileText size={18} /> },
  { id: 'effects', label: 'Effects', icon: <Sparkles size={18} /> },
  { id: 'transitions', label: 'Transitions', icon: <ArrowLeftRight size={18} /> },
  { id: 'filters', label: 'Filters', icon: <Palette size={18} /> },
  { id: 'brand', label: 'Brand', icon: <SwatchBook size={18} /> },
  { id: 'ai', label: 'AI', icon: <Bot size={18} /> },
]

export function LeftRail() {
  const active = useEditor((s) => s.activeLeftTab)
  const collapsed = useEditor((s) => s.leftCollapsed)
  return (
    <nav className="ed-rail">
      {TABS.map((t) => (
        <button
          key={t.id}
          className={clsx(active === t.id && !collapsed && 'on', t.id === 'ai' && 'rail-ai')}
          onClick={() => useEditor.setState(active === t.id && !collapsed ? { leftCollapsed: true } : { activeLeftTab: t.id, leftCollapsed: false })}
          title={t.label}
        >
          {t.icon}
          <span>{t.label}</span>
        </button>
      ))}
      <div className="spacer" />
      <button onClick={() => useEditor.setState({ shortcutsOpen: true })} title="Keyboard shortcuts (?)">
        <Keyboard size={18} />
        <span>Keys</span>
      </button>
    </nav>
  )
}

export function AssetPanel() {
  const active = useEditor((s) => s.activeLeftTab)
  const collapsed = useEditor((s) => s.leftCollapsed)
  if (collapsed) return null
  const tab = TABS.find((t) => t.id === active)!
  return (
    <aside className="ed-assets">
      <header className="ed-panelhead">
        <h3>{tab.label === 'AI' ? 'AI assistant' : tab.label}</h3>
        <button className="ed-collapse" title="Collapse panel" onClick={() => useEditor.setState({ leftCollapsed: true })}>
          <ChevronsLeft size={14} />
        </button>
      </header>
      <div className={clsx('ed-panelbody', active === 'ai' && 'flush')}>
        {active === 'media' && <MediaPanel />}
        {active === 'audio' && <AudioPanel />}
        {active === 'text' && <TextPanel />}
        {active === 'captions' && <CaptionsPanel />}
        {active === 'transcript' && <TranscriptPanel />}
        {active === 'effects' && <EffectsPanel />}
        {active === 'transitions' && <TransitionsPanel />}
        {active === 'filters' && <FiltersPanel />}
        {active === 'brand' && <BrandPanel />}
        {active === 'ai' && <AssistantPanel />}
      </div>
    </aside>
  )
}

// ---------- media ----------

function useLibraryList(kinds: Asset['kind'][]) {
  useEditor((s) => s.project.assets)
  useLibrary((s) => s.records)
  return libraryAssets(kinds)
}

function UploadBox({ accept, label }: { accept: string; label: string }) {
  const input = useRef<HTMLInputElement>(null)
  const uploads = useLibrary((s) => s.uploads)
  return (
    <>
      <button
        className="ed-upload"
        onClick={() => input.current?.click()}
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault()
          e.stopPropagation()
          if (e.dataTransfer.files.length) void uploadFiles(e.dataTransfer.files)
        }}
      >
        <Upload size={18} />
        <div>
          <b>{label}</b>
          <small>or drop files anywhere in the editor</small>
        </div>
      </button>
      <input
        ref={input}
        type="file"
        multiple
        accept={accept}
        hidden
        onChange={(e) => {
          if (e.target.files?.length) void uploadFiles(e.target.files)
          e.target.value = ''
        }}
      />
      {uploads.length > 0 && (
        <div className="ed-uploads">
          {uploads.map((u) => (
            <div key={u.key} className={clsx('ed-uprow', u.status)}>
              <span className="nm">{u.name}</span>
              <span className="st">{u.status === 'uploading' ? `${Math.round(u.progress * 100)}%` : u.status === 'processing' ? 'Processing…' : u.status === 'error' ? 'Failed' : 'Ready'}</span>
              <div className="bar"><div style={{ width: `${(u.status === 'uploading' ? u.progress : 1) * 100}%` }} /></div>
            </div>
          ))}
        </div>
      )}
    </>
  )
}

function MediaPanel() {
  const list = useLibraryList(['video', 'image'])
  const loading = useLibrary((s) => s.loading)
  const [filter, setFilter] = useState<'all' | 'video' | 'image'>('all')
  const shown = list.filter((x) => filter === 'all' || x.asset.kind === filter)
  return (
    <>
      <UploadBox accept="video/*,image/*,audio/*" label="Upload media" />
      <div className="ed-chiprow" style={{ margin: '12px 0 10px' }}>
        {(['all', 'video', 'image'] as const).map((f) => (
          <button key={f} className={clsx('chip', filter === f && 'active')} onClick={() => setFilter(f)}>
            {f === 'all' ? 'All' : f === 'video' ? 'Videos' : 'Images'}
          </button>
        ))}
      </div>
      {loading && !list.length && (
        <div className="ed-grid2">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="skeleton" style={{ aspectRatio: '16/10' }} />
          ))}
        </div>
      )}
      {!loading && !shown.length && <Empty icon={<Clapperboard size={22} />} title="No media yet">Upload video or images to start editing.</Empty>}
      <div className="ed-grid2">
        {shown.map(({ asset, status }) => (
          <AssetCard key={asset.id} asset={asset} ready={status === 'ready'} status={status} />
        ))}
      </div>
    </>
  )
}

function AssetCard({ asset, ready, status }: { asset: Asset; ready: boolean; status: string }) {
  const [frac, setFrac] = useState<number | null>(null)
  const inProject = useEditor((s) => !!s.project.assets[asset.id])
  const strip = filmstripUrl(asset)
  const fs = asset.filmstrip
  const th = thumbUrl(asset)
  const idx = fs && frac !== null ? Math.min(fs.frames - 1, Math.floor(frac * fs.frames)) : 0
  const add = () => {
    if (!ready) return toast('Still processing — try again in a moment')
    A.addAssetAt(asset, useEditor.getState().playhead)
  }
  return (
    <div
      className={clsx('ed-asset', !ready && 'pending')}
      draggable={ready}
      onDragStart={(e) => startDrag(e, { kind: 'asset', asset })}
      onDragEnd={endDrag}
      onDoubleClick={add}
      title={`${asset.name}${asset.width ? ` · ${asset.width}×${asset.height}` : ''}`}
    >
      <div
        className="thumb"
        onMouseMove={(e) => {
          const r = e.currentTarget.getBoundingClientRect()
          setFrac(Math.max(0, Math.min(0.999, (e.clientX - r.left) / r.width)))
        }}
        onMouseLeave={() => setFrac(null)}
      >
        {strip && fs && frac !== null ? (
          <div className="sprite" style={{ backgroundImage: `url("${strip}")`, backgroundSize: `${fs.frames * 100}% 100%`, backgroundPosition: `${fs.frames > 1 ? (idx / (fs.frames - 1)) * 100 : 0}% 0` }} />
        ) : th ? (
          <img src={th} alt="" draggable={false} loading="lazy" onError={(e) => (e.currentTarget.style.visibility = 'hidden')} />
        ) : (
          <div className="ph" />
        )}
        {frac !== null && strip && <div className="scrub" style={{ left: `${frac * 100}%` }} />}
        {asset.kind === 'video' && asset.duration !== undefined && <span className="dur">{shortDuration(asset.duration)}</span>}
        {asset.kind === 'image' && <span className="dur">IMG</span>}
        {!ready && (
          <span className="proc">
            <Loader2 size={14} className="spin" /> {status === 'error' ? 'Failed' : 'Processing'}
          </span>
        )}
        {inProject && <span className="used" title="Used in this project" />}
        <button className="add" title="Add at playhead" onClick={add} disabled={!ready}>
          <Plus size={14} />
        </button>
      </div>
      <div className="nm">{asset.name}</div>
    </div>
  )
}

// ---------- text ----------

function TextPanel() {
  const cats = [...new Set(TEXT_TEMPLATES.map((t) => t.category))].filter((c) => c !== 'Basic')
  const addShape = (shape: 'rect' | 'ellipse') => {
    const s = useEditor.getState()
    const it = createShapeItem(s.playhead, { shape, name: shape === 'rect' ? 'Rectangle' : 'Ellipse', fill: '#ff5a5f', width: shape === 'rect' ? 480 : 320, height: shape === 'rect' ? 270 : 320 })
    s.commit(addItem(s.project, it), 'Add shape', { selection: [it.id] })
  }
  return (
    <>
      <div className="ed-textadd">
        <button draggable onDragStart={(e) => startDrag(e, { kind: 'text', templateId: 'heading' })} onDragEnd={endDrag} onClick={() => A.addText('heading')}>
          <span style={{ fontSize: 20, fontWeight: 800 }}>Add heading</span>
        </button>
        <button draggable onDragStart={(e) => startDrag(e, { kind: 'text', templateId: 'body' })} onDragEnd={endDrag} onClick={() => A.addText('body')}>
          <span style={{ fontSize: 13, fontWeight: 500 }}>Add body text</span>
        </button>
      </div>
      {cats.map((c) => (
        <div key={c} className="ed-group">
          <div className="eyebrow">{c}</div>
          <div className="ed-grid2">
            {TEXT_TEMPLATES.filter((t) => t.category === c).map((t) => (
              <button
                key={t.id}
                className="ed-tpl"
                draggable
                onDragStart={(e) => startDrag(e, { kind: 'text', templateId: t.id })}
                onDragEnd={endDrag}
                onClick={() => A.addText(t.id)}
                title={`${t.name} — click to add, or drag to the timeline`}
              >
                <span
                  className="sample"
                  style={{
                    fontFamily: `'${t.style.fontFamily ?? 'Inter'}', Inter, sans-serif`,
                    fontWeight: t.style.fontWeight ?? 700,
                    fontStyle: t.style.italic ? 'italic' : undefined,
                    fontSize: Math.max(11, Math.min(26, (t.style.fontSize ?? 72) * 0.15)),
                    letterSpacing: (t.style.letterSpacing ?? 0) * 0.15,
                    color: t.style.color ?? '#fff',
                    WebkitTextStroke: t.style.stroke ? `${Math.max(0.6, t.style.stroke.width * 0.15)}px ${t.style.stroke.color}` : undefined,
                    paintOrder: 'stroke fill',
                    background: t.style.background?.color,
                    padding: t.style.background ? '3px 7px' : undefined,
                    borderRadius: t.style.background ? Math.min(6, t.style.background.radius * 0.4) : undefined,
                    textShadow: t.style.glow ? `0 0 8px ${t.style.glow.color}, 0 0 16px ${t.style.glow.color}` : undefined,
                  }}
                >
                  {t.text}
                </span>
                <small>{t.name}</small>
              </button>
            ))}
          </div>
        </div>
      ))}
      <div className="ed-group">
        <div className="eyebrow">Shapes</div>
        <div className="ed-grid2">
          <button className="ed-tpl" onClick={() => addShape('rect')}>
            <Square size={26} color="var(--accent)" fill="var(--accent)" />
            <small>Rectangle</small>
          </button>
          <button className="ed-tpl" onClick={() => addShape('ellipse')}>
            <Circle size={26} color="var(--cyan)" fill="var(--cyan)" />
            <small>Ellipse</small>
          </button>
        </div>
      </div>
    </>
  )
}

// ---------- audio ----------

let previewEl: HTMLAudioElement | null = null

function AudioPanel() {
  const list = useLibraryList(['audio'])
  const project = useEditor((s) => s.project)
  const [playing, setPlaying] = useState<string | null>(null)
  useEffect(() => () => previewEl?.pause(), [])
  const toggle = (a: Asset, url: string) => {
    if (playing === a.id) {
      previewEl?.pause()
      setPlaying(null)
      return
    }
    previewEl?.pause()
    previewEl = new Audio(url)
    previewEl.volume = 0.7
    previewEl.onended = () => setPlaying(null)
    void previewEl.play().catch(() => {
      setPlaying(null)
      toast('Preview unavailable')
    })
    setPlaying(a.id)
  }
  const inProject = list.filter((x) => project.assets[x.asset.id])
  const others = list.filter((x) => !project.assets[x.asset.id])
  const row = ({ asset, status }: { asset: Asset; status: string }) => (
    <div
      key={asset.id}
      className="ed-audiorow"
      draggable={status === 'ready'}
      onDragStart={(e) => startDrag(e, { kind: 'asset', asset })}
      onDragEnd={endDrag}
    >
      <button className="pl" onClick={() => toggle(asset, assetUrl(asset, asset.id, 'media'))} title="Preview">
        {playing === asset.id ? <Pause size={13} fill="currentColor" /> : <Play size={13} fill="currentColor" />}
      </button>
      <div className="meta">
        <div className="nm">{asset.name}</div>
        <div className="sub">{asset.duration ? shortDuration(asset.duration) : '—'}{status !== 'ready' ? ` · ${status}` : ''}</div>
      </div>
      <button className="add" title="Add at playhead" disabled={status !== 'ready'} onClick={() => A.addAssetAt(asset, useEditor.getState().playhead)}>
        <Plus size={14} />
      </button>
    </div>
  )
  return (
    <>
      <VoiceoverBox />
      <div className="ed-group">
        <div className="eyebrow">In this project</div>
        {inProject.length ? inProject.map(row) : <p className="ed-note">No audio in this project yet.</p>}
      </div>
      <div className="ed-group">
        <div className="eyebrow">Uploads</div>
        <UploadBox accept="audio/*" label="Upload audio" />
        <div style={{ height: 8 }} />
        {others.map(row)}
      </div>
    </>
  )
}

function VoiceoverBox() {
  const [text, setText] = useState('')
  const [voice, setVoice] = useState<string>('af_heart')
  const [speed, setSpeed] = useState(1)
  const [busy, setBusy] = useState<number | null>(null)
  const sample = useRef<HTMLAudioElement | null>(null)
  const generate = async () => {
    if (A.demoBlocked('AI voiceover')) return
    const s = useEditor.getState()
    if (!text.trim()) return toast('Write the voiceover script first')
    if (!s.workspaceId) return toast('No workspace')
    setBusy(0)
    try {
      const job = await api.tts({ workspaceId: s.workspaceId, projectId: s.projectId, text, voice, speed, name: `Voiceover · ${text.slice(0, 24)}` })
      const done = await waitForJob<{ asset: AssetRecord; duration: number }>(job.id, (j) => setBusy(j.progress < 0 ? 0 : j.progress))
      const res = done.result!
      const st = useEditor.getState()
      let p = addAsset(st.project, res.asset.asset)
      const at = st.playhead
      const item = createAudioItem(res.asset.asset, at, { duration: res.duration || res.asset.asset.duration || 3, name: 'Voiceover', tts: { text, voice, speed } })
      const free = p.tracks.find((t) => t.kind === 'audio' && !t.locked && !t.items.some((i) => i.start < at + item.duration && itemEnd(i) > at))
      p = addItem(p, item as AudioItem, free?.id)
      st.commit(p, 'Add voiceover', { selection: [item.id] })
      toast('Voiceover added at the playhead')
    } catch (e) {
      toastError(e)
    } finally {
      setBusy(null)
    }
  }
  const playSample = () => {
    if (A.demoBlocked('voice samples')) return
    sample.current?.pause()
    sample.current = new Audio(api.voiceSampleUrl(voice))
    void sample.current.play().catch(() => toast('Sample unavailable'))
  }
  const v = VOICES.find((x) => x.id === voice)
  return (
    <div className="ed-vo">
      <div className="row" style={{ marginBottom: 8 }}>
        <Mic size={14} color="var(--accent)" />
        <b style={{ fontSize: 13 }}>Voiceover</b>
        <span className="muted" style={{ fontSize: 11 }}>text to speech</span>
      </div>
      <textarea className="ed-textarea" rows={4} placeholder="Type what the narrator should say…" value={text} onChange={(e) => setText(e.target.value)} />
      <div className="row" style={{ gap: 6, marginTop: 8 }}>
        <select className="ed-select" value={voice} onChange={(e) => setVoice(e.target.value)} style={{ flex: 1 }}>
          {['American English', 'British English'].map((lang) => (
            <optgroup key={lang} label={lang}>
              {VOICES.filter((x) => x.lang === lang).map((x) => (
                <option key={x.id} value={x.id}>{x.name} — {x.style}</option>
              ))}
            </optgroup>
          ))}
        </select>
        <button className="btn sm icon" title={`Play ${v?.name} sample`} onClick={playSample}>
          <Play size={13} />
        </button>
      </div>
      <Slider label="Speed" value={speed} min={0.5} max={2} step={0.05} suffix="×" onChange={setSpeed} />
      <button className="btn primary sm" style={{ width: '100%', marginTop: 6 }} onClick={generate} disabled={busy !== null}>
        {busy !== null ? <Loader2 size={14} className="spin" /> : <Wand2 size={14} />}
        {busy !== null ? `Generating… ${Math.round(busy * 100)}%` : 'Generate and add at playhead'}
      </button>
    </div>
  )
}
