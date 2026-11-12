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
import { type JobContext, subContext } from '../jobs/worker'
import { ffmpeg } from '../media/proc'
import { type AssetRow, createAssetFromFile, localSource, tmpDir } from '../services/assets'
import { processAsset } from '../media/process'
import { log } from '../log'
import { getLook, headlineStyle, labelStyle, lookPalette, sizeForAspect } from '../services/looks'
import { insertProject, loadProjectRow, saveProjectDoc, withFreshIds, type SaveOptions } from '../services/projects'
import { getBrand } from '../routes/workspaces'
import { requireProvider } from './provider'
import { drawingPalette, writeDrawing } from './drawn'
import { type DrawingEnv, renderDrawing } from '../media/drawing'
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
  const frameSize = sizeForAspect(brief.aspect || getLook(brief.template).aspect)
  const drawing = { ...frameSize, fps: doc.fps || 30, pal: lookPalette(getLook(brief.template), brand), silent: !parts.narration, noWords: !parts.onScreenText, style: drawingStyleOf(brief.drawingStyle) }
  const made = await makeSceneVisuals(jc, { workspaceId: row.workspaceId, userId: jc.job.userId, projectId: row.id, aspect: brief.aspect, scenes: input.scenes, voices, drawing, look: brief.aiLook, fullMotion: brief.motion === 'full' })
  // 3b. music composed on the cuts, and sound effects where things move (both free: made on this server)
  const probe = () => buildProducerTimeline({ project: doc, brief, scenes: made.scenes, footage, voices, generated: made.generated, illustrations: made.illustrations, brand })
  const sounded = await makeSound(subContext(jc, 0.9, 0.92, 'Adding music and sound'), { workspaceId: row.workspaceId, userId: jc.job.userId, projectId: row.id, jobId: jc.job.id, brief, scenes: made.scenes, voices, probe, seed: brand?.name || row.id })
  made.notes.push(...sounded.notes)
  // 4. timeline, built on the project as it is now (a rename or script edit saved meanwhile stays); a timeline
  // edited while this ran is left alone
  jc.progress(0.92, 'Assembling timeline')
  jc.check()
  const scenes = made.scenes.map((s) => ({ ...s, voice: voices.has(s.id) ? { assetId: voices.get(s.id)!.asset.id, duration: voices.get(s.id)!.duration } : undefined }))
  const build = (cur: Project) => {
    const built = buildProducerTimeline({ project: cur, brief, scenes, footage, voices, generated: made.generated, illustrations: made.illustrations, brand, sound: sounded.sound })
    built.ai = { ...(cur.ai ?? {}), brief, script: { ...(cur.ai?.script ?? {}), scenes }, status: 'assembled', assembled: { fingerprint: timelineFingerprint(built), at: Date.now() } }
    return built
  }
  const notes = made.notes.length ? { notes: made.notes } : {}
  const done = made.notes.length ? `Assembled · ${made.notes.length} scene${made.notes.length === 1 ? '' : 's'} used animated text instead` : 'Assembled'
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

type MadeKind = 'image' | 'stock' | 'photo' | 'aiVideo'
const MAKING: Record<MadeKind, string> = { image: 'Making an image', stock: 'Finding footage', photo: 'Finding a photo', aiVideo: 'Making a video clip' }

/**
 * Make (or reuse) each scene's AI still / stock clip or photo / AI clip, and find the illustrations of its animations.
 * Something made earlier for the same prompt is reused (no second bill); a scene whose visual can't be made falls back
 * to animated text, and says why in `notes`.
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
  },
): Promise<{ scenes: ScriptScene[]; generated: Map<string, Asset>; illustrations: Map<string, Asset>; notes: string[] }> {
  const generated = new Map<string, Asset>()
  const illustrations = new Map<string, Asset>()
  const notes: string[] = []
  const scenes = o.scenes.map((s) => ({ ...s }))
  const todo = scenes.filter((s) => s.visual && (s.visual.kind === 'image' || s.visual.kind === 'stock' || s.visual.kind === 'photo' || s.visual.kind === 'aiVideo' || s.visual.kind === 'animation' || s.visual.kind === 'drawn'))
  if (!todo.length) return { scenes, generated, illustrations, notes }
  const work = tmpDir('scene-visuals')
  let clips = 0
  let drawn = 0
  const maxClips = o.fullMotion ? MAX_AI_CLIPS_FULL_MOTION : MAX_AI_CLIPS
  // Wan clips start from a picture painted first, when this space can paint one
  const fromPicture = todo.some((s) => s.visual?.kind === 'aiVideo') && !!(await generationCapabilities(o.workspaceId)).video?.fromPicture
  try {
    for (let i = 0; i < todo.length; i++) {
      const s = todo[i]
      jc.check()
      if (s.visual?.kind === 'animation') {
        jc.progress(0.6 + (i / todo.length) * 0.3, `Drawing the animation for ${s.id}`)
        const { visual, missing } = await findIllustrations(jc, { ...o, jobId: jc.job.id, visual: s.visual, work, into: illustrations })
        s.visual = visual
        if (missing.length) notes.push(`${s.id}: no illustration found for ${missing.map((m) => `“${m}”`).join(', ')}, so a labelled circle stands in`)
        continue
      }
      if (s.visual?.kind === 'drawn') {
        const v = s.visual
        const sub = subContext(jc, 0.6 + (i / todo.length) * 0.3, 0.6 + ((i + 1) / todo.length) * 0.3, `Drawing ${s.id}`)
        if (!o.drawing || drawn >= MAX_DRAWN) {
          if (o.drawing) notes.push(`${s.id}: only ${MAX_DRAWN} scenes are drawn per video`)
          s.visual = { kind: 'motion', points: [] }
          continue
        }
        try {
          const made = await makeDrawn(sub, { ...o, drawing: o.drawing, jobId: jc.job.id, scene: s, visual: v, last: o.scenes.at(-1)?.id === s.id, work })
          drawn++
          generated.set(s.id, made.asset)
          s.visual = { kind: 'drawn', prompt: v.prompt, code: made.code, assetId: made.asset.id, ...(o.drawing.style !== 'clean' ? { style: o.drawing.style } : {}) }
        } catch (err) {
          if (jc.signal.aborted) throw err
          const why = err instanceof HttpError ? err.message : 'it could not be drawn'
          log.warn('drawn scene failed', { scene: s.id, err })
          notes.push(`${s.id}: ${why}`)
          s.visual = { kind: 'motion', points: [] }
        }
        continue
      }
      const v = s.visual as Extract<NonNullable<ScriptScene['visual']>, { kind: MadeKind }>
      // generated pictures and clips in the video's look (the reuse below compares the whole request)
      const ask = v.kind === 'stock' || v.kind === 'photo' ? v.query : withAiLook(v.prompt, o.look)
      const sub = subContext(jc, 0.6 + (i / todo.length) * 0.3, 0.6 + ((i + 1) / todo.length) * 0.3, `${MAKING[v.kind]} for ${s.id}`)
      // reuse what was made for this scene before, while the request is the same
      if (v.assetId) {
        const prev = (await ctx().db.select().from(assets).where(and(eq(assets.id, v.assetId), eq(assets.workspaceId, o.workspaceId))).limit(1))[0]
        if (prev && prev.status === 'ready' && prev.meta?.generated?.kind === v.kind && prev.meta.generated.prompt === ask) {
          generated.set(s.id, assetDoc(prev))
          continue
        }
      }
      if (v.kind === 'aiVideo' && clips >= maxClips) {
        notes.push(`${s.id}: only ${maxClips} AI clips are made per video`)
        s.visual = { kind: 'motion', points: [] }
        continue
      }
      const voiceDur = o.voices.get(s.id)?.duration ?? Math.max(2, s.narration.split(/\s+/).length / 2.6)
      try {
        const made = await makeOne(sub, { ...o, jobId: jc.job.id, scene: s, visual: v, ask, seconds: voiceDur + LEAD + TAIL, work, fromPicture })
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
  return { scenes, generated, illustrations, notes }
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
    code = (await writeDrawing(ai, { description: o.visual.prompt, narration: o.scene.narration, headline: o.scene.headline, env, silent: o.drawing.silent, noWords: o.drawing.noWords, style: o.drawing.style, signal: jc.signal, progress: (f, m) => jc.progress(f * 0.6, m) })).code
  }
  jc.check()
  jc.progress(0.6, 'Rendering the animation')
  const file = path.join(o.work, `drawn-${o.scene.id.replace(/[^\w-]/g, '')}-${crypto.randomBytes(4).toString('hex')}.mp4`)
  await renderDrawing(code, env, file, { signal: jc.signal, onProgress: (f) => jc.progress(0.6 + f * 0.3, 'Rendering the animation') })
  const row = await createAssetFromFile({
    workspaceId: o.workspaceId,
    userId: o.userId,
    projectId: o.projectId,
    filePath: file,
    name: `${o.scene.id} · ${o.scene.headline || o.scene.title} (drawn)`.slice(0, 200),
    mime: 'video/mp4',
    kind: 'video',
    origin: 'ai',
    meta: { generated: { kind: 'drawn', prompt: drawnKey(code, env, wordsKey), provider, model: 'code' }, jobId: o.jobId },
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
export async function makeAiClip(o: { workspaceId: string; prompt: string; aspect: Brief['aspect']; seconds: number; outDir: string; fromPicture?: boolean; signal: AbortSignal; progress: (f: number, msg: string) => void }) {
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
  return generateVideo({ workspaceId: o.workspaceId, prompt: o.prompt, aspect: o.aspect, seconds: o.seconds, outDir: o.outDir, image, signal: o.signal, onProgress: (f, m) => o.progress(0.12 + f * 0.7, m) })
}

/** What the image AI is asked for when it paints a clip's opening frame. */
export const firstFramePrompt = (shot: string) =>
  `The opening frame of this shot, as one finished still picture: sharp, well composed, no motion blur, no words, letters or logos.\n\n${shot}`

async function makeOne(
  jc: Pick<JobContext, 'signal' | 'progress' | 'check'>,
  o: { workspaceId: string; userId: string; projectId: string; jobId: string; aspect: Brief['aspect']; scene: ScriptScene; visual: { kind: MadeKind }; ask: string; seconds: number; work: string; fromPicture?: boolean },
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
    file = await makeAiClip({ workspaceId: o.workspaceId, prompt: o.ask, aspect: o.aspect, seconds: o.seconds, outDir: o.work, fromPicture: o.fromPicture, signal: jc.signal, progress: (f, m) => jc.progress(f, m) })
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

