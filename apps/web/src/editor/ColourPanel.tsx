// The Colour tab (clips, images and adjustment layers): scopes, filter preset, basic colour, curves, HSL by hue
// range and LUTs; the effects list; and an adjustment layer's own tab. The pixel work is core's (colour.ts), drawn by
// the renderer the same way in the preview and the export.
import type { AdjustmentItem, ColorAdjust, CurvePoints, Curves, Effect, Grade, HslShift, HueRange, ImageItem, Item, VideoItem, VisualItem } from '@producer/core'
import { ADJUSTMENT_EFFECTS, CubeError, EFFECTS, FILTERS, HUE_RANGES, NEUTRAL_ADJUST, addLut, adjustToFilter, findItem, parseCube, pruneLuts, uid, updateItem } from '@producer/core'
import clsx from 'clsx'
import { RotateCcw, Upload, X } from 'lucide-react'
import { useRef, useState } from 'react'
import { toast } from '../lib/toast'
import './colour.css'
import { KeyframeToggle, Section, Slider, useThrottledPlayhead } from './controls'
import * as A from './actions'
import { thumbUrl } from './media'
import { Scopes } from './Scopes'
import { useEditor } from './store'
import { ToneCurve } from './ToneCurve'

type Graded = VideoItem | ImageItem | AdjustmentItem

function up<T extends Item>(item: T, patch: Partial<T>, label: string, coalesce?: string) {
  const s = useEditor.getState()
  s.commit(updateItem<T>(s.project, item.id, patch), label, coalesce ? { coalesce } : undefined)
}

/** Current version of the item from the store (props can be stale inside callbacks). */
function live<T extends Item>(id: string): T | undefined {
  return findItem(useEditor.getState().project, id)?.item as T | undefined
}

/** Change the item's grade. */
function setGrade(id: string, f: (g: Grade) => Grade, label: string, coalesce?: string) {
  const s = useEditor.getState()
  const cur = live<Graded>(id)
  if (!cur) return
  const next = f(cur.grade ?? {})
  s.commit(updateItem<Graded>(s.project, id, { grade: next }), label, coalesce ? { coalesce } : undefined)
}

// ---------- effects ----------

export function EffectsSection({ item }: { item: VisualItem | AdjustmentItem }) {
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
              <button className="ed-kf" title="Remove effect" aria-label={`Remove ${EFFECTS.find((e) => e.id === fx.type)?.name ?? fx.type}`} onClick={() => up<VisualItem>(item as VisualItem, { effects: item.effects.filter((e) => e.id !== fx.id) }, 'Remove effect')}>
                <X size={12} />
              </button>
            }
          />
        </div>
      ))}
    </Section>
  )
}

// ---------- colour ----------

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

export function ColourTab({ item }: { item: Graded }) {
  const asset = useEditor((s) => ('assetId' in item ? s.project.assets[item.assetId] : undefined))
  const th = asset ? thumbUrl(asset) : undefined
  const css = adjustToFilter(item.adjust, item.filter?.id, item.filter?.intensity ?? 100).filter
  return (
    <>
      <Section title="Scopes" defaultOpen={false}>
        <Scopes />
      </Section>
      <Section title="Filter">
        {th && (
          <div className="ed-adjpreview">
            <img src={th} alt="" style={{ filter: css || undefined }} />
            <span>Preview</span>
          </div>
        )}
        <div className="ed-field">
          <label htmlFor={`flt-${item.id}`}>Preset</label>
          <div className="ed-field-ctl">
            <select
              id={`flt-${item.id}`}
              className="ed-select"
              value={item.filter?.id ?? ''}
              onChange={(e) => up<Graded>(item, { filter: e.target.value ? { id: e.target.value, intensity: item.filter?.intensity ?? 80 } : undefined }, 'Filter')}
            >
              <option value="">None</option>
              {FILTERS.map((f) => (
                <option key={f.id} value={f.id}>{f.category} · {f.name}</option>
              ))}
            </select>
          </div>
          <div className="ed-field-kf" />
        </div>
        {item.filter && <Slider label="Intensity" value={item.filter.intensity} min={0} max={100} onChange={(v) => up<Graded>(item, { filter: { id: item.filter!.id, intensity: v } }, 'Filter intensity', `fi:${item.id}`)} suffix="%" />}
      </Section>
      <Section
        title="Colour"
        right={
          <button className="ed-mini" title="Reset colour" aria-label="Reset colour" onClick={() => up<Graded>(item, { adjust: { ...NEUTRAL_ADJUST } }, 'Reset colour')}>
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
              const cur = live<Graded>(item.id)
              if (cur) up<Graded>(cur, { adjust: { ...cur.adjust, [k]: v } }, label, `adj:${k}:${item.id}`)
            }}
          />
        ))}
      </Section>
      <CurvesSection item={item} />
      <HslSection item={item} />
      <LutSection item={item} />
      <GradeNote item={item} />
    </>
  )
}

/** Says when the preview can't grade a clip (its media host doesn't share pixels); the export still does. */
function GradeNote({ item }: { item: Graded }) {
  const blocked = typeof document !== 'undefined' && [...document.querySelectorAll<HTMLElement>('[data-ps-grade-blocked]')].some((el) => el.dataset.psLayer === item.id)
  if (!blocked) return null
  return <p className="ed-note" role="note">The preview can't show curves, HSL or the LUT on this clip: its media is served from a host that doesn't allow reading its pixels. The export shows them.</p>
}

type Channel = keyof Curves
const CHANNELS: Array<{ id: Channel; name: string; color: string }> = [
  { id: 'master', name: 'Master', color: 'var(--text)' },
  { id: 'r', name: 'Red', color: '#ff5a5f' },
  { id: 'g', name: 'Green', color: '#3ddc97' },
  { id: 'b', name: 'Blue', color: '#4d8dff' },
]

function curveSet(pts: CurvePoints | undefined): boolean {
  return !!pts && pts.length >= 2 && pts.some(([x, y]) => Math.abs(x - y) > 1e-4)
}

function CurvesSection({ item }: { item: Graded }) {
  const [ch, setCh] = useState<Channel>('master')
  const curves = item.grade?.curves ?? {}
  const setCurve = (pts: CurvePoints | undefined, label = 'Curves') =>
    setGrade(item.id, (g) => ({ ...g, curves: { ...(g.curves ?? {}), [ch]: pts } }), label, `curve:${ch}:${item.id}`)
  const info = CHANNELS.find((c) => c.id === ch)!
  return (
    <Section
      title="Curves"
      right={
        <button className="ed-mini" title="Reset all curves" aria-label="Reset all curves" onClick={() => setGrade(item.id, (g) => ({ ...g, curves: undefined }), 'Reset curves')}>
          <RotateCcw size={12} />
        </button>
      }
    >
      <div className="ed-seg sm" role="group" aria-label="Curve channel">
        {CHANNELS.map((c) => (
          <button key={c.id} type="button" aria-pressed={c.id === ch} className={clsx(c.id === ch && 'on')} onClick={() => setCh(c.id)}>
            {c.name}
            {curveSet(curves[c.id]) && <span className="ed-dot" style={{ background: c.color }} aria-label="(changed)" />}
          </button>
        ))}
      </div>
      <ToneCurve
        key={ch}
        label={`${info.name} curve`}
        color={info.color}
        value={curves[ch]}
        onChange={(pts) => setCurve(pts)}
        onEnd={() => useEditor.getState().endCoalesce()}
      />
      {curveSet(curves[ch]) && (
        <button type="button" className="btn sm" onClick={() => setCurve(undefined, `Reset ${info.name.toLowerCase()} curve`)}>
          Reset {info.name.toLowerCase()}
        </button>
      )}
    </Section>
  )
}

const ZERO: HslShift = { h: 0, s: 0, l: 0 }
const shifted = (s: HslShift | undefined) => !!s && (s.h !== 0 || s.s !== 0 || s.l !== 0)

function HslSection({ item }: { item: Graded }) {
  const [range, setRange] = useState<HueRange>('red')
  const hsl = item.grade?.hsl ?? {}
  const cur = hsl[range] ?? ZERO
  const set = (k: keyof HslShift, v: number, label: string) =>
    setGrade(item.id, (g) => {
      const next = { ...(g.hsl ?? {}), [range]: { ...(g.hsl?.[range] ?? ZERO), [k]: v } }
      if (!shifted(next[range])) delete next[range]
      return { ...g, hsl: Object.keys(next).length ? next : undefined }
    }, label, `hsl:${range}:${k}:${item.id}`)
  const name = HUE_RANGES.find((r) => r.id === range)!.name
  return (
    <Section
      title="HSL"
      right={
        <button className="ed-mini" title="Reset HSL" aria-label="Reset HSL" onClick={() => setGrade(item.id, (g) => ({ ...g, hsl: undefined }), 'Reset HSL')}>
          <RotateCcw size={12} />
        </button>
      }
    >
      <div className="ed-hues" role="group" aria-label="Hue range">
        {HUE_RANGES.map((r) => (
          <button key={r.id} type="button" title={r.name} aria-label={`${r.name}${shifted(hsl[r.id]) ? ' (changed)' : ''}`} aria-pressed={r.id === range} className={clsx(r.id === range && 'on', shifted(hsl[r.id]) && 'set')} style={{ ['--sw' as string]: r.swatch }} onClick={() => setRange(r.id)} />
        ))}
      </div>
      <Slider label={`${name} hue`} value={cur.h} min={-100} max={100} onChange={(v) => set('h', v, `${name} hue`)} />
      <Slider label={`${name} saturation`} value={cur.s} min={-100} max={100} onChange={(v) => set('s', v, `${name} saturation`)} />
      <Slider label={`${name} lightness`} value={cur.l} min={-100} max={100} onChange={(v) => set('l', v, `${name} lightness`)} />
    </Section>
  )
}

/** .cube files bigger than this aren't read (a 65-point LUT is about 7 MB). */
const CUBE_MAX = 20 * 1024 * 1024

function LutSection({ item }: { item: Graded }) {
  const luts = useEditor((s) => s.project.luts) ?? {}
  const file = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)
  const lut = item.grade?.lut
  const unused = useEditor((s) => Object.keys(s.project.luts ?? {}).length - Object.keys(pruneLuts(s.project).luts ?? {}).length)
  const choose = (id: string) => setGrade(item.id, (g) => ({ ...g, lut: id ? { id, intensity: g.lut?.intensity ?? 100 } : undefined }), id ? 'LUT' : 'Remove LUT')
  const load = async (f: File) => {
    if (f.size > CUBE_MAX) return toast(`${f.name} is larger than ${CUBE_MAX / 1024 / 1024} MB: not a .cube LUT this editor can read`)
    setBusy(true)
    try {
      const { lut: data } = parseCube(await f.text())
      const s = useEditor.getState()
      const cur = live<Graded>(item.id)
      if (!cur) return
      const r = addLut(s.project, f.name.replace(/\.cube$/i, ''), data)
      s.commit(updateItem<Graded>(r.project, item.id, { grade: { ...(cur.grade ?? {}), lut: { id: r.id, intensity: cur.grade?.lut?.intensity ?? 100 } } }), 'Load LUT')
    } catch (e) {
      toast(e instanceof CubeError ? `${f.name}: ${e.message}` : `Could not read ${f.name}`)
    } finally {
      setBusy(false)
    }
  }
  return (
    <Section title="LUT">
      <div className="ed-field">
        <label htmlFor={`lut-${item.id}`}>Look</label>
        <div className="ed-field-ctl">
          <select id={`lut-${item.id}`} className="ed-select" value={lut && luts[lut.id] ? lut.id : ''} onChange={(e) => choose(e.target.value)}>
            <option value="">None</option>
            {Object.values(luts).map((l) => (
              <option key={l.id} value={l.id}>{l.name}</option>
            ))}
          </select>
        </div>
        <div className="ed-field-kf" />
      </div>
      {lut && luts[lut.id] && <Slider label="LUT intensity" value={lut.intensity} min={0} max={100} suffix="%" onChange={(v) => setGrade(item.id, (g) => ({ ...g, lut: g.lut && { ...g.lut, intensity: v } }), 'LUT intensity', `lut:${item.id}`)} />}
      <input
        ref={file}
        type="file"
        accept=".cube"
        hidden
        aria-label="LUT file"
        onChange={(e) => {
          const f = e.target.files?.[0]
          e.target.value = ''
          if (f) void load(f)
        }}
      />
      <button type="button" className="btn sm" disabled={busy} onClick={() => file.current?.click()}>
        <Upload size={13} /> Load .cube LUT…
      </button>
      {unused > 0 && (
        <button type="button" className="btn sm" onClick={() => useEditor.getState().commit(pruneLuts(useEditor.getState().project), 'Remove unused LUTs')}>
          Remove {unused} unused LUT{unused > 1 ? 's' : ''}
        </button>
      )}
      <p className="ed-note">Applied after the curves and HSL. LUTs are kept in this project, so the export uses them as you see them.</p>
    </Section>
  )
}

// ---------- adjustment layer ----------

export function AdjustmentLayerTab({ item }: { item: AdjustmentItem }) {
  const playhead = useThrottledPlayhead()
  const strength = A.readProp(item, 'opacity', playhead)
  const has = new Set(item.effects.map((e) => e.type))
  const add = (type: Effect['type']) => {
    const cur = live<AdjustmentItem>(item.id)
    if (cur) up<AdjustmentItem>(cur, { effects: [...cur.effects.filter((e) => e.type !== type), { id: uid('fx'), type, intensity: 60 }] }, 'Add effect')
  }
  return (
    <>
      <Section title="Adjustment layer">
        <p className="ed-note">Everything beneath this layer, for as long as it lasts, takes its colour, filter and effects (its curves, HSL and LUT go onto the clips and images beneath). Set them in the Colour tab.</p>
        <Slider
          label="Strength"
          value={strength}
          min={0}
          max={1}
          step={0.01}
          display={{ to: (v) => v * 100, from: (v) => v / 100, step: 1 }}
          suffix="%"
          neutral={1}
          onChange={(v) => {
            const s = useEditor.getState()
            s.commit(A.writeProp(s.project, item.id, 'opacity', v), 'Strength', { coalesce: `opacity:${item.id}` })
          }}
          keyframe={<KeyframeToggle item={item} prop="opacity" />}
        />
      </Section>
      <Section title="Add an effect">
        <div className="ed-chiprow">
          {ADJUSTMENT_EFFECTS.map((id) => (
            <button key={id} type="button" className={clsx('chip', has.has(id) && 'active')} aria-pressed={has.has(id)} onClick={() => add(id)}>
              {EFFECTS.find((e) => e.id === id)?.name ?? id}
            </button>
          ))}
        </div>
      </Section>
      <EffectsSection item={item} />
    </>
  )
}
