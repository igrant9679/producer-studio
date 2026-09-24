// Effects, Transitions and Filters panels. Each card previews on a sample frame with a CSS approximation.
import type { EffectType, TransitionType, VideoItem, VisualItem } from '@producer/core'
import { EFFECTS, FILTERS, NEUTRAL_ADJUST, TRANSITIONS, adjustToFilter, findItem, uid, updateItem } from '@producer/core'
import clsx from 'clsx'
import { X } from 'lucide-react'
import { useState } from 'react'
import { toast } from '../../lib/toast'
import * as A from '../actions'
import { Slider } from '../controls'
import { endDrag, startDrag, thumbUrl } from '../media'
import { useEditor } from '../store'

function useSampleFrames(): [string | undefined, string | undefined] {
  const assets = useEditor((s) => s.project.assets)
  const sel = useEditor((s) => s.selection)
  const project = useEditor.getState().project
  const selAsset = sel.map((id) => findItem(project, id)?.item).find((i) => i && 'assetId' in i && i.type !== 'audio') as { assetId: string } | undefined
  const visuals = Object.values(assets).filter((a) => a.kind !== 'audio')
  const first = selAsset ? assets[selAsset.assetId] : visuals[0]
  const second = visuals.find((a) => a.id !== first?.id)
  return [first ? thumbUrl(first) : undefined, second ? thumbUrl(second) : undefined]
}

function Sample({ src, style, className }: { src?: string; style?: React.CSSProperties; className?: string }) {
  return src ? <img src={src} alt="" draggable={false} className={className} style={style} /> : <div className={clsx('fx-ph', className)} style={style} />
}

const cats = <T extends { category: string }>(list: T[]) => [...new Set(list.map((x) => x.category))]

// ---------- effects ----------

export function EffectsPanel() {
  const [a] = useSampleFrames()
  const selection = useEditor((s) => s.selection)
  const project = useEditor((s) => s.project)
  const targets = A.selectedItems(project, selection).filter((i): i is VisualItem => 'effects' in i)
  const primary = targets[targets.length - 1]
  const apply = (type: EffectType) => {
    if (!targets.length) return toast('Select a clip, then pick an effect (or drag it onto a clip)')
    let p = project
    for (const t of targets) p = updateItem<VisualItem>(p, t.id, { effects: [...t.effects.filter((e) => e.type !== type), { id: uid('fx'), type, intensity: 60 }] })
    useEditor.getState().commit(p, 'Add effect')
  }
  return (
    <>
      {primary && primary.effects.length > 0 && (
        <div className="ed-applied">
          <div className="eyebrow">On selected clip</div>
          {primary.effects.map((fx) => (
            <div key={fx.id} className="ed-fxrow">
              <Slider
                label={EFFECTS.find((e) => e.id === fx.type)?.name ?? fx.type}
                value={fx.intensity}
                min={0}
                max={100}
                onChange={(v) => {
                  const s = useEditor.getState()
                  const cur = findItem(s.project, primary.id)?.item as VisualItem
                  s.commit(updateItem<VisualItem>(s.project, primary.id, { effects: cur.effects.map((e) => (e.id === fx.id ? { ...e, intensity: v } : e)) }), 'Effect intensity', { coalesce: `fx:${fx.id}` })
                }}
                keyframe={
                  <button className="ed-kf" title="Remove" onClick={() => useEditor.getState().commit(updateItem<VisualItem>(project, primary.id, { effects: primary.effects.filter((e) => e.id !== fx.id) }), 'Remove effect')}>
                    <X size={12} />
                  </button>
                }
              />
            </div>
          ))}
        </div>
      )}
      {cats(EFFECTS).map((c) => (
        <div key={c} className="ed-group">
          <div className="eyebrow">{c}</div>
          <div className="ed-grid3">
            {EFFECTS.filter((e) => e.category === c).map((e) => {
              const on = primary?.effects.some((x) => x.type === e.id)
              return (
                <button
                  key={e.id}
                  className={clsx('ed-fxcard', on && 'on')}
                  draggable
                  onDragStart={(ev) => startDrag(ev, { kind: 'effect', type: e.id })}
                  onDragEnd={endDrag}
                  onClick={() => apply(e.id)}
                  title={`${e.name} — click to apply to the selection or drag onto a clip`}
                >
                  <div className={`fx-prev fx-${e.id}`}>
                    <Sample src={a} />
                    <div className="fx-over" />
                  </div>
                  <span>{e.name}</span>
                </button>
              )
            })}
          </div>
        </div>
      ))}
    </>
  )
}

// ---------- transitions ----------

export function TransitionsPanel() {
  const [a, b] = useSampleFrames()
  const [dur, setDur] = useState(0.6)
  const selection = useEditor((s) => s.selection)
  const project = useEditor((s) => s.project)
  const sel = A.selectedItems(project, selection)[0]
  const target = sel ? A.transitionTargetFor(sel.id) : null
  const cur = target ? (findItem(project, target)?.item as VisualItem | undefined)?.transitionOut : undefined
  const apply = (type: TransitionType) => {
    if (!sel) return toast('Select a clip, then pick a transition (or drag it onto a cut)')
    if (!target) return toast('This clip has no touching neighbour on its track')
    A.setTransition(target, type, dur)
  }
  return (
    <>
      <div className="ed-applied">
        <Slider label="Duration" value={dur} min={0.1} max={2} step={0.05} suffix="s" onChange={(v) => {
          setDur(v)
          if (target && cur) {
            const s = useEditor.getState()
            s.commit(updateItem<VisualItem>(s.project, target, { transitionOut: { ...cur, duration: v } }), 'Transition duration', { coalesce: `trd:${target}` })
          }
        }} />
        <p className="ed-note" style={{ margin: '4px 0 0' }}>
          {sel ? (target ? (cur ? `Current: ${TRANSITIONS.find((t) => t.id === cur.type)?.name}` : 'Click a transition to apply it to the cut after the selected clip.') : 'The selected clip has no neighbour to transition to.') : 'Select a clip, or drag a transition onto a cut in the timeline.'}
          {cur && (
            <button className="btn sm ghost" style={{ marginLeft: 6, height: 22 }} onClick={() => A.setTransition(target!, null)}>Remove</button>
          )}
        </p>
      </div>
      {cats(TRANSITIONS).map((c) => (
        <div key={c} className="ed-group">
          <div className="eyebrow">{c}</div>
          <div className="ed-grid3">
            {TRANSITIONS.filter((t) => t.category === c).map((t) => (
              <button
                key={t.id}
                className={clsx('ed-fxcard', cur?.type === t.id && 'on')}
                draggable
                onDragStart={(ev) => startDrag(ev, { kind: 'transition', type: t.id })}
                onDragEnd={endDrag}
                onClick={() => apply(t.id)}
                title={`${t.name} — click to apply or drag onto a cut`}
              >
                <div className={`tr-prev tr-${t.id}`}>
                  <Sample src={a} className="a" />
                  <Sample src={b ?? a} className="b" style={!b ? { filter: 'hue-rotate(140deg)' } : undefined} />
                  <div className="dip" />
                </div>
                <span>{t.name}</span>
              </button>
            ))}
          </div>
        </div>
      ))}
    </>
  )
}

// ---------- filters ----------

export function FiltersPanel() {
  const [a] = useSampleFrames()
  const selection = useEditor((s) => s.selection)
  const project = useEditor((s) => s.project)
  const targets = A.selectedItems(project, selection).filter((i): i is VideoItem => i.type === 'video' || i.type === 'image')
  const primary = targets[targets.length - 1]
  const apply = (id: string | null) => {
    if (!targets.length) return toast('Select a video or image clip, then pick a filter (or drag it onto a clip)')
    let p = project
    for (const t of targets) p = updateItem<VideoItem>(p, t.id, { filter: id ? { id, intensity: t.filter?.intensity ?? 80 } : undefined })
    useEditor.getState().commit(p, id ? 'Apply filter' : 'Remove filter')
  }
  return (
    <>
      {primary?.filter && (
        <div className="ed-applied">
          <Slider
            label="Intensity"
            value={primary.filter.intensity}
            min={0}
            max={100}
            suffix="%"
            onChange={(v) => {
              const s = useEditor.getState()
              let p = s.project
              for (const t of targets) if (t.filter) p = updateItem<VideoItem>(p, t.id, { filter: { id: t.filter.id, intensity: v } })
              s.commit(p, 'Filter intensity', { coalesce: `fi:${primary.id}` })
            }}
          />
        </div>
      )}
      <div className="ed-grid3" style={{ marginBottom: 12 }}>
        <button className={clsx('ed-fxcard', primary && !primary.filter && 'on')} onClick={() => apply(null)}>
          <div className="fx-prev"><Sample src={a} /></div>
          <span>None</span>
        </button>
      </div>
      {cats(FILTERS).map((c) => (
        <div key={c} className="ed-group">
          <div className="eyebrow">{c}</div>
          <div className="ed-grid3">
            {FILTERS.filter((f) => f.category === c).map((f) => (
              <button
                key={f.id}
                className={clsx('ed-fxcard', primary?.filter?.id === f.id && 'on')}
                draggable
                onDragStart={(ev) => startDrag(ev, { kind: 'filter', id: f.id })}
                onDragEnd={endDrag}
                onClick={() => apply(f.id)}
                title={`${f.name} — click to apply or drag onto a clip`}
              >
                <div className="fx-prev">
                  <Sample src={a} style={{ filter: adjustToFilter(NEUTRAL_ADJUST, f.id, 100).filter || undefined }} />
                </div>
                <span>{f.name}</span>
              </button>
            ))}
          </div>
        </div>
      ))}
    </>
  )
}
