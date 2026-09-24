// Editor-assistant tools: zod-validated inputs mapped onto pure core ops. Each handler mutates `state.project`
// (replacing it with the op's result) and records a human-readable change.
import * as z from 'zod/v4'
import {
  ANIMATION_PRESETS,
  ASPECT_RATIOS,
  CAPTION_PRESETS,
  EFFECTS,
  FILTERS,
  FONTS,
  TEXT_TEMPLATES,
  TRANSITIONS,
  VOICES,
  addAsset,
  addItem,
  captionStyleFromPreset,
  createAudioItem,
  createTextItem,
  cutSourceRanges,
  deleteItems,
  fillerWordRanges,
  findItem,
  freezeFrame,
  generateCaptions,
  itemEnd,
  itemWords,
  moveItem,
  projectDuration,
  removeSilences,
  round,
  separateAudio,
  setAspect,
  setKeyframe,
  splitAt,
  trimItem,
  uid,
  updateItem,
  updateTrack,
  type Asset,
  type AudioItem,
  type Item,
  type Project,
  type TextItem,
  type Transcript,
  type VideoItem,
} from '@producer/core'

export interface ToolState {
  project: Project
  playhead: number
  selection: string[]
  changes: string[]
}

/** Server services a tool may need (injected so handlers can be unit-tested without I/O). */
export interface ToolEnv {
  transcribe(assetId: string): Promise<Transcript>
  tts(text: string, voice: string, speed: number): Promise<{ asset: Asset; duration: number }>
}

export class ToolError extends Error {}

const ids = <T extends readonly { id: string }[]>(list: T) => list.map((x) => x.id) as unknown as [T[number]['id'], ...T[number]['id'][]]

const Time = z.number().min(0).max(36000)
const ItemId = z.string().min(1).describe('Item id from get_timeline')

export const TOOL_SCHEMAS = {
  get_timeline: z.object({}).describe('Compact summary of the edit: canvas, duration, playhead, selection, tracks and items (ids, types, times, text), assets.'),
  get_transcript: z.object({ itemId: ItemId }).describe('Words spoken inside a video/audio item, with TIMELINE times in seconds (use for transcript cuts).'),
  split_at: z.object({ time: Time.describe('Timeline seconds'), itemIds: z.array(ItemId).optional().describe('Items to split; default every item under the time') }).describe('Split items at a timeline time.'),
  trim_item: z.object({ itemId: ItemId, edge: z.enum(['start', 'end']), time: Time.describe('New timeline time for that edge') }).describe('Trim the start or end edge of an item to a timeline time (main track ripples).'),
  move_item: z.object({ itemId: ItemId, start: Time, trackId: z.string().optional() }).describe('Move an item to a new start time (and optionally another track).'),
  delete_items: z.object({ itemIds: z.array(ItemId).min(1), ripple: z.boolean().optional().describe('Close the gaps on non-main tracks') }).describe('Delete items. The main track always closes gaps.'),
  add_text: z
    .object({
      text: z.string().min(1).max(500),
      start: Time,
      duration: z.number().min(0.1).max(3600),
      template: z.enum(ids(TEXT_TEMPLATES)).optional(),
      position: z.enum(['top', 'center', 'bottom', 'lower-third']).optional(),
      x: z.number().optional().describe('Canvas px from centre (overrides position)'),
      y: z.number().optional().describe('Canvas px from centre, positive is down (overrides position)'),
    })
    .describe('Add a text item.'),
  update_text_style: z
    .object({
      itemId: ItemId,
      text: z.string().max(500).optional(),
      fontFamily: z.enum(FONTS).optional(),
      fontSize: z.number().min(8).max(600).optional(),
      fontWeight: z.number().int().min(100).max(900).optional(),
      color: z.string().optional(),
      align: z.enum(['left', 'center', 'right']).optional(),
      italic: z.boolean().optional(),
      uppercase: z.boolean().optional(),
      letterSpacing: z.number().optional(),
      background: z.object({ color: z.string(), opacity: z.number().min(0).max(1).optional(), radius: z.number().optional(), padding: z.number().optional() }).nullable().optional(),
      stroke: z.object({ color: z.string(), width: z.number().min(0).max(40) }).nullable().optional(),
      shadow: z.object({ color: z.string(), blur: z.number(), x: z.number().optional(), y: z.number().optional() }).nullable().optional(),
    })
    .describe('Change a text item’s text and/or style.'),
  set_item_properties: z
    .object({
      itemId: ItemId,
      x: z.number().optional(),
      y: z.number().optional(),
      scale: z.number().min(0.01).max(20).optional(),
      rotation: z.number().optional(),
      opacity: z.number().min(0).max(1).optional(),
      volume: z.number().min(0).max(4).optional(),
      muted: z.boolean().optional(),
      speed: z.number().min(0.1).max(10).optional(),
      filter: z.object({ id: z.enum(ids(FILTERS)), intensity: z.number().min(0).max(100) }).nullable().optional(),
      adjust: z.object({ brightness: z.number(), contrast: z.number(), saturation: z.number(), exposure: z.number(), temperature: z.number(), tint: z.number(), hue: z.number(), sharpen: z.number(), vignette: z.number() }).partial().optional(),
      fit: z.enum(['contain', 'cover']).optional(),
    })
    .describe('Set transform/opacity/volume/speed/filter/colour adjust on an item.'),
  add_transition: z.object({ itemId: ItemId.describe('Item BEFORE the cut'), type: z.enum(ids(TRANSITIONS)), duration: z.number().min(0.1).max(3).default(0.5) }).describe('Add a transition across the cut after an item (to the next adjacent item on its track).'),
  add_animation: z.object({ itemId: ItemId, which: z.enum(['in', 'out', 'combo']), preset: z.string(), duration: z.number().min(0.1).max(10).optional() }).describe(`Set an in/out animation (${ANIMATION_PRESETS.map((a) => a.id).join(', ')}) or a looping combo (pulse, float, shake, swing, none).`),
  add_effect: z.object({ itemId: ItemId, type: z.enum(ids(EFFECTS)), intensity: z.number().min(0).max(100).default(60) }).describe('Add a visual effect to an item.'),
  set_keyframe: z
    .object({ itemId: ItemId, prop: z.enum(['x', 'y', 'scale', 'rotation', 'opacity', 'volume']), time: Time.describe('TIMELINE seconds'), value: z.number(), ease: z.enum(['linear', 'easeIn', 'easeOut', 'easeInOut', 'hold']).optional() })
    .describe('Set a keyframe on an item property at a timeline time.'),
  generate_captions: z.object({ itemIds: z.array(ItemId).optional(), preset: z.enum(ids(CAPTION_PRESETS)).optional() }).describe('Generate a caption track from speech (transcribes media first if needed). Replaces existing captions.'),
  set_caption_style: z
    .object({
      preset: z.enum(ids(CAPTION_PRESETS)).optional(),
      position: z.number().min(0).max(1).optional().describe('Vertical position, 0 top .. 1 bottom'),
      mode: z.enum(['line', 'word', 'karaoke']).optional(),
      maxWordsPerLine: z.number().int().min(1).max(20).optional(),
      fontFamily: z.enum(FONTS).optional(),
      fontSize: z.number().min(8).max(300).optional(),
      color: z.string().optional(),
      highlightColor: z.string().optional(),
    })
    .describe('Restyle the caption track.'),
  remove_silences: z.object({ itemId: ItemId, minGap: z.number().min(0.2).max(10).optional() }).describe('Cut pauses longer than minGap seconds out of a video/audio item.'),
  remove_filler_words: z.object({ itemId: ItemId }).describe('Cut filler words (um, uh, …) out of a video/audio item using its transcript.'),
  cut_transcript_ranges: z.object({ itemId: ItemId, ranges: z.array(z.object({ start: Time, end: Time })).min(1).describe('TIMELINE time ranges to remove') }).describe('Remove time ranges (e.g. words from get_transcript) from a media item; the edit ripples.'),
  set_aspect_ratio: z.object({ ratio: z.enum(ids(ASPECT_RATIOS)) }).describe('Change the canvas aspect ratio.'),
  add_voiceover: z.object({ text: z.string().min(1).max(4000), voice: z.enum(ids(VOICES)).optional(), start: Time.optional(), speed: z.number().min(0.5).max(2).optional() }).describe('Generate a TTS voiceover and place it on an audio track.'),
  separate_audio: z.object({ itemId: ItemId }).describe('Detach a video’s audio onto its own linked audio item.'),
  freeze_frame: z.object({ itemId: ItemId, time: Time.describe('Timeline seconds'), hold: z.number().min(0.2).max(30).optional() }).describe('Insert a freeze frame into a video item at a timeline time.'),
} as const

export type ToolName = keyof typeof TOOL_SCHEMAS

function need(p: Project, id: string): Item {
  const f = findItem(p, id)
  if (!f) throw new ToolError(`No item with id ${id}`)
  return f.item
}

function label(it: Item): string {
  if (it.type === 'text' || it.type === 'caption') return `${it.type} "${it.text.slice(0, 30)}"`
  return `${it.type} "${it.name ?? it.id}"`
}

const r2 = (n: number) => round(n, 2)

export function timelineSummary(s: ToolState) {
  const p = s.project
  return {
    canvas: { width: p.width, height: p.height, fps: p.fps, background: p.background },
    duration: projectDuration(p),
    playhead: r2(s.playhead),
    selection: s.selection,
    tracks: p.tracks.map((t) => ({
      id: t.id,
      kind: t.kind,
      name: t.name,
      ...(t.main ? { main: true } : {}),
      ...(t.muted ? { muted: true } : {}),
      ...(t.captionStyle ? { captionPreset: t.captionStyle.preset } : {}),
      items: t.items.map((it) => ({
        id: it.id,
        type: it.type,
        start: r2(it.start),
        end: r2(itemEnd(it)),
        ...(it.name ? { name: it.name } : {}),
        ...(it.type === 'text' || it.type === 'caption' ? { text: it.text.slice(0, 120) } : {}),
        ...(it.type === 'video' || it.type === 'audio' ? { assetId: it.assetId, in: r2(it.in), speed: it.speed, ...(it.muted ? { muted: true } : {}) } : {}),
        ...(it.type === 'image' ? { assetId: it.assetId } : {}),
        ...(it.type === 'video' && it.freezeAt !== undefined ? { freezeAt: it.freezeAt } : {}),
        ...('transitionOut' in it && it.transitionOut ? { transitionOut: it.transitionOut.type } : {}),
        ...('transform' in it && (it.transform.x || it.transform.y || it.transform.scale !== 1) ? { x: r2(it.transform.x), y: r2(it.transform.y), scale: r2(it.transform.scale) } : {}),
      })),
    })),
    assets: Object.values(p.assets).map((a) => ({ id: a.id, kind: a.kind, name: a.name, duration: a.duration, hasTranscript: Boolean(a.transcript), silences: a.silences?.length ?? 0 })),
  }
}

function set(s: ToolState, p: Project, change: string) {
  if (p === s.project) throw new ToolError(`Nothing changed (${change}) — check the ids and times`)
  s.project = p
  s.changes.push(change)
  return change
}

function positionY(p: Project, pos: string | undefined): number {
  switch (pos) {
    case 'top':
      return -p.height * 0.36
    case 'bottom':
      return p.height * 0.34
    case 'lower-third':
      return p.height * 0.28
    default:
      return 0
  }
}

/** Run one tool against the state; returns the tool_result text. Throws ToolError for model-fixable problems. */
export async function runTool(s: ToolState, name: string, rawInput: unknown, env: ToolEnv): Promise<{ result: string; summary: string }> {
  const schema = (TOOL_SCHEMAS as Record<string, z.ZodType>)[name]
  if (!schema) throw new ToolError(`Unknown tool ${name}`)
  const parsed = schema.safeParse(rawInput ?? {})
  if (!parsed.success) throw new ToolError(`Invalid input for ${name}: ${parsed.error.issues.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`).join('; ')}`)
  const i = parsed.data as Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
  const p = s.project
  const done = (summary: string) => ({ result: JSON.stringify({ ok: true, change: summary, duration: projectDuration(s.project) }), summary })

  switch (name as ToolName) {
    case 'get_timeline':
      return { result: JSON.stringify(timelineSummary(s)), summary: 'Read the timeline' }
    case 'get_transcript': {
      const it = need(p, i.itemId)
      if (it.type !== 'video' && it.type !== 'audio') throw new ToolError('Only video/audio items have transcripts')
      if (!p.assets[it.assetId]?.transcript) {
        const tr = await env.transcribe(it.assetId)
        s.project = addAsset(p, { ...p.assets[it.assetId], transcript: tr })
      }
      const words = itemWords(s.project, it.id).map((w) => ({ w: w.w, start: r2(w.start), end: r2(w.end) }))
      return { result: JSON.stringify({ itemId: it.id, words: words.slice(0, 3000) }), summary: `Read the transcript of ${label(it)}` }
    }
    case 'split_at': {
      const next = splitAt(p, i.time, i.itemIds)
      return done(set(s, next, `Split at ${r2(i.time)}s`))
    }
    case 'trim_item': {
      const it = need(p, i.itemId)
      return done(set(s, trimItem(p, it.id, i.edge, i.time), `Trimmed the ${i.edge} of ${label(it)} to ${r2(i.time)}s`))
    }
    case 'move_item': {
      const it = need(p, i.itemId)
      return done(set(s, moveItem(p, it.id, { start: i.start, trackId: i.trackId }), `Moved ${label(it)} to ${r2(i.start)}s`))
    }
    case 'delete_items': {
      const items = (i.itemIds as string[]).map((id) => need(p, id))
      return done(set(s, deleteItems(p, i.itemIds, { ripple: i.ripple }), `Deleted ${items.map(label).join(', ')}`))
    }
    case 'add_text': {
      const tpl = i.template ?? 'heading'
      const item = createTextItem(i.start, tpl, { text: i.text, name: i.text.slice(0, 40), duration: i.duration })
      item.transform = { ...item.transform, x: i.x ?? 0, y: i.y ?? positionY(p, i.position) }
      item.style = { ...item.style, boxWidth: Math.min(item.style.boxWidth, Math.round(p.width * 0.9)) }
      if (i.position === 'lower-third' && i.x === undefined) item.transform.x = p.width > p.height ? -p.width * 0.22 : 0
      const textTrack = p.tracks.find((t) => t.kind === 'text' && !t.items.some((x) => x.start < i.start + i.duration && itemEnd(x) > i.start))
      const next = addItem(p, item, textTrack?.id)
      set(s, next, `Added text "${i.text.slice(0, 40)}" at ${r2(i.start)}s`)
      return { result: JSON.stringify({ ok: true, itemId: item.id }), summary: s.changes[s.changes.length - 1] }
    }
    case 'update_text_style': {
      const it = need(p, i.itemId)
      if (it.type !== 'text') throw new ToolError('update_text_style only works on text items')
      const style = { ...it.style }
      for (const k of ['fontFamily', 'fontSize', 'fontWeight', 'color', 'align', 'italic', 'uppercase', 'letterSpacing'] as const) if (i[k] !== undefined) (style as Record<string, unknown>)[k] = i[k]
      if (i.background === null) delete style.background
      else if (i.background) style.background = { color: i.background.color, opacity: i.background.opacity ?? 1, radius: i.background.radius ?? 10, padding: i.background.padding ?? 16 }
      if (i.stroke === null) delete style.stroke
      else if (i.stroke) style.stroke = i.stroke
      if (i.shadow === null) delete style.shadow
      else if (i.shadow) style.shadow = { color: i.shadow.color, blur: i.shadow.blur, x: i.shadow.x ?? 0, y: i.shadow.y ?? 2 }
      const patch: Partial<TextItem> = { style }
      if (i.text !== undefined) patch.text = i.text
      return done(set(s, updateItem<TextItem>(p, it.id, patch), `Restyled ${label(it)}`))
    }
    case 'set_item_properties': {
      const it = need(p, i.itemId)
      const patch: Record<string, unknown> = {}
      const bits: string[] = []
      if ('transform' in it && (i.x !== undefined || i.y !== undefined || i.scale !== undefined || i.rotation !== undefined)) {
        patch.transform = { ...it.transform, ...(i.x !== undefined ? { x: i.x } : {}), ...(i.y !== undefined ? { y: i.y } : {}), ...(i.scale !== undefined ? { scale: i.scale } : {}), ...(i.rotation !== undefined ? { rotation: i.rotation } : {}) }
        bits.push('transform')
      }
      if (i.opacity !== undefined && 'opacity' in it) (patch.opacity = i.opacity), bits.push(`opacity ${i.opacity}`)
      if ((it.type === 'video' || it.type === 'audio') && i.volume !== undefined) (patch.volume = i.volume), bits.push(`volume ${i.volume}`)
      if ((it.type === 'video' || it.type === 'audio') && i.muted !== undefined) (patch.muted = i.muted), bits.push(i.muted ? 'muted' : 'unmuted')
      if ((it.type === 'video' || it.type === 'audio') && i.speed !== undefined) {
        const m = it as VideoItem | AudioItem
        const span = m.duration * m.speed
        patch.speed = i.speed
        patch.duration = round(span / i.speed, 4)
        bits.push(`speed ${i.speed}×`)
      }
      if ((it.type === 'video' || it.type === 'image') && i.filter !== undefined) (patch.filter = i.filter ?? undefined), bits.push(i.filter ? `filter ${i.filter.id}` : 'no filter')
      if ((it.type === 'video' || it.type === 'image') && i.adjust) (patch.adjust = { ...it.adjust, ...i.adjust }), bits.push('colour adjust')
      if ((it.type === 'video' || it.type === 'image') && i.fit) (patch.fit = i.fit), bits.push(`fit ${i.fit}`)
      if (!bits.length) throw new ToolError('None of those properties apply to this item type')
      return done(set(s, updateItem(p, it.id, patch as Partial<Item>), `Set ${bits.join(', ')} on ${label(it)}`))
    }
    case 'add_transition': {
      const it = need(p, i.itemId)
      if (!('transitionOut' in it) && it.type !== 'video' && it.type !== 'image' && it.type !== 'text' && it.type !== 'shape') throw new ToolError('Transitions apply to visual items')
      return done(set(s, updateItem(p, it.id, { transitionOut: { type: i.type, duration: i.duration } } as Partial<Item>), `Added a ${i.type} transition after ${label(it)}`))
    }
    case 'add_animation': {
      const it = need(p, i.itemId)
      if (!('animations' in it)) throw new ToolError('Animations apply to visual items')
      const anims = { ...it.animations }
      if (i.which === 'combo') {
        if (!['pulse', 'float', 'shake', 'swing', 'none'].includes(i.preset)) throw new ToolError('combo preset must be pulse, float, shake, swing or none')
        anims.combo = { preset: i.preset, period: i.duration ?? 1.2 }
      } else {
        if (i.preset !== 'none' && !ANIMATION_PRESETS.some((a) => a.id === i.preset)) throw new ToolError(`Unknown animation ${i.preset}`)
        anims[i.which as 'in' | 'out'] = { preset: i.preset, duration: i.duration ?? 0.5 }
      }
      return done(set(s, updateItem(p, it.id, { animations: anims } as Partial<Item>), `Set ${i.which} animation ${i.preset} on ${label(it)}`))
    }
    case 'add_effect': {
      const it = need(p, i.itemId)
      if (!('effects' in it)) throw new ToolError('Effects apply to visual items')
      const effects = [...it.effects.filter((e) => e.type !== i.type), { id: uid('e'), type: i.type, intensity: i.intensity }]
      return done(set(s, updateItem(p, it.id, { effects } as Partial<Item>), `Added ${i.type} effect to ${label(it)}`))
    }
    case 'set_keyframe': {
      const it = need(p, i.itemId)
      return done(set(s, setKeyframe(p, it.id, i.prop, i.time - it.start, i.value, i.ease), `Keyframed ${i.prop}=${i.value} on ${label(it)} at ${r2(i.time)}s`))
    }
    case 'generate_captions': {
      let cur = p
      const sources = cur.tracks.flatMap((t) => t.items).filter((it): it is VideoItem | AudioItem => (it.type === 'video' || it.type === 'audio') && (!i.itemIds || i.itemIds.includes(it.id)) && !it.muted)
      if (!sources.length) throw new ToolError('No unmuted video/audio items to caption')
      for (const aid of [...new Set(sources.map((x) => x.assetId))]) {
        if (!cur.assets[aid]?.transcript && cur.assets[aid]) cur = addAsset(cur, { ...cur.assets[aid], transcript: await env.transcribe(aid) })
      }
      const style = i.preset ? captionStyleFromPreset(i.preset) : cur.tracks.find((t) => t.kind === 'caption')?.captionStyle
      const next = generateCaptions(cur, { itemIds: i.itemIds, style })
      const n = next.tracks.find((t) => t.kind === 'caption')?.items.length ?? 0
      if (!n) throw new ToolError('No speech found to caption')
      s.project = next
      s.changes.push(`Generated ${n} captions`)
      return done(s.changes[s.changes.length - 1])
    }
    case 'set_caption_style': {
      const track = p.tracks.find((t) => t.kind === 'caption')
      if (!track) throw new ToolError('There is no caption track — call generate_captions first')
      const base = i.preset ? captionStyleFromPreset(i.preset) : structuredClone(track.captionStyle ?? captionStyleFromPreset('clean'))
      if (i.position !== undefined) base.position = i.position
      if (i.mode) base.mode = i.mode
      if (i.maxWordsPerLine) base.maxWordsPerLine = i.maxWordsPerLine
      if (i.highlightColor) base.highlightColor = i.highlightColor
      if (i.fontFamily) base.style.fontFamily = i.fontFamily
      if (i.fontSize) base.style.fontSize = i.fontSize
      if (i.color) base.style.color = i.color
      return done(set(s, updateTrack(p, track.id, { captionStyle: base }), `Restyled captions${i.preset ? ` (${i.preset})` : ''}`))
    }
    case 'remove_silences': {
      const it = need(p, i.itemId)
      if (it.type !== 'video' && it.type !== 'audio') throw new ToolError('remove_silences needs a video/audio item')
      const asset = p.assets[it.assetId]
      if (!asset?.silences?.length && !asset?.transcript) {
        s.project = addAsset(p, { ...asset, transcript: await env.transcribe(it.assetId) })
      }
      const before = projectDuration(s.project)
      const next = removeSilences(s.project, it.id, i.minGap ?? 0.6)
      if (next === s.project) throw new ToolError('No pauses long enough to remove')
      const cut = r2(before - projectDuration(next))
      return done(set(s, next, `Removed silences from ${label(it)} (${cut}s shorter)`))
    }
    case 'remove_filler_words': {
      const it = need(p, i.itemId)
      if (it.type !== 'video' && it.type !== 'audio') throw new ToolError('remove_filler_words needs a video/audio item')
      let cur = p
      let tr = cur.assets[it.assetId]?.transcript
      if (!tr) {
        tr = await env.transcribe(it.assetId)
        cur = addAsset(cur, { ...cur.assets[it.assetId], transcript: tr })
      }
      const ranges = fillerWordRanges(tr)
      if (!ranges.length) throw new ToolError('No filler words found')
      const next = cutSourceRanges(cur, it.id, ranges)
      s.project = cur
      return done(set(s, next, `Removed ${ranges.length} filler words from ${label(it)}`))
    }
    case 'cut_transcript_ranges': {
      const it = need(p, i.itemId)
      if (it.type !== 'video' && it.type !== 'audio') throw new ToolError('cut_transcript_ranges needs a video/audio item')
      const m = it as VideoItem | AudioItem
      const src = (i.ranges as Array<{ start: number; end: number }>).map((r) => ({ start: m.in + (Math.min(r.start, r.end) - m.start) * m.speed, end: m.in + (Math.max(r.start, r.end) - m.start) * m.speed }))
      return done(set(s, cutSourceRanges(p, it.id, src), `Cut ${src.length} range(s) from ${label(it)}`))
    }
    case 'set_aspect_ratio': {
      const a = ASPECT_RATIOS.find((x) => x.id === i.ratio)!
      return done(set(s, setAspect(p, a.width, a.height), `Changed the canvas to ${a.id} (${a.width}×${a.height})`))
    }
    case 'add_voiceover': {
      const voice = i.voice ?? 'af_heart'
      const speed = i.speed ?? 1
      const v = await env.tts(i.text, voice, speed)
      const start = i.start ?? s.playhead
      const audio = createAudioItem(v.asset, start, { duration: round(v.duration, 3), name: `Voiceover · ${i.text.slice(0, 30)}`, tts: { text: i.text, voice, speed } })
      let next = addAsset(p, v.asset)
      const free = next.tracks.find((t) => t.kind === 'audio' && !t.items.some((x) => x.start < start + v.duration && itemEnd(x) > start))
      next = addItem(next, audio, free?.id)
      set(s, next, `Added a ${r2(v.duration)}s voiceover at ${r2(start)}s`)
      return { result: JSON.stringify({ ok: true, itemId: audio.id, duration: r2(v.duration) }), summary: s.changes[s.changes.length - 1] }
    }
    case 'separate_audio': {
      const it = need(p, i.itemId)
      return done(set(s, separateAudio(p, it.id), `Separated the audio of ${label(it)}`))
    }
    case 'freeze_frame': {
      const it = need(p, i.itemId)
      return done(set(s, freezeFrame(p, it.id, i.time, i.hold ?? 2), `Inserted a ${i.hold ?? 2}s freeze frame at ${r2(i.time)}s`))
    }
  }
  throw new ToolError(`Unhandled tool ${name}`)
}
