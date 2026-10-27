// Producer AI pipeline: ai.produce.script (Claude structured output) and ai.produce.assemble (TTS + timeline).
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { and, desc, eq, inArray, sql } from 'drizzle-orm'
import * as z from 'zod/v4'
import {
  captionStyleFromPreset,
  createAudioItem,
  createImageItem,
  createProject,
  createShapeItem,
  createTextItem,
  createTrack,
  createVideoItem,
  defaultTextStyle,
  generateCaptions,
  round,
  uid,
  type Asset,
  type Item,
  type ProducerMeta,
  type Project,
  type ScriptScene,
  type Track,
  type Transcript,
  type VideoItem,
  type VisualKind,
} from '@producer/core'
import { ctx } from '../context'
import { assets } from '../db/schema'
import { assetDoc } from '../dto'
import { HttpError, invalid } from '../http'
import { type JobContext, subContext } from '../jobs/worker'
import { ffmpeg } from '../media/proc'
import { type AssetRow, createAssetFromFile, localSource, tmpDir } from '../services/assets'
import { processAsset } from '../media/process'
import { log } from '../log'
import { getLook, headlineStyle, labelStyle, lookPalette, sizeForAspect } from '../services/looks'
import { insertProject, loadProjectRow, saveProjectDoc, withFreshIds } from '../services/projects'
import { getBrand } from '../routes/workspaces'
import { requireProvider } from './provider'
import { houseRules } from './rules'
import { ensureTranscript, synthesizeToAsset, transcribeAsset } from './speech'
import { whisperAvailable } from './whisper'
import { downloadStock, generateImage, generateVideo, generationCapabilities, searchStock } from './generate'
import { IDEA_SYSTEM, IdeaScriptSchema, VISUAL_KINDS, buildIdeaPrompt, normalizeIdeaScript } from './scenes'
import { type Placed, type SceneFrame, diagramItems, motionItems, slotIndex } from './scene-layout'

export type Brief = NonNullable<ProducerMeta['brief']>

/**
 * Re-read the project and save `next(current)` on top of that version; if another save lands in between, do it
 * again on the newer one. Jobs that write the project (script, assembly, wizard drafts) never save over edits made
 * while they ran.
 */
export async function saveOnLatest(id: string, next: (cur: Project) => Project, tries = 5): Promise<Awaited<ReturnType<typeof saveProjectDoc>>> {
  for (let i = 0; ; i++) {
    const row = await loadProjectRow(id)
    const doc = next(row.doc)
    try {
      return await saveProjectDoc(id, doc, row.version)
    } catch (err) {
      if (!(err instanceof HttpError && err.status === 409) || i >= tries - 1) throw err
    }
  }
}

/** Sorted-key JSON: a document read back from Postgres (jsonb reorders keys) fingerprints like the one saved. */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map((x) => (x === undefined ? 'null' : canonical(x))).join(',')}]`
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>
    return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(',')}}`
  }
  return JSON.stringify(v) ?? 'null'
}

/** The part of a project assembly replaces, and a person edits: the tracks and the canvas. */
export function timelineFingerprint(p: Project): string {
  return crypto.createHash('sha256').update(canonical({ tracks: p.tracks, width: p.width, height: p.height, fps: p.fps, background: p.background })).digest('hex').slice(0, 32)
}

/** The timeline holds work an assembly would replace: edited since the last assembly, or built by hand before one. */
export function editedSinceAssembly(p: Project): boolean {
  if (!p.tracks.some((t) => t.items.length)) return false
  return p.ai?.assembled?.fingerprint !== timelineFingerprint(p)
}

export const EDITED_WHILE_ASSEMBLING =
  'Someone edited this project’s timeline while it was being assembled, so their edits were kept and the new assembly was saved as a copy.'

export const ScriptSchema = z.object({
  message: z.string().describe('The one-sentence message of the video'),
  scenes: z.array(
    z.object({
      id: z.string().describe('s01, s02, ... in order'),
      title: z.string().describe('Short scene label, e.g. Hook, Where it lives, Close'),
      headline: z.string().describe('3-6 word on-screen headline (2-4 for vertical)'),
      narration: z.string().describe('Exactly what the narrator says, written as spoken'),
      footage: z.array(
        z.object({
          assetId: z.string().describe('Id of the source recording this window comes from'),
          start: z.number().describe('Window start, seconds into that recording'),
          end: z.number().describe('Window end, seconds into that recording'),
          note: z.string().describe('What is on screen in this window'),
        }),
      ),
      visuals: z.string().describe('Anything on screen besides footage (callouts, labels) with exact values; empty if none'),
    }),
  ),
})
export type ScriptOutput = z.infer<typeof ScriptSchema>

export const SCRIPT_SYSTEM =
  'You are the script writer for Producer, which turns screen recordings into short narrated, branded videos. You write warm, plain, spoken narration with one idea per scene, and you pick footage windows that show exactly what each line describes.'

function fmtTranscript(t: Transcript, maxChars = 30000): string {
  const lines = t.segments.map((s) => `[${s.start.toFixed(1)}–${s.end.toFixed(1)}] ${s.text}`)
  let out = lines.join('\n')
  if (out.length > maxChars) out = out.slice(0, maxChars) + '\n[… transcript truncated]'
  return out || '(no speech detected)'
}

/** One contact sheet per video (≤ 20 frames, 5×4 grid). Frame k (row-major from 0) shows second k·interval. */
async function contactSheet(row: AssetRow, work: string, signal: AbortSignal): Promise<{ data: string; interval: number; frames: number } | null> {
  if (row.kind !== 'video') return null
  const dur = row.meta?.duration ?? 0
  if (dur <= 0) return null
  const interval = Math.max(1, Math.ceil(dur / 20))
  const frames = Math.min(20, Math.floor(dur / interval) + 1)
  const src = await localSource(row, work, row.proxyKey ?? row.sourceKey)
  const out = path.join(work, `sheet-${row.id}.jpg`)
  await ffmpeg(['-i', src, '-vf', `fps=1/${interval},scale=384:-2,tile=5x4:padding=4:color=black`, '-frames:v', '1', '-q:v', '5', out], { signal })
  return { data: fs.readFileSync(out).toString('base64'), interval, frames }
}

export function buildScriptPrompt(opts: {
  brief: Brief
  sources: Array<{ id: string; name: string; duration: number; width?: number; height?: number; transcript: Transcript; sheet?: { interval: number; frames: number } }>
  rules: string
  example: string
}): string {
  const b = opts.brief
  const vertical = b.aspect === '9:16'
  const totalWordsHint = Math.round(opts.sources.reduce((n, s) => n + s.duration, 0) * 2.8 * 0.6)
  return `Write the production script for a narrated video built from the screen recordings below.

BRIEF
- Title: ${b.title}
- Audience: ${b.audience || 'internal staff and stakeholders'}
- Goal / message: ${b.goal || 'infer from the recordings'}
- Tone: ${b.tone || 'warm, plain, confident'}
- Aspect: ${b.aspect}${vertical ? ' (vertical: headlines 2-4 words)' : ''}
- Visual template: ${b.template}
- Voice: ${b.voice}${b.notes ? `\n- Producer notes: ${b.notes}` : ''}

SOURCE RECORDINGS
${opts.sources
  .map(
    (s) => `## ${s.id} — "${s.name}" (${s.duration.toFixed(1)} s${s.width ? `, ${s.width}x${s.height}` : ''})${s.sheet ? `\nContact sheet attached: 5 columns × 4 rows, frame k (row-major, from 0) shows second ${s.sheet.interval}·k (${s.sheet.frames} frames).` : ''}
Transcript (timestamps in seconds; may contain mis-heard words — rewrite, never quote verbatim):
${fmtTranscript(s.transcript)}`,
  )
  .join('\n\n')}

HOUSE RULES
${opts.rules}

APPROVED EXAMPLE SCRIPT (match its register, rhythm and density; not its content)
${opts.example}

REQUIREMENTS
- Value-first story: the hook speaks the viewer's language, the message lands by scene 2, every later scene is evidence. Do not open with a rhetorical question; no inventory sentences.
- ${opts.sources.length > 1 ? '6–12' : '4–10'} scenes, ids s01..sNN in order; the last scene is the close. Narration 20–70 words per scene, paced at ~2.8 words/second (overall roughly ${Math.max(60, totalWordsHint)} words or fewer).
- Every fact, number and label in the narration must be visible or said in the recordings. Do not invent numbers.
- Footage windows reference the recording id exactly as given above (${opts.sources.map((s) => s.id).join(', ')}), with start/end in that recording's seconds, inside its duration. Pick windows that show what the narration describes; avoid blank or loading stretches. Title-only scenes may have an empty footage list.
- Each window should be about as long as the scene's narration takes to speak plus ~2 s; several windows per scene are fine.
- Headlines are what the viewer reads (official spelling); narration is what the voice says (spoken spelling).`
}

/** Clamp windows to real assets and durations; drop unusable ones. */
export function validateScript(out: ScriptOutput, durations: Map<string, number>): ScriptScene[] {
  const scenes: ScriptScene[] = []
  out.scenes.forEach((s, i) => {
    const narration = s.narration.trim()
    if (!narration) return
    const footage = s.footage
      .filter((f) => durations.has(f.assetId))
      .map((f) => {
        const d = durations.get(f.assetId)!
        let start = Math.max(0, Math.min(f.start, f.end))
        let end = Math.min(d, Math.max(f.start, f.end))
        if (end - start < 0.5) {
          end = Math.min(d, start + 2)
          start = Math.max(0, end - 2)
        }
        return { assetId: f.assetId, start: round(start, 2), end: round(end, 2) }
      })
      .filter((f) => f.end - f.start >= 0.3)
    scenes.push({ id: `s${String(i + 1).padStart(2, '0')}`, title: s.title.trim() || `Scene ${i + 1}`, headline: s.headline.trim(), narration, footage, visuals: s.visuals?.trim() || undefined })
  })
  if (!scenes.length) throw new HttpError(502, 'server', 'The AI returned an empty script')
  return scenes
}

async function workspaceAssets(workspaceId: string, ids: string[]): Promise<AssetRow[]> {
  if (!ids.length) return []
  const rows = await ctx().db.select().from(assets).where(and(eq(assets.workspaceId, workspaceId), inArray(assets.id, ids)))
  const missing = ids.filter((id) => !rows.some((r) => r.id === id))
  if (missing.length) throw invalid(`Unknown asset(s) in this workspace: ${missing.join(', ')}`)
  return ids.map((id) => rows.find((r) => r.id === id)!)
}

/** The visual kinds an idea-mode script may use: those asked for that this workspace can make (motion always). */
export async function allowedVisualKinds(workspaceId: string, requested?: VisualKind[]): Promise<VisualKind[]> {
  const caps = await generationCapabilities(workspaceId)
  // AI video is opt-in (slow, and billed per second to the workspace's key); the rest default on when available
  const want = new Set<VisualKind>(requested?.length ? requested : ['motion', 'diagram', 'image', 'stock'])
  want.add('motion')
  return VISUAL_KINDS.filter((k) => want.has(k) && (k === 'image' ? !!caps.image : k === 'aiVideo' ? !!caps.video : k === 'stock' ? caps.stock : true))
}

/** Idea mode (no recordings): the writer plans every scene and picks the visual that explains it. */
async function produceIdeaScript(jc: JobContext, input: { projectId: string; brief: Brief }): Promise<{ script: { scenes: ScriptScene[]; message?: string } }> {
  const provider = await requireProvider(jc.job.workspaceId, 'script')
  const row = await loadProjectRow(input.projectId)
  const kinds = await allowedVisualKinds(row.workspaceId, input.brief.visualKinds)
  const { rules, example } = houseRules()
  jc.progress(0.1, 'Writing the script')
  const raw = await provider.structured({ system: IDEA_SYSTEM, prompt: buildIdeaPrompt({ brief: input.brief, kinds, rules, example }), images: [], schema: IdeaScriptSchema, signal: jc.signal })
  const check = IdeaScriptSchema.safeParse(raw)
  if (!check.success) throw new HttpError(502, 'server', 'The AI response did not match the script format')
  const scenes = normalizeIdeaScript(check.data, kinds)
  jc.check()
  await saveOnLatest(input.projectId, (cur) => ({ ...cur, ai: { ...(cur.ai ?? {}), brief: input.brief, script: { scenes, message: check.data.message, brief: input.brief }, status: 'scripted' } }))
  jc.progress(1, `${scenes.length} scenes`)
  return { script: { scenes, message: check.data.message } }
}

export async function produceScript(jc: JobContext): Promise<{ script: { scenes: ScriptScene[]; message?: string } }> {
  const input = jc.job.input as { projectId: string; assetIds: string[]; brief: Brief }
  if (input.brief.source === 'idea') return produceIdeaScript(jc, input)
  const provider = await requireProvider(jc.job.workspaceId, 'script') // fail fast (503) when AI isn't configured
  const row = await loadProjectRow(input.projectId)
  const rows = await workspaceAssets(row.workspaceId, input.assetIds)
  const work = tmpDir('script')
  try {
    // 1. transcripts (transcribe if missing)
    const transcripts = new Map<string, Transcript>()
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i]
      if (r.kind === 'image') continue
      const sub = subContext(jc, (i / rows.length) * 0.45, ((i + 1) / rows.length) * 0.45, `Transcribing ${r.name}`)
      transcripts.set(r.id, r.meta?.transcript ?? (whisperAvailable() ? await ensureTranscript(r.id, sub) : { language: 'en', engine: 'none', segments: [] }))
      jc.check()
    }
    // 2. contact sheets (≤ 3 images)
    jc.progress(0.47, 'Building contact sheets')
    const sheets = new Map<string, { data: string; interval: number; frames: number }>()
    for (const r of rows.filter((x) => x.kind === 'video').slice(0, 3)) {
      const s = await contactSheet(r, work, jc.signal).catch(() => null)
      if (s) sheets.set(r.id, s)
    }
    jc.check()
    // 3. prompt + structured output
    const { rules, example } = houseRules()
    const sources = rows
      .filter((r) => r.kind !== 'image')
      .map((r) => ({ id: r.id, name: r.name, duration: r.meta?.duration ?? 0, width: r.meta?.width, height: r.meta?.height, transcript: transcripts.get(r.id)!, sheet: sheets.get(r.id) }))
    const prompt = buildScriptPrompt({ brief: input.brief, sources, rules, example })
    jc.progress(0.55, 'Writing the script')
    const raw = await provider.structured({
      system: SCRIPT_SYSTEM,
      prompt,
      images: [...sheets].map(([id, s]) => ({ label: `Contact sheet for ${id}:`, mediaType: 'image/jpeg' as const, data: s.data })),
      schema: ScriptSchema,
      signal: jc.signal,
    })
    const check = ScriptSchema.safeParse(raw)
    const parsed: ScriptOutput | null = check.success ? check.data : null
    if (!parsed) throw new HttpError(502, 'server', 'The AI response did not match the script format')
    const durations = new Map(rows.map((r) => [r.id, r.meta?.duration ?? (r.kind === 'image' ? 5 : 0)]))
    const scenes = validateScript(parsed, durations)
    jc.check()
    // 4. save onto the project
    await saveOnLatest(input.projectId, (cur) => ({ ...cur, ai: { ...(cur.ai ?? {}), brief: input.brief, script: { scenes, message: parsed.message, brief: input.brief }, status: 'scripted' } }))
    jc.progress(1, `${scenes.length} scenes`)
    return { script: { scenes, message: parsed.message } }
  } finally {
    fs.rm(work, { recursive: true, force: true }, () => undefined)
  }
}

// ---------------- assembly ----------------

const LEAD = 0.5
const TAIL = 1.4
const CLOSE_TAIL = 1.8
const TITLE_CARD = 3
const CLOSE_CARD = 3.5

/** Even word timings for a narration line when whisper isn't available. */
export function syntheticTranscript(text: string, duration: number): Transcript {
  const words = text.split(/\s+/).filter(Boolean)
  const weights = words.map((w) => Math.max(2, w.replace(/[^\w]/g, '').length) + (/[.,!?;:]$/.test(w) ? 3 : 0))
  const total = weights.reduce((a, b) => a + b, 0) || 1
  let t = 0.05
  const span = Math.max(0.2, duration - 0.15)
  const out = words.map((w, i) => {
    const d = (weights[i] / total) * span
    const r = { w, start: round(t, 3), end: round(t + d * 0.92, 3) }
    t += d
    return r
  })
  return { language: 'en', engine: 'estimate', segments: [{ start: 0, end: duration, text, words: out }] }
}

export interface AssembleInput {
  project: Project
  brief: Brief
  scenes: ScriptScene[]
  /** asset rows for footage (by id) */
  footage: Map<string, Asset>
  /** generated voice per scene id */
  voices: Map<string, { asset: Asset; duration: number }>
  /** AI still, stock clip or AI clip made for a scene (by scene id) */
  generated?: Map<string, Asset>
  brand?: import('@producer/core').BrandKitDoc | null
}

/** Pure timeline construction from script + voices (unit-testable, no I/O). */
export function buildProducerTimeline(inp: AssembleInput): Project {
  const look = getLook(inp.brief.template)
  const pal = lookPalette(look, inp.brand)
  const { width, height } = sizeForAspect(inp.brief.aspect || look.aspect)
  const scale = Math.min(width, height) / 1080
  const vertical = height > width
  const base = createProject({ id: inp.project.id, name: inp.project.name, width, height, fps: inp.project.fps || 30, background: pal.canvas })
  const p: Project = { ...base, createdAt: inp.project.createdAt, brand: inp.project.brand, ai: inp.project.ai }
  const main = p.tracks[0]
  main.name = 'Main'
  const cards = createTrack('text', { name: 'Headlines' })
  const labels = createTrack('text', { name: 'Labels' })
  const voice = createTrack('audio', { name: 'Voiceover' })
  const mainItems: Item[] = []
  const graphics: Placed[][] = []
  const addAsset = (a: Asset) => {
    p.assets[a.id] = a
  }

  // title card on the main track (a canvas-coloured shape) + title text
  const titleShape = createShapeItem(0, { name: 'Title card', duration: TITLE_CARD, width, height, fill: pal.canvas, radius: 0 })
  mainItems.push(titleShape)
  cards.items.push(
    createTextItem(0.25, 'heading', {
      name: 'Title',
      text: inp.brief.title || inp.project.name,
      duration: TITLE_CARD - 0.25,
      style: headlineStyle(pal, width, Math.round((vertical ? 104 : 120) * scale)),
      transform: { x: 0, y: -30 * scale, scale: 1, rotation: 0 },
      animations: { in: { preset: 'rise', duration: 0.6 }, out: { preset: 'fade', duration: 0.3 } },
    }),
  )
  if (inp.brand?.name || inp.brief.audience) {
    labels.items.push(
      createTextItem(0.6, 'heading', {
        name: 'Title label',
        text: inp.brand?.name || inp.brief.audience,
        duration: TITLE_CARD - 0.6,
        style: labelStyle(pal, width, Math.round(28 * scale)),
        transform: { x: 0, y: 90 * scale, scale: 1, rotation: 0 },
        animations: { in: { preset: 'fade', duration: 0.4 }, out: { preset: 'fade', duration: 0.3 } },
      }),
    )
  }
  let t = TITLE_CARD
  titleShape.transitionOut = { type: 'crossfade', duration: 0.5 }

  inp.scenes.forEach((scene, si) => {
    const isLast = si === inp.scenes.length - 1
    const v = inp.voices.get(scene.id)
    const voiceDur = v?.duration ?? Math.max(2, scene.narration.split(/\s+/).length / 2.8)
    const dur = round(voiceDur + LEAD + (isLast ? CLOSE_TAIL : TAIL), 1)
    const sceneStart = t
    const visual = scene.visual ?? { kind: 'footage' as const }
    const gen = inp.generated?.get(scene.id)
    const clip = (id: string) => inp.footage.get(id) ?? (gen?.id === id ? gen : undefined)
    // footage windows: the recordings' own, or the whole stock / AI clip made for this scene (filling the frame)
    let windows = visual.kind === 'footage' ? scene.footage.filter((f) => inp.footage.has(f.assetId) && f.end > f.start) : []
    const madeClip = gen?.kind === 'video' && (visual.kind === 'stock' || visual.kind === 'aiVideo')
    if (madeClip) windows = [{ assetId: gen.id, start: 0, end: gen.duration ?? dur }]
    const fit = madeClip ? 'cover' : 'contain'
    const still = gen?.kind === 'image' && visual.kind === 'image' ? gen : undefined
    const pieces: Item[] = []
    if (windows.length) {
      // cut to fill the scene; slow slightly or hold the last frame when short
      const total = windows.reduce((n, f) => n + (f.end - f.start), 0)
      const speed = total >= dur ? 1 : total >= dur * 0.6 ? round(Math.max(0.6, total / dur), 3) : 1
      let remaining = dur
      for (const f of windows) {
        if (remaining <= 0.05) break
        const asset = clip(f.assetId)!
        const len = Math.min((f.end - f.start) / speed, remaining)
        pieces.push(createVideoItem(asset, 0, { name: `${scene.id} · ${asset.name}`, in: f.start, duration: round(len, 3), speed, muted: true, volume: 0, fit }))
        remaining -= len
      }
      if (remaining > 0.05) {
        const last = pieces[pieces.length - 1] as VideoItem
        const holdAt = round(last.in + last.duration * last.speed - 1 / p.fps, 3)
        pieces.push(createVideoItem(clip(last.assetId)!, 0, { name: `${scene.id} · hold`, in: last.in, duration: round(remaining, 3), freezeAt: Math.max(0, holdAt), muted: true, volume: 0, fit }))
      }
      for (const f of windows) addAsset(clip(f.assetId)!)
    } else if (still) {
      // an AI still, brought to life with a slow pan and zoom
      addAsset(still)
      pieces.push(createImageItem(still, 0, { name: `${scene.id} · ${still.name}`, duration: dur, fit: 'cover', effects: [{ id: uid('fx'), type: 'kenBurns', intensity: 70 }] }))
    } else {
      pieces.push(createShapeItem(0, { name: `${scene.id} · card`, duration: dur, width, height, fill: pal.canvas, radius: 0 }))
    }
    // pack pieces edge to edge (main track is magnetic)
    let pt = sceneStart
    for (const it of pieces) {
      it.start = round(pt, 4)
      pt += it.duration
      mainItems.push(it)
    }
    const lastPiece = pieces[pieces.length - 1] as Item & { transitionOut?: { type: import('@producer/core').TransitionType; duration: number } }
    lastPiece.transitionOut = { type: isLast ? 'slideUp' : 'crossfade', duration: 0.5 }

    // voice
    if (v) {
      addAsset(v.asset)
      voice.items.push(createAudioItem(v.asset, round(sceneStart + LEAD, 4), { name: `${scene.id} voice`, duration: round(v.duration, 3), tts: { text: scene.narration, voice: inp.brief.voice, speed: 1 } }))
    }
    // headline (top band, captions own the bottom) + chapter label
    const fullFrame = windows.length > 0 || !!still
    const points = visual.kind === 'motion' ? (visual.points ?? []).filter(Boolean) : []
    const diagram = visual.kind === 'diagram' ? visual.diagram : undefined
    // a card with only the headline: centred and big; above points or a diagram: smaller, in the top band
    const centred = !fullFrame && !points.length && !diagram
    const headY = centred ? -20 * scale : diagram ? -height * 0.38 : points.length ? -height * (vertical ? 0.3 : 0.28) : -height * (vertical ? 0.36 : 0.37)
    const headSize = centred ? (vertical ? 96 : 110) : diagram ? (vertical ? 60 : 66) : points.length ? (vertical ? 80 : 92) : vertical ? 64 : 72
    cards.items.push(
      createTextItem(round(sceneStart + 0.3, 4), 'heading', {
        name: `${scene.id} headline`,
        text: scene.headline || scene.title,
        duration: round(dur - 0.5, 3),
        style: headlineStyle(pal, width, Math.round(headSize * scale), fullFrame ? { background: { color: pal.canvas, radius: 14, padding: Math.round(18 * scale), opacity: 0.88 }, boxWidth: Math.round(width * 0.86) } : {}),
        transform: { x: 0, y: round(headY, 1), scale: 1, rotation: 0 },
        animations: { in: { preset: 'rise', duration: 0.5 }, out: { preset: 'fade', duration: 0.3 } },
      }),
    )
    // motion points and diagrams: editable shapes and text revealed as the narration names each part
    if (points.length || diagram) {
      const frame: SceneFrame = {
        start: sceneStart,
        duration: dur,
        voiceStart: sceneStart + LEAD,
        voiceDuration: voiceDur,
        words: (v?.asset.transcript?.segments ?? []).flatMap((sg) => sg.words ?? []).map((w) => ({ w: w.w, start: w.start })),
        width,
        height,
        pal,
      }
      graphics.push(diagram ? diagramItems(diagram, frame) : motionItems(points, frame))
    }
    const noFootage = centred
    if (noFootage && scene.title) {
      labels.items.push(
        createTextItem(round(sceneStart + 0.5, 4), 'heading', {
          name: `${scene.id} label`,
          text: scene.title,
          duration: round(dur - 0.8, 3),
          style: labelStyle(pal, width, Math.round(26 * scale)),
          transform: { x: 0, y: round(-130 * scale, 1), scale: 1, rotation: 0 },
          animations: { in: { preset: 'fade', duration: 0.4 }, out: { preset: 'fade', duration: 0.3 } },
        }),
      )
    }
    t = sceneStart + dur
  })

  // close card
  const closeStart = t
  mainItems.push(createShapeItem(closeStart, { name: 'Close card', duration: CLOSE_CARD, width, height, fill: pal.canvas, radius: 0 }))
  cards.items.push(
    createTextItem(round(closeStart + 0.3, 4), 'heading', {
      name: 'Close',
      text: inp.brand?.name || inp.brief.title || inp.project.name,
      duration: CLOSE_CARD - 0.3,
      style: headlineStyle(pal, width, Math.round((vertical ? 96 : 110) * scale)),
      transform: { x: 0, y: -20 * scale, scale: 1, rotation: 0 },
      animations: { in: { preset: 'slideUp', duration: 0.6 } },
    }),
  )
  labels.items.push(
    createTextItem(round(closeStart + 0.7, 4), 'heading', {
      name: 'Close label',
      text: inp.brief.goal ? inp.brief.goal.slice(0, 60) : 'Thanks for watching',
      duration: CLOSE_CARD - 0.7,
      style: labelStyle(pal, width, Math.round(26 * scale)),
      transform: { x: 0, y: 90 * scale, scale: 1, rotation: 0 },
      animations: { in: { preset: 'fade', duration: 0.5 } },
    }),
  )

  main.items = mainItems
  // graphics: each scene fills slots 1..n of shared stacks (shape tracks below text tracks); scenes never overlap
  const shapeTracks: Track[] = []
  const textTracks: Track[] = []
  for (const placed of graphics) {
    const slots = slotIndex(placed)
    for (const pl of placed) {
      const k = slots.get(pl) ?? 0
      const stack = pl.layer === 'shape' ? shapeTracks : textTracks
      while (stack.length <= k) stack.push(createTrack(pl.layer === 'shape' ? 'overlay' : 'text', { name: pl.layer === 'shape' ? `Graphics ${stack.length + 1}` : `Graphic text ${stack.length + 1}` }))
      stack[k].items.push(pl.item)
    }
  }
  for (const tr of [...shapeTracks, ...textTracks]) tr.items.sort((a, b) => a.start - b.start)
  p.tracks = [voice, main, ...shapeTracks, ...textTracks, cards, labels].filter((tr) => tr.main || tr.items.length)
  // captions from the voice transcripts
  const captionStyle = captionStyleFromPreset(inp.brand?.captionPreset ?? 'clean')
  captionStyle.style = { ...captionStyle.style, fontFamily: pal.bodyFont, boxWidth: Math.round(width * 0.8), fontSize: Math.round(captionStyle.style.fontSize * scale) }
  const withCaptions = generateCaptions(p, { itemIds: voice.items.map((i) => i.id), style: captionStyle })
  return { ...withCaptions, updatedAt: Date.now() }
}

export interface AssembleJobInput {
  projectId: string
  scenes: ScriptScene[]
  /** The brief as it was on screen when Assemble was pressed (older jobs: none, so the project's). */
  brief?: Brief
  /** Fingerprint of the timeline the person chose to replace when they pressed Assemble. */
  base?: string
}

type Voice = { asset: Asset; duration: number }

/**
 * A voice already made for this narration in this voice: the scene's own, else one made for this project (a failed
 * run's: a retry re-voices nothing it already has). One this job made before its worker died is processed now.
 */
async function reuseVoice(jc: JobContext, o: { workspaceId: string; projectId: string; text: string; voice: string; hint?: string }): Promise<Voice | undefined> {
  const db = ctx().db
  const same = (r: AssetRow) => r.meta?.tts?.text === o.text && r.meta.tts.voice === o.voice && (r.meta.tts.speed ?? 1) === 1
  if (o.hint) {
    const r = (await db.select().from(assets).where(and(eq(assets.id, o.hint), eq(assets.workspaceId, o.workspaceId))).limit(1))[0]
    if (r && r.status === 'ready' && same(r)) return { asset: assetDoc(r), duration: r.meta.duration ?? 0 }
  }
  const rows = (
    await db
      .select()
      .from(assets)
      .where(and(eq(assets.workspaceId, o.workspaceId), eq(assets.projectId, o.projectId), eq(assets.origin, 'tts'), sql`${assets.meta}->'tts'->>'text' = ${o.text}`))
      .orderBy(desc(assets.createdAt))
      .limit(20)
  ).filter(same)
  const ready = rows.find((r) => r.status === 'ready')
  if (ready) return { asset: assetDoc(ready), duration: ready.meta.duration ?? 0 }
  const left = rows.find((r) => r.status === 'processing' && r.meta.jobId === jc.job.id)
  if (left) {
    try {
      const done = await processAsset(left.id, { signal: jc.signal, check: jc.check, progress: () => undefined })
      return { asset: assetDoc(done), duration: done.meta?.duration ?? 0 }
    } catch (err) {
      if (jc.signal.aborted) throw err
      log.warn('could not finish an earlier voice; making it again', { assetId: left.id, err })
    }
  }
  return undefined
}

export async function produceAssemble(jc: JobContext): Promise<{ version: number; copyProjectId?: string; message?: string; notes?: string[] }> {
  const input = jc.job.input as unknown as AssembleJobInput
  const row = await loadProjectRow(input.projectId)
  const doc = row.doc
  const brief: Brief = input.brief ?? doc.ai?.brief ?? { title: doc.name, audience: '', goal: '', tone: 'warm', template: 'studio-dark', voice: 'af_heart', aspect: '16:9' }
  // the timeline the person agreed to replace; edits saved after it are never overwritten
  const base = input.base ?? timelineFingerprint(doc)
  const brand = await getBrand(row.workspaceId)
  if (!input.scenes?.length) throw invalid('No scenes to assemble')
  const footageIds = [...new Set(input.scenes.flatMap((s) => s.footage.map((f) => f.assetId)))]
  const footageRows = await ctx().db.select().from(assets).where(and(eq(assets.workspaceId, row.workspaceId), inArray(assets.id, footageIds.length ? footageIds : ['-'])))
  const footage = new Map(footageRows.map((r) => [r.id, assetDoc(r)]))
  // 1. voice per scene (reuse one already made for the same narration and voice)
  const voices = new Map<string, Voice>()
  const prior = new Map((doc.ai?.script?.scenes ?? []).map((s) => [s.id, s]))
  for (let i = 0; i < input.scenes.length; i++) {
    const s = input.scenes[i]
    jc.check()
    const sub = subContext(jc, (i / input.scenes.length) * 0.6, ((i + 1) / input.scenes.length) * 0.6, `Voicing ${s.id}`)
    const reused = await reuseVoice(jc, { workspaceId: row.workspaceId, projectId: row.id, text: s.narration, voice: brief.voice, hint: (s.voice ?? prior.get(s.id)?.voice)?.assetId })
    if (reused) {
      voices.set(s.id, reused)
      continue
    }
    const v = await synthesizeToAsset({ workspaceId: row.workspaceId, userId: jc.job.userId, projectId: row.id, text: s.narration, voice: brief.voice, name: `${s.id} · ${s.title}`, jobId: jc.job.id }, sub)
    voices.set(s.id, { asset: v.asset.asset, duration: v.duration })
  }
  // 2. word timings for captions (whisper round trip, or an estimate)
  for (let i = 0; i < input.scenes.length; i++) {
    const s = input.scenes[i]
    const v = voices.get(s.id)!
    jc.check()
    jc.progress(0.6 + (i / input.scenes.length) * 0.3, `Timing captions ${s.id}`)
    let transcript = v.asset.transcript
    if (!transcript) {
      transcript = whisperAvailable()
        ? (await transcribeAsset(v.asset.id, 'en', { signal: jc.signal, check: jc.check, progress: () => undefined })).transcript
        : syntheticTranscript(s.narration, v.duration)
    }
    v.asset = { ...v.asset, transcript }
  }
  // 3. generated visuals (videos made from an idea): AI stills, stock clips, AI clips
  const made = await makeSceneVisuals(jc, { workspaceId: row.workspaceId, userId: jc.job.userId, projectId: row.id, aspect: brief.aspect, scenes: input.scenes, voices })
  // 4. timeline, built on the project as it is now (a rename or script edit saved meanwhile stays); a timeline
  // edited while this ran is left alone
  jc.progress(0.92, 'Assembling timeline')
  jc.check()
  const scenes = made.scenes.map((s) => ({ ...s, voice: voices.has(s.id) ? { assetId: voices.get(s.id)!.asset.id, duration: voices.get(s.id)!.duration } : undefined }))
  const build = (cur: Project) => {
    const built = buildProducerTimeline({ project: cur, brief, scenes, footage, voices, generated: made.generated, brand })
    built.ai = { ...(cur.ai ?? {}), brief, script: { ...(cur.ai?.script ?? {}), scenes }, status: 'assembled', assembled: { fingerprint: timelineFingerprint(built), at: Date.now() } }
    return built
  }
  const notes = made.notes.length ? { notes: made.notes } : {}
  const done = made.notes.length ? `Assembled · ${made.notes.length} scene${made.notes.length === 1 ? '' : 's'} used animated text instead` : 'Assembled'
  try {
    const saved = await saveOnLatest(row.id, (cur) => {
      if (timelineFingerprint(cur) !== base) throw new EditedMeanwhile()
      return build(cur)
    })
    jc.progress(1, done)
    return { version: saved.version, ...notes }
  } catch (err) {
    if (!(err instanceof EditedMeanwhile)) throw err
  }
  // the timeline was edited while this ran: those edits stay where they are, and the new assembly (with the voices
  // and visuals already paid for) goes into a copy next to it
  const cur = await loadProjectRow(row.id)
  const fresh = withFreshIds(cur.doc, uid('p'))
  fresh.name = `${cur.name} (new assembly)`.slice(0, 200)
  const copy = await insertProject({ workspaceId: cur.workspaceId, userId: jc.job.userId, doc: build(fresh), kind: cur.kind })
  ctx().bus.publish(copy.workspaceId, 'project', { id: copy.id, version: copy.version }, { id: copy.id, inline: { id: copy.id, version: copy.version } })
  jc.progress(1, `${done} into a copy, because the timeline was edited meanwhile`)
  return { version: copy.version, copyProjectId: copy.id, message: EDITED_WHILE_ASSEMBLING, ...notes }
}

class EditedMeanwhile extends Error {}

/** At most this many AI clips per video: each costs real money on the workspace's key and minutes to make. */
export const MAX_AI_CLIPS = 3

/**
 * Make (or reuse) each scene's AI still / stock clip / AI clip. Something made earlier for the same prompt is reused
 * (no second bill); a scene whose visual can't be made falls back to animated text, and says why in `notes`.
 */
async function makeSceneVisuals(
  jc: JobContext,
  o: { workspaceId: string; userId: string; projectId: string; aspect: Brief['aspect']; scenes: ScriptScene[]; voices: Map<string, { asset: Asset; duration: number }> },
): Promise<{ scenes: ScriptScene[]; generated: Map<string, Asset>; notes: string[] }> {
  const generated = new Map<string, Asset>()
  const notes: string[] = []
  const scenes = o.scenes.map((s) => ({ ...s }))
  const todo = scenes.filter((s) => s.visual && (s.visual.kind === 'image' || s.visual.kind === 'stock' || s.visual.kind === 'aiVideo'))
  if (!todo.length) return { scenes, generated, notes }
  const work = tmpDir('scene-visuals')
  let clips = 0
  try {
    for (let i = 0; i < todo.length; i++) {
      const s = todo[i]
      const v = s.visual as Extract<NonNullable<ScriptScene['visual']>, { kind: 'image' | 'stock' | 'aiVideo' }>
      const ask = v.kind === 'stock' ? v.query : v.prompt
      jc.check()
      const sub = subContext(jc, 0.6 + (i / todo.length) * 0.3, 0.6 + ((i + 1) / todo.length) * 0.3, `${v.kind === 'image' ? 'Making an image' : v.kind === 'stock' ? 'Finding footage' : 'Making a video clip'} for ${s.id}`)
      // reuse what was made for this scene before, while the request is the same
      if (v.assetId) {
        const prev = (await ctx().db.select().from(assets).where(and(eq(assets.id, v.assetId), eq(assets.workspaceId, o.workspaceId))).limit(1))[0]
        if (prev && prev.status === 'ready' && prev.meta?.generated?.kind === v.kind && prev.meta.generated.prompt === ask) {
          generated.set(s.id, assetDoc(prev))
          continue
        }
      }
      if (v.kind === 'aiVideo' && clips >= MAX_AI_CLIPS) {
        notes.push(`${s.id}: only ${MAX_AI_CLIPS} AI clips are made per video`)
        s.visual = { kind: 'motion', points: [] }
        continue
      }
      const voiceDur = o.voices.get(s.id)?.duration ?? Math.max(2, s.narration.split(/\s+/).length / 2.6)
      try {
        const made = await makeOne(sub, { ...o, jobId: jc.job.id, scene: s, visual: v, ask, seconds: voiceDur + LEAD + TAIL, work })
        if (v.kind === 'aiVideo') clips++
        generated.set(s.id, made.asset)
        s.visual = { ...v, assetId: made.asset.id, ...(made.credit ? { credit: made.credit } : {}) }
      } catch (err) {
        if (jc.signal.aborted) throw err
        const why = err instanceof HttpError ? err.message : 'it could not be made'
        log.warn('scene visual failed', { scene: s.id, kind: v.kind, err })
        notes.push(`${s.id}: ${why}`)
        s.visual = { kind: 'motion', points: [] }
      }
    }
  } finally {
    fs.rm(work, { recursive: true, force: true }, () => undefined)
  }
  return { scenes, generated, notes }
}

async function makeOne(
  jc: Pick<JobContext, 'signal' | 'progress' | 'check'>,
  o: { workspaceId: string; userId: string; projectId: string; jobId: string; aspect: Brief['aspect']; scene: ScriptScene; visual: { kind: 'image' | 'stock' | 'aiVideo' }; ask: string; seconds: number; work: string },
): Promise<{ asset: Asset; credit?: { author: string; url: string } }> {
  const { kind } = o.visual
  let file: { file: string; mime: string; provider: string; model: string }
  let credit: { author: string; url: string } | undefined
  if (kind === 'image') {
    jc.progress(0.05, 'Making an image')
    file = await generateImage({ workspaceId: o.workspaceId, prompt: o.ask, aspect: o.aspect, outDir: o.work, signal: jc.signal })
  } else if (kind === 'stock') {
    jc.progress(0.05, 'Searching stock footage')
    const found = await searchStock({ query: o.ask, aspect: o.aspect, minSeconds: Math.min(20, o.seconds), signal: jc.signal })
    if (!found.length) throw new HttpError(404, 'not_found', `no stock footage matched “${o.ask}”`)
    jc.progress(0.3, 'Downloading footage')
    file = await downloadStock(found[0], o.work, jc.signal)
    credit = { author: found[0].author, url: found[0].pageUrl }
  } else {
    file = await generateVideo({ workspaceId: o.workspaceId, prompt: o.ask, aspect: o.aspect, seconds: o.seconds, outDir: o.work, signal: jc.signal, onProgress: (f, m) => jc.progress(0.05 + f * 0.75, m) })
  }
  jc.check()
  const row = await createAssetFromFile({
    workspaceId: o.workspaceId,
    userId: o.userId,
    projectId: o.projectId,
    filePath: file.file,
    name: `${o.scene.id} · ${o.scene.headline || o.scene.title}`.slice(0, 200),
    mime: file.mime,
    kind: kind === 'image' ? 'image' : 'video',
    origin: kind === 'stock' ? 'stock' : 'ai',
    meta: { generated: { kind, prompt: o.ask, provider: file.provider, model: file.model, ...(credit ? { credit } : {}) }, jobId: o.jobId },
  })
  jc.progress(0.85, 'Preparing it for the editor')
  const ready = await processAsset(row.id, jc)
  return { asset: assetDoc(ready), credit }
}

