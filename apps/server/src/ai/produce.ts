// Producer AI pipeline: ai.produce.script (Claude structured output) and ai.produce.assemble (TTS + timeline).
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm'
import * as z from 'zod/v4'
import {
  captionStyleForBrief,
  createAudioItem,
  createImageItem,
  createProject,
  createShapeItem,
  createTextItem,
  createTrack,
  createVideoItem,
  defaultTextStyle,
  drawingStyleOf,
  MAX_AI_CLIPS_FULL_MOTION,
  withAiLook,
  generateCaptions,
  musicStyleFor,
  videoParts,
  round,
  uid,
  type Asset,
  type DrawingStyleId,
  type Item,
  type MediaCredit,
  type ProducerMeta,
  type Project,
  type ScriptCharacter,
  type SceneObject,
  type SceneVisual,
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
import { CancelledError, type JobContext, subContext } from '../jobs/worker'
import { ffmpeg } from '../media/proc'
import { type AssetRow, createAssetFromFile, localSource, tmpDir } from '../services/assets'
import { processAsset } from '../media/process'
import { log } from '../log'
import { getLook, headlineStyle, labelStyle, lookPalette, sizeForAspect } from '../services/looks'
import { insertProject, loadProjectRow, saveProjectDoc, withFreshIds, type SaveOptions } from '../services/projects'
import { getBrand } from '../routes/workspaces'
import { requireProvider } from './provider'
import { MAX_REFERENCED, castIn, characterPicturePrompt, normalizeCast, withCast } from './cast'
import { drawingPalette, inWorkLine, writeDrawing } from './drawn'
import { type DrawingEnv, renderDrawing } from '../media/drawing'
import { sizeChart } from '../media/size-chart'
import { BlenderUnavailableError, type BlenderRunner, openBlender } from '../media/blender'
import { houseRules } from './rules'
import { ensureTranscript, synthesizeToAsset, transcribeAsset } from './speech'
import { whisperAvailable } from './whisper'
import { SOURCE_NAMES, type StockSource, downloadStock, findIllustration, generateImage, generateVideo, generationCapabilities, illustrationPng, searchStock } from './generate'
import { IDEA_SYSTEM, type IdeaMedia, IdeaScriptSchema, VISUAL_KINDS, buildIdeaPrompt, normalizeIdeaScript } from './scenes'
import { type AnimObject, type Placed, type SceneFrame, animationItems, diagramItems, motionItems, slotIndex } from './scene-layout'
import { type SceneSpan, type VideoSound, addSound, kitFor, makeMusic, planSfx, sfxAsset, sfxCues, sfxManifest } from './soundtrack'

export type Brief = NonNullable<ProducerMeta['brief']>

/**
 * Re-read the project and save `next(current)` on top of that version; if another save lands in between, do it
 * again on the newer one. Jobs that write the project (script, assembly, wizard drafts) never save over edits made
 * while they ran.
 */
export async function saveOnLatest(id: string, next: (cur: Project) => Project, tries = 5, opts?: SaveOptions): Promise<Awaited<ReturnType<typeof saveProjectDoc>>> {
  for (let i = 0; ; i++) {
    const row = await loadProjectRow(id)
    const doc = next(row.doc)
    try {
      return await saveProjectDoc(id, doc, row.version, opts)
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
export async function allowedVisualKinds(workspaceId: string, requested?: VisualKind[], opts: { fullMotion?: boolean } = {}): Promise<VisualKind[]> {
  const caps = await generationCapabilities(workspaceId)
  // AI video is opt-in (slow, and billed per second to the workspace's key); the rest default on when available
  const want = new Set<VisualKind>(requested?.length ? requested : ['motion', 'diagram', 'animation', 'image', 'photo', 'stock'])
  want.add('motion')
  // full motion is the opt-in: every scene a clip
  if (opts.fullMotion) want.add('aiVideo')
  const can = (k: VisualKind) =>
    k === 'image'
      ? !!caps.image
      : k === 'aiVideo'
        ? !!caps.video
        : k === 'stock'
          ? !!caps.stockSources?.video.length
          : k === 'photo'
            ? !!caps.stockSources?.photo.length
            : k === 'animation'
              ? ctx().config.freeMedia
              : k === 'drawn'
                ? !!ctx().config.chromePath && fs.existsSync(ctx().config.chromePath!)
                : true
  return VISUAL_KINDS.filter((k) => want.has(k) && can(k))
}

/**
 * What the writer sees of the person's own clips and images: the image itself, or three frames across a clip. One
 * that can't be read is still listed, just without a picture.
 */
async function mediaPicture(row: AssetRow, work: string, signal: AbortSignal): Promise<string | null> {
  const src = await localSource(row, work, row.proxyKey ?? row.sourceKey)
  const out = path.join(work, `media-${row.id}.jpg`)
  if (row.kind === 'image') await ffmpeg(['-i', src, '-vf', 'scale=512:-2', '-frames:v', '1', '-q:v', '5', out], { signal })
  else {
    const dur = row.meta?.duration ?? 0
    if (dur <= 0) return null
    const step = Math.max(0.5, dur / 3)
    await ffmpeg(['-ss', String(round(step / 2, 2)), '-i', src, '-vf', `fps=1/${round(step, 3)},scale=320:-2,tile=3x1:padding=4:color=black`, '-frames:v', '1', '-q:v', '5', out], { signal })
  }
  return fs.readFileSync(out).toString('base64')
}

/**
 * Idea mode: the writer plans every scene and picks the visual that explains it. Clips and images the person added
 * (`assetIds`) are offered as `media` scenes, with their pictures, so a video can be made from them with no recording.
 */
async function produceIdeaScript(jc: JobContext, input: { projectId: string; brief: Brief; assetIds?: string[] }): Promise<{ script: { scenes: ScriptScene[]; message?: string } }> {
  const provider = await requireProvider(jc.job.workspaceId, 'script')
  const row = await loadProjectRow(input.projectId)
  const kinds = await allowedVisualKinds(row.workspaceId, input.brief.visualKinds, { fullMotion: input.brief.motion === 'full' })
  const rows = (await workspaceAssets(row.workspaceId, input.assetIds ?? [])).filter((r) => r.status === 'ready' && (r.kind === 'video' || r.kind === 'image'))
  const media: IdeaMedia[] = rows.map((r, i) => {
    const speech = r.meta?.transcript?.segments.map((sg) => sg.text).join(' ').trim()
    return { ref: `m${i + 1}`, assetId: r.id, kind: r.kind as 'video' | 'image', name: r.name, duration: r.meta?.duration, ...(speech ? { speech } : {}) }
  })
  if (media.length) kinds.push('media')
  const images: Array<{ label: string; mediaType: 'image/jpeg'; data: string }> = []
  const work = tmpDir('idea-media')
  try {
    for (let i = 0; i < rows.length; i++) {
      jc.progress(0.05 + (i / rows.length) * 0.1, `Looking at ${rows[i].name}`)
      const data = await mediaPicture(rows[i], work, jc.signal).catch((err) => {
        log.warn('idea media picture failed', { assetId: rows[i].id, err })
        return null
      })
      if (data) images.push({ label: `${media[i].ref} (${media[i].kind === 'image' ? 'image' : 'three frames across the clip'}):`, mediaType: 'image/jpeg', data })
      jc.check()
    }
  } finally {
    fs.rm(work, { recursive: true, force: true }, () => undefined)
  }
  // no words on screen: animated text and diagrams are nothing but words (the fallback for a visual that can't be made stays)
  if (input.brief.onScreenText === false && kinds.some((k) => k !== 'motion' && k !== 'diagram' && k !== 'media')) {
    for (const k of ['motion', 'diagram'] as const) if (kinds.includes(k)) kinds.splice(kinds.indexOf(k), 1)
  }
  const { rules, example } = houseRules()
  jc.progress(0.15, 'Writing the script')
  const raw = await provider.structured({ system: IDEA_SYSTEM, prompt: buildIdeaPrompt({ brief: input.brief, kinds, rules, example, media }), images, schema: IdeaScriptSchema, signal: jc.signal })
  const check = IdeaScriptSchema.safeParse(raw)
  if (!check.success) throw new HttpError(502, 'server', 'The AI response did not match the script format')
  const scenes = normalizeIdeaScript(check.data, kinds, media)
  // the characters that return, as the writer described them: every picture and clip of them is made from these words
  const cast = normalizeCast(check.data.cast)
  jc.check()
  await saveOnLatest(input.projectId, (cur) => ({ ...cur, ai: { ...(cur.ai ?? {}), brief: input.brief, script: { scenes, ...(cast.length ? { cast } : {}), message: check.data.message, brief: input.brief }, status: 'scripted' } }))
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
      // a recording with no sound (a screen capture without a microphone) is footage only: nothing to transcribe
      const hear = r.meta?.hasAudio !== false && whisperAvailable()
      transcripts.set(r.id, r.meta?.transcript ?? (hear ? await ensureTranscript(r.id, sub) : { language: 'en', engine: 'none', segments: [] }))
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

/** Where each scene sits on an assembled timeline (after the title card), where the close card starts, and the length. */
export function sceneSpans(scenes: ScriptScene[], voices: Map<string, { duration: number }>, cards = true): { spans: SceneSpan[]; closeStart?: number; duration: number } {
  let t = cards ? TITLE_CARD : 0
  const spans = scenes.map((scene, si) => {
    const voiceDur = voices.get(scene.id)?.duration ?? Math.max(2, scene.narration.split(/\s+/).length / 2.8)
    const start = t
    t = start + round(voiceDur + LEAD + (si === scenes.length - 1 ? CLOSE_TAIL : TAIL), 1)
    return { id: scene.id, start, end: t }
  })
  return cards ? { spans, closeStart: t, duration: round(t + CLOSE_CARD, 3) } : { spans, duration: round(t, 3) }
}

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
  /** AI still, stock clip or photo, or AI clip made for a scene (by scene id) */
  generated?: Map<string, Asset>
  /** The illustrations animation scenes use (by asset id) */
  illustrations?: Map<string, Asset>
  brand?: import('@producer/core').BrandKitDoc | null
  /** Background music and sound effects (made beforehand; see makeSound). */
  sound?: VideoSound
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
  const parts = videoParts(inp.brief)
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
  if (parts.cards) {
    const titleShape = createShapeItem(0, { name: 'Title card', duration: TITLE_CARD, width, height, fill: pal.canvas, radius: 0 })
    titleShape.transitionOut = { type: 'crossfade', duration: 0.5 }
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
  }
  let t = parts.cards ? TITLE_CARD : 0

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
    const madeClip = gen?.kind === 'video' && (visual.kind === 'stock' || visual.kind === 'aiVideo' || visual.kind === 'drawn')
    if (madeClip) windows = [{ assetId: gen.id, start: 0, end: gen.duration ?? dur }]
    // the person's own clip (from its start, or the part they chose) or image, filling the frame like a made one
    const own = visual.kind === 'media' ? inp.footage.get(visual.assetId) : undefined
    const ownClip = own?.kind === 'video' && visual.kind === 'media'
    if (ownClip) {
      const start = Math.min(Math.max(0, visual.start ?? 0), Math.max(0, (own.duration ?? 0) - 0.5))
      windows = [{ assetId: own.id, start, end: Math.max(start + 0.5, visual.end ?? own.duration ?? start + dur) }]
    }
    const fit = madeClip || ownClip ? 'cover' : 'contain'
    const still = gen?.kind === 'image' && (visual.kind === 'image' || visual.kind === 'photo') ? gen : own?.kind === 'image' ? own : undefined
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
      // a still (AI-made or the person's own), brought to life with a slow pan and zoom
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
    // the last scene slides into the closing card; with no card there is nothing after it to move to
    if (!isLast) lastPiece.transitionOut = { type: 'crossfade', duration: 0.5 }
    else if (parts.cards) lastPiece.transitionOut = { type: 'slideUp', duration: 0.5 }

    // voice
    if (v) {
      addAsset(v.asset)
      voice.items.push(createAudioItem(v.asset, round(sceneStart + LEAD, 4), { name: `${scene.id} voice`, duration: round(v.duration, 3), tts: { text: scene.narration, voice: inp.brief.voice, speed: 1 } }))
    }
    // headline (top band, captions own the bottom) + chapter label
    const fullFrame = windows.length > 0 || !!still
    const points = visual.kind === 'motion' ? (visual.points ?? []).filter(Boolean) : []
    // an animation is laid out like a diagram: the headline small in the top band, the drawing under it
    const animation = visual.kind === 'animation' && visual.objects.length ? visual : undefined
    const diagram = visual.kind === 'diagram' ? visual.diagram : undefined
    const drawn = !!diagram || !!animation
    // a card with only the headline: centred and big; above points or a diagram: smaller, in the top band
    const centred = !fullFrame && !points.length && !drawn
    const headY = centred ? -20 * scale : drawn ? -height * 0.38 : points.length ? -height * (vertical ? 0.3 : 0.28) : -height * (vertical ? 0.36 : 0.37)
    const headSize = centred ? (vertical ? 96 : 110) : drawn ? (vertical ? 60 : 66) : points.length ? (vertical ? 80 : 92) : vertical ? 64 : 72
    // words off: no headline, unless it is all this scene has to show (a visual that couldn't be made)
    if (parts.onScreenText || centred) cards.items.push(
      createTextItem(round(sceneStart + 0.3, 4), 'heading', {
        name: `${scene.id} headline`,
        text: scene.headline || scene.title,
        duration: round(dur - 0.5, 3),
        style: headlineStyle(pal, width, Math.round(headSize * scale), fullFrame ? { background: { color: pal.canvas, radius: 14, padding: Math.round(18 * scale), opacity: 0.88 }, boxWidth: Math.round(width * 0.86) } : {}),
        transform: { x: 0, y: round(headY, 1), scale: 1, rotation: 0 },
        animations: { in: { preset: 'rise', duration: 0.5 }, out: { preset: 'fade', duration: 0.3 } },
      }),
    )
    // a stock clip or photo whose licence asks for credit (CC BY, CC BY-SA): a small line in the top corner, editable
    const credit = (visual.kind === 'stock' || visual.kind === 'photo') && fullFrame ? visual.credit : undefined
    if (credit?.licence) {
      labels.items.push(
        createTextItem(round(sceneStart + 0.2, 4), 'body', {
          name: `${scene.id} credit`,
          text: `${visual.kind === 'photo' ? 'Photo' : 'Video'}: ${credit.author.slice(0, 60)} · ${credit.licence}${credit.source ? ` · ${credit.source}` : ''}`,
          duration: round(dur - 0.4, 3),
          style: { ...defaultTextStyle(), fontFamily: pal.bodyFont, fontSize: Math.round(20 * scale), fontWeight: 500, color: '#ffffff', align: 'right', boxWidth: Math.round(width * 0.6), shadow: { color: 'rgba(0,0,0,0.7)', blur: 6, x: 0, y: 1 } },
          transform: { x: round(width * 0.2 - 30 * scale, 1), y: round(-height / 2 + 34 * scale, 1), scale: 1, rotation: 0 },
          animations: { in: { preset: 'fade', duration: 0.4 }, out: { preset: 'fade', duration: 0.3 } },
        }),
      )
    }
    // motion points, diagrams and animations: editable shapes, pictures and text revealed as the narration names each part
    if (points.length || drawn) {
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
      const objects = (a: Extract<SceneVisual, { kind: 'animation' }>): AnimObject[] => a.objects.map((o) => ({ name: o.name, label: parts.onScreenText ? o.label : undefined, noWord: !parts.onScreenText, asset: o.assetId ? inp.illustrations?.get(o.assetId) : undefined }))
      graphics.push(animation ? animationItems(animation.style, objects(animation), frame) : diagram ? diagramItems(diagram, frame) : motionItems(points, frame))
      for (const o of animation?.objects ?? []) if (o.assetId && inp.illustrations?.has(o.assetId)) addAsset(inp.illustrations.get(o.assetId)!)
    }
    const noFootage = centred
    if (noFootage && scene.title && parts.onScreenText) {
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
  if (parts.cards) {
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
  }

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
  if (inp.sound) {
    const sounded = addSound(p, inp.sound, parts.cards ? closeStart + CLOSE_CARD : closeStart)
    p.tracks = sounded.tracks
    p.assets = sounded.assets
  }
  // captions from the voice transcripts
  if (!parts.captions) return { ...p, updatedAt: Date.now() }
  // the look, font, size and place the brief picked (else the brand kit's look in its body font)
  const captionStyle = captionStyleForBrief(inp.brief, { brandPreset: inp.brand?.captionPreset, brandFont: pal.bodyFont, scale, boxWidth: Math.round(width * 0.8) })
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
  /** Scenes to narrate with a fresh take (A-7): the voice made before for the same words isn't reused. */
  renarrate?: string[]
}

type Voice = { asset: Asset; duration: number }

/**
 * A voice already made for this narration in this voice: the scene's own, else one made for this project (a failed
 * run's: a retry re-voices nothing it already has). One this job made before its worker died is processed now.
 */
async function reuseVoice(jc: JobContext, o: { workspaceId: string; projectId: string; text: string; voice: string; speed?: number; hint?: string }): Promise<Voice | undefined> {
  const db = ctx().db
  const same = (r: AssetRow) => r.meta?.tts?.text === o.text && r.meta.tts.voice === o.voice && (r.meta.tts.speed ?? 1) === (o.speed ?? 1)
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
  // the brief's brand kit (a kit deleted since: the space's default)
  const { getBrandKit } = await import('../services/brand')
  const brand = await getBrandKit(row.workspaceId, brief.brandKitId, { fallback: true })
  if (!input.scenes?.length) throw invalid('No scenes to assemble')
  const footageIds = [...new Set(input.scenes.flatMap((s) => [...s.footage.map((f) => f.assetId), ...(s.visual?.kind === 'media' ? [s.visual.assetId] : [])]))]
  const footageRows = await ctx().db.select().from(assets).where(and(eq(assets.workspaceId, row.workspaceId), inArray(assets.id, footageIds.length ? footageIds : ['-'])))
  const footage = new Map(footageRows.map((r) => [r.id, assetDoc(r)]))
  // 1. voice per scene (reuse one already made for the same narration and voice)
  // (a video with no narration has none: its scenes last as long as their description would take to say)
  const parts = videoParts(brief)
  const spoken = parts.narration ? input.scenes : []
  const voices = new Map<string, Voice>()
  const prior = new Map((doc.ai?.script?.scenes ?? []).map((s) => [s.id, s]))
  for (let i = 0; i < spoken.length; i++) {
    const s = spoken[i]
    jc.check()
    const sub = subContext(jc, (i / input.scenes.length) * 0.6, ((i + 1) / input.scenes.length) * 0.6, `Voicing ${s.id}`)
    // a scene may have its own narrator (voice, speed); one asked to be narrated again gets a fresh take
    const voice = s.narrator?.voice ?? brief.voice
    const speed = s.narrator?.speed ?? 1
    const fresh = input.renarrate?.includes(s.id)
    const reused = fresh ? undefined : await reuseVoice(jc, { workspaceId: row.workspaceId, projectId: row.id, text: s.narration, voice, speed, hint: (s.voice ?? prior.get(s.id)?.voice)?.assetId })
    if (reused) {
      voices.set(s.id, reused)
      continue
    }
    const v = await synthesizeToAsset({ workspaceId: row.workspaceId, userId: jc.job.userId, projectId: row.id, text: s.narration, voice, speed, name: `${s.id} · ${s.title}`, jobId: jc.job.id }, sub)
    voices.set(s.id, { asset: v.asset.asset, duration: v.duration })
  }
  // 2. word timings for captions (whisper round trip, or an estimate)
  for (let i = 0; i < spoken.length; i++) {
    const s = spoken[i]
    const v = voices.get(s.id)!
    jc.check()
    // (quick, and said at the end of the voices' share of the bar: the visuals' share starts here and never goes back)
    jc.progress(0.6, `Timing captions ${s.id}`)
    let transcript = v.asset.transcript
    if (!transcript) {
      transcript = whisperAvailable()
        ? (await transcribeAsset(v.asset.id, 'en', { signal: jc.signal, check: jc.check, progress: () => undefined })).transcript
        : syntheticTranscript(s.narration, v.duration)
    }
    v.asset = { ...v.asset, transcript }
  }
  // 3. generated visuals (videos made from an idea): AI stills, stock clips, AI clips
  const frameSize = sizeForAspect(brief.aspect || getLook(brief.template).aspect)
  const drawing = { ...frameSize, fps: doc.fps || 30, pal: lookPalette(getLook(brief.template), brand), silent: !parts.narration, noWords: !parts.onScreenText, style: drawingStyleOf(brief.drawingStyle) }
  const allowed = await allowedVisualKinds(row.workspaceId, brief.visualKinds, { fullMotion: brief.motion === 'full' })
  const made = await makeSceneVisuals(jc, { workspaceId: row.workspaceId, userId: jc.job.userId, projectId: row.id, aspect: brief.aspect, scenes: input.scenes, voices, drawing, look: brief.aiLook, fullMotion: brief.motion === 'full', allowed, cast: doc.ai?.script?.cast })
  // 3b. music composed on the cuts, and sound effects where things move (both free: made on this server)
  const probe = () => buildProducerTimeline({ project: doc, brief, scenes: made.scenes, footage, voices, generated: made.generated, illustrations: made.illustrations, brand })
  const sounded = await makeSound(subContext(jc, 0.9, 0.92, 'Adding music and sound'), { workspaceId: row.workspaceId, userId: jc.job.userId, projectId: row.id, jobId: jc.job.id, brief, scenes: made.scenes, voices, probe, seed: brand?.name || row.id })
  made.notes.push(...sounded.notes)
  // 4. timeline, built on the project as it is now (a rename or script edit saved meanwhile stays); a timeline
  // edited while this ran is left alone
  jc.progress(0.92, 'Assembling timeline')
  jc.check()
  const scenes = made.scenes.map((s) => ({ ...s, voice: voices.has(s.id) ? { assetId: voices.get(s.id)!.asset.id, duration: voices.get(s.id)!.duration } : undefined }))
  // the timeline shows text where nothing else could be made; the script keeps what it asked for there
  const script = scenes.map((s) => (made.asked.has(s.id) ? { ...s, visual: made.asked.get(s.id) } : s))
  const build = (cur: Project) => {
    const built = buildProducerTimeline({ project: cur, brief, scenes, footage, voices, generated: made.generated, illustrations: made.illustrations, brand, sound: sounded.sound })
    built.ai = { ...(cur.ai ?? {}), brief, script: { ...(cur.ai?.script ?? {}), scenes: script }, status: 'assembled', assembled: { fingerprint: timelineFingerprint(built), at: Date.now() } }
    return built
  }
  const notes = made.notes.length ? { notes: made.notes } : {}
  const done = made.notes.length ? `Assembled · ${made.notes.length} thing${made.notes.length === 1 ? '' : 's'} to know about it` : 'Assembled'
  try {
    const saved = await saveOnLatest(
      row.id,
      (cur) => {
        if (timelineFingerprint(cur) !== base) throw new EditedMeanwhile()
        return build(cur)
      },
      5,
      { userId: jc.job.userId, before: 'before-ai', note: 'Producer AI assembly' },
    )
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

/**
 * The music and sound effects a brief asks for: the music composed (or reused) on the video's cuts, and each effect's
 * take this space has (or a copy of the shipped one). Neither stops an assembly: what can't be made is left out and
 * said in `notes`.
 */
async function makeSound(
  jc: JobContext,
  o: { workspaceId: string; userId: string; projectId: string; jobId: string; brief: Brief; scenes: ScriptScene[]; voices: Map<string, Voice>; probe: () => Project; seed: string },
): Promise<{ sound?: VideoSound; notes: string[] }> {
  const style = musicStyleFor(o.brief.music, o.brief.tone)
  const effects = o.brief.soundEffects === true
  if (!style && !effects) return { notes: [] }
  const parts = videoParts(o.brief)
  const layout = sceneSpans(o.scenes, o.voices, parts.cards)
  const notes: string[] = []
  const sound: VideoSound = {}
  const work = tmpDir('sound')
  try {
    if (style) {
      try {
        sound.music = await makeMusic(subContext(jc, 0, effects ? 0.8 : 1), { ...o, style, spans: layout.spans, duration: layout.duration, work, voiced: parts.narration, cards: parts.cards })
      } catch (err) {
        if (jc.signal.aborted) throw err
        log.warn('music could not be made', { err })
        notes.push(`No music: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
    const m = effects ? sfxManifest() : null
    if (effects && !m) notes.push('No sound effects: this install has none')
    if (m) {
      try {
        const plan = planSfx(sfxCues(o.probe(), layout.spans, layout.closeStart), kitFor(style), m)
        const byFile = new Map<string, Asset>()
        sound.effects = []
        for (const e of plan) {
          jc.check()
          if (!byFile.has(e.take.file)) byFile.set(e.take.file, await sfxAsset({ ...o, take: e.take, role: e.role, work }, { signal: jc.signal, check: jc.check, progress: () => undefined }))
          sound.effects.push({ asset: byFile.get(e.take.file)!, start: e.start, volume: e.volume, name: `${e.cue.moment} sound` })
        }
        jc.progress(1, `${sound.effects.length} sound effects`)
      } catch (err) {
        if (jc.signal.aborted) throw err
        log.warn('sound effects could not be added', { err })
        notes.push(`No sound effects: ${err instanceof Error ? err.message : String(err)}`)
        sound.effects = undefined
      }
    }
  } finally {
    fs.rm(work, { recursive: true, force: true }, () => undefined)
  }
  return { sound, notes }
}

/** At most this many AI clips per video: each costs real money on the workspace's key and minutes to make. */
export const MAX_AI_CLIPS = 3
/** At most this many AI-drawn scenes per video: each is a few calls to the space's AI and a minute of rendering. */
export const MAX_DRAWN = 6
/** AI-drawn scenes drawn at the same time (each waits minutes on the model; its test and final renders are short). */
export const DRAWN_AT_ONCE = 2
/**
 * One drawing, start to clip, takes this long at most. Each of its steps has its own limit and reports while it runs
 * (ai/drawn.ts); this is for whatever still hangs (an upload, a browser that won't close). That scene is given up and
 * stood in for, and the rest of the video is made: one scene never costs the whole run.
 */
export const DRAWN_LIMITS = { sceneMs: 30 * 60_000 }

type MadeKind = 'image' | 'stock' | 'photo' | 'aiVideo'
const MAKING: Record<MadeKind, string> = { image: 'Making an image', stock: 'Finding footage', photo: 'Finding a photo', aiVideo: 'Making a video clip' }

/**
 * Make (or reuse) each scene's AI still / stock clip or photo / AI clip, and find the illustrations of its animations.
 * Something made earlier for the same prompt is reused (no second bill); a scene whose visual can't be made is drawn
 * or painted instead where the video may use those kinds (`instead` below), else falls back to animated text, and says
 * why in `notes`.
 */
async function makeSceneVisuals(
  jc: JobContext,
  o: {
    workspaceId: string
    userId: string
    projectId: string
    aspect: Brief['aspect']
    scenes: ScriptScene[]
    voices: Map<string, { asset: Asset; duration: number }>
    /** The frame AI-drawn scenes are drawn for. */
    drawing?: { width: number; height: number; fps: number; pal: { canvas: string; accent: string; ink: string; headlineFont: string; bodyFont: string }; silent?: boolean; noWords?: boolean; style: DrawingStyleId }
    /** The look every AI picture and clip is made in (AI_LOOKS; absent / 'auto': each prompt's own). */
    look?: string
    /** Every scene a clip: more AI clips allowed (MAX_AI_CLIPS_FULL_MOTION). */
    fullMotion?: boolean
    /** The visual kinds this video may use (the brief's, as this space can make them): what a failed visual may become. */
    allowed?: VisualKind[]
    /** The script's returning characters (ai.script.cast): each is said, and where it can be shown, the same way in every picture and clip. */
    cast?: ScriptCharacter[]
  },
): Promise<{ scenes: ScriptScene[]; generated: Map<string, Asset>; illustrations: Map<string, Asset>; notes: string[]; asked: Map<string, NonNullable<ScriptScene['visual']>> }> {
  const generated = new Map<string, Asset>()
  const illustrations = new Map<string, Asset>()
  const notes: string[] = []
  // what the script asked for, of the scenes only text could show this time: the script keeps it, so the next
  // assembly tries again (a failure is not the script's to remember)
  const asked = new Map<string, NonNullable<ScriptScene['visual']>>()
  const written = new Map(o.scenes.map((s) => [s.id, s.visual]))
  const scenes = o.scenes.map((s) => ({ ...s }))
  const todo = scenes.filter((s) => s.visual && (s.visual.kind === 'image' || s.visual.kind === 'stock' || s.visual.kind === 'photo' || s.visual.kind === 'aiVideo' || s.visual.kind === 'animation' || s.visual.kind === 'drawn'))
  if (!todo.length) return { scenes, generated, illustrations, notes, asked }
  const work = tmpDir('scene-visuals')
  let clips = 0
  const maxClips = o.fullMotion ? MAX_AI_CLIPS_FULL_MOTION : MAX_AI_CLIPS
  const clipScenes = todo.filter((s) => s.visual?.kind === 'aiVideo')
  const caps = clipScenes.length ? await generationCapabilities(o.workspaceId) : undefined
  // Wan clips start from a picture painted first, when this space can paint one
  const fromPicture = !!caps?.video?.fromPicture
  // The film's characters. Each picture and clip is made on its own, so the script's cast is said word for word in
  // every prompt that shows a character; and where the clip model takes reference pictures, one picture of each
  // character that is in more than one clip is painted once (below) and sent with each of those clips.
  const cast = normalizeCast(o.cast)
  /** character name → its reference picture (a file). */
  const pictures = new Map<string, string>()
  const inClips = (c: ScriptCharacter) => clipScenes.filter((s) => castIn((s.visual as { prompt: string }).prompt, [c]).length).length
  const toPicture = caps?.video?.references ? cast.filter((c) => inClips(c) > 1).slice(0, MAX_REFERENCED) : []
  /** The pictured characters side by side at their true sizes (a file), and who is on it: sent with clips that show them all. */
  let chart: { file: string; names: string[] } | undefined
  // Blender scenes: this computer's Blender or a rented RunPod card, opened on the first one and closed (the pod
  // deleted) when the visuals are done; without one they're drawn in the 3D studio style instead
  let drawing = o.drawing
  let blender: BlenderRunner | undefined
  let opened: BlenderRunner | undefined
  // A scene whose visual can't be made is not left a bare text card while something else can show it: a clip that
  // can't be made (or is over the limit) is drawn in the video's drawing style, and a scene that can't be drawn is
  // painted as an AI picture, when the video may use those kinds. Only then does it become animated text.
  const first = new Map<string, { what: string; why: string }>()
  let canDraw: boolean | undefined
  const instead = async (s: ScriptScene, from: 'aiVideo' | 'drawn', prompt: string, why: string): Promise<boolean> => {
    if (!first.has(s.id)) first.set(s.id, { what: from === 'aiVideo' ? 'its clip couldn’t be made' : 'it couldn’t be drawn', why })
    if (from === 'aiVideo' && drawing && todo.filter((x) => x.visual?.kind === 'drawn').length < MAX_DRAWN) {
      // a film asked for in full motion is animation: drawing is the nearest thing to the clip, whatever kinds were ticked
      canDraw ??= o.fullMotion ? (await allowedVisualKinds(o.workspaceId, ['drawn'])).includes('drawn') : !!o.allowed?.includes('drawn')
      if (canDraw) {
        if (drawing.style === 'blender' && !blender) drawing = { ...drawing, style: 'studio3d' }
        s.visual = { kind: 'drawn', prompt }
        return true
      }
    }
    if (!o.allowed?.includes('image')) return false
    s.visual = { kind: 'image', prompt }
    return true
  }
  /** The note of a scene that ended up as something else than it was written as. */
  const stoodIn = (s: ScriptScene, as: 'drawn' | 'image') => {
    const f = first.get(s.id)
    if (f) notes.push(`${s.id}: ${as === 'drawn' ? 'The AI drew this scene' : 'An AI picture stands in'} because ${f.what}. ${f.why.charAt(0).toUpperCase()}${f.why.slice(1)}`)
  }
  /** Nothing could show it: animated text, and why (the first reason: what the scene was meant to be). */
  const asText = (s: ScriptScene, why: string) => {
    notes.push(`${s.id}: ${first.get(s.id)?.why ?? why}`)
    const was = written.get(s.id)
    if (was) asked.set(s.id, was)
    s.visual = { kind: 'motion', points: [] }
  }
  if (drawing?.style === 'blender' && todo.some((s) => s.visual?.kind === 'drawn')) {
    try {
      blender = await openBlender(o.workspaceId)
      opened = blender
    } catch (err) {
      const why = err instanceof HttpError ? err.message : 'Blender isn’t available'
      notes.push(`Blender scenes were drawn in the 3D studio style instead: ${why}`)
      drawing = { ...drawing, style: 'studio3d' }
    }
  }
  // The visuals' share of the bar (0.6 to 0.9) is what is done of all the scenes together, each counting its own
  // part. Several drawings are under way at once: the last scene finishing first must not read as "nearly done" while
  // another is still being written, and the bar never goes back whichever of them reports.
  const part = todo.map(() => 0)
  const tell = (i: number, f: number, m?: string) => {
    if (f >= 0) part[i] = Math.max(part[i], Math.min(1, f))
    jc.progress(0.6 + (part.reduce((a, b) => a + b, 0) / todo.length) * 0.3, m)
  }
  // The job has one status line. Each scene in work keeps the step it last said, and the line names them all in scene
  // order (inWorkLine), so two drawings under way read as one steady line, not two taking turns every few seconds.
  const inWork = new Map<number, { label: string; step?: string }>()
  const line = () => inWorkLine([...inWork.entries()].sort((a, b) => a[0] - b[0]).map(([, w]) => w))
  /** This scene says nothing more for now (its entry leaves the line). */
  const idle = (s: ScriptScene) => void inWork.delete(todo.indexOf(s))
  /** This scene's visual is settled (made, reused, or given up); the line goes on with the scenes still in work. */
  const finished = (s: ScriptScene) => {
    idle(s)
    tell(todo.indexOf(s), 1, line())
  }
  const slot = (s: ScriptScene, label: string): JobContext => {
    const i = todo.indexOf(s)
    return {
      ...jc,
      progress: (f, m) => {
        if (m !== undefined) inWork.set(i, { label, step: m })
        tell(i, f, m !== undefined ? line() : m)
      },
    }
  }
  /** One scene's drawing, given up (the scene, not the job) when it takes longer than DRAWN_LIMITS.sceneMs. */
  const withinLimit = async <T>(s: ScriptScene, work: (sc: Pick<JobContext, 'signal' | 'progress' | 'check'>) => Promise<T>): Promise<T> => {
    const ac = new AbortController()
    const onStop = () => ac.abort(jc.signal.reason)
    if (jc.signal.aborted) onStop()
    else jc.signal.addEventListener('abort', onStop, { once: true })
    const ms = DRAWN_LIMITS.sceneMs
    const tooLong = () => new HttpError(504, 'server', `it took longer than ${ms >= 60_000 ? `${Math.round(ms / 60_000)} minutes` : `${Math.round(ms / 1000)} s`} to draw`)
    let late = false
    let timer: NodeJS.Timeout | undefined
    const over = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        late = true
        ac.abort()
        reject(tooLong())
      }, ms)
      timer.unref?.()
    })
    const sc = slot(s, `Drawing ${s.id}`)
    const run = work({
      signal: ac.signal,
      // a scene given up says nothing more, whatever of it is still winding down
      progress: (f, m) => {
        if (!late) sc.progress(f, m)
      },
      check: () => {
        if (ac.signal.aborted) throw new CancelledError()
      },
    })
    // given up when too long: whatever it does afterwards is nobody's to handle
    run.catch(() => undefined)
    try {
      return await Promise.race([run, over])
    } catch (err) {
      if (late && !jc.signal.aborted) throw tooLong()
      throw err
    } finally {
      clearTimeout(timer)
      jc.signal.removeEventListener('abort', onStop)
    }
  }

  /**
   * A scene's AI still, stock clip or photo, or AI clip: reused, made, or stood in for. A clip that can't be made may
   * leave here as a drawn scene (drawn with the others, below) or be made again as an AI picture.
   */
  const make = async (s: ScriptScene): Promise<void> => {
    try {
      await makeOrStandIn(s)
    } finally {
      // (a clip that became a drawing is in work again when it is drawn)
      idle(s)
    }
  }
  const makeOrStandIn = async (s: ScriptScene): Promise<void> => {
    for (;;) {
      const v = s.visual as Extract<NonNullable<ScriptScene['visual']>, { kind: MadeKind }>
      // generated pictures and clips in the video's look, with the characters they show described the way the cast
      // describes them; a clip is also given the reference pictures of (up to MAX_REFERENCED of) its characters, which
      // the words number in the order they are sent (the reuse below compares the whole request)
      const shown = v.kind === 'image' || v.kind === 'aiVideo' ? castIn(v.prompt, cast) : []
      const pictured = v.kind === 'aiVideo' ? shown.filter((c) => pictures.has(c.name)).slice(0, MAX_REFERENCED) : []
      // a clip that shows everyone on the size chart is sent it too, after their own pictures
      const sized = chart && chart.names.every((n) => pictured.some((c) => c.name === n)) ? chart : undefined
      const ask = v.kind === 'stock' || v.kind === 'photo' ? v.query : withCast(withAiLook(v.prompt, o.look), [...pictured, ...shown.filter((c) => !pictured.includes(c))], pictured.length, sized ? pictured.length + 1 : undefined)
      // reuse what was made for this scene before, while the request is the same
      if (v.assetId) {
        const prev = (await ctx().db.select().from(assets).where(and(eq(assets.id, v.assetId), eq(assets.workspaceId, o.workspaceId))).limit(1))[0]
        if (prev && prev.status === 'ready' && prev.meta?.generated?.kind === v.kind && prev.meta.generated.prompt === ask) {
          generated.set(s.id, assetDoc(prev))
          return
        }
      }
      let why: string
      if (v.kind === 'aiVideo' && clips >= maxClips) why = `only ${maxClips} AI clips are made per video`
      else {
        const voiceDur = o.voices.get(s.id)?.duration ?? Math.max(2, s.narration.split(/\s+/).length / 2.6)
        try {
          const made = await makeOne(slot(s, `${MAKING[v.kind]} for ${s.id}`), { ...o, jobId: jc.job.id, scene: s, visual: v, ask, seconds: voiceDur + LEAD + TAIL, work, fromPicture, references: [...pictured.map((c) => pictures.get(c.name)!), ...(sized ? [sized.file] : [])] })
          if (v.kind === 'aiVideo') clips++
          generated.set(s.id, made.asset)
          s.visual = { ...v, assetId: made.asset.id, ...(made.credit ? { credit: made.credit } : {}) }
          if (v.kind === 'image') stoodIn(s, 'image')
          return
        } catch (err) {
          if (jc.signal.aborted) throw err
          why = err instanceof HttpError ? err.message : 'it could not be made'
          log.warn('scene visual failed', { scene: s.id, kind: v.kind, err })
        }
      }
      if (v.kind !== 'aiVideo' || !(await instead(s, 'aiVideo', v.prompt, why))) return asText(s, why)
      // drawn with the other drawings; an AI picture is made right here
      if (s.visual?.kind === 'drawn') return
    }
  }

  /** One AI-drawn scene. False: it couldn't be drawn (why is kept for what stands in). */
  const couldNotDraw = new Map<string, string>()
  // one scene's code, shown to the scenes drawn after it, so the same fox is the same fox in every scene
  let reference: string | undefined
  const draw = async (s: ScriptScene, onWorking?: (code: string) => void): Promise<void> => {
    const v = s.visual as Extract<SceneVisual, { kind: 'drawn' }>
    for (;;) {
      const style = drawing!.style
      try {
        const opts = { ...o, drawing: drawing!, jobId: jc.job.id, scene: s, visual: v, last: o.scenes.at(-1)?.id === s.id, work, blender, reference, onWorking }
        // (Blender renders on a rented card and keeps its own time)
        const made = blender ? await makeDrawn(slot(s, `Drawing ${s.id}`), opts) : await withinLimit(s, (sc) => makeDrawn(sc, opts))
        reference ??= made.code
        generated.set(s.id, made.asset)
        s.visual = { kind: 'drawn', prompt: v.prompt, code: made.code, assetId: made.asset.id, ...(style !== 'clean' ? { style } : {}) }
        stoodIn(s, 'drawn')
        finished(s)
        return
      } catch (err) {
        if (jc.signal.aborted) throw err
        if (blender && err instanceof BlenderUnavailableError) {
          // Blender can't be used for this video: this scene and the rest are drawn in the 3D studio style
          notes.push(`Blender scenes from ${s.id} on were drawn in the 3D studio style instead: ${err.message}`)
          await blender.close()
          blender = undefined
          drawing = { ...drawing!, style: 'studio3d' }
          continue
        }
        log.warn('drawn scene failed', { scene: s.id, err })
        couldNotDraw.set(s.id, err instanceof HttpError ? err.message : 'it could not be drawn')
        finished(s)
        return
      }
    }
  }

  try {
    // 0. the characters' reference pictures: painted once per video (kept with the project, so the next assembly
    // uses the same ones), then sent with every clip a character is in. One that can't be painted leaves its
    // character to the words, and says so.
    for (const c of toPicture) {
      jc.check()
      jc.progress(0.6, `Painting ${c.name} for the clips`)
      try {
        pictures.set(c.name, await characterPicture(jc, { workspaceId: o.workspaceId, userId: o.userId, projectId: o.projectId, jobId: jc.job.id, character: c, look: o.look, work }))
      } catch (err) {
        if (jc.signal.aborted) throw err
        log.warn('character picture failed', { character: c.name, err })
        notes.push(`${c.name} may look different from clip to clip: its reference picture couldn’t be painted (${err instanceof HttpError ? err.message : 'it could not be made'})`)
      }
    }
    // ...and the characters side by side at their true sizes, made from those pictures (each fills its own, so nothing
    // else shows how big one is beside the other); without it the words still say how their heights compare
    const onChart = toPicture.filter((c) => pictures.has(c.name) && c.heightCm)
    if (onChart.length > 1) {
      try {
        const file = path.join(work, `sizes-${crypto.randomBytes(4).toString('hex')}.jpg`)
        await sizeChart(onChart.map((c) => ({ file: pictures.get(c.name)!, heightCm: c.heightCm! })), file)
        chart = { file, names: onChart.map((c) => c.name) }
      } catch (err) {
        log.warn('size chart failed; the sizes are said in words only', { err })
      }
    }
    // 1. everything but the drawings, in order
    for (const s of todo) {
      jc.check()
      if (s.visual?.kind === 'animation') {
        tell(todo.indexOf(s), 0, `Drawing the animation for ${s.id}`)
        const { visual, missing } = await findIllustrations(jc, { ...o, jobId: jc.job.id, visual: s.visual, work, into: illustrations })
        s.visual = visual
        if (missing.length) notes.push(`${s.id}: no illustration found for ${missing.map((m) => `“${m}”`).join(', ')}, so a labelled circle stands in`)
      } else if (s.visual?.kind !== 'drawn') await make(s)
      // (a clip that became a drawing is settled when it is drawn, below)
      if (s.visual?.kind !== 'drawn') finished(s)
    }
    // 2. the drawings (the script's, and clips that became one). A drawing takes minutes, nearly all of it waiting for
    // the model, so DRAWN_AT_ONCE are drawn at a time; Blender has one card and takes them one by one.
    const toDraw = todo.filter((s) => s.visual?.kind === 'drawn')
    if (!drawing) for (const s of toDraw) s.visual = { kind: 'motion', points: [] }
    else if (toDraw.length) {
      const now = toDraw.slice(0, MAX_DRAWN)
      for (const s of toDraw.slice(MAX_DRAWN)) couldNotDraw.set(s.id, `only ${MAX_DRAWN} scenes are drawn per video`)
      const style = drawing.style
      // A drawing this video already has for the same note in this style, from a run that was stopped or failed after
      // finishing it (its code is kept on its clip): used again, not paid for twice.
      for (const s of now) {
        const v = s.visual as Extract<SceneVisual, { kind: 'drawn' }>
        if (v.code && drawingStyleOf(v.style) === style) continue
        const was = await earlierDrawing({ workspaceId: o.workspaceId, projectId: o.projectId, prompt: v.prompt, style })
        if (was) s.visual = { kind: 'drawn', prompt: v.prompt, code: was.code, assetId: was.assetId, ...(style !== 'clean' ? { style } : {}) }
      }
      // a scene drawn before in this style (an earlier assembly) already shows how the film's characters look
      reference = now.map((s) => s.visual).find((v): v is Extract<SceneVisual, { kind: 'drawn' }> & { code: string } => v?.kind === 'drawn' && !!v.code && drawingStyleOf(v.style) === style)?.code
      // else the first scene leads: the others start as soon as its code first runs (its looks go on meanwhile)
      let lead: Promise<void> | undefined
      if (!reference && !blender && now.length > 1) {
        let started!: () => void
        const working = new Promise<void>((r) => (started = r))
        lead = draw(now[0], (code) => {
          reference ??= code
          started()
        }).finally(started)
        await working
      }
      let next = lead ? 1 : 0
      const lane = async () => {
        while (next < now.length) {
          jc.check()
          await draw(now[next++])
        }
      }
      const lanes = await Promise.allSettled([...(lead ? [lead] : []), ...Array.from({ length: Math.min(blender ? 1 : DRAWN_AT_ONCE, now.length - next) }, lane)])
      const broke = lanes.find((l) => l.status === 'rejected')
      if (broke) throw (broke as PromiseRejectedResult).reason
      // 3. what couldn't be drawn: an AI picture where the video may have one, else text
      for (const s of toDraw) {
        const why = couldNotDraw.get(s.id)
        if (why === undefined) continue
        jc.check()
        const v = s.visual as Extract<SceneVisual, { kind: 'drawn' }>
        if (await instead(s, 'drawn', v.prompt, why)) await make(s)
        else asText(s, why)
      }
    }
  } finally {
    if (opened) {
      await opened.close()
      const info = 'info' in opened ? (opened as { info?: { gpu?: string; costPerHr?: number } }).info : undefined
      if (info) notes.push(`Blender scenes rendered on a rented ${info.gpu || 'graphics card'}${info.costPerHr ? ` ($${info.costPerHr.toFixed(2)} an hour)` : ''}, billed to your RunPod account; the card was given back when they were done`)
    }
    fs.rm(work, { recursive: true, force: true }, () => undefined)
  }
  return { scenes, generated, illustrations, notes: sameReasonTogether(notes), asked }
}

/**
 * "s01: why", "s02: why" → "s01, s02: why": one line per reason, in the order they first came, its scenes in scene
 * order (drawings finish in any order: the second can be done before the first).
 */
export function sameReasonTogether(notes: string[]): string[] {
  const out: Array<{ ids: string[]; why: string } | string> = []
  const byWhy = new Map<string, { ids: string[]; why: string }>()
  for (const n of notes) {
    const m = /^(s[\w-]+): ([\s\S]+)$/.exec(n)
    if (!m) {
      out.push(n)
      continue
    }
    const g = byWhy.get(m[2])
    if (g) g.ids.push(m[1])
    else {
      const ng = { ids: [m[1]], why: m[2] }
      byWhy.set(m[2], ng)
      out.push(ng)
    }
  }
  const inOrder = (ids: string[]) => [...ids].sort((a, b) => a.localeCompare(b, 'en', { numeric: true }))
  return out.map((o) => (typeof o === 'string' ? o : `${inOrder(o.ids).join(', ')}: ${o.why}`))
}

/** What a drawing was asked for: the director's note and the drawing style (its clip keeps the code under this). */
const drawnAsk = (prompt: string, style: DrawingStyleId) => crypto.createHash('sha256').update(JSON.stringify([prompt.trim(), style])).digest('hex')

/**
 * A drawing this project already has for this note in this style: the newest, a clip that is ready before one that
 * never finished processing (its code is as good). Clips in the trash don't count.
 */
async function earlierDrawing(o: { workspaceId: string; projectId: string; prompt: string; style: DrawingStyleId }): Promise<{ code: string; assetId: string } | undefined> {
  const rows = (
    await ctx()
      .db.select()
      .from(assets)
      .where(and(eq(assets.workspaceId, o.workspaceId), eq(assets.projectId, o.projectId), eq(assets.origin, 'ai'), isNull(assets.trashedAt), sql`${assets.meta}->'generated'->>'ask' = ${drawnAsk(o.prompt, o.style)}`))
      .orderBy(desc(assets.createdAt))
      .limit(10)
  ).filter((r) => r.meta?.generated?.kind === 'drawn' && !!r.meta.generated.code)
  const best = rows.find((r) => r.status === 'ready') ?? rows[0]
  return best ? { code: best.meta!.generated!.code!, assetId: best.id } : undefined
}

/** What a drawn clip was made from: the code, its length and frame (the same → the clip is reused). */
const drawnKey = (code: string, env: Pick<DrawingEnv, 'width' | 'height' | 'fps' | 'duration' | 'palette'>, words: string) =>
  `drawn:${crypto.createHash('sha256').update(JSON.stringify([code, env.width, env.height, env.fps, env.duration, env.palette, words])).digest('hex')}`

/**
 * An AI-drawn scene's clip: the same clip again while its code, length, frame and word timings are unchanged; else the
 * code it has (a re-assembly with a changed narration) or new code from the space's AI, rendered in the sandbox.
 */
async function makeDrawn(
  jc: Pick<JobContext, 'signal' | 'progress' | 'check'>,
  o: {
    workspaceId: string
    userId: string
    projectId: string
    jobId: string
    scene: ScriptScene
    visual: Extract<SceneVisual, { kind: 'drawn' }>
    voices: Map<string, { asset: Asset; duration: number }>
    drawing: NonNullable<Parameters<typeof makeSceneVisuals>[1]['drawing']>
    last: boolean
    work: string
    /** The 'blender' style: where its scripts are tried and rendered. */
    blender?: BlenderRunner
    /** An earlier scene's drawing code of this video (same style): what appears again is drawn the same. */
    reference?: string
    /** Called with the first code that runs, when this scene's code is being written. */
    onWorking?: (code: string) => void
  },
): Promise<{ asset: Asset; code: string }> {
  const voice = o.voices.get(o.scene.id)
  const voiceDur = voice?.duration ?? Math.max(2, o.scene.narration.split(/\s+/).length / 2.6)
  const words = (voice?.asset.transcript?.segments ?? []).flatMap((sg) => sg.words ?? []).map((w) => ({ w: w.w, start: round(LEAD + w.start, 3), ...(w.end !== undefined ? { end: round(LEAD + w.end, 3) } : {}) }))
  const { pal } = o.drawing
  const env: DrawingEnv = {
    width: o.drawing.width,
    height: o.drawing.height,
    fps: o.drawing.fps,
    duration: round(voiceDur + LEAD + (o.last ? CLOSE_TAIL : TAIL) + 0.2, 2),
    words,
    palette: drawingPalette(o.drawing.style, { canvas: pal.canvas, accent: pal.accent, ink: pal.ink }),
    fonts: { headline: pal.headlineFont, body: pal.bodyFont },
  }
  const wordsKey = words.map((w) => `${w.w}@${w.start}`).join(' ')
  if (o.visual.code && o.visual.assetId && drawingStyleOf(o.visual.style) === o.drawing.style) {
    const prev = (await ctx().db.select().from(assets).where(and(eq(assets.id, o.visual.assetId), eq(assets.workspaceId, o.workspaceId))).limit(1))[0]
    if (prev && prev.status === 'ready' && prev.meta?.generated?.kind === 'drawn' && prev.meta.generated.prompt === drawnKey(o.visual.code, env, wordsKey)) return { asset: assetDoc(prev), code: o.visual.code }
  }
  // code written for another drawing style is written again in this one
  let code = drawingStyleOf(o.visual.style) === o.drawing.style ? o.visual.code : undefined
  let provider = 'ai'
  if (!code) {
    const ai = await requireProvider(o.workspaceId, 'animation')
    provider = ai.id
    code = (await writeDrawing(ai, { description: o.visual.prompt, narration: o.scene.narration, headline: o.scene.headline, env, silent: o.drawing.silent, noWords: o.drawing.noWords, style: o.drawing.style, signal: jc.signal, progress: (f, m) => jc.progress(f * 0.6, m), blender: o.blender, reference: o.blender ? undefined : o.reference, onWorking: o.onWorking })).code
  }
  jc.check()
  const rendering = o.blender ? (o.blender.where === 'runpod' ? 'Rendering in Blender on the graphics card' : 'Rendering in Blender') : 'Rendering the animation'
  jc.progress(0.6, rendering)
  const file = path.join(o.work, `drawn-${o.scene.id.replace(/[^\w-]/g, '')}-${crypto.randomBytes(4).toString('hex')}.mp4`)
  if (o.blender) await o.blender.render(code, env, file, { signal: jc.signal, onProgress: (f) => jc.progress(0.6 + f * 0.3, rendering) })
  else await renderDrawing(code, env, file, { signal: jc.signal, onProgress: (f) => jc.progress(0.6 + f * 0.3, rendering) })
  const row = await createAssetFromFile({
    workspaceId: o.workspaceId,
    userId: o.userId,
    projectId: o.projectId,
    filePath: file,
    name: `${o.scene.id} · ${o.scene.headline || o.scene.title} (drawn)`.slice(0, 200),
    mime: 'video/mp4',
    kind: 'video',
    origin: 'ai',
    // the clip keeps the code that draws it: a later assembly of this video finds it here (earlierDrawing), whether or
    // not this run gets as far as saving the script
    meta: { generated: { kind: 'drawn', prompt: drawnKey(code, env, wordsKey), provider, model: o.blender ? 'blender' : 'code', ask: drawnAsk(o.visual.prompt, o.drawing.style), code }, jobId: o.jobId },
  })
  jc.progress(0.92, 'Preparing it for the editor')
  const ready = await processAsset(row.id, jc)
  return { asset: assetDoc(ready), code }
}

/** An illustration this space already has for this icon (any video's): drawn once, reused everywhere. */
async function knownIllustration(workspaceId: string, icon: string): Promise<AssetRow | undefined> {
  const rows = await ctx()
    .db.select()
    .from(assets)
    .where(and(eq(assets.workspaceId, workspaceId), eq(assets.status, 'ready'), sql`${assets.meta}->'generated'->>'kind' = 'illustration'`, sql`${assets.meta}->'generated'->>'prompt' = ${icon}`))
    .limit(1)
  return rows[0]
}

/**
 * The illustration for each object of an animation scene: the one found before (while its name is the same), one this
 * space already drew for the same icon, or a new one found and drawn now. An object with none keeps no asset.
 */
async function findIllustrations(
  jc: JobContext,
  o: { workspaceId: string; userId: string; projectId: string; jobId: string; visual: Extract<SceneVisual, { kind: 'animation' }>; work: string; into: Map<string, Asset> },
): Promise<{ visual: Extract<SceneVisual, { kind: 'animation' }>; missing: string[] }> {
  const missing: string[] = []
  const objects: SceneObject[] = []
  for (const obj of o.visual.objects) {
    jc.check()
    const { assetId: _a, icon: _i, ...base } = obj
    if (obj.assetId) {
      const prev = (await ctx().db.select().from(assets).where(and(eq(assets.id, obj.assetId), eq(assets.workspaceId, o.workspaceId))).limit(1))[0]
      if (prev && prev.status === 'ready' && prev.meta?.generated?.kind === 'illustration' && (!obj.icon || prev.meta.generated.prompt === obj.icon)) {
        o.into.set(prev.id, assetDoc(prev))
        objects.push(obj)
        continue
      }
    }
    try {
      const found = await findIllustration(obj.name, jc.signal)
      if (!found) {
        missing.push(obj.name)
        objects.push(base)
        continue
      }
      let row = await knownIllustration(o.workspaceId, found.icon)
      if (!row) {
        const png = await illustrationPng(found.svg, o.work, jc.signal)
        const made = await createAssetFromFile({
          workspaceId: o.workspaceId,
          userId: o.userId,
          projectId: o.projectId,
          filePath: png.file,
          name: `${obj.name} (illustration)`.slice(0, 200),
          mime: png.mime,
          kind: 'image',
          origin: 'stock',
          meta: { generated: { kind: 'illustration', prompt: found.icon, provider: 'iconify', model: found.icon.split(':')[0] }, jobId: o.jobId },
        })
        row = await processAsset(made.id, jc)
      }
      o.into.set(row.id, assetDoc(row))
      objects.push({ ...base, assetId: row.id, icon: found.icon })
    } catch (err) {
      if (jc.signal.aborted) throw err
      log.warn('illustration failed', { name: obj.name, err })
      missing.push(obj.name)
      objects.push(base)
    }
  }
  return { visual: { ...o.visual, objects }, missing }
}

/**
 * One AI clip. Picture first (fromPicture: Wan on fal and an image key here): the space's image AI paints the shot's
 * opening frame and Wan animates it, which keeps the composition and the look; a picture that can't be made (refused,
 * no credit) leaves the clip to the words alone. Progress runs 0 → 0.82.
 */
export async function makeAiClip(o: {
  workspaceId: string
  prompt: string
  aspect: Brief['aspect']
  seconds: number
  outDir: string
  fromPicture?: boolean
  /** Reference pictures of the clip's characters (files), in the order the prompt numbers them. */
  references?: string[]
  signal: AbortSignal
  progress: (f: number, msg: string) => void
}) {
  let image: string | undefined
  if (o.fromPicture) {
    o.progress(0.03, 'Painting the first frame')
    try {
      image = (await generateImage({ workspaceId: o.workspaceId, prompt: firstFramePrompt(o.prompt), aspect: o.aspect, outDir: o.outDir, signal: o.signal })).file
    } catch (err) {
      if (o.signal.aborted) throw err
      log.warn('first frame failed; the clip is made from the words', { err })
    }
  }
  return generateVideo({ workspaceId: o.workspaceId, prompt: o.prompt, aspect: o.aspect, seconds: o.seconds, outDir: o.outDir, image, ...(o.references?.length ? { references: o.references } : {}), signal: o.signal, onProgress: (f, m) => o.progress(0.12 + f * 0.7, m) })
}

/**
 * The reference picture of one of a film's characters: the one this project already has for the same description and
 * look, else painted now by the space's image AI and kept with the project (a clip in the Library: "Character · …").
 * Returns the picture as a local file.
 */
async function characterPicture(
  jc: Pick<JobContext, 'signal' | 'progress' | 'check'>,
  o: { workspaceId: string; userId: string; projectId: string; jobId: string; character: ScriptCharacter; look?: string; work: string },
): Promise<string> {
  const ask = withAiLook(characterPicturePrompt(o.character), o.look)
  const had = (
    await ctx()
      .db.select()
      .from(assets)
      .where(and(eq(assets.workspaceId, o.workspaceId), eq(assets.projectId, o.projectId), eq(assets.origin, 'ai'), eq(assets.status, 'ready'), isNull(assets.trashedAt), sql`${assets.meta}->'generated'->>'kind' = 'character'`, sql`${assets.meta}->'generated'->>'prompt' = ${ask}`))
      .orderBy(desc(assets.createdAt))
      .limit(1)
  )[0]
  if (had) return localSource(had, o.work)
  const file = await generateImage({ workspaceId: o.workspaceId, prompt: ask, aspect: '1:1', outDir: o.work, signal: jc.signal })
  jc.check()
  const row = await createAssetFromFile({
    workspaceId: o.workspaceId,
    userId: o.userId,
    projectId: o.projectId,
    filePath: file.file,
    name: `Character · ${o.character.name}`.slice(0, 200),
    mime: file.mime,
    kind: 'image',
    origin: 'ai',
    meta: { generated: { kind: 'character', prompt: ask, provider: file.provider, model: file.model }, jobId: o.jobId },
  })
  const ready = await processAsset(row.id, { signal: jc.signal, check: jc.check, progress: () => undefined })
  return localSource(ready, o.work)
}

/** What the image AI is asked for when it paints a clip's opening frame. */
export const firstFramePrompt = (shot: string) =>
  `The opening frame of this shot, as one finished still picture: sharp, well composed, no motion blur, no words, letters or logos.\n\n${shot}`

async function makeOne(
  jc: Pick<JobContext, 'signal' | 'progress' | 'check'>,
  o: { workspaceId: string; userId: string; projectId: string; jobId: string; aspect: Brief['aspect']; scene: ScriptScene; visual: { kind: MadeKind }; ask: string; seconds: number; work: string; fromPicture?: boolean; references?: string[] },
): Promise<{ asset: Asset; credit?: MediaCredit }> {
  const { kind } = o.visual
  let file: { file: string; mime: string; provider: string; model: string }
  let credit: MediaCredit | undefined
  if (kind === 'image') {
    jc.progress(0.05, 'Making an image')
    file = await generateImage({ workspaceId: o.workspaceId, prompt: o.ask, aspect: o.aspect, outDir: o.work, signal: jc.signal })
  } else if (kind === 'stock' || kind === 'photo') {
    const photo = kind === 'photo'
    jc.progress(0.05, photo ? 'Searching stock photos' : 'Searching stock footage')
    // the first that downloads (a library's file can be gone or too big); a library none of whose files download is
    // passed over for the next
    let got: { file: string; mime: string; provider: string; model: string } | undefined
    let lastErr: unknown
    const skip: StockSource[] = []
    for (let round = 0; !got && round < 4; round++) {
      const found = await searchStock({ query: o.ask, aspect: o.aspect, media: photo ? 'photo' : 'video', minSeconds: Math.min(20, o.seconds), signal: jc.signal, skip }).catch((err) => {
        if (jc.signal.aborted || !lastErr) throw err
        return []
      })
      if (!found.length) break
      jc.progress(0.3, photo ? 'Downloading the photo' : 'Downloading footage')
      for (const pick of found.slice(0, 3)) {
        try {
          got = await downloadStock(pick, o.work, jc.signal)
          credit = { author: pick.author, url: pick.pageUrl, source: SOURCE_NAMES[pick.source ?? 'pexels'], ...(pick.licence ? { licence: pick.licence } : {}) }
          break
        } catch (err) {
          if (jc.signal.aborted) throw err
          lastErr = err
        }
      }
      skip.push(found[0].source ?? 'pexels')
    }
    if (!got) throw lastErr ?? new HttpError(404, 'not_found', `no stock ${photo ? 'photo' : 'footage'} matched “${o.ask}”`)
    file = got
  } else {
    file = await makeAiClip({ workspaceId: o.workspaceId, prompt: o.ask, aspect: o.aspect, seconds: o.seconds, outDir: o.work, fromPicture: o.fromPicture, references: o.references, signal: jc.signal, progress: (f, m) => jc.progress(f, m) })
  }
  jc.check()
  const row = await createAssetFromFile({
    workspaceId: o.workspaceId,
    userId: o.userId,
    projectId: o.projectId,
    filePath: file.file,
    name: `${o.scene.id} · ${o.scene.headline || o.scene.title}`.slice(0, 200),
    mime: file.mime,
    kind: kind === 'image' || kind === 'photo' ? 'image' : 'video',
    origin: kind === 'stock' || kind === 'photo' ? 'stock' : 'ai',
    meta: { generated: { kind, prompt: o.ask, provider: file.provider, model: file.model, ...(credit ? { credit } : {}) }, jobId: o.jobId },
  })
  jc.progress(0.85, 'Preparing it for the editor')
  const ready = await processAsset(row.id, jc)
  return { asset: assetDoc(ready), credit }
}

