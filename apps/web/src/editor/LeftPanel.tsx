// Left icon rail + collapsible asset panel.
import type { Asset, AssetRecord, AudioItem } from '@producer/core'
import { useVoices } from '../shell/components/VoiceCard'
import { TEXT_TEMPLATES, VOICES, addAsset, addItem, createAudioItem, createShapeItem, itemEnd } from '@producer/core'
import clsx from 'clsx'
import {
  AlertTriangle,
  ArrowLeftRight,
  AudioLines,
  Bot,
  ChevronsLeft,
  Circle,
  Clapperboard,
  FileText,
  Keyboard,
  Loader2,
  MessageSquare,
  Mic,
  Palette,
  Pause,
  Play,
  Plus,
  RotateCcw,
  Sparkles,
  Square,
  Subtitles,
  SwatchBook,
  Trash2,
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
import { ViewOnly } from './viewer'
import { CommentsPanel } from './collab/CommentsPanel'
import { shortDuration } from './timelineMath'
import { libraryAssets, removeAsset, retryAsset, uploadFiles, useLibrary } from './uploads'
import { tipProps } from '../lib/tooltip'

const TABS: Array<{ id: LeftTab; label: string; icon: React.ReactNode; desc: string }> = [
  { id: 'media', label: 'Media', icon: <Clapperboard size={18} />, desc: 'Your uploaded videos and images. Hover a clip to preview it; press + or drag it onto the timeline.' },
  { id: 'audio', label: 'Audio', icon: <AudioLines size={18} />, desc: 'Audio uploads and voiceovers generated from text.' },
  { id: 'text', label: 'Text', icon: <Type size={18} />, desc: 'Headings, body text, styled titles and shapes.' },
  { id: 'captions', label: 'Captions', icon: <Subtitles size={18} />, desc: 'Auto captions from speech, manual captions, caption styles, SRT import and export.' },
  { id: 'transcript', label: 'Transcript', icon: <FileText size={18} />, desc: 'Edit by text: select words to cut them, remove pauses and filler words, search what was said.' },
  { id: 'effects', label: 'Effects', icon: <Sparkles size={18} />, desc: 'Looks and motion for the selected clip: blur, glow, camera shake, VHS and more.' },
  { id: 'transitions', label: 'Transitions', icon: <ArrowLeftRight size={18} />, desc: 'How one clip turns into the next: crossfade, push, wipe, zoom.' },
  { id: 'filters', label: 'Filters', icon: <Palette size={18} />, desc: 'Colour grades for the selected clip, with adjustable strength.' },
  { id: 'brand', label: 'Brand', icon: <SwatchBook size={18} />, desc: "Your workspace's brand colours and fonts, applied to text, shapes or the background." },
  { id: 'comments', label: 'Comments', icon: <MessageSquare size={18} />, desc: 'Review comments pinned to moments (and points on the frame), from your team and from share links. Reply, resolve and jump to each.' },
  { id: 'ai', label: 'AI', icon: <Bot size={18} />, desc: 'Ask the assistant to edit for you: trim, split, add text and captions, remove silences.' },
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
          {...tipProps(t.label, t.desc, undefined, 'right')}
        >
          {t.icon}
          <span>{t.label}</span>
        </button>
      ))}
      <div className="spacer" />
      <button onClick={() => useEditor.setState({ shortcutsOpen: true })} {...tipProps('Keyboard shortcuts', 'Every shortcut in the editor.', '?', 'right')}>
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
        <ViewOnly inline>
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
        </ViewOnly>
        {active === 'comments' && <CommentsPanel />}
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

/** "1.2 GB": file sizes for the hover card. */
function fileSize(bytes?: number): string | undefined {
  if (!bytes) return undefined
  const u = ['B', 'KB', 'MB', 'GB']
  let i = 0
  let v = bytes
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024
    i++
  }
  return `${v >= 10 || i === 0 ? Math.round(v) : v.toFixed(1)} ${u[i]}`
}

/** What a clip's tile says about it. "uploading" with no upload running in this tab never finished. */
function clipState(status: string, progress?: { p: number; message: string }, localUpload?: { progress: number }) {
  if (status === 'ready') return { kind: 'ready' as const, label: '' }
  if (status === 'error') return { kind: 'failed' as const, label: 'Failed' }
  if (status === 'uploading') {
    return localUpload ? { kind: 'busy' as const, label: `Uploading ${Math.round(localUpload.progress * 100)}%` } : { kind: 'failed' as const, label: "Upload didn't finish" }
  }
  if (progress && progress.p > 0) return { kind: 'busy' as const, label: `${progress.message || 'Processing'} ${Math.round(progress.p * 100)}%` }
  return { kind: 'busy' as const, label: progress?.message || 'Processing' }
}

function AssetCard({ asset, ready, status }: { asset: Asset; ready: boolean; status: string }) {
  const [frac, setFrac] = useState<number | null>(null)
  const [hovering, setHovering] = useState(false)
  const [videoOk, setVideoOk] = useState(false)
  const videoRef = useRef<HTMLVideoElement>(null)
  const hoverTimer = useRef<number | undefined>(undefined)
  const inProject = useEditor((s) => !!s.project.assets[asset.id])
  const record = useLibrary((s) => s.records.find((r) => r.asset.id === asset.id))
  const progress = useLibrary((s) => s.progress[asset.id])
  const localUpload = useLibrary((s) => s.uploads.find((u) => u.status === 'uploading' && u.name === asset.name))
  const state = clipState(status, progress, status === 'uploading' ? localUpload : undefined)
  const strip = filmstripUrl(asset)
  const fs = asset.filmstrip
  // A video's thumbnail exists once the server says so (asset.thumbnail). Asking earlier got a 404, the image hid
  // itself, and the same URL never loaded again when processing finished: a black tile until the page reloaded.
  const th = asset.kind === 'video' && !asset.thumbnail && status !== 'ready' ? undefined : thumbUrl(asset)
  const [thumbFailed, setThumbFailed] = useState(false)
  useEffect(() => setThumbFailed(false), [th, asset.thumbnail, status])
  const idx = fs && frac !== null ? Math.min(fs.frames - 1, Math.floor(frac * fs.frames)) : 0
  // Hover preview: real frames from the edit proxy, following the pointer. The filmstrip shows until it loads.
  const canPreview = ready && asset.kind === 'video'
  const add = () => {
    if (!ready) return toast(state.kind === 'failed' ? 'This clip failed: retry it or remove it' : 'Still processing, try again in a moment')
    A.addAssetAt(asset, useEditor.getState().playhead)
  }
  useEffect(() => {
    const v = videoRef.current
    if (!v || !videoOk || frac === null || !asset.duration) return
    const t = Math.max(0, Math.min(asset.duration - 0.05, frac * asset.duration))
    if (Math.abs(v.currentTime - t) > 0.04) v.currentTime = t
  }, [frac, videoOk, asset.duration])
  useEffect(() => () => window.clearTimeout(hoverTimer.current), [])

  const facts = [
    asset.kind === 'video' && asset.duration !== undefined ? shortDuration(asset.duration) : asset.kind === 'image' ? 'Image' : undefined,
    asset.width && asset.height ? `${asset.width}×${asset.height}` : undefined,
    fileSize(asset.sizeBytes),
  ].filter(Boolean)
  const tipDesc = [
    facts.join(' · '),
    state.kind === 'failed'
      ? record?.error || (status === 'uploading' ? 'The upload stopped before the file reached storage. Remove this clip and upload the file again.' : 'Processing failed.')
      : state.kind === 'busy'
        ? `${state.label}. It can be used once it's ready.`
        : 'Hover to preview · press + or double-click to add at the playhead · or drag it onto the timeline.',
  ]
    .filter(Boolean)
    .join('\n')

  return (
    <div
      className={clsx('ed-asset', !ready && 'pending', state.kind === 'failed' && 'failed')}
      draggable={ready}
      onDragStart={(e) => startDrag(e, { kind: 'asset', asset })}
      onDragEnd={endDrag}
      onDoubleClick={add}
      {...tipProps(asset.name, tipDesc)}
    >
      <div
        className="thumb"
        onMouseEnter={() => {
          if (!canPreview) return
          hoverTimer.current = window.setTimeout(() => setHovering(true), 150)
        }}
        onMouseMove={(e) => {
          const r = e.currentTarget.getBoundingClientRect()
          setFrac(Math.max(0, Math.min(0.999, (e.clientX - r.left) / r.width)))
        }}
        onMouseLeave={() => {
          window.clearTimeout(hoverTimer.current)
          setFrac(null)
          setHovering(false)
          setVideoOk(false)
        }}
      >
        {strip && fs && frac !== null ? (
          <div className="sprite" style={{ backgroundImage: `url("${strip}")`, backgroundSize: `${fs.frames * 100}% 100%`, backgroundPosition: `${fs.frames > 1 ? (idx / (fs.frames - 1)) * 100 : 0}% 0` }} />
        ) : th ? (
          !thumbFailed ? (
            <img key={`${th}|${asset.thumbnail ?? ''}|${status}`} src={th} alt="" draggable={false} loading="lazy" onError={() => setThumbFailed(true)} />
          ) : (
            <div className="ph" />
          )
        ) : (
          <div className="ph" />
        )}
        {hovering && canPreview && (
          <video
            ref={videoRef}
            className={clsx('hoverprev', videoOk && 'on')}
            src={assetUrl(asset, asset.id, 'proxy')}
            muted
            playsInline
            preload="auto"
            onLoadedData={() => setVideoOk(true)}
            onError={() => setVideoOk(false)}
          />
        )}
        {frac !== null && (strip || videoOk) && <div className="scrub" style={{ left: `${frac * 100}%` }} />}
        {asset.kind === 'video' && asset.duration !== undefined && (
          <span className="dur">{frac !== null && videoOk ? shortDuration(frac * asset.duration) : shortDuration(asset.duration)}</span>
        )}
        {asset.kind === 'image' && <span className="dur">IMG</span>}
        {state.kind === 'busy' && (
          <span className="proc">
            <Loader2 size={14} className="spin" /> {state.label}
          </span>
        )}
        {state.kind === 'failed' && (
          <span className="proc failed">
            <span className="why">
              <AlertTriangle size={14} /> {state.label}
            </span>
            <span className="acts">
              {status === 'error' && (
                <button
                  className="act"
                  onClick={(e) => {
                    e.stopPropagation()
                    void retryAsset(asset.id)
                  }}
                  {...tipProps('Retry', 'Process this clip again. Works when the file reached storage.')}
                >
                  <RotateCcw size={12} /> Retry
                </button>
              )}
              <button
                className="act"
                onClick={(e) => {
                  e.stopPropagation()
                  if (window.confirm(`Remove "${asset.name}" from your media library?`)) void removeAsset(asset.id)
                }}
                {...tipProps('Remove', 'Delete this clip from the media library. Upload the file again to replace it.')}
              >
                <Trash2 size={12} /> Remove
              </button>
            </span>
          </span>
        )}
        {inProject && <span className="used" {...tipProps('Used in this project')} />}
        {ready && (
          <button
            className="add"
            onClick={(e) => {
              e.stopPropagation()
              add()
            }}
            {...tipProps('Add at playhead', 'Put this clip on the timeline where the playhead is.')}
          >
            <Plus size={14} />
          </button>
        )}
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
          <span style={{ fontSize: '1.25rem', fontWeight: 800 }}>Add heading</span>
        </button>
        <button draggable onDragStart={(e) => startDrag(e, { kind: 'text', templateId: 'body' })} onDragEnd={endDrag} onClick={() => A.addText('body')}>
          <span style={{ fontSize: '0.8125rem', fontWeight: 500 }}>Add body text</span>
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

export function VoiceoverBox() {
  const voices = useVoices()
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
    // it lands where the playhead was when it was asked for, in the project it was asked for
    const at = s.playhead
    const session = s.session
    try {
      const job = await api.tts({ workspaceId: s.workspaceId, projectId: s.projectId, text, voice, speed, name: `Voiceover · ${text.slice(0, 24)}` })
      const done = await waitForJob<{ asset: AssetRecord; duration: number }>(job.id, (j) => setBusy(j.progress < 0 ? 0 : j.progress))
      const res = done.result!
      const st = useEditor.getState()
      if (st.session !== session) {
        toast('Your voiceover is ready in the project you made it for, under Uploads in its Audio panel.')
        return
      }
      let p = addAsset(st.project, res.asset.asset)
      const item = createAudioItem(res.asset.asset, at, { duration: res.duration || res.asset.asset.duration || 3, name: 'Voiceover', tts: { text, voice, speed } })
      const free = p.tracks.find((t) => t.kind === 'audio' && !t.locked && !t.items.some((i) => i.start < at + item.duration && itemEnd(i) > at))
      p = addItem(p, item as AudioItem, free?.id)
      st.commit(p, 'Add voiceover', { selection: [item.id] })
      toast(`Voiceover added at ${shortDuration(at)}`)
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
  const v = voices.find((x) => x.id === voice) ?? VOICES.find((x) => x.id === voice)
  const custom = voices.filter((x) => x.source === 'clone' || x.source === 'design')
  return (
    <div className="ed-vo">
      <div className="row" style={{ marginBottom: 8 }}>
        <Mic size={14} color="var(--accent)" />
        <b style={{ fontSize: '0.8125rem' }}>Voiceover</b>
        <span className="muted" style={{ fontSize: '0.6875rem' }}>text to speech</span>
      </div>
      <textarea className="ed-textarea" rows={4} placeholder="Type what the narrator should say…" value={text} onChange={(e) => setText(e.target.value)} />
      <div className="row" style={{ gap: 6, marginTop: 8 }}>
        <select className="ed-select" value={voice} onChange={(e) => setVoice(e.target.value)} style={{ flex: 1 }}>
          {custom.length > 0 && (
            <optgroup label="My voices">
              {custom.map((x) => (
                <option key={x.id} value={x.id} disabled={x.available === false}>{x.name} — {x.available === false ? (x.detail ?? 'unavailable') : x.style}</option>
              ))}
            </optgroup>
          )}
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
