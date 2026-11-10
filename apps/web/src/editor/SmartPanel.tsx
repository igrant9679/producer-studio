// The Properties panel's Smart tab (E-21): a shape mask (edited here and with handles on the canvas), a chroma key
// with an eyedropper, the server tools that make a stabilised, denoised or background-removed copy of the clip, and
// Sketch it in (a picture drawn in, stroke by stroke, in its place).
import type { AudioItem, ImageItem, MaskProp, MaskShape, SketchStyleId, VideoItem } from '@producer/core'
import { DEFAULT_KEY, KEY_PRESETS, MASK_PROPS, SKETCH_SECONDS, SKETCH_STYLES, readMaskProp } from '@producer/core'
import { Brush, Circle, Loader2, Pipette, RectangleHorizontal, SquareDashedMousePointer, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useAnnounceChange } from '../lib/announce'
import { useEditGate } from '../shell/ui'
import { localTime } from './actions'
import { ColorInput, Field, KeyframeToggle, Section, Segmented, Slider, Toggle, useThrottledPlayhead } from './controls'
import { KeyframesSection } from './KeyframePanel'
import {
  TOOL_LABEL,
  cancelSmartTool,
  loadSmartTools,
  patchMask,
  runSmartTool,
  setItemKey,
  setItemMask,
  startDrawing,
  startPicking,
  toolUnavailable,
  useSmart,
  writeMask,
  type ToolChoice,
} from './smartActions'
import { useEditor } from './store'
import './smart.css'

type Pictured = VideoItem | ImageItem

export function SmartTab({ item }: { item: VideoItem | ImageItem | AudioItem }) {
  const gate = useEditGate()
  useEffect(() => void loadSmartTools(), [])
  return (
    <div className="ed-smart">
      {!gate.canEdit && <p className="ed-note" role="note">{gate.tip}</p>}
      <fieldset disabled={!gate.canEdit} className="ed-smart-set">
        {item.type !== 'audio' && <MaskSection item={item} />}
        {item.type !== 'audio' && <KeySection item={item} />}
        {item.type !== 'image' && <CleanUpSection item={item} />}
        {item.type === 'image' && <SketchSection item={item} />}
      </fieldset>
    </div>
  )
}

// ---------- mask ----------

const SHAPES: Array<{ value: MaskShape | 'none'; label: React.ReactNode; title: string }> = [
  { value: 'none', label: 'None', title: 'No mask' },
  { value: 'rect', label: <RectangleHorizontal size={14} />, title: 'Rectangle mask' },
  { value: 'ellipse', label: <Circle size={14} />, title: 'Ellipse mask' },
  { value: 'path', label: <Brush size={14} />, title: 'Drawn mask' },
]

const pct = { to: (v: number) => Math.round(v * 1000) / 10, from: (v: number) => v / 100, step: 1 }

function MaskSection({ item }: { item: Pictured }) {
  const playhead = useThrottledPlayhead()
  const editing = useSmart((s) => s.maskEdit === item.id)
  const drawing = useSmart((s) => s.drawing?.itemId === item.id)
  const m = item.mask
  const lt = localTime(item, playhead)
  const val = (p: MaskProp) => readMaskProp(item, p, lt)
  const set = (p: MaskProp, label: string) => (v: number) => writeMask(item.id, { [p]: v }, label, `mask:${p}:${item.id}`)
  const pickShape = (v: MaskShape | 'none') => {
    if (v === 'none') return setItemMask(item.id, null)
    // a drawn mask starts by drawing it on the picture
    if (v === 'path') return startDrawing(item.id)
    setItemMask(item.id, v)
  }
  return (
    <Section title="Mask">
      <Field label="Shape">
        <Segmented size="sm" value={drawing ? 'path' : m?.shape ?? 'none'} options={SHAPES} onChange={pickShape} />
      </Field>
      {drawing && (
        <p className="ed-note" role="status">
          Click on the picture to place the corners; click the first one, double-click or press Enter to close the shape. Backspace takes the last corner back, Escape stops.
        </p>
      )}
      {m && (
        <>
          <div className="row ed-smart-actions">
            <button type="button" className="btn sm" aria-pressed={editing} onClick={() => useSmart.setState({ maskEdit: editing ? null : item.id, drawing: null })}>
              <SquareDashedMousePointer size={13} /> {editing ? 'Done editing on the canvas' : 'Edit on the canvas'}
            </button>
            {m.shape === 'path' && !drawing && (
              <button type="button" className="btn sm" onClick={() => startDrawing(item.id)}>
                <Brush size={13} /> Draw again
              </button>
            )}
          </div>
          <Slider label="Mask X" value={val('maskX')} min={-0.5} max={1.5} step={0.001} display={pct} suffix="%" onChange={set('maskX', 'Mask position')} keyframe={<KeyframeToggle item={item} prop="maskX" />} />
          <Slider label="Mask Y" value={val('maskY')} min={-0.5} max={1.5} step={0.001} display={pct} suffix="%" onChange={set('maskY', 'Mask position')} keyframe={<KeyframeToggle item={item} prop="maskY" />} />
          <Slider label="Mask width" value={val('maskWidth')} min={0.01} max={2} step={0.001} display={pct} suffix="%" onChange={set('maskWidth', 'Mask size')} keyframe={<KeyframeToggle item={item} prop="maskWidth" />} />
          <Slider label="Mask height" value={val('maskHeight')} min={0.01} max={2} step={0.001} display={pct} suffix="%" onChange={set('maskHeight', 'Mask size')} keyframe={<KeyframeToggle item={item} prop="maskHeight" />} />
          <Slider label="Mask rotation" value={val('maskRotation')} min={-180} max={180} step={0.5} suffix="°" onChange={set('maskRotation', 'Mask rotation')} keyframe={<KeyframeToggle item={item} prop="maskRotation" />} />
          <Slider label="Feather" value={val('maskFeather')} min={0} max={200} step={1} suffix="px" onChange={set('maskFeather', 'Mask feather')} keyframe={<KeyframeToggle item={item} prop="maskFeather" />} />
          <Slider label="Expansion" value={val('maskExpand')} min={-200} max={200} step={1} suffix="px" onChange={set('maskExpand', 'Mask expansion')} keyframe={<KeyframeToggle item={item} prop="maskExpand" />} />
          {m.shape === 'rect' && <Slider label="Corner radius" value={m.radius} min={0} max={1} step={0.01} display={pct} suffix="%" onChange={(v) => patchMask(item.id, { radius: v }, 'Mask corners', `mask:r:${item.id}`)} />}
          <Field label="Invert">
            <Toggle checked={m.invert} onChange={(v) => patchMask(item.id, { invert: v }, v ? 'Invert mask' : 'Un-invert mask')} />
          </Field>
          <KeyframesSection item={item} only={MASK_PROPS} />
        </>
      )}
    </Section>
  )
}

// ---------- chroma key ----------

function KeySection({ item }: { item: Pictured }) {
  const picking = useSmart((s) => s.picking === item.id)
  const k = item.chromaKey
  const set = (patch: Partial<typeof DEFAULT_KEY>, label: string, coalesce?: string) => setItemKey(item.id, { ...(k ?? DEFAULT_KEY), ...patch }, label, coalesce)
  return (
    <Section title="Chroma key">
      <Field label="Key out a colour">
        <Toggle checked={!!k} onChange={(on) => setItemKey(item.id, on ? DEFAULT_KEY : undefined, on ? 'Chroma key' : 'Remove chroma key')} />
      </Field>
      {k && (
        <>
          <Field label="Key colour">
            <ColorInput value={k.color} onChange={(c) => /^#[0-9a-f]{6}$/i.test(c) && set({ color: c }, 'Key colour', `key:c:${item.id}`)} />
          </Field>
          <div className="row ed-smart-actions">
            <button type="button" className="btn sm" aria-pressed={picking} onClick={() => (picking ? useSmart.setState({ picking: null }) : startPicking(item.id))}>
              <Pipette size={13} /> {picking ? 'Click the colour on the picture…' : 'Pick from the picture'}
            </button>
            {KEY_PRESETS.map((x) => (
              <button key={x.color} type="button" className="btn sm" onClick={() => set({ color: x.color }, 'Key colour')}>
                <span className="ed-smart-swatch" style={{ background: x.color }} aria-hidden /> {x.name}
              </button>
            ))}
          </div>
          <Slider label="Tolerance" value={k.tolerance} min={0} max={100} onChange={(v) => set({ tolerance: v }, 'Key tolerance', `key:t:${item.id}`)} />
          <Slider label="Softness" value={k.softness} min={0} max={100} onChange={(v) => set({ softness: v }, 'Key softness', `key:s:${item.id}`)} />
          <Slider label="Spill suppression" value={k.spill} min={0} max={100} onChange={(v) => set({ spill: v }, 'Spill suppression', `key:p:${item.id}`)} />
          <p className="ed-note">The key is drawn the same way in the preview and the export.</p>
        </>
      )}
    </Section>
  )
}

// ---------- clean up (server tools) ----------

function CleanUpSection({ item }: { item: VideoItem | AudioItem }) {
  const tools = useSmart((s) => s.tools)
  const toolsError = useSmart((s) => s.toolsError)
  const running = useSmart((s) => s.running[item.id])
  const hasAudio = useEditor((s) => s.project.assets[item.assetId]?.hasAudio !== false)
  const frozen = item.type === 'video' && item.freezeAt !== undefined
  const [strength, setStrength] = useState(50)
  const [smoothing, setSmoothing] = useState(50)
  // said once as a run starts; the finish is a toast
  useAnnounceChange(running ? `${TOOL_LABEL[running.tool]}: started` : undefined)
  const choices: ToolChoice[] = item.type === 'audio' ? ['denoiseAudio'] : ['stabilise', ...(hasAudio ? (['denoiseAudio'] as const) : []), 'denoiseVideo', 'removeBackground']
  return (
    <Section title="Clean up">
      <p className="ed-note">Each makes a processed copy of the part of the file this clip uses and puts it in the clip’s place (Undo puts the original back). The copy is in the media library too.</p>
      {toolsError && (
        <p className="ed-note" role="alert">
          Couldn’t ask the server what it can do: {toolsError}{' '}
          <button type="button" className="btn sm" onClick={() => void loadSmartTools()}>Try again</button>
        </p>
      )}
      {!tools && !toolsError && <p className="ed-note">Asking the server what it can do…</p>}
      {running ? (
        <div className="ed-smart-run">
          <Loader2 size={13} className="spin" aria-hidden />
          <span className="msg">{TOOL_LABEL[running.tool]} · {running.message || 'Working'}</span>
          <progress max={1} value={Math.max(0, running.progress)} aria-label={TOOL_LABEL[running.tool]} />
          <button type="button" className="ed-mini" aria-label={`Stop: ${TOOL_LABEL[running.tool]}`} title="Stop" disabled={!running.jobId} onClick={() => void cancelSmartTool(item.id)}>
            <X size={12} />
          </button>
        </div>
      ) : (
        tools && (
          <>
            {item.type === 'video' && <Slider label="Smoothing" value={smoothing} min={0} max={100} onChange={setSmoothing} />}
            {(hasAudio || item.type === 'video') && <Slider label="Clean-up strength" value={strength} min={0} max={100} onChange={setStrength} />}
            <div className="ed-smart-tools">
              {choices.map((c) => {
                const why = toolUnavailable(tools, c) ?? (frozen && c !== 'denoiseAudio' ? 'A freeze frame shows one picture: there is nothing to process' : undefined)
                return (
                  <div key={c} className="ed-smart-tool">
                    <button type="button" className="btn sm" disabled={!!why} aria-describedby={why ? `why-${c}-${item.id}` : undefined} onClick={() => void runSmartTool(item.id, c, c === 'stabilise' ? { smoothing } : { strength })}>
                      {TOOL_LABEL[c]}
                    </button>
                    {why && (
                      <span className="why" id={`why-${c}-${item.id}`}>
                        {why}
                      </span>
                    )}
                  </div>
                )
              })}
            </div>
          </>
        )
      )}
    </Section>
  )
}

// ---------- sketch it in ----------

const SKETCH_OPTIONS = SKETCH_STYLES.map((s) => ({ value: s.id, label: s.label, title: `${s.label}: ${s.about}` }))

function SketchSection({ item }: { item: ImageItem }) {
  const tools = useSmart((s) => s.tools)
  const toolsError = useSmart((s) => s.toolsError)
  const running = useSmart((s) => s.running[item.id])
  const [style, setStyle] = useState<SketchStyleId>('pencil')
  const [colour, setColour] = useState(true)
  useAnnounceChange(running ? `${TOOL_LABEL[running.tool]}: started` : undefined)
  const why = toolUnavailable(tools, 'sketch')
  const seconds = Math.min(SKETCH_SECONDS.max, Math.max(SKETCH_SECONDS.min, item.duration))
  return (
    <Section title="Sketch">
      <p className="ed-note">
        The picture is drawn in, stroke by stroke, over the clip’s {Math.round(seconds * 10) / 10} seconds{item.duration > SKETCH_SECONDS.max ? ` (the longest a sketch takes is ${SKETCH_SECONDS.max})` : ''}, and put in its place as a video clip with the same framing and effects. Undo puts the picture back; the sketch is in the media library too.
      </p>
      {toolsError && (
        <p className="ed-note" role="alert">
          Couldn’t ask the server what it can do: {toolsError}{' '}
          <button type="button" className="btn sm" onClick={() => void loadSmartTools()}>Try again</button>
        </p>
      )}
      {running ? (
        <div className="ed-smart-run">
          <Loader2 size={13} className="spin" aria-hidden />
          <span className="msg">{TOOL_LABEL[running.tool]} · {running.message || 'Working'}</span>
          <progress max={1} value={Math.max(0, running.progress)} aria-label={TOOL_LABEL[running.tool]} />
          <button type="button" className="ed-mini" aria-label={`Stop: ${TOOL_LABEL[running.tool]}`} title="Stop" disabled={!running.jobId} onClick={() => void cancelSmartTool(item.id)}>
            <X size={12} />
          </button>
        </div>
      ) : (
        tools && (
          <>
            <Field label="Drawn in">
              <Segmented size="sm" value={style} options={SKETCH_OPTIONS} onChange={setStyle} />
            </Field>
            <Field label="Ending">
              <Toggle checked={colour} onChange={setColour} label="Turns into the picture in colour" />
            </Field>
            <div className="ed-smart-tools">
              <div className="ed-smart-tool">
                <button type="button" className="btn sm" disabled={!!why} aria-describedby={why ? `why-sketch-${item.id}` : undefined} onClick={() => void runSmartTool(item.id, 'sketch', { style, colour })}>
                  {TOOL_LABEL.sketch}
                </button>
                {why && (
                  <span className="why" id={`why-sketch-${item.id}`}>
                    {why}
                  </span>
                )}
              </div>
            </div>
          </>
        )
      )}
    </Section>
  )
}
