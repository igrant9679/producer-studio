// Right-hand, context-sensitive properties panel. Tabs depend on the selected item's type; with nothing
// selected it edits the project. Numeric transform/opacity/volume props carry ◇ keyframe toggles.
import type { AnimationPreset, AudioItem, BlendMode, CaptionItem, CaptionStyle, ColorAdjust, ImageItem, Item, Project, ShapeItem, TextItem, TextStyle, Track, VideoItem, VisualItem } from '@producer/core'
import {
  ANIMATION_PRESETS,
  ASPECT_RATIOS,
  CAPTION_PRESETS,
  COMBO_PRESETS,
  EFFECTS,
  EXPORT_FPS,
  FILTERS,
  FONTS,
  NEUTRAL_ADJUST,
  adjustToFilter,
  captionStyleFromPreset,
  findItem,
  generateCaptions,
  projectDuration,
  setAspect,
  updateItem,
  updateProject,
  updateTrack,
} from '@producer/core'
import clsx from 'clsx'
import { AlignCenter, AlignLeft, AlignRight, Bold, CaseUpper, ChevronsRight, FlipHorizontal2, FlipVertical2, Italic, RotateCcw, Snowflake, SplitSquareHorizontal, Trash2, Underline, X, CopyPlus, Copy, RefreshCw } from 'lucide-react'
import { useEffect, useState } from 'react'
import * as A from './actions'
import { ColorInput, Empty, Field, KeyframeToggle, NumberInput, Section, Segmented, Slider, Toggle, useThrottledPlayhead } from './controls'
import { resetDemoProject } from './demo'
import { thumbUrl } from './media'
import { useEditor } from './store'
import { timecode } from './timelineMath'

const BLENDS: BlendMode[] = ['normal', 'multiply', 'screen', 'overlay', 'darken', 'lighten', 'color-dodge', 'color-burn', 'hard-light', 'soft-light', 'difference', 'exclusion']

function up<T extends Item>(item: T, patch: Partial<T>, label: string, coalesce?: string) {
  const s = useEditor.getState()
  s.commit(updateItem<T>(s.project, item.id, patch), label, coalesce ? { coalesce } : undefined)
}

/** Current version of the item from the store (props can be stale inside callbacks). */
function live<T extends Item>(id: string): T | undefined {
  return findItem(useEditor.getState().project, id)?.item as T | undefined
}

export function PropertiesPanel() {
  const project = useEditor((s) => s.project)
  const selection = useEditor((s) => s.selection)
  const activeTab = useEditor((s) => s.activeRightTab)
  const collapsed = useEditor((s) => s.rightCollapsed)
  const items = A.selectedItems(project, selection)
  const item = items.length === 1 ? items[0] : undefined
  const f = item ? findItem(project, item.id) : null

  let tabs: Array<{ id: string; label: string }> = []
  if (!item) tabs = items.length > 1 ? [{ id: 'multi', label: 'Selection' }] : [{ id: 'project', label: 'Project' }]
  else if (item.type === 'video')
    tabs = [
      { id: 'basic', label: 'Basic' },
      { id: 'adjust', label: 'Adjust' },
      ...(f?.track.main ? [{ id: 'background', label: 'Canvas' }] : []),
      { id: 'animation', label: 'Animation' },
      { id: 'speed', label: 'Speed' },
      { id: 'audio', label: 'Audio' },
    ]
  else if (item.type === 'image')
    tabs = [
      { id: 'basic', label: 'Basic' },
      { id: 'adjust', label: 'Adjust' },
      ...(f?.track.main ? [{ id: 'background', label: 'Canvas' }] : []),
      { id: 'animation', label: 'Animation' },
    ]
  else if (item.type === 'text') tabs = [{ id: 'text', label: 'Text' }, { id: 'basic', label: 'Transform' }, { id: 'animation', label: 'Animation' }]
  else if (item.type === 'shape') tabs = [{ id: 'shape', label: 'Shape' }, { id: 'basic', label: 'Transform' }, { id: 'animation', label: 'Animation' }]
  else if (item.type === 'audio') tabs = [{ id: 'audio', label: 'Audio' }, { id: 'speed', label: 'Speed' }]
  else if (item.type === 'caption') tabs = [{ id: 'caption', label: 'Captions' }]
  const tab = tabs.find((t) => t.id === activeTab)?.id ?? tabs[0].id

  if (collapsed) return null
  return (
    <aside className="ed-props">
      <div className="ed-tabs">
        {tabs.map((t) => (
          <button key={t.id} className={clsx(t.id === tab && 'on')} onClick={() => useEditor.setState({ activeRightTab: t.id })}>
            {t.label}
          </button>
        ))}
        <div className="spacer" />
        <button className="ed-collapse" title="Collapse panel" onClick={() => useEditor.setState({ rightCollapsed: true })}>
          <ChevronsRight size={14} />
        </button>
      </div>
      <div className="ed-props-body">
        {item && <ItemHeader item={item} track={f!.track} />}
        {tab === 'project' && <ProjectTab project={project} />}
        {tab === 'multi' && <MultiTab items={items} />}
        {item && tab === 'basic' && 'transform' in item && <BasicTab item={item as VisualItem} main={!!f?.track.main} />}
        {item && tab === 'adjust' && (item.type === 'video' || item.type === 'image') && <AdjustTab item={item} />}
        {item && tab === 'background' && (item.type === 'video' || item.type === 'image') && <BackgroundTab item={item} project={project} />}
        {item && tab === 'animation' && 'animations' in item && <AnimationTab item={item as VisualItem} />}
        {item && tab === 'speed' && (item.type === 'video' || item.type === 'audio') && <SpeedTab item={item} project={project} />}
        {item && tab === 'audio' && (item.type === 'video' || item.type === 'audio') && <AudioTab item={item} />}
        {item && tab === 'text' && item.type === 'text' && <TextTab item={item} />}
        {item && tab === 'shape' && item.type === 'shape' && <ShapeTab item={item} />}
        {item && tab === 'caption' && item.type === 'caption' && <CaptionTab item={item} track={f!.track} />}
      </div>
    </aside>
  )
}

function ItemHeader({ item, track }: { item: Item; track: Track }) {
  const asset = 'assetId' in item ? useEditor.getState().project.assets[item.assetId] : undefined
  const fps = useEditor.getState().project.fps
  const th = asset ? thumbUrl(asset) : undefined
  return (
    <div className="ed-itemhead">
      {th ? <img src={th} alt="" /> : <div className="ph">{item.type[0].toUpperCase()}</div>}
      <div className="meta">
        <div className="nm">{item.type === 'text' || item.type === 'caption' ? item.text.split('\n')[0] : item.name ?? asset?.name ?? item.type}</div>
        <div className="sub">
          {item.type} · {track.name} · {timecode(item.start, fps)} → {timecode(item.start + item.duration, fps)}
        </div>
      </div>
    </div>
  )
}

// ---------- project ----------

function ProjectTab({ project }: { project: Project }) {
  const commit = useEditor((s) => s.commit)
  const demo = useEditor((s) => s.demo)
  const dur = projectDuration(project)
  const items = project.tracks.reduce((n, t) => n + t.items.length, 0)
  const aspect = ASPECT_RATIOS.find((a) => a.width / a.height === project.width / project.height)
  return (
    <>
      <Section title="Project">
        <Field label="Name">
          <input className="ed-input" defaultValue={project.name} key={project.name} onBlur={(e) => e.target.value !== project.name && commit(updateProject(project, { name: e.target.value || 'Untitled project' }), 'Rename project')} onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()} />
        </Field>
        <Field label="Canvas">
          <span className="ed-static">{project.width} × {project.height}</span>
        </Field>
        <Field label="Frame rate">
          <select className="ed-select" value={project.fps} onChange={(e) => commit(updateProject(project, { fps: +e.target.value }), 'Frame rate')}>
            {EXPORT_FPS.map((f) => (
              <option key={f} value={f}>{f} fps</option>
            ))}
          </select>
        </Field>
        <Field label="Background">
          <ColorInput value={project.background} onChange={(v) => commit(updateProject(useEditor.getState().project, { background: v }), 'Background colour', { coalesce: 'proj-bg' })} />
        </Field>
        <Field label="Duration">
          <span className="ed-static mono">{timecode(dur, project.fps)}</span>
        </Field>
        <Field label="Contents">
          <span className="ed-static">{project.tracks.length} tracks · {items} items · {Object.keys(project.assets).length} assets</span>
        </Field>
      </Section>
      <Section title="Aspect ratio">
        <div className="ed-ratio-grid">
          {ASPECT_RATIOS.map((a) => (
            <button key={a.id} className={clsx(aspect?.id === a.id && 'on')} onClick={() => commit(setAspect(project, a.width, a.height), `Ratio ${a.name}`)}>
              <span className="shape" style={{ aspectRatio: `${a.width}/${a.height}` }} />
              <b>{a.name}</b>
              <small>{a.hint}</small>
            </button>
          ))}
        </div>
      </Section>
      {demo && (
        <Section title="Demo">
          <p className="ed-note">This demo project lives in your browser (localStorage). Reset it to get the original clips back.</p>
          <button className="btn sm" onClick={() => useEditor.getState().load({ project: resetDemoProject(), version: 0, projectId: 'demo', demo: true })}>
            <RefreshCw size={13} /> Reset demo project
          </button>
        </Section>
      )}
    </>
  )
}

function MultiTab({ items }: { items: Item[] }) {
  return (
    <Section title={`${items.length} items selected`}>
      <p className="ed-note">{[...new Set(items.map((i) => i.type))].join(', ')}</p>
      <div className="row" style={{ flexWrap: 'wrap' }}>
        <button className="btn sm" onClick={A.duplicate}><CopyPlus size={13} /> Duplicate</button>
        <button className="btn sm" onClick={A.copy}><Copy size={13} /> Copy</button>
        <button className="btn sm" onClick={() => A.remove()}><Trash2 size={13} /> Delete</button>
      </div>
    </Section>
  )
}

// ---------- basic (transform) ----------

function PropSlider({ item, prop, label, min, max, step, pct, suffix }: { item: VisualItem | AudioItem | VideoItem; prop: 'x' | 'y' | 'scale' | 'rotation' | 'opacity' | 'volume'; label: string; min: number; max: number; step: number; pct?: boolean; suffix?: string }) {
  const playhead = useThrottledPlayhead()
  const value = A.readProp(item, prop, playhead)
  return (
    <Slider
      label={label}
      value={value}
      min={min}
      max={max}
      step={step}
      suffix={suffix ?? (pct ? '%' : undefined)}
      display={pct ? { to: (v) => v * 100, from: (v) => v / 100, step: 1 } : undefined}
      onChange={(v) => {
        const s = useEditor.getState()
        s.commit(A.writeProp(s.project, item.id, prop, v), label, { coalesce: `${prop}:${item.id}` })
      }}
      keyframe={<KeyframeToggle item={item} prop={prop} />}
    />
  )
}

function BasicTab({ item, main }: { item: VisualItem; main: boolean }) {
  const W = useEditor((s) => s.project.width)
  const H = useEditor((s) => s.project.height)
  const media = item.type === 'video' || item.type === 'image'
  return (
    <>
      <Section
        title="Transform"
        right={
          <button className="ed-mini" title="Reset transform" onClick={() => up<VisualItem>(item, { transform: { x: 0, y: 0, scale: 1, rotation: 0 }, keyframes: {} }, 'Reset transform')}>
            <RotateCcw size={12} />
          </button>
        }
      >
        <PropSlider item={item} prop="x" label="Position X" min={-W} max={W} step={1} />
        <PropSlider item={item} prop="y" label="Position Y" min={-H} max={H} step={1} />
        <PropSlider item={item} prop="scale" label="Scale" min={0.05} max={5} step={0.01} pct />
        <PropSlider item={item} prop="rotation" label="Rotation" min={-180} max={180} step={1} suffix="°" />
        <Field label="Flip">
          <div className="row" style={{ gap: 4 }}>
            <button className={clsx('ed-iconbtn', item.transform.flipX && 'on')} title="Flip horizontal" onClick={() => up<VisualItem>(item, { transform: { ...item.transform, flipX: !item.transform.flipX } }, 'Flip')}>
              <FlipHorizontal2 size={14} />
            </button>
            <button className={clsx('ed-iconbtn', item.transform.flipY && 'on')} title="Flip vertical" onClick={() => up<VisualItem>(item, { transform: { ...item.transform, flipY: !item.transform.flipY } }, 'Flip')}>
              <FlipVertical2 size={14} />
            </button>
          </div>
        </Field>
        {media && (
          <Field label="Fit">
            <Segmented
              value={(item as VideoItem).fit}
              options={[{ value: 'contain', label: 'Fit' }, { value: 'cover', label: 'Fill' }]}
              onChange={(v) => up<VideoItem>(item as VideoItem, { fit: v }, v === 'cover' ? 'Fill' : 'Fit')}
            />
          </Field>
        )}
      </Section>
      <Section title="Blend">
        <PropSlider item={item} prop="opacity" label="Opacity" min={0} max={1} step={0.01} pct />
        <Field label="Mode">
          <select className="ed-select" value={item.blend} onChange={(e) => up<VisualItem>(item, { blend: e.target.value as BlendMode }, 'Blend mode')}>
            {BLENDS.map((b) => (
              <option key={b} value={b}>{b.replace('-', ' ')}</option>
            ))}
          </select>
        </Field>
      </Section>
      <EffectsSection item={item} />
      {main && media && <p className="ed-note">Main-track clip · letterbox fill lives in the Canvas tab.</p>}
    </>
  )
}

function EffectsSection({ item }: { item: VisualItem }) {
  if (!item.effects.length) return null
  return (
    <Section title={`Effects (${item.effects.length})`}>
      {item.effects.map((fx) => (
        <div key={fx.id} className="ed-fxrow">
          <Slider
            label={EFFECTS.find((e) => e.id === fx.type)?.name ?? fx.type}
            value={fx.intensity}
            min={0}
            max={100}
            step={1}
            onChange={(v) => {
              const cur = live<VisualItem>(item.id)
              if (cur) up<VisualItem>(cur, { effects: cur.effects.map((e) => (e.id === fx.id ? { ...e, intensity: v } : e)) }, 'Effect intensity', `fx:${fx.id}`)
            }}
            keyframe={
              <button className="ed-kf" title="Remove effect" onClick={() => up<VisualItem>(item, { effects: item.effects.filter((e) => e.id !== fx.id) }, 'Remove effect')}>
                <X size={12} />
              </button>
            }
          />
        </div>
      ))}
    </Section>
  )
}

// ---------- adjust ----------

const ADJ: Array<{ k: keyof ColorAdjust; label: string }> = [
  { k: 'brightness', label: 'Brightness' },
  { k: 'contrast', label: 'Contrast' },
  { k: 'saturation', label: 'Saturation' },
  { k: 'exposure', label: 'Exposure' },
  { k: 'temperature', label: 'Temperature' },
  { k: 'tint', label: 'Tint' },
  { k: 'hue', label: 'Hue' },
  { k: 'sharpen', label: 'Sharpen' },
  { k: 'vignette', label: 'Vignette' },
]

function AdjustTab({ item }: { item: VideoItem | ImageItem }) {
  const asset = useEditor((s) => s.project.assets[item.assetId])
  const th = asset ? thumbUrl(asset) : undefined
  const css = adjustToFilter(item.adjust, item.filter?.id, item.filter?.intensity ?? 100).filter
  return (
    <>
      <Section title="Filter">
        {th && (
          <div className="ed-adjpreview">
            <img src={th} alt="" style={{ filter: css || undefined }} />
            <span>Preview</span>
          </div>
        )}
        <Field label="Preset">
          <select
            className="ed-select"
            value={item.filter?.id ?? ''}
            onChange={(e) => up<VideoItem>(item as VideoItem, { filter: e.target.value ? { id: e.target.value, intensity: item.filter?.intensity ?? 80 } : undefined }, 'Filter')}
          >
            <option value="">None</option>
            {FILTERS.map((f) => (
              <option key={f.id} value={f.id}>{f.category} · {f.name}</option>
            ))}
          </select>
        </Field>
        {item.filter && (
          <Slider label="Intensity" value={item.filter.intensity} min={0} max={100} onChange={(v) => up<VideoItem>(item as VideoItem, { filter: { id: item.filter!.id, intensity: v } }, 'Filter intensity', `fi:${item.id}`)} suffix="%" />
        )}
      </Section>
      <Section
        title="Colour"
        right={
          <button className="ed-mini" title="Reset colour" onClick={() => up<VideoItem>(item as VideoItem, { adjust: { ...NEUTRAL_ADJUST } }, 'Reset colour')}>
            <RotateCcw size={12} />
          </button>
        }
      >
        {ADJ.map(({ k, label }) => (
          <Slider
            key={k}
            label={label}
            value={item.adjust[k]}
            min={k === 'sharpen' || k === 'vignette' ? 0 : -100}
            max={100}
            onChange={(v) => {
              const cur = live<VideoItem>(item.id)
              if (cur) up<VideoItem>(cur, { adjust: { ...cur.adjust, [k]: v } }, label, `adj:${k}:${item.id}`)
            }}
          />
        ))}
      </Section>
    </>
  )
}

// ---------- background ----------

const BG_SWATCHES = ['#000000', '#ffffff', '#0c0e14', '#1b2030', '#ff5a5f', '#35e0ff', '#ffc24d', '#3ddc97', '#7950f2', '#e8590c']

function BackgroundTab({ item, project }: { item: VideoItem | ImageItem; project: Project }) {
  const bg = item.background
  const type = bg?.type ?? 'none'
  const images = Object.values(project.assets).filter((a) => a.kind === 'image')
  const set = (b: VideoItem['background'], label = 'Background') => up<VideoItem>(item as VideoItem, { background: b }, label, `bg:${item.id}`)
  const applyAll = () => {
    const s = useEditor.getState()
    const main = s.project.tracks.find((t) => t.main)
    if (!main) return
    let p = s.project
    for (const it of main.items) if (it.type === 'video' || it.type === 'image') p = updateItem<VideoItem>(p, it.id, { background: bg })
    s.commit(p, 'Background to all')
  }
  return (
    <Section title="Letterbox fill">
      <p className="ed-note">Fills the empty canvas area around this clip when it doesn't cover the frame.</p>
      <Segmented
        value={type}
        options={[{ value: 'none', label: 'None' }, { value: 'color', label: 'Colour' }, { value: 'blur', label: 'Blur' }, { value: 'image', label: 'Image' }]}
        onChange={(v) => {
          if (v === 'none') set(undefined)
          if (v === 'color') set({ type: 'color', color: '#1b2030' })
          if (v === 'blur') set({ type: 'blur', amount: 30 })
          if (v === 'image') images[0] ? set({ type: 'image', assetId: images[0].id }) : set({ type: 'color', color: '#1b2030' })
        }}
      />
      <div style={{ height: 10 }} />
      {bg?.type === 'color' && (
        <>
          <div className="ed-swatches">
            {BG_SWATCHES.map((c) => (
              <button key={c} style={{ background: c }} className={clsx(c === bg.color && 'on')} onClick={() => set({ type: 'color', color: c })} />
            ))}
          </div>
          <Field label="Colour">
            <ColorInput value={bg.color} onChange={(v) => set({ type: 'color', color: v })} />
          </Field>
        </>
      )}
      {bg?.type === 'blur' && <Slider label="Blur" value={bg.amount} min={4} max={80} onChange={(v) => set({ type: 'blur', amount: v })} suffix="px" />}
      {bg?.type === 'image' && (
        <div className="ed-bgimgs">
          {images.map((a) => (
            <button key={a.id} className={clsx(bg.assetId === a.id && 'on')} onClick={() => set({ type: 'image', assetId: a.id })}>
              <img src={thumbUrl(a)} alt={a.name} />
            </button>
          ))}
          {!images.length && <p className="ed-note">Upload an image to use it as a background.</p>}
        </div>
      )}
      <button className="btn sm" style={{ marginTop: 10 }} onClick={applyAll}>Apply to all main-track clips</button>
    </Section>
  )
}

// ---------- animation ----------

function AnimationTab({ item }: { item: VisualItem }) {
  const [mode, setMode] = useState<'in' | 'out' | 'combo'>('in')
  const anims = item.animations ?? {}
  const presets = ANIMATION_PRESETS.filter((p) => !p.textOnly || item.type === 'text')
  const cur = mode === 'combo' ? anims.combo?.preset ?? 'none' : anims[mode]?.preset ?? 'none'
  const maxDur = Math.max(0.2, Math.min(5, item.duration))
  const setAnim = (preset: string) => {
    const it = live<VisualItem>(item.id) ?? item
    const a = { ...(it.animations ?? {}) }
    if (mode === 'combo') a.combo = preset === 'none' ? undefined : { preset: preset as 'pulse', period: a.combo?.period ?? 1.2 }
    else a[mode] = preset === 'none' ? undefined : { preset: preset as AnimationPreset, duration: a[mode]?.duration ?? Math.min(0.6, maxDur / 2) }
    up<VisualItem>(it, { animations: a }, preset === 'none' ? 'Remove animation' : 'Animation')
    // preview: jump to where the animation plays
    const s = useEditor.getState()
    if (preset !== 'none') {
      if (mode === 'in') s.setPlayhead(it.start)
      if (mode === 'out') s.setPlayhead(Math.max(it.start, it.start + it.duration - (a.out?.duration ?? 0.6) - 0.05))
    }
  }
  const setDur = (v: number) => {
    const it = live<VisualItem>(item.id) ?? item
    const a = { ...(it.animations ?? {}) }
    if (mode === 'combo' && a.combo) a.combo = { ...a.combo, period: v }
    else if (mode !== 'combo' && a[mode]) a[mode] = { ...a[mode]!, duration: v }
    up<VisualItem>(it, { animations: a }, 'Animation duration', `anim:${mode}:${item.id}`)
  }
  const list = mode === 'combo' ? [{ id: 'none', name: 'None' }, ...COMBO_PRESETS] : [{ id: 'none', name: 'None' }, ...presets]
  return (
    <Section title="Animation">
      <Segmented value={mode} options={[{ value: 'in', label: 'In' }, { value: 'out', label: 'Out' }, { value: 'combo', label: 'Loop' }]} onChange={setMode} />
      <div className="ed-animgrid">
        {list.map((p) => (
          <button key={p.id} className={clsx(cur === p.id && 'on')} onClick={() => setAnim(p.id)}>
            <span className={clsx('ed-animicon', `a-${p.id}`, mode)} />
            <span>{p.name}</span>
          </button>
        ))}
      </div>
      {mode !== 'combo' && anims[mode] && <Slider label="Duration" value={anims[mode]!.duration} min={0.1} max={maxDur} step={0.05} suffix="s" onChange={setDur} />}
      {mode === 'combo' && anims.combo && <Slider label="Period" value={anims.combo.period} min={0.2} max={4} step={0.05} suffix="s" onChange={setDur} />}
    </Section>
  )
}

// ---------- speed ----------

function SpeedTab({ item, project }: { item: VideoItem | AudioItem; project: Project }) {
  const asset = project.assets[item.assetId]
  const setSpeed = (v: number) => {
    const it = live<VideoItem | AudioItem>(item.id) ?? item
    const span = it.duration * it.speed
    const max = asset?.duration ? (asset.duration - it.in) : Infinity
    const src = Math.min(span, max)
    up<VideoItem>(it as VideoItem, { speed: +v.toFixed(3), duration: +(src / v).toFixed(4) }, 'Speed', `speed:${item.id}`)
  }
  const frozen = item.type === 'video' && item.freezeAt !== undefined
  return (
    <>
      <Section title="Speed">
        {frozen ? (
          <p className="ed-note">This is a freeze-frame segment; speed doesn't apply.</p>
        ) : (
          <>
            <Slider label="Speed" value={item.speed} min={0.25} max={4} step={0.05} suffix="×" onChange={setSpeed} />
            <div className="ed-chiprow">
              {[0.5, 1, 1.5, 2, 3].map((s) => (
                <button key={s} className={clsx('chip', Math.abs(item.speed - s) < 0.001 && 'active')} onClick={() => setSpeed(s)}>{s}×</button>
              ))}
            </div>
            <Field label="Duration">
              <span className="ed-static mono">{item.duration.toFixed(2)} s</span>
            </Field>
          </>
        )}
        {item.type === 'video' && !frozen && (
          <Field label="Reverse">
            <Toggle checked={!!item.reverse} onChange={(v) => up<VideoItem>(item, { reverse: v }, v ? 'Reverse' : 'Un-reverse')} label={<span className="muted">preview is approximate</span>} />
          </Field>
        )}
      </Section>
      {item.type === 'video' && !frozen && (
        <Section title="Freeze frame">
          <p className="ed-note">Holds the frame under the playhead for 2 seconds.</p>
          <button className="btn sm" onClick={A.freeze}><Snowflake size={13} /> Freeze frame at playhead</button>
        </Section>
      )}
    </>
  )
}

// ---------- audio ----------

function AudioTab({ item }: { item: VideoItem | AudioItem }) {
  const maxFade = Math.max(0.1, Math.min(10, item.duration / 2))
  return (
    <>
      <Section title="Volume">
        <PropSlider item={item} prop="volume" label="Volume" min={0} max={2} step={0.01} pct />
        <Field label="Mute">
          <Toggle checked={!!item.muted} onChange={(v) => up<VideoItem>(item as VideoItem, { muted: v }, v ? 'Mute clip' : 'Unmute clip')} />
        </Field>
        <Slider label="Fade in" value={item.fadeIn} min={0} max={maxFade} step={0.05} suffix="s" onChange={(v) => up<VideoItem>(item as VideoItem, { fadeIn: v }, 'Fade in', `fin:${item.id}`)} />
        <Slider label="Fade out" value={item.fadeOut} min={0} max={maxFade} step={0.05} suffix="s" onChange={(v) => up<VideoItem>(item as VideoItem, { fadeOut: v }, 'Fade out', `fout:${item.id}`)} />
      </Section>
      {item.type === 'video' && (
        <Section title="Separate">
          <p className="ed-note">Moves this clip's sound to its own audio track (linked, the video is muted).</p>
          <button className="btn sm" onClick={A.separate}><SplitSquareHorizontal size={13} /> Separate audio</button>
        </Section>
      )}
      {item.type === 'audio' && item.tts && (
        <Section title="Voiceover">
          <p className="ed-note" style={{ whiteSpace: 'pre-wrap' }}>“{item.tts.text}”</p>
          <p className="ed-note">Voice {item.tts.voice} · {item.tts.speed}×</p>
        </Section>
      )}
    </>
  )
}

// ---------- text ----------

const WEIGHTS = [300, 400, 500, 600, 700, 800, 900]

function TextTab({ item }: { item: TextItem }) {
  const [text, setText] = useState(item.text)
  useEffect(() => setText(item.text), [item.text, item.id])
  const st = item.style
  const set = (patch: Partial<TextStyle>, label: string, key?: string) => {
    const cur = live<TextItem>(item.id) ?? item
    up<TextItem>(cur, { style: { ...cur.style, ...patch } }, label, key ? `${key}:${item.id}` : undefined)
  }
  return (
    <>
      <Section title="Content">
        <textarea
          className="ed-textarea"
          rows={3}
          value={text}
          onChange={(e) => {
            setText(e.target.value)
            up<TextItem>(item, { text: e.target.value, name: e.target.value.split('\n')[0].slice(0, 40) || 'Text' }, 'Edit text', `text:${item.id}`)
          }}
          onBlur={() => useEditor.getState().endCoalesce()}
        />
      </Section>
      <Section title="Font">
        <Field label="Family">
          <select className="ed-select" value={st.fontFamily} style={{ fontFamily: st.fontFamily }} onChange={(e) => set({ fontFamily: e.target.value }, 'Font')}>
            {FONTS.map((f) => (
              <option key={f} value={f} style={{ fontFamily: f }}>{f}</option>
            ))}
          </select>
        </Field>
        <Field label="Size / weight">
          <div className="row" style={{ gap: 6, flex: 1, minWidth: 0 }}>
            <NumberInput value={st.fontSize} min={8} max={600} onChange={(v) => set({ fontSize: v }, 'Font size')} suffix="px" width={74} />
            <select className="ed-select" style={{ flex: 1, minWidth: 64 }} value={st.fontWeight} onChange={(e) => set({ fontWeight: +e.target.value }, 'Font weight')}>
              {WEIGHTS.map((w) => (
                <option key={w} value={w}>{w}</option>
              ))}
            </select>
          </div>
        </Field>
        <Field label="Style">
          <div className="row" style={{ gap: 4, flexWrap: 'wrap' }}>
            <button className={clsx('ed-iconbtn', st.fontWeight >= 700 && 'on')} title="Bold" onClick={() => set({ fontWeight: st.fontWeight >= 700 ? 400 : 700 }, 'Bold')}><Bold size={14} /></button>
            <button className={clsx('ed-iconbtn', st.italic && 'on')} title="Italic" onClick={() => set({ italic: !st.italic }, 'Italic')}><Italic size={14} /></button>
            <button className={clsx('ed-iconbtn', st.underline && 'on')} title="Underline" onClick={() => set({ underline: !st.underline }, 'Underline')}><Underline size={14} /></button>
            <button className={clsx('ed-iconbtn', st.uppercase && 'on')} title="Uppercase" onClick={() => set({ uppercase: !st.uppercase }, 'Case')}><CaseUpper size={14} /></button>
            <div className="ed-vsep" />
            {(['left', 'center', 'right'] as const).map((a) => (
              <button key={a} className={clsx('ed-iconbtn', st.align === a && 'on')} title={`Align ${a}`} onClick={() => set({ align: a }, 'Align')}>
                {a === 'left' ? <AlignLeft size={14} /> : a === 'center' ? <AlignCenter size={14} /> : <AlignRight size={14} />}
              </button>
            ))}
          </div>
        </Field>
        <Slider label="Letter spacing" value={st.letterSpacing} min={-10} max={40} step={0.5} suffix="px" onChange={(v) => set({ letterSpacing: v }, 'Letter spacing', 'ls')} />
        <Slider label="Line height" value={st.lineHeight} min={0.7} max={2.5} step={0.05} onChange={(v) => set({ lineHeight: v }, 'Line height', 'lh')} />
        <Slider label="Box width" value={st.boxWidth} min={100} max={Math.max(3000, st.boxWidth)} step={10} suffix="px" onChange={(v) => set({ boxWidth: v }, 'Text width', 'bw')} />
      </Section>
      <Section title="Fill & stroke">
        <Field label="Fill">
          <ColorInput value={st.color} onChange={(v) => set({ color: v }, 'Text colour', 'col')} />
        </Field>
        <OptionalGroup label="Stroke" on={!!st.stroke} onToggle={(v) => set({ stroke: v ? { color: '#000000', width: 4 } : undefined }, 'Stroke')}>
          {st.stroke && (
            <>
              <Field label="Colour"><ColorInput value={st.stroke.color} onChange={(v) => set({ stroke: { ...st.stroke!, color: v } }, 'Stroke colour', 'sc')} /></Field>
              <Slider label="Width" value={st.stroke.width} min={0} max={30} step={0.5} suffix="px" onChange={(v) => set({ stroke: { ...(live<TextItem>(item.id)?.style.stroke ?? st.stroke!), width: v } }, 'Stroke width', 'sw')} />
            </>
          )}
        </OptionalGroup>
        <OptionalGroup label="Background" on={!!st.background} onToggle={(v) => set({ background: v ? { color: '#000000', radius: 10, padding: 16, opacity: 0.8 } : undefined }, 'Text background')}>
          {st.background && (
            <>
              <Field label="Colour"><ColorInput value={st.background.color} onChange={(v) => set({ background: { ...st.background!, color: v } }, 'Background colour', 'bgc')} /></Field>
              <Slider label="Opacity" value={st.background.opacity} min={0} max={1} step={0.01} display={{ to: (v) => v * 100, from: (v) => v / 100, step: 1 }} suffix="%" onChange={(v) => set({ background: { ...(live<TextItem>(item.id)?.style.background ?? st.background!), opacity: v } }, 'Background opacity', 'bgo')} />
              <Slider label="Radius" value={st.background.radius} min={0} max={60} onChange={(v) => set({ background: { ...(live<TextItem>(item.id)?.style.background ?? st.background!), radius: v } }, 'Background radius', 'bgr')} suffix="px" />
              <Slider label="Padding" value={st.background.padding} min={0} max={80} onChange={(v) => set({ background: { ...(live<TextItem>(item.id)?.style.background ?? st.background!), padding: v } }, 'Background padding', 'bgp')} suffix="px" />
            </>
          )}
        </OptionalGroup>
      </Section>
      <Section title="Shadow & glow">
        <OptionalGroup label="Shadow" on={!!st.shadow} onToggle={(v) => set({ shadow: v ? { color: 'rgba(0,0,0,0.6)', blur: 12, x: 0, y: 4 } : undefined }, 'Shadow')}>
          {st.shadow && (
            <>
              <Field label="Colour"><ColorInput value={st.shadow.color} onChange={(v) => set({ shadow: { ...st.shadow!, color: v } }, 'Shadow colour', 'shc')} /></Field>
              <Slider label="Blur" value={st.shadow.blur} min={0} max={60} suffix="px" onChange={(v) => set({ shadow: { ...(live<TextItem>(item.id)?.style.shadow ?? st.shadow!), blur: v } }, 'Shadow blur', 'shb')} />
              <Slider label="Offset X" value={st.shadow.x} min={-40} max={40} suffix="px" onChange={(v) => set({ shadow: { ...(live<TextItem>(item.id)?.style.shadow ?? st.shadow!), x: v } }, 'Shadow X', 'shx')} />
              <Slider label="Offset Y" value={st.shadow.y} min={-40} max={40} suffix="px" onChange={(v) => set({ shadow: { ...(live<TextItem>(item.id)?.style.shadow ?? st.shadow!), y: v } }, 'Shadow Y', 'shy')} />
            </>
          )}
        </OptionalGroup>
        <OptionalGroup label="Glow" on={!!st.glow} onToggle={(v) => set({ glow: v ? { color: '#35e0ff', blur: 20 } : undefined }, 'Glow')}>
          {st.glow && (
            <>
              <Field label="Colour"><ColorInput value={st.glow.color} onChange={(v) => set({ glow: { ...st.glow!, color: v } }, 'Glow colour', 'glc')} /></Field>
              <Slider label="Size" value={st.glow.blur} min={0} max={80} suffix="px" onChange={(v) => set({ glow: { ...(live<TextItem>(item.id)?.style.glow ?? st.glow!), blur: v } }, 'Glow size', 'glb')} />
            </>
          )}
        </OptionalGroup>
      </Section>
      <Section title="Opacity">
        <PropSlider item={item} prop="opacity" label="Opacity" min={0} max={1} step={0.01} pct />
      </Section>
    </>
  )
}

function OptionalGroup({ label, on, onToggle, children }: { label: string; on: boolean; onToggle: (v: boolean) => void; children: React.ReactNode }) {
  return (
    <div className={clsx('ed-optgroup', on && 'on')}>
      <Field label={label}>
        <Toggle checked={on} onChange={onToggle} />
      </Field>
      {on && <div className="ed-optbody">{children}</div>}
    </div>
  )
}

// ---------- shape ----------

function ShapeTab({ item }: { item: ShapeItem }) {
  return (
    <Section title="Shape">
      <Field label="Type">
        <Segmented value={item.shape} options={[{ value: 'rect', label: 'Rect' }, { value: 'ellipse', label: 'Ellipse' }, { value: 'line', label: 'Line' }]} onChange={(v) => up<ShapeItem>(item, { shape: v }, 'Shape')} />
      </Field>
      <Field label="Fill"><ColorInput value={item.fill} onChange={(v) => up<ShapeItem>(item, { fill: v }, 'Shape fill', `sf:${item.id}`)} /></Field>
      <Slider label="Width" value={item.width} min={2} max={4000} onChange={(v) => up<ShapeItem>(item, { width: v }, 'Shape width', `sw:${item.id}`)} suffix="px" />
      <Slider label="Height" value={item.height} min={2} max={4000} onChange={(v) => up<ShapeItem>(item, { height: v }, 'Shape height', `sh:${item.id}`)} suffix="px" />
      <Slider label="Radius" value={item.radius} min={0} max={400} onChange={(v) => up<ShapeItem>(item, { radius: v }, 'Shape radius', `sr:${item.id}`)} suffix="px" />
    </Section>
  )
}

// ---------- captions ----------

export function CaptionStyleEditor({ track }: { track: Track }) {
  const cs = track.captionStyle ?? captionStyleFromPreset('clean')
  const set = (patch: Partial<CaptionStyle>, label: string, key?: string) => {
    const s = useEditor.getState()
    const t = s.project.tracks.find((x) => x.id === track.id)
    const cur = t?.captionStyle ?? cs
    let p = updateTrack(s.project, track.id, { captionStyle: { ...cur, ...patch } })
    // words-per-line changes re-chunk the lines
    if (patch.maxWordsPerLine !== undefined) p = generateCaptions(p, { style: { ...cur, ...patch } })
    s.commit(p, label, key ? { coalesce: `${key}:${track.id}` } : undefined)
  }
  const setStyle = (patch: Partial<TextStyle>, label: string, key?: string) => {
    const t = useEditor.getState().project.tracks.find((x) => x.id === track.id)
    const cur = t?.captionStyle ?? cs
    set({ style: { ...cur.style, ...patch } }, label, key)
  }
  return (
    <>
      <Section title="Caption style">
        <div className="ed-capgrid">
          {CAPTION_PRESETS.map((p) => (
            <button
              key={p.id}
              className={clsx(cs.preset === p.id && 'on')}
              onClick={() => {
                const next = captionStyleFromPreset(p.id)
                set({ ...next, position: cs.position }, `Caption style ${p.name}`)
              }}
            >
              <CaptionPresetPreview id={p.id} />
              <small>{p.name}</small>
            </button>
          ))}
        </div>
        <Field label="Mode">
          <Segmented value={cs.mode} options={[{ value: 'line', label: 'Line' }, { value: 'word', label: 'Word' }, { value: 'karaoke', label: 'Karaoke' }]} onChange={(v) => set({ mode: v }, 'Caption mode')} />
        </Field>
        <Slider label="Position" value={cs.position} min={0.05} max={0.95} step={0.01} display={{ to: (v) => v * 100, from: (v) => v / 100, step: 1 }} suffix="%" onChange={(v) => set({ position: v }, 'Caption position', 'cpos')} />
        <Slider label="Words / line" value={cs.maxWordsPerLine} min={1} max={14} step={1} onChange={(v) => set({ maxWordsPerLine: v }, 'Words per line', 'cwpl')} />
      </Section>
      <Section title="Caption text">
        <Field label="Font">
          <select className="ed-select" value={cs.style.fontFamily} onChange={(e) => setStyle({ fontFamily: e.target.value }, 'Caption font')}>
            {FONTS.map((f) => (
              <option key={f} value={f}>{f}</option>
            ))}
          </select>
        </Field>
        <Slider label="Size" value={cs.style.fontSize} min={16} max={200} suffix="px" onChange={(v) => setStyle({ fontSize: v }, 'Caption size', 'csz')} />
        <Field label="Weight">
          <select className="ed-select" value={cs.style.fontWeight} onChange={(e) => setStyle({ fontWeight: +e.target.value }, 'Caption weight')}>
            {WEIGHTS.map((w) => (
              <option key={w} value={w}>{w}</option>
            ))}
          </select>
        </Field>
        <Field label="Colour"><ColorInput value={cs.style.color} onChange={(v) => setStyle({ color: v }, 'Caption colour', 'ccol')} /></Field>
        <Field label="Highlight"><ColorInput value={cs.highlightColor} onChange={(v) => set({ highlightColor: v }, 'Highlight colour', 'chl')} /></Field>
        <Field label="Uppercase"><Toggle checked={cs.style.uppercase} onChange={(v) => setStyle({ uppercase: v }, 'Caption case')} /></Field>
        <Field label="Box">
          <Toggle
            checked={!!cs.style.background}
            onChange={(v) => setStyle({ background: v ? { color: '#000000', radius: 10, padding: 14, opacity: 0.7 } : undefined }, 'Caption box')}
          />
        </Field>
        <Field label="Outline">
          <Toggle checked={!!cs.style.stroke} onChange={(v) => setStyle({ stroke: v ? { color: '#000000', width: 6 } : undefined }, 'Caption outline')} />
        </Field>
      </Section>
    </>
  )
}

export function CaptionPresetPreview({ id }: { id: string }) {
  const p = CAPTION_PRESETS.find((c) => c.id === id)!
  const s = p.caption.style
  const words = ['Make', 'it', 'pop']
  return (
    <span
      className="ed-cappreview"
      style={{
        fontFamily: s.fontFamily,
        fontWeight: s.fontWeight,
        fontStyle: s.italic ? 'italic' : undefined,
        textTransform: s.uppercase ? 'uppercase' : undefined,
        color: s.color,
        WebkitTextStroke: s.stroke ? `${Math.max(1, s.stroke.width / 5)}px ${s.stroke.color}` : undefined,
        paintOrder: 'stroke fill',
        background: s.background ? `rgba(0,0,0,${s.background.opacity})` : undefined,
        textShadow: s.shadow ? '0 1px 4px rgba(0,0,0,.8)' : undefined,
      }}
    >
      {p.caption.mode === 'word' ? 'POP' : words.map((w, i) => (
        <span key={w} style={{ color: p.caption.mode === 'karaoke' && i === 1 ? p.caption.highlightColor : undefined }}>{w} </span>
      ))}
    </span>
  )
}

function CaptionTab({ item, track }: { item: CaptionItem; track: Track }) {
  const [text, setText] = useState(item.text)
  useEffect(() => setText(item.text), [item.text, item.id])
  return (
    <>
      <Section title="This caption">
        <textarea
          className="ed-textarea"
          rows={2}
          value={text}
          onChange={(e) => {
            setText(e.target.value)
            // editing text drops per-word timing (it no longer matches)
            up<CaptionItem>(item, { text: e.target.value, words: undefined }, 'Edit caption', `cap:${item.id}`)
          }}
          onBlur={() => useEditor.getState().endCoalesce()}
        />
      </Section>
      <CaptionStyleEditor track={track} />
    </>
  )
}
