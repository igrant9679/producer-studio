// The media library's files (core mediaLibrary.ts, 21 Nov 2026). An operator has them made with a space's keys
// (Operator → Media library): one 'library.make' job per item, one at a time (each job queues the next, so the
// worker's two slots are never both taken from people's own work), music first, then the full-motion clips, then the
// animations. Each made item is kept in storage under library/ with a small JSON beside it saying what it is (its
// file, length, model, when), shared by every space: listed in the editor, heard or watched there, and copied into a
// space as its own clip when someone adds it.
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm'
import {
  CLIP_LIBRARY,
  CLIP_LIBRARY_VERSION,
  CLIP_SOUND_VERSION,
  MUSIC_LIBRARY,
  MUSIC_LIBRARY_VERSION,
  type DrawingStyleId,
  type LibraryClip,
  type LibraryEntry,
  type LibraryItemStatus,
  type LibraryKind,
  type LibraryTrack,
  type LibraryCustomMode as CustomMode,
  libraryItem,
} from '@producer/core'
import { ctx } from '../context'
import { assets, jobs } from '../db/schema'
import { assetRecord } from '../dto'
import { HttpError, notFound } from '../http'
import { newId } from '../ids'
import { enqueue } from '../jobs/queue'
import type { JobContext } from '../jobs/worker'
import { log } from '../log'
import { fitSong } from '../media/fit-song'
import { ffmpeg } from '../media/proc'
import { processAsset } from '../media/process'
import { type AssetRow, createAssetFromFile, tmpDir } from './assets'

export type LibraryItem = NonNullable<ReturnType<typeof libraryItem>>

/** What is kept beside an item's file. */
export interface LibraryInfo {
  /** The storage key of the file. */
  key: string
  mime: string
  seconds: number
  madeAt: number
  provider: string
  model: string
  /** A frame of a clip (JPEG), for the list. */
  poster?: string
  /** An animation's drawing code (a .js beside it) and what it was drawn for: it can be drawn again in other colours. */
  drawing?: { key: string; env: { width: number; height: number; fps: number; duration: number; palette: { canvas: string; accent: string; ink: string }; fonts: { headline: string; body: string } }; style: string }
  /** The space whose keys made it. */
  workspaceId: string
  /** A full-motion clip heard with a library song instead of the sound its video model made (scoreClip): the song,
   * the CLIP_SOUND_VERSION it was put on with, and the file as it was made (kept). */
  sound?: { song: string; rev: number; original: string }
}

const version = (it: LibraryItem) => (it.kind === 'music' ? MUSIC_LIBRARY_VERSION : CLIP_LIBRARY_VERSION)
const stem = (it: LibraryItem) => `library/${it.kind === 'music' ? 'music' : 'clips'}/${it.id}.v${version(it)}`
const infoKey = (it: LibraryItem) => `${stem(it)}.json`
/** What a space's copy of an item is known by, so adding it again finds it (a clip given its song since is another copy). */
export const libraryAssetKey = (it: LibraryItem, info?: Pick<LibraryInfo, 'sound'> | null) => `${it.id} v${version(it)}${info?.sound ? ` s${info.sound.rev}` : ''}`

export function requireItem(id: string, kind?: 'music' | 'clip'): LibraryItem {
  const it = libraryItem(id)
  if (!it || (kind === 'music' && it.kind !== 'music') || (kind === 'clip' && it.kind === 'music')) throw notFound('No such item in the media library')
  return it
}

// ---------------- what is made (read from storage, remembered a while) ----------------

const cache = new Map<string, { info: LibraryInfo | null; until: number }>()
const HIT_MS = 10 * 60_000
const MISS_MS = 60_000

async function readJson(key: string): Promise<unknown> {
  const s = await ctx().storage.getStream(key)
  const chunks: Buffer[] = []
  for await (const ch of s) chunks.push(Buffer.isBuffer(ch) ? ch : Buffer.from(ch))
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

/** The item's kept info, or null while it hasn't been made. */
export async function libraryInfo(it: LibraryItem): Promise<LibraryInfo | null> {
  const hit = cache.get(it.id)
  if (hit && hit.until > Date.now()) return hit.info
  let info: LibraryInfo | null = null
  try {
    if (await ctx().storage.stat(infoKey(it))) info = (await readJson(infoKey(it))) as LibraryInfo
  } catch (err) {
    log.warn('media library: an item’s info could not be read', { item: it.id, err })
  }
  cache.set(it.id, { info, until: Date.now() + (info ? HIT_MS : MISS_MS) })
  return info
}

/** Forget what was read (tests; and after an item is made). */
export function forgetLibraryInfo(id?: string) {
  if (id) cache.delete(id)
  else cache.clear()
}

export async function listMusic(): Promise<Array<LibraryEntry<LibraryTrack>>> {
  return Promise.all(
    MUSIC_LIBRARY.map(async (t) => {
      const info = await libraryInfo({ kind: 'music', ...t })
      return { ...t, ready: !!info, ...(info ? { seconds: info.seconds } : {}) }
    }),
  )
}

export async function listClips(): Promise<Array<LibraryEntry<LibraryClip>>> {
  return Promise.all(
    CLIP_LIBRARY.map(async ({ song: _planned, ...c }) => {
      const info = await libraryInfo(c)
      // the song a clip is heard with once it has been put on (until then, the sound it was made with)
      return { ...c, ready: !!info, ...(info ? { seconds: info.seconds } : {}), ...(info?.sound ? { song: info.sound.song } : {}) }
    }),
  )
}

/** The kept info of an item that has been made; 404 while it hasn't. */
export async function madeItem(it: LibraryItem): Promise<LibraryInfo> {
  const info = await libraryInfo(it)
  if (!info) throw notFound('This item of the library hasn’t been made yet')
  return info
}

// ---------------- the operator's view, and making ----------------

const ORDER: LibraryKind[] = ['music', 'motion', 'animation']
const allItems = (): LibraryItem[] => [...MUSIC_LIBRARY.map((t) => ({ kind: 'music' as const, ...t })), ...CLIP_LIBRARY]

export async function libraryStatus(): Promise<LibraryItemStatus[]> {
  const items = allItems()
  const rows = await ctx()
    .db.select()
    .from(jobs)
    .where(and(eq(jobs.kind, 'library.make'), inArray(sql<string>`${jobs.input}->>'item'`, items.map((i) => i.id))))
    .orderBy(desc(jobs.createdAt))
    .limit(400)
  const newest = new Map<string, (typeof rows)[number]>()
  for (const r of rows) {
    const id = (r.input as { item?: string }).item
    if (id && !newest.has(id)) newest.set(id, r)
  }
  return Promise.all(
    items.map(async (it) => {
      const info = await libraryInfo(it)
      const j = newest.get(it.id)
      return {
        id: it.id,
        kind: it.kind,
        title: it.title,
        ready: !!info,
        ...(info ? { seconds: info.seconds, madeAt: info.madeAt, model: info.model } : {}),
        ...(j ? { job: { id: j.id, status: j.status as NonNullable<LibraryItemStatus['job']>['status'], progress: j.progress, message: j.message, error: j.error } } : {}),
      }
    }),
  )
}

/**
 * Has the items not made yet (of `kinds`, or all) made with `workspaceId`'s keys: queues the first, and each job
 * queues the next when it ends. Nothing is queued while a chain is already going.
 */
export async function makeLibrary(o: { workspaceId: string; userId: string; kinds?: LibraryKind[] }): Promise<{ queued: string[]; going?: boolean }> {
  if (await libraryBusy()) return { queued: [], going: true }
  const kinds = ORDER.filter((k) => !o.kinds?.length || o.kinds.includes(k))
  const status = await libraryStatus()
  const todo = kinds.flatMap((k) => status.filter((s) => s.kind === k && !s.ready).map((s) => s.id))
  if (todo.length) await queueNext({ chain: newId('lib'), kinds, workspaceId: o.workspaceId, userId: o.userId })
  return { queued: todo }
}

/** A library job queued or running (other than `except`): one chain at a time. */
async function libraryBusy(except?: string): Promise<boolean> {
  const rows = await ctx()
    .db.select({ id: jobs.id })
    .from(jobs)
    .where(and(eq(jobs.kind, 'library.make'), inArray(jobs.status, ['queued', 'running'])))
    .limit(3)
  return rows.some((r) => r.id !== except)
}

/**
 * Queues the chain's next item: the first of its kinds, in order, that isn't made and that this chain hasn't tried
 * (so an item that failed is left for the next go). Worked out afresh each time from what is made and what this chain
 * ran, so a job run again by hand (Operator → Jobs → Requeue) can't start a second chain.
 */
async function queueNext(o: { chain: string; kinds: LibraryKind[]; workspaceId: string; userId: string; except?: string }): Promise<string | undefined> {
  if (await libraryBusy(o.except)) return undefined
  const tried = new Set(
    (await ctx().db.select({ input: jobs.input }).from(jobs).where(and(eq(jobs.kind, 'library.make'), sql`${jobs.input}->>'chain' = ${o.chain}`))).map((r) => (r.input as { item?: string }).item),
  )
  for (const k of ORDER.filter((x) => o.kinds.includes(x))) {
    for (const it of allItems().filter((i) => i.kind === k)) {
      if (tried.has(it.id) || (await libraryInfo(it))) continue
      await enqueue('library.make', { item: it.id, chain: o.chain, kinds: o.kinds }, { workspaceId: o.workspaceId, userId: o.userId, message: `Making “${it.title}” for the media library` })
      return it.id
    }
  }
  return undefined
}

/** The library's animations are drawn on a light, neutral palette (each drawing style adjusts it its own way). */
const LIBRARY_PALETTE = { canvas: '#F6F3EE', accent: '#FF6B4A', ink: '#1F2430' }

/** A made item's file, before it is kept. */
export interface MadeItem {
  file: string
  mime: string
  seconds: number
  provider: string
  model: string
  /** An animation's code and the drawing environment it was rendered in. */
  drawing?: { code: string; env: NonNullable<LibraryInfo['drawing']>['env']; style: string }
}

/** Writers for each kind (tests stand in quick ones: the real ones spend the space's AI credit). */
export const LIBRARY_MAKERS = {
  async music(o: { workspaceId: string; prompt: string; outDir: string; signal: AbortSignal }): Promise<MadeItem> {
    const { generateMusic } = await import('../ai/generate/music')
    const s = await generateMusic(o)
    return { file: s.file, mime: s.mime, seconds: s.seconds, provider: 'gemini', model: s.model }
  },
  async motion(o: { workspaceId: string; prompt: string; seconds: number; outDir: string; signal: AbortSignal; progress: (f: number, m: string) => void }): Promise<MadeItem> {
    const { generateVideo } = await import('../ai/generate/video')
    const v = await generateVideo({ workspaceId: o.workspaceId, prompt: o.prompt, aspect: '16:9', seconds: o.seconds, outDir: o.outDir, provider: 'gemini', signal: o.signal, onProgress: o.progress })
    return { file: v.file, mime: v.mime, seconds: v.seconds, provider: v.provider, model: v.model }
  },
  async animation(o: { workspaceId: string; prompt: string; style: DrawingStyleId; seconds: number; outDir: string; signal: AbortSignal; progress: (f: number, m: string) => void }): Promise<MadeItem> {
    const [{ requireProvider }, { drawingPalette, writeDrawing }, { renderDrawing }] = await Promise.all([import('../ai/provider'), import('../ai/drawn'), import('../media/drawing')])
    const ai = await requireProvider(o.workspaceId, 'animation')
    const env = { width: 1920, height: 1080, fps: 30, duration: o.seconds, words: [], palette: drawingPalette(o.style, LIBRARY_PALETTE), fonts: { headline: 'Inter', body: 'Inter' } }
    const { code } = await writeDrawing(ai, { description: o.prompt, narration: '', headline: '', env, silent: true, noWords: true, style: o.style, signal: o.signal, progress: (f, m) => o.progress(f * 0.7, m) })
    const file = path.join(o.outDir, `drawn-${Date.now().toString(36)}.mp4`)
    o.progress(0.7, 'Rendering the animation')
    await renderDrawing(code, env, file, { signal: o.signal, onProgress: (f) => o.progress(0.7 + f * 0.28, 'Rendering the animation') })
    return { file, mime: 'video/mp4', seconds: o.seconds, provider: ai.id, model: 'code', drawing: { code, env: { width: env.width, height: env.height, fps: env.fps, duration: env.duration, palette: env.palette, fonts: env.fonts }, style: o.style } }
  },
}

const EXT: Record<string, string> = { 'audio/mpeg': 'mp3', 'audio/wav': 'wav', 'audio/mp4': 'm4a', 'audio/aac': 'aac', 'audio/ogg': 'ogg', 'video/mp4': 'mp4', 'video/webm': 'webm' }

/** The 'library.make' job: makes its item (unless it was made meanwhile), keeps it, and queues the next. */
export async function makeLibraryJob(jc: JobContext): Promise<unknown> {
  const { item, chain, kinds = ORDER } = jc.job.input as { item: string; chain?: string; kinds?: LibraryKind[] }
  const it = requireItem(item)
  try {
    forgetLibraryInfo(it.id)
    const had = await libraryInfo(it)
    if (had) return { item: it.id, skipped: 'already made', seconds: had.seconds }
    const work = tmpDir('library')
    try {
      const progress = (f: number, m: string) => jc.progress(Math.min(0.95, f), m)
      jc.progress(0.02, it.kind === 'music' ? 'Writing the song' : it.kind === 'motion' ? 'Making the AI clip' : 'Drawing the animation')
      const made =
        it.kind === 'music'
          ? await LIBRARY_MAKERS.music({ workspaceId: jc.job.workspaceId, prompt: it.prompt, outDir: work, signal: jc.signal })
          : it.kind === 'motion'
            ? await LIBRARY_MAKERS.motion({ workspaceId: jc.job.workspaceId, prompt: it.prompt, seconds: it.seconds, outDir: work, signal: jc.signal, progress })
            : await LIBRARY_MAKERS.animation({ workspaceId: jc.job.workspaceId, prompt: it.prompt, style: it.style ?? 'clean', seconds: it.seconds, outDir: work, signal: jc.signal, progress })
      jc.check()
      jc.progress(0.96, 'Keeping it in the library')
      const key = `${stem(it)}.${EXT[made.mime] ?? path.extname(made.file).slice(1) ?? 'bin'}`
      await ctx().storage.putFile(key, made.file, made.mime)
      let poster: string | undefined
      if (it.kind !== 'music') {
        const jpg = path.join(work, 'poster.jpg')
        try {
          await ffmpeg(['-y', '-v', 'error', '-ss', String(Math.min(1, made.seconds / 3)), '-i', made.file, '-frames:v', '1', '-vf', 'scale=640:-2', '-q:v', '4', jpg], { signal: jc.signal })
          poster = `${stem(it)}.jpg`
          await ctx().storage.putFile(poster, jpg, 'image/jpeg')
        } catch (err) {
          if (jc.signal.aborted) throw err
          log.warn('media library: no poster frame', { item: it.id, err })
          poster = undefined
        }
      }
      let drawing: LibraryInfo['drawing']
      if (made.drawing) {
        const codeKey = `${stem(it)}.drawing.js`
        await ctx().storage.put(codeKey, Buffer.from(made.drawing.code, 'utf8'), { contentType: 'text/javascript' })
        drawing = { key: codeKey, env: made.drawing.env, style: made.drawing.style }
      }
      const info: LibraryInfo = { key, mime: made.mime, seconds: Math.round(made.seconds * 100) / 100, madeAt: Date.now(), provider: made.provider, model: made.model, workspaceId: jc.job.workspaceId, ...(poster ? { poster } : {}), ...(drawing ? { drawing } : {}) }
      await ctx().storage.put(infoKey(it), Buffer.from(JSON.stringify(info)), { contentType: 'application/json' })
      forgetLibraryInfo(it.id)
      log.info('media library: made an item', { item: it.id, kind: it.kind, seconds: info.seconds, model: info.model })
      return { item: it.id, kind: it.kind, seconds: info.seconds, model: info.model }
    } finally {
      fs.rm(work, { recursive: true, force: true }, () => undefined)
    }
  } finally {
    // the next item, whether this one was made or failed; not after a stop (a cancel ends the chain, and a restart
    // queues this same job again, which queues the next itself)
    if (chain && !jc.signal.aborted) await queueNext({ chain, kinds, workspaceId: jc.job.workspaceId, userId: jc.job.userId, except: jc.job.id }).catch((err) => log.warn('media library: the next item could not be queued', { err }))
  }
}

/** A space's own copy of an item (made before in this space, or copied in now and prepared for the editor). */
export async function addLibraryItem(o: { it: LibraryItem; workspaceId: string; userId: string; projectId?: string | null; signal: AbortSignal }): Promise<AssetRow> {
  const info = await madeItem(o.it)
  const key = libraryAssetKey(o.it, info)
  const had = (
    await ctx()
      .db.select()
      .from(assets)
      .where(and(eq(assets.workspaceId, o.workspaceId), eq(assets.status, 'ready'), isNull(assets.trashedAt), sql`${assets.meta}->'generated'->>'kind' = 'library'`, sql`${assets.meta}->'generated'->>'prompt' = ${key}`))
      .limit(1)
  )[0]
  if (had) return had
  const work = tmpDir('library-add')
  try {
    const file = path.join(work, `item${path.extname(info.key)}`)
    await ctx().storage.download(info.key, file)
    const row = await createAssetFromFile({
      workspaceId: o.workspaceId,
      userId: o.userId,
      projectId: o.projectId ?? null,
      filePath: file,
      name: `${o.it.kind === 'music' ? 'Music' : o.it.kind === 'motion' ? 'Clip' : 'Animation'} · ${o.it.title}`,
      mime: info.mime,
      kind: o.it.kind === 'music' ? 'audio' : 'video',
      origin: 'ai',
      meta: { generated: { kind: 'library', prompt: key, provider: info.provider, model: info.model } },
    })
    return await processAsset(row.id, { signal: o.signal, check: () => undefined, progress: () => undefined })
  } catch (err) {
    if (err instanceof HttpError) throw err
    log.warn('media library: an item could not be added', { item: o.it.id, err })
    throw new HttpError(503, 'server', 'This item couldn’t be added just now. Try again in a minute.')
  } finally {
    fs.rm(work, { recursive: true, force: true }, () => undefined)
  }
}

// ---------------- customizing an item for a space (21 Nov 2026) ----------------
// The owner: "The clips and samples should be available for users to insert into their videos and customize based on
// their needs/brand/topic". Any item can be remade for the space's topic on the space's own AI keys (an animation
// redrawn from the library's code for the topic, a clip filmed again, a song written again in the same genre). The
// brand goes on in the editor instead, as titles, text and a logo stamp over the clip (web editor/libraryBrand.ts): the
// owner, the same day, "the branding doesn't need to affect the animations so much as the Narrative Text, Titles,
// Thumbnail, company stamp/logo". (A recolouring of the animations from their kept code was tried on production first:
// the AI writes most colours into a drawing as fixed values, so a new palette barely changed them.)

/** Checks a customization can be asked for, and queues it as the space's job. */
export async function queueCustom(o: { it: LibraryItem; mode: CustomMode; topic?: string; aspect?: string; workspaceId: string; userId: string; projectId?: string | null }) {
  await madeItem(o.it)
  if (o.mode !== 'topic') throw new HttpError(400, 'invalid', 'Your brand goes on in the editor, as titles, text and your logo over the clip.')
  const topic = (o.topic ?? '').trim()
  if (topic.length < 3) throw new HttpError(400, 'invalid', 'Say what your video is about, in a few words.')
  return enqueue('library.custom', { item: o.it.id, mode: 'topic', topic: topic.slice(0, 300), ...(o.aspect ? { aspect: o.aspect } : {}) }, { workspaceId: o.workspaceId, userId: o.userId, projectId: o.projectId ?? null, message: `Making “${o.it.title}” for your topic` })
}

async function readText(key: string): Promise<string> {
  const s = await ctx().storage.getStream(key)
  const chunks: Buffer[] = []
  for await (const ch of s) chunks.push(Buffer.isBuffer(ch) ? ch : Buffer.from(ch))
  return Buffer.concat(chunks).toString('utf8')
}

/** Remakes for a topic go through these (tests stand in quick ones: the real ones spend the space's AI credit). */
export const LIBRARY_REMAKERS = {
  async music(o: { workspaceId: string; prompt: string; outDir: string; signal: AbortSignal }): Promise<MadeItem> {
    return LIBRARY_MAKERS.music(o)
  },
  async motion(o: { workspaceId: string; prompt: string; seconds: number; aspect: string; outDir: string; signal: AbortSignal; progress: (f: number, m: string) => void }): Promise<MadeItem> {
    const { generateVideo } = await import('../ai/generate/video')
    const aspect = (['16:9', '9:16', '1:1'].includes(o.aspect) ? o.aspect : '16:9') as '16:9' | '9:16' | '1:1'
    const v = await generateVideo({ workspaceId: o.workspaceId, prompt: o.prompt, aspect, seconds: o.seconds, outDir: o.outDir, signal: o.signal, onProgress: o.progress })
    return { file: v.file, mime: v.mime, seconds: v.seconds, provider: v.provider, model: v.model }
  },
  async drawing(o: { workspaceId: string; description: string; reference: string; env: NonNullable<LibraryInfo['drawing']>['env']; style: DrawingStyleId; signal: AbortSignal; progress: (f: number, m: string) => void }): Promise<string> {
    const [{ requireProvider }, { writeDrawing }] = await Promise.all([import('../ai/provider'), import('../ai/drawn')])
    const ai = await requireProvider(o.workspaceId, 'animation')
    const { code } = await writeDrawing(ai, { description: o.description, narration: '', headline: '', env: { ...o.env, words: [] }, silent: true, noWords: true, style: o.style, reference: o.reference, signal: o.signal, progress: o.progress })
    return code
  },
  async render(code: string, env: NonNullable<LibraryInfo['drawing']>['env'], file: string, o: { signal: AbortSignal; onProgress: (f: number) => void }) {
    const { renderDrawing } = await import('../media/drawing')
    await renderDrawing(code, { ...env, words: [] }, file, o)
  },
}

/** The 'library.custom' job: the item remade for the space's topic, added to its media. */
export async function customizeLibraryJob(jc: JobContext): Promise<unknown> {
  const { item, topic = '', aspect = '16:9' } = jc.job.input as { item: string; topic?: string; aspect?: string }
  const it = requireItem(item)
  const info = await madeItem(it)
  const ws = jc.job.workspaceId
  const progress = (f: number, m: string) => jc.progress(Math.min(0.9, f), m)
  const work = tmpDir('library-custom')
  try {
    let made: MadeItem
    if (it.kind === 'animation') {
      if (!info.drawing) throw new HttpError(400, 'invalid', 'This animation can’t be drawn again: its drawing wasn’t kept.')
      const style = (info.drawing.style as DrawingStyleId) ?? it.style ?? 'clean'
      const env = info.drawing.env
      const library = await readText(info.drawing.key)
      jc.progress(0.03, 'Drawing it for your topic')
      const code = await LIBRARY_REMAKERS.drawing({ workspaceId: ws, description: `${it.prompt}\nMake it about this instead, keeping the style and the kind of motion: ${topic}`, reference: library, env, style, signal: jc.signal, progress: (f, m) => progress(f * 0.6, m) })
      jc.check()
      const file = path.join(work, 'custom.mp4')
      jc.progress(0.6, 'Rendering the animation')
      await LIBRARY_REMAKERS.render(code, env, file, { signal: jc.signal, onProgress: (f) => progress(0.6 + f * 0.3, 'Rendering the animation') })
      made = { file, mime: 'video/mp4', seconds: env.duration, provider: 'ai', model: 'code' }
    } else {
      jc.progress(0.03, it.kind === 'music' ? 'Writing the song for your topic' : 'Making the clip for your topic')
      made =
        it.kind === 'music'
          ? await LIBRARY_REMAKERS.music({ workspaceId: ws, prompt: `${it.prompt} Make it suit this: ${topic}.`, outDir: work, signal: jc.signal })
          : await LIBRARY_REMAKERS.motion({ workspaceId: ws, prompt: `${it.prompt} Make it about this instead, keeping the kind of shot, the camera movement and the mood: ${topic}.`, seconds: it.seconds, aspect, outDir: work, signal: jc.signal, progress })
    }
    jc.check()
    jc.progress(0.92, 'Adding it to your media')
    const row = await createAssetFromFile({
      workspaceId: ws,
      userId: jc.job.userId,
      projectId: jc.job.projectId ?? null,
      filePath: made.file,
      name: `${it.kind === 'music' ? 'Music' : it.kind === 'motion' ? 'Clip' : 'Animation'} · ${it.title} (“${topic.length > 40 ? `${topic.slice(0, 38)}…` : topic}”)`.slice(0, 200),
      mime: made.mime,
      kind: it.kind === 'music' ? 'audio' : 'video',
      origin: 'ai',
      meta: { generated: { kind: 'library', prompt: `${libraryAssetKey(it)} topic ${crypto.randomBytes(6).toString('hex')}`, provider: made.provider, model: made.model }, jobId: jc.job.id },
    })
    const ready = await processAsset(row.id, jc)
    return { asset: assetRecord(ready) }
  } finally {
    fs.rm(work, { recursive: true, force: true }, () => undefined)
  }
}

// ---------------- the full-motion clips' music (23 Nov 2026) ----------------
// The owner: the music in the library's videos "seems to be out of tune". The full-motion clips came with the sound
// their video model made (the animations have none); each is now heard with a stretch of a library song that suits it
// (LibraryClip.song): the picture is copied untouched, the song cut to the clip with short fades, at the loudness of a
// clip played on its own. Done once by the server after it starts (the clips already done are left alone); the file
// as it was made is kept, and a space's copies added before stay as they were.

/** How loud a clip's song is: a clip played on its own, like a song in the music library. */
export const CLIP_LUFS = -16

/** One full-motion clip heard with its library song: 'scored', or why not. */
export async function scoreClip(it: LibraryClip, signal?: AbortSignal): Promise<'scored' | 'already' | 'not made' | 'no song'> {
  if (it.kind !== 'motion' || !it.song) return 'no song'
  forgetLibraryInfo(it.id)
  const info = await libraryInfo(it)
  if (!info) return 'not made'
  if (info.sound?.song === it.song && info.sound.rev === CLIP_SOUND_VERSION) return 'already'
  const song = requireItem(it.song, 'music')
  const songInfo = await libraryInfo(song)
  if (!songInfo) return 'no song'
  const work = tmpDir('library-score')
  try {
    const original = info.sound?.original ?? info.key
    const clip = path.join(work, 'clip.mp4')
    await ctx().storage.download(original, clip)
    const src = path.join(work, `song${path.extname(songInfo.key) || '.m4a'}`)
    await ctx().storage.download(songInfo.key, src)
    // a stretch from a quarter of the way in (past the song's intro), faded in and out
    const music = path.join(work, 'music.m4a')
    await fitSong({ src, seconds: songInfo.seconds, duration: info.seconds, lufs: CLIP_LUFS, out: music, from: Math.min(30, songInfo.seconds * 0.25), fadeIn: 0.6, fadeOut: 1.2, signal })
    const out = path.join(work, 'scored.mp4')
    await ffmpeg(['-y', '-v', 'error', '-i', clip, '-i', music, '-map', '0:v:0', '-map', '1:a:0', '-c', 'copy', '-shortest', '-movflags', '+faststart', out], { signal })
    const key = `${stem(it)}.s${CLIP_SOUND_VERSION}.mp4`
    await ctx().storage.putFile(key, out, 'video/mp4')
    const next: LibraryInfo = { ...info, key, mime: 'video/mp4', sound: { song: it.song, rev: CLIP_SOUND_VERSION, original } }
    await ctx().storage.put(infoKey(it), Buffer.from(JSON.stringify(next)), { contentType: 'application/json' })
    forgetLibraryInfo(it.id)
    return 'scored'
  } finally {
    fs.rm(work, { recursive: true, force: true }, () => undefined)
  }
}

let scoring: Promise<void> | undefined

/** Every full-motion clip that has been made heard with its library song (one at a time; the done ones are left alone). */
export function scoreLibraryClips(): Promise<void> {
  scoring ??= (async () => {
    for (const c of CLIP_LIBRARY) {
      if (c.kind !== 'motion' || !c.song) continue
      try {
        const r = await scoreClip(c)
        if (r === 'scored') log.info('media library: a full-motion clip now plays its library song', { clip: c.id, song: c.song })
      } catch (err) {
        log.warn('media library: a clip could not be given its song', { clip: c.id, err })
      }
    }
  })().finally(() => {
    scoring = undefined
  })
  return scoring
}

/** The library before 21 Nov 2026 was composed onto the server's disk: those files are no longer listed. */
export function removeOldMusicLibrary() {
  try {
    fs.rmSync(path.join(ctx().config.dataDir, 'music-library'), { recursive: true, force: true })
  } catch (err) {
    log.warn('media library: the old music folder could not be removed', { err })
  }
}
