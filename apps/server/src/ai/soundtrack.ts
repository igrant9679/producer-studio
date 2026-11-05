// Sound for videos made by Producer: background music composed on the video's scene cuts (scripts/music, from
// huashu-motion), and sound effects from earshot's bank (sfx/, its kits' takes rendered once and shipped as files) on
// the cuts, on graphics as they appear and on the title and close cards. Both are free: no key, no network.
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { and, eq, sql } from 'drizzle-orm'
import { type Asset, type Item, type MusicStyle, type Project, createAudioItem, createTrack } from '@producer/core'
import { SERVER_ROOT } from '../config'
import { ctx } from '../context'
import { assets } from '../db/schema'
import { assetDoc } from '../dto'
import { HttpError } from '../http'
import type { JobContext } from '../jobs/worker'
import { ffmpeg, run } from '../media/proc'
import { processAsset } from '../media/process'
import { type AssetRow, createAssetFromFile } from '../services/assets'

/** Bumped when the composer changes what it writes: music made before is composed again. */
export const MUSIC_VERSION = 1
/** The music's loudness: Kokoro narrates near -22.5 LUFS, so the bed sits ~7 LU under it between lines and, ducked,
 * ~17 LU under it while the narrator speaks (huashu-motion's rule of thumb is 12 under plus a 10 dB duck). */
export const MUSIC_LUFS = -30
/** With no narration the music is the only thing to hear, at huashu-motion's level for music alone. */
export const MUSIC_ALONE_LUFS = -18
/** dB the music track drops while the voiceover speaks (the editor's duck, so a moved or re-recorded voice stays ducked). */
export const MUSIC_DUCK_DB = 10
/** A minute of video takes the composer about a minute on one core; past this it is stopped. */
const COMPOSE_TIMEOUT_MS = 15 * 60_000

export interface SceneSpan {
  id: string
  start: number
  end: number
}

/** The music for a video: a WAV composed on its cuts, encoded to AAC. */
export async function composeMusicFile(o: { style: MusicStyle; cuts: Array<{ id: string; t: number }>; duration: number; seed: string; out: string; voiced?: boolean; signal?: AbortSignal }): Promise<{ about: string; lufs: number }> {
  const voiced = o.voiced !== false
  const lufs = voiced ? MUSIC_LUFS : MUSIC_ALONE_LUFS
  const wav = o.out.replace(/\.[^.]+$/, '') + '.wav'
  const script = path.join(SERVER_ROOT, 'scripts', 'music', 'compose.mjs')
  const req = { id: o.seed, brand: o.seed, duration: o.duration, cuts: o.cuts, style: o.style, voiced, lufs, out: wav }
  const r = await run(process.execPath, [script], { input: JSON.stringify(req), signal: o.signal, timeoutMs: COMPOSE_TIMEOUT_MS, cwd: SERVER_ROOT })
  const reply = (() => {
    try {
      return JSON.parse(r.stdout.trim().split('\n').pop() || '{}') as { ok?: boolean; error?: string; about?: string; lufs?: number }
    } catch {
      return {}
    }
  })()
  if (!reply.ok) throw new HttpError(500, 'server', `The music could not be composed: ${reply.error || r.stderr.trim().split('\n').pop() || `the composer stopped (${r.code})`}`)
  try {
    await ffmpeg(['-y', '-v', 'error', '-i', wav, '-c:a', 'aac', '-b:a', '192k', o.out], { signal: o.signal })
  } finally {
    fs.rm(wav, { force: true }, () => undefined)
  }
  return { about: reply.about ?? o.style, lufs: reply.lufs ?? lufs }
}

/** What the music for these cuts is keyed on: the same style, cuts and length reuse the track made before. */
export function musicKey(style: string, cuts: Array<{ id: string; t: number }>, duration: number, seed: string, voiced = true): string {
  const c = cuts.map((x) => `${x.id}@${x.t.toFixed(2)}`).join(' ')
  return `${style} v${MUSIC_VERSION}${voiced ? '' : ' alone'} ${duration.toFixed(2)}s ${crypto.createHash('sha256').update(`${seed}|${c}`).digest('hex').slice(0, 16)}`
}

/** The music track for a video: made before for the same style, cuts and length (this project's), or composed now. */
export async function makeMusic(
  jc: Pick<JobContext, 'signal' | 'progress' | 'check'>,
  o: { workspaceId: string; userId: string; projectId: string; jobId: string; style: MusicStyle; spans: SceneSpan[]; duration: number; seed: string; work: string; voiced?: boolean; cards?: boolean },
): Promise<Asset> {
  const cards = o.cards !== false
  const cuts = [...(cards ? [{ id: 'title', t: 0 }] : []), ...o.spans.map((s) => ({ id: s.id, t: s.start })), ...(cards ? [{ id: 'close', t: o.spans.at(-1)?.end ?? o.duration }] : [])]
  const key = musicKey(o.style, cuts, o.duration, o.seed, o.voiced !== false)
  const prev = (
    await ctx()
      .db.select()
      .from(assets)
      .where(and(eq(assets.workspaceId, o.workspaceId), eq(assets.projectId, o.projectId), eq(assets.status, 'ready'), sql`${assets.meta}->'generated'->>'kind' = 'music'`, sql`${assets.meta}->'generated'->>'prompt' = ${key}`))
      .limit(1)
  )[0]
  if (prev) return assetDoc(prev)
  jc.progress(0.1, 'Composing the music')
  const file = path.join(o.work, `music-${crypto.randomBytes(4).toString('hex')}.m4a`)
  const made = await composeMusicFile({ style: o.style, cuts, duration: o.duration, seed: o.seed, out: file, voiced: o.voiced, signal: jc.signal })
  jc.check()
  const row = await createAssetFromFile({
    workspaceId: o.workspaceId,
    userId: o.userId,
    projectId: o.projectId,
    filePath: file,
    name: `Music · ${made.about}`.slice(0, 200),
    mime: 'audio/mp4',
    kind: 'audio',
    origin: 'ai',
    meta: { generated: { kind: 'music', prompt: key, provider: 'huashu-motion', model: o.style }, jobId: o.jobId },
  })
  jc.progress(0.9, 'Preparing the music for the editor')
  return assetDoc(await processAsset(row.id, { ...jc, progress: (f, m) => jc.progress(0.9 + 0.1 * Math.max(0, f), m) }))
}

// ---------------- sound effects ----------------

/** The moments a video gets a sound on. */
export type SfxMoment = 'title' | 'cut' | 'appear' | 'close'
/** The kit role each moment plays (earshot's role names). */
const ROLE: Record<SfxMoment, string> = { title: 'land', cut: 'whoosh.short', appear: 'pop', close: 'click.confirm' }

export interface SfxTake {
  file: string
  /** Seconds into the file of the moment that lands on the cue (its onset, or its peak for a whoosh). */
  sync: number
  duration: number
}
export interface SfxRole {
  sound: string
  level_db: number
  offset_ms?: number
  min_gap_ms?: number
  takes: SfxTake[]
}
export interface SfxManifest {
  version: number
  kits: Record<string, { roles: Record<string, SfxRole> }>
}

let manifest: SfxManifest | null | undefined
export const SFX_DIR = () => path.join(SERVER_ROOT, 'sfx')
export function sfxManifest(): SfxManifest | null {
  if (manifest === undefined) {
    try {
      manifest = JSON.parse(fs.readFileSync(path.join(SFX_DIR(), 'manifest.json'), 'utf8')) as SfxManifest
    } catch {
      manifest = null
    }
  }
  return manifest
}

/** The kit whose sounds suit the music: soft and organic under quiet styles, crisp under bright ones, punchy under beats. */
export function kitFor(style: MusicStyle | undefined): string {
  if (!style) return 'crisp'
  if (['ambient', 'piano', 'acoustic', 'lofi', 'guofeng'].includes(style)) return 'calm'
  if (['mallet', 'pizzicato'].includes(style)) return 'crisp'
  return 'launch'
}

export interface SfxCue {
  moment: SfxMoment
  at: number
}

const APPEAR_PER_SCENE = 3
/** An appearance this close to a cut is heard as part of the cut's whoosh. */
const NEAR_CUT = 0.35

/**
 * Where a built video gets its sounds: a soft landing as the title arrives, a whoosh on every cut (scene changes and
 * the close card), a pop as graphics appear (a few per scene, spaced, not on a cut) and a ding on the close card.
 */
export function sfxCues(p: Project, spans: SceneSpan[], closeStart?: number): SfxCue[] {
  const cues: SfxCue[] = []
  const all = p.tracks.flatMap((t) => t.items.map((it) => ({ it, track: t })))
  const title = all.find(({ it }) => it.name === 'Title')?.it
  if (title) cues.push({ moment: 'title', at: title.start })
  const cuts = [...spans.map((s) => s.start), ...(closeStart !== undefined ? [closeStart] : [])]
  for (const t of cuts) cues.push({ moment: 'cut', at: t })
  const graphics = all
    .filter(({ track, it }) => /^Graphic/.test(track.name) && it.type !== 'audio' && (it as { animations?: { in?: unknown } }).animations?.in)
    .map(({ it }) => it.start)
    .sort((a, b) => a - b)
  for (const s of spans) {
    let n = 0
    let last = -Infinity
    for (const t of graphics) {
      if (t < s.start || t >= s.end || n >= APPEAR_PER_SCENE) continue
      if (cuts.some((c) => Math.abs(c - t) < NEAR_CUT) || t - last < 0.45) continue
      cues.push({ moment: 'appear', at: t })
      last = t
      n++
    }
  }
  const close = all.find(({ it }) => it.name === 'Close')?.it
  if (close) cues.push({ moment: 'close', at: Math.round((close.start + 0.4) * 1000) / 1000 })
  return cues.sort((a, b) => a.at - b.at)
}

/** The take each cue plays (the role's takes in turn) and where its item starts so its sync point lands on the cue. */
export function planSfx(cues: SfxCue[], kit: string, m: SfxManifest): Array<{ cue: SfxCue; role: string; take: SfxTake; start: number; volume: number }> {
  const roles = m.kits[kit]?.roles ?? {}
  const turn = new Map<string, number>()
  const out: Array<{ cue: SfxCue; role: string; take: SfxTake; start: number; volume: number }> = []
  for (const cue of cues) {
    const name = ROLE[cue.moment]
    const role = roles[name]
    if (!role?.takes.length) continue
    const k = turn.get(name) ?? 0
    turn.set(name, k + 1)
    const take = role.takes[k % role.takes.length]
    const start = Math.round((cue.at + (role.offset_ms ?? 0) / 1000 - take.sync) * 1000) / 1000
    if (start < 0) continue
    out.push({ cue, role: name, take, start, volume: Math.round(Math.min(1, Math.max(0.05, 10 ** (role.level_db / 20))) * 1000) / 1000 })
  }
  return out
}

/** This space's copy of a shipped effect (one per take, shared by every video). */
export async function sfxAsset(o: { workspaceId: string; userId: string; projectId: string; jobId: string; take: SfxTake; role: string; work: string }, jc: Pick<JobContext, 'signal' | 'progress' | 'check'>): Promise<Asset> {
  const m = sfxManifest()
  const key = `${o.take.file} v${m?.version ?? 0}`
  const prev = (
    await ctx()
      .db.select()
      .from(assets)
      .where(and(eq(assets.workspaceId, o.workspaceId), eq(assets.status, 'ready'), sql`${assets.meta}->'generated'->>'kind' = 'sfx'`, sql`${assets.meta}->'generated'->>'prompt' = ${key}`))
      .limit(1)
  )[0] as AssetRow | undefined
  if (prev) return assetDoc(prev)
  const src = path.join(SFX_DIR(), o.take.file)
  if (!src.startsWith(SFX_DIR() + path.sep) || !fs.existsSync(src)) throw new HttpError(500, 'server', `A sound effect is missing from this install (${o.take.file})`)
  // a copy: storage may move the file it is given, and the shipped one stays for the next space
  const copy = path.join(o.work, `sfx-${crypto.randomBytes(4).toString('hex')}${path.extname(src)}`)
  await fs.promises.copyFile(src, copy)
  const row = await createAssetFromFile({
    workspaceId: o.workspaceId,
    userId: o.userId,
    projectId: o.projectId,
    filePath: copy,
    name: `Sound · ${o.role} (${path.basename(o.take.file, path.extname(o.take.file))})`.slice(0, 200),
    mime: 'audio/ogg',
    kind: 'audio',
    origin: 'ai',
    meta: { generated: { kind: 'sfx', prompt: key, provider: 'earshot', model: o.role }, jobId: o.jobId },
  })
  return assetDoc(await processAsset(row.id, jc))
}

export interface VideoSound {
  music?: Asset
  effects?: Array<{ asset: Asset; start: number; volume: number; name: string }>
}

/** The music (its own track, ducked under the voice) and the effects (their own track) added to a built video, with their assets. */
export function addSound(p: Project, sound: VideoSound, duration: number): Project {
  const tracks = [...p.tracks]
  const at = Math.max(0, tracks.findIndex((t) => t.name === 'Voiceover') + 1)
  const add: typeof tracks = []
  if (sound.music) {
    const music = createTrack('audio', { name: 'Music' })
    // nothing to step aside for in a video with no narration
    if (tracks.some((t) => t.name === 'Voiceover')) music.duck = MUSIC_DUCK_DB
    music.items.push(createAudioItem(sound.music, 0, { name: 'Music', duration: Math.min(duration, sound.music.duration ?? duration), fadeIn: 0.3, fadeOut: 1.2 }))
    add.push(music)
  }
  if (sound.effects?.length) {
    const fx = createTrack('audio', { name: 'Sound effects' })
    fx.items = sound.effects.map((e): Item => createAudioItem(e.asset, e.start, { name: e.name, duration: e.asset.duration ?? 0.5, volume: e.volume }))
    add.push(fx)
  }
  tracks.splice(at, 0, ...add)
  const used = [sound.music, ...(sound.effects ?? []).map((e) => e.asset)].filter((a): a is Asset => !!a)
  return { ...p, tracks, assets: { ...p.assets, ...Object.fromEntries(used.map((a) => [a.id, a])) } }
}
