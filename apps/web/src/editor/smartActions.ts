// Smart tools in the editor (E-21): masks and the chroma key (document edits, one undo step each), editing a mask on
// the canvas, the key colour eyedropper, and the server jobs that make a stabilised, denoised or background-removed
// copy of a clip's media, swapped in when done (one undo step: Undo puts the original back).
import type { ChromaKey, Item, Mask, MaskProp, MaskShape, Project, SmartJobRequest, SmartJobResult, SmartTool, SmartToolsInfo } from '@producer/core'
import {
  applyProcessedCopy,
  clipSourceRange,
  defaultMask,
  editable,
  findItem,
  hexColor,
  pathMask,
  setChromaKey,
  setMask,
  takesMask,
  writeMaskProps,
} from '@producer/core'
import { create } from 'zustand'
import { api, waitForJob } from '../lib/api'
import { toast, toastError } from '../lib/toast'
import { LOCKED_NOTE, demoBlocked, localTime } from './actions'
import { parseTransform } from './canvasActions'
import { useEditor } from './store'
import { useLibrary } from './uploads'

const S = () => useEditor.getState()

/** A smart tool as the panel offers it: denoise comes as two (sound, picture). */
export type ToolChoice = 'stabilise' | 'denoiseAudio' | 'denoiseVideo' | 'removeBackground'

export const TOOL_LABEL: Record<ToolChoice, string> = {
  stabilise: 'Stabilise',
  denoiseAudio: 'Clean up sound',
  denoiseVideo: 'Clean up picture',
  removeBackground: 'Remove background',
}

const DONE: Record<ToolChoice, string> = {
  stabilise: 'Stabilised',
  denoiseAudio: 'Sound cleaned up',
  denoiseVideo: 'Picture cleaned up',
  removeBackground: 'Background removed',
}

export interface RunningTool {
  tool: ToolChoice
  jobId?: string
  progress: number
  message: string
}

interface SmartState {
  /** What the server can do (GET /api/smart-tools), once asked. */
  tools?: SmartToolsInfo
  toolsError?: string
  /** The clip whose mask has handles on the canvas. */
  maskEdit: string | null
  /** Drawing a path mask: the clip and the corners so far (fractions of its frame). */
  drawing: { itemId: string; points: Array<[number, number]> } | null
  /** Picking a key colour on the canvas for this clip. */
  picking: string | null
  /** Smart tool jobs running, by clip. */
  running: Record<string, RunningTool>
}

export const useSmart = create<SmartState>(() => ({ maskEdit: null, drawing: null, picking: null, running: {} }))

let asking: Promise<void> | undefined

/** Ask the server what it can do (once; again after a failure). */
export function loadSmartTools(): Promise<void> {
  if (useSmart.getState().tools || S().demo) return Promise.resolve()
  asking ??= api
    .smartTools()
    .then((tools) => useSmart.setState({ tools, toolsError: undefined }))
    .catch((e: unknown) => useSmart.setState({ toolsError: e instanceof Error ? e.message : String(e) }))
    .finally(() => (asking = undefined))
  return asking
}

/** The clip, when it can still be changed (says why not when it can't). */
function changeable(itemId: string): Item | null {
  const f = findItem(S().project, itemId)
  if (!f) return null
  if (!editable(f)) {
    toast(LOCKED_NOTE)
    return null
  }
  return f.item
}

// ---------- masks ----------

/** Give the clip a mask of `shape` (keeping its feather, expansion and invert), or take it off (null). */
export function setItemMask(itemId: string, shape: MaskShape | null) {
  const it = changeable(itemId)
  if (!takesMask(it ?? undefined)) return
  const s = S()
  const cur = (it as Extract<Item, { mask?: Mask }>).mask
  if (!shape) {
    s.commit(setMask(s.project, itemId, undefined), 'Remove mask')
    useSmart.setState({ maskEdit: null, drawing: null })
    return
  }
  if (cur?.shape === shape) return
  const next = { ...defaultMask(shape), ...(cur ? { feather: cur.feather, expand: cur.expand, invert: cur.invert } : {}) }
  s.commit(setMask(s.project, itemId, next), cur ? 'Change mask shape' : 'Add mask')
  // the handles come up with it
  useSmart.setState({ maskEdit: itemId })
}

/** Change mask settings that take no keyframes (invert, corner radius). */
export function patchMask(itemId: string, patch: Partial<Mask>, label: string, coalesce?: string) {
  const it = changeable(itemId)
  if (!takesMask(it ?? undefined) || !(it as { mask?: Mask }).mask) return
  const s = S()
  s.commit(setMask(s.project, itemId, { ...(it as { mask: Mask }).mask, ...patch }), label, coalesce ? { coalesce } : undefined)
}

/** Set mask numbers at the playhead (through their keyframes when they have any). */
export function writeMask(itemId: string, values: Partial<Record<MaskProp, number>>, label: string, coalesce?: string, base?: Project) {
  const s = S()
  const it = findItem(base ?? s.project, itemId)?.item
  if (!it) return
  const p = writeMaskProps(base ?? s.project, itemId, values, localTime(it, s.playhead))
  if (p !== s.project) s.commit(p, label, coalesce ? { coalesce } : undefined)
}

export function startDrawing(itemId: string) {
  if (!changeable(itemId)) return
  useEditor.setState({ playing: false })
  useSmart.setState({ drawing: { itemId, points: [] }, maskEdit: null, picking: null })
}

export function addDrawPoint(pt: [number, number]) {
  const d = useSmart.getState().drawing
  if (d) useSmart.setState({ drawing: { ...d, points: [...d.points, pt] } })
}

export function undoDrawPoint() {
  const d = useSmart.getState().drawing
  if (d) useSmart.setState({ drawing: { ...d, points: d.points.slice(0, -1) } })
}

/** Close the path into the clip's mask (at least three corners). */
export function finishDrawing(): boolean {
  const d = useSmart.getState().drawing
  if (!d) return false
  const it = findItem(S().project, d.itemId)?.item as Extract<Item, { mask?: Mask }> | undefined
  const m = pathMask(d.points, it?.mask ? { ...it.mask } : undefined)
  if (!m) {
    toast('A drawn mask needs at least three points: click on the picture to add them')
    return false
  }
  const s = S()
  s.commit(setMask(s.project, d.itemId, m), 'Draw mask')
  useSmart.setState({ drawing: null, maskEdit: d.itemId })
  return true
}

export const cancelDrawing = () => useSmart.setState({ drawing: null })

// ---------- chroma key ----------

export function setItemKey(itemId: string, key: Partial<ChromaKey> | undefined, label: string, coalesce?: string) {
  if (!changeable(itemId)) return
  const s = S()
  const p = setChromaKey(s.project, itemId, key)
  if (p !== s.project) s.commit(p, label, coalesce ? { coalesce } : undefined)
}

export function startPicking(itemId: string) {
  if (!changeable(itemId)) return
  useEditor.setState({ playing: false })
  useSmart.setState({ picking: itemId, drawing: null })
}

export const cancelPicking = () => useSmart.setState({ picking: null })

/**
 * Where a point on screen falls in a clip's frame (fractions of its layer box, 0..1 inside it), from the layer's
 * place on the canvas: `canvasPt` is in canvas px.
 */
export function frameFraction(layer: { box: { cx: number; cy: number; width: number; height: number }; transform: string }, canvasPt: { x: number; y: number }, height = layer.box.height): [number, number] {
  const { rot, sx, sy } = parseTransform(layer.transform)
  const a = (-rot * Math.PI) / 180
  const dx = canvasPt.x - layer.box.cx
  const dy = canvasPt.y - layer.box.cy
  const ux = (dx * Math.cos(a) - dy * Math.sin(a)) / (sx || 1)
  const uy = (dx * Math.sin(a) + dy * Math.cos(a)) / (sy || 1)
  return [ux / Math.max(1, layer.box.width) + 0.5, uy / Math.max(1, height) + 0.5]
}

/**
 * The colour of a clip's own picture (before its key and colour filters) at a point of its frame, averaged over a few
 * pixels. Null when the picture isn't drawn yet or can't be read.
 */
export function samplePicture(itemId: string, fx: number, fy: number): string | null {
  const it = findItem(S().project, itemId)?.item
  const media = document.querySelector(`.cv-stage [data-ps-layer="${itemId.replace(/["\\]/g, '\\$&')}"] [data-ps-content]`) as HTMLVideoElement | HTMLImageElement | null
  if (!it || !media) return null
  const w = media instanceof HTMLVideoElement ? media.videoWidth : media.naturalWidth
  const h = media instanceof HTMLVideoElement ? media.videoHeight : media.naturalHeight
  if (!w || !h) return null
  // the box shows the uncropped part of the frame
  const crop = 'crop' in it && it.crop ? it.crop : { left: 0, right: 0, top: 0, bottom: 0 }
  const u = crop.left + Math.min(1, Math.max(0, fx)) * (1 - crop.left - crop.right)
  const v = crop.top + Math.min(1, Math.max(0, fy)) * (1 - crop.top - crop.bottom)
  const c = document.createElement('canvas')
  c.width = c.height = 5
  const g = c.getContext('2d', { willReadFrequently: true })
  if (!g) return null
  try {
    g.drawImage(media, Math.max(0, u * w - 2.5), Math.max(0, v * h - 2.5), 5, 5, 0, 0, 5, 5)
    const d = g.getImageData(0, 0, 5, 5).data
    let r = 0
    let gr = 0
    let b = 0
    for (let i = 0; i < d.length; i += 4) {
      r += d[i]
      gr += d[i + 1]
      b += d[i + 2]
    }
    const n = d.length / 4
    return hexColor(r / n, gr / n, b / n)
  } catch {
    // a picture from another origin can't be read
    return null
  }
}

/** The eyedropper: key the colour under the pointer. */
export function pickKeyAt(itemId: string, fx: number, fy: number): boolean {
  const color = samplePicture(itemId, fx, fy)
  useSmart.setState({ picking: null })
  if (!color) {
    toast('Couldn’t read the colour there: wait for the picture to load, or type the colour')
    return false
  }
  const it = findItem(S().project, itemId)?.item as Extract<Item, { chromaKey?: ChromaKey }> | undefined
  setItemKey(itemId, { ...(it?.chromaKey ?? {}), color }, 'Pick key colour')
  return true
}

// ---------- server jobs ----------

const REFUSED = {
  missing: 'The clip is gone',
  locked: LOCKED_NOTE,
  kind: 'The copy is a different kind of media from the clip',
  same: 'The clip already uses this copy',
} as const

export function toolAvailable(tools: SmartToolsInfo | undefined, choice: ToolChoice): boolean {
  if (!tools) return false
  if (choice === 'stabilise') return !!tools.stabilise
  if (choice === 'denoiseAudio') return tools.denoise.audio.length > 0
  if (choice === 'denoiseVideo') return tools.denoise.video.length > 0
  return tools.removeBackground.available
}

/** Why a tool can't run here (for the panel), or undefined. */
export function toolUnavailable(tools: SmartToolsInfo | undefined, choice: ToolChoice): string | undefined {
  if (!tools || toolAvailable(tools, choice)) return undefined
  const tool: SmartTool = choice === 'stabilise' ? 'stabilise' : choice === 'removeBackground' ? 'removeBackground' : 'denoise'
  return tools.why[tool] ?? `${TOOL_LABEL[choice]} is not available on this server`
}

function setRunning(itemId: string, r: RunningTool | null) {
  const { [itemId]: _, ...rest } = useSmart.getState().running
  useSmart.setState({ running: r ? { ...rest, [itemId]: r } : rest })
}

/**
 * Make a processed copy of the clip's media on the server and swap it in. The copy covers the part of the file the
 * clip shows (a second either side); sound is cleaned over the whole file so the picture can be copied untouched.
 */
export async function runSmartTool(itemId: string, choice: ToolChoice, opts: { strength?: number; smoothing?: number; method?: string } = {}) {
  if (demoBlocked('smart tools')) return
  const it = changeable(itemId)
  if (!it || !('assetId' in it)) return
  if (useSmart.getState().running[itemId]) return toast('This clip is already being processed')
  const s = S()
  const session = s.session
  const asset = s.project.assets[it.assetId]
  const range = choice === 'denoiseAudio' ? null : clipSourceRange(it, 1, asset?.duration)
  const body: SmartJobRequest = { ...(range ?? {}) }
  if (choice === 'stabilise') body.smoothing = opts.smoothing
  if (choice === 'denoiseAudio' || choice === 'denoiseVideo') {
    body.target = choice === 'denoiseAudio' ? 'audio' : 'video'
    body.strength = opts.strength
    if (opts.method) body.method = opts.method
    // the separated sound of a video: a sound file, so only that clip changes
    if (it.type === 'audio' && asset?.kind === 'video') body.soundOnly = true
  }
  const tool = choice === 'stabilise' ? 'stabilise' : choice === 'removeBackground' ? 'remove-background' : 'denoise'
  setRunning(itemId, { tool: choice, progress: 0, message: 'Starting' })
  try {
    const job = await api.smartTool(it.assetId, tool, body)
    setRunning(itemId, { tool: choice, jobId: job.id, progress: 0, message: job.message })
    const done = await waitForJob<SmartJobResult>(job.id, (j) => useSmart.getState().running[itemId] && setRunning(itemId, { tool: choice, jobId: job.id, progress: j.progress, message: j.message }))
    const result = done.result
    if (!result) throw new Error('The job ended without a copy')
    const rec = result.asset
    const recs = useLibrary.getState().records
    if (!recs.some((r) => r.asset.id === rec.asset.id)) useLibrary.setState({ records: [rec, ...recs] })
    const now = S()
    // another project opened, or the clip changed its media or went away meanwhile: the copy stays in the library
    const cur = findItem(now.project, itemId)?.item
    if (now.session !== session) return
    if (!cur || !('assetId' in cur) || cur.assetId !== it.assetId) return toast(`${DONE[choice]}: the clip changed meanwhile, so the copy is in the media library`)
    const r = applyProcessedCopy(now.project, itemId, rec.asset, result.offset)
    if (r.refused) return toast(REFUSED[r.refused])
    now.commit(r.project, TOOL_LABEL[choice], { selection: [itemId] })
    toast(`${DONE[choice]}. Undo puts the original back.`)
  } catch (e) {
    if (!/cancelled/i.test(e instanceof Error ? e.message : '')) toastError(e, `Couldn’t ${TOOL_LABEL[choice].toLowerCase()}`)
  } finally {
    setRunning(itemId, null)
  }
}

/** Stop a running smart tool job. */
export async function cancelSmartTool(itemId: string) {
  const r = useSmart.getState().running[itemId]
  if (!r?.jobId) return
  try {
    await api.cancelJob(r.jobId)
  } catch (e) {
    toastError(e, 'Couldn’t stop it')
  }
}
