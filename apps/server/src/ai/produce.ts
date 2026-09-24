// Producer AI pipeline: ai.produce.script (Claude structured output) and ai.produce.assemble (TTS + timeline).
import fs from 'node:fs'
import path from 'node:path'
import { and, eq, inArray } from 'drizzle-orm'
import * as z from 'zod/v4'
import {
  captionStyleFromPreset,
  createAudioItem,
  createProject,
  createShapeItem,
  createTextItem,
  createTrack,
  createVideoItem,
  defaultTextStyle,
  generateCaptions,
  round,
  type Asset,
  type Item,
  type ProducerMeta,
  type Project,
  type ScriptScene,
  type Transcript,
  type VideoItem,
} from '@producer/core'
import { ctx } from '../context'
import { assets } from '../db/schema'
import { assetDoc } from '../dto'
import { HttpError, invalid } from '../http'
import { type JobContext, subContext } from '../jobs/worker'
import { ffmpeg } from '../media/proc'
import { type AssetRow, localSource, tmpDir } from '../services/assets'
import { getLook, headlineStyle, labelStyle, lookPalette, sizeForAspect } from '../services/looks'
import { loadProjectRow, saveProjectDoc } from '../services/projects'
import { getBrand } from '../routes/workspaces'
import { requireProvider } from './provider'
import { houseRules } from './rules'
import { ensureTranscript, synthesizeToAsset, transcribeAsset } from './speech'
import { whisperAvailable } from './whisper'

export type Brief = NonNullable<ProducerMeta['brief']>

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

export async function produceScript(jc: JobContext): Promise<{ script: { scenes: ScriptScene[]; message?: string } }> {
  const input = jc.job.input as { projectId: string; assetIds: string[]; brief: Brief }
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
    const fresh = await loadProjectRow(input.projectId)
    const ai: ProducerMeta = { ...(fresh.doc.ai ?? {}), brief: input.brief, script: { scenes, message: parsed.message }, status: 'scripted' }
    await saveProjectDoc(input.projectId, { ...fresh.doc, ai })
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
    // footage windows cut to fill the scene; slow slightly or hold the last frame when short
    const windows = scene.footage.filter((f) => inp.footage.has(f.assetId) && f.end > f.start)
    const pieces: Item[] = []
    if (windows.length) {
      const total = windows.reduce((n, f) => n + (f.end - f.start), 0)
      const speed = total >= dur ? 1 : total >= dur * 0.6 ? round(Math.max(0.6, total / dur), 3) : 1
      let remaining = dur
      for (const f of windows) {
        if (remaining <= 0.05) break
        const asset = inp.footage.get(f.assetId)!
        const len = Math.min((f.end - f.start) / speed, remaining)
        pieces.push(createVideoItem(asset, 0, { name: `${scene.id} · ${asset.name}`, in: f.start, duration: round(len, 3), speed, muted: true, volume: 0, fit: 'contain' }))
        remaining -= len
      }
      if (remaining > 0.05) {
        const last = pieces[pieces.length - 1] as VideoItem
        const holdAt = round(last.in + last.duration * last.speed - 1 / p.fps, 3)
        pieces.push(createVideoItem(inp.footage.get(last.assetId)!, 0, { name: `${scene.id} · hold`, in: last.in, duration: round(remaining, 3), freezeAt: Math.max(0, holdAt), muted: true, volume: 0, fit: 'contain' }))
      }
      for (const f of windows) addAsset(inp.footage.get(f.assetId)!)
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
    const noFootage = !windows.length
    const headY = noFootage ? -20 * scale : -height * (vertical ? 0.36 : 0.37)
    cards.items.push(
      createTextItem(round(sceneStart + 0.3, 4), 'heading', {
        name: `${scene.id} headline`,
        text: scene.headline || scene.title,
        duration: round(dur - 0.5, 3),
        style: headlineStyle(pal, width, Math.round((noFootage ? (vertical ? 96 : 110) : vertical ? 64 : 72) * scale), noFootage ? {} : { background: { color: pal.canvas, radius: 14, padding: Math.round(18 * scale), opacity: 0.88 }, boxWidth: Math.round(width * 0.86) }),
        transform: { x: 0, y: round(headY, 1), scale: 1, rotation: 0 },
        animations: { in: { preset: 'rise', duration: 0.5 }, out: { preset: 'fade', duration: 0.3 } },
      }),
    )
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
  p.tracks = [voice, main, cards, labels].filter((tr) => tr.main || tr.items.length)
  // captions from the voice transcripts
  const captionStyle = captionStyleFromPreset(inp.brand?.captionPreset ?? 'clean')
  captionStyle.style = { ...captionStyle.style, fontFamily: pal.bodyFont, boxWidth: Math.round(width * 0.8), fontSize: Math.round(captionStyle.style.fontSize * scale) }
  const withCaptions = generateCaptions(p, { itemIds: voice.items.map((i) => i.id), style: captionStyle })
  return { ...withCaptions, updatedAt: Date.now() }
}

export async function produceAssemble(jc: JobContext): Promise<{ version: number }> {
  const input = jc.job.input as { projectId: string; scenes: ScriptScene[] }
  const row = await loadProjectRow(input.projectId)
  const doc = row.doc
  const brief: Brief = doc.ai?.brief ?? { title: doc.name, audience: '', goal: '', tone: 'warm', template: 'studio-dark', voice: 'af_heart', aspect: '16:9' }
  const brand = await getBrand(row.workspaceId)
  if (!input.scenes?.length) throw invalid('No scenes to assemble')
  const footageIds = [...new Set(input.scenes.flatMap((s) => s.footage.map((f) => f.assetId)))]
  const footageRows = await ctx().db.select().from(assets).where(and(eq(assets.workspaceId, row.workspaceId), inArray(assets.id, footageIds.length ? footageIds : ['-'])))
  const footage = new Map(footageRows.map((r) => [r.id, assetDoc(r)]))
  // 1. voice per scene (reuse an existing voice when the narration is unchanged)
  const voices = new Map<string, { asset: Asset; duration: number }>()
  const prior = new Map((doc.ai?.script?.scenes ?? []).map((s) => [s.id, s]))
  for (let i = 0; i < input.scenes.length; i++) {
    const s = input.scenes[i]
    jc.check()
    const sub = subContext(jc, (i / input.scenes.length) * 0.6, ((i + 1) / input.scenes.length) * 0.6, `Voicing ${s.id}`)
    const old = s.voice ?? prior.get(s.id)?.voice
    if (old) {
      const r = (await ctx().db.select().from(assets).where(and(eq(assets.id, old.assetId), eq(assets.workspaceId, row.workspaceId))).limit(1))[0]
      if (r && r.meta?.tts?.text === s.narration && r.meta.tts.voice === brief.voice) {
        voices.set(s.id, { asset: assetDoc(r), duration: r.meta.duration ?? old.duration })
        continue
      }
    }
    const v = await synthesizeToAsset({ workspaceId: row.workspaceId, userId: jc.job.userId, projectId: row.id, text: s.narration, voice: brief.voice, name: `${s.id} · ${s.title}` }, sub)
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
  // 3. timeline
  jc.progress(0.92, 'Assembling timeline')
  const scenes = input.scenes.map((s) => ({ ...s, voice: voices.has(s.id) ? { assetId: voices.get(s.id)!.asset.id, duration: voices.get(s.id)!.duration } : undefined }))
  const built = buildProducerTimeline({ project: doc, brief, scenes, footage, voices, brand })
  built.ai = { ...(doc.ai ?? {}), brief, script: { ...(doc.ai?.script ?? {}), scenes }, status: 'assembled' }
  const saved = await saveProjectDoc(row.id, built)
  jc.progress(1, 'Assembled')
  return { version: saved.version }
}

