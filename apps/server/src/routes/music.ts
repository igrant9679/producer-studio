// Music for people to hear and use (21 Nov 2026). The music library is MUSIC_LIBRARY's AI songs (Google's Lyria),
// made once by an operator with a space's keys and kept in storage (services/media-library.ts); before 21 Nov it was
// tracks composed on the server, which the owner had replaced. The brief's preview of a music style is still composed
// by the server, with the same composer as a video's own music, so it sounds like what the video will get.
//   GET  /api/music                       -> the library's tracks, each with `ready` (made) and `seconds`
//   GET  /api/music/:id/preview           -> a made track (from storage; Range supported)
//   POST /api/music/:id/add               -> { workspaceId, projectId? } -> AssetRecord: the space's clip of the track
//   POST /api/music/:id/customize         -> { workspaceId, projectId?, mode: topic, topic } -> Job: the song remade for the
//                                            space's topic on its own Gemini key (library.custom)
//   GET  /api/music/style/:style/preview  -> a sample of a music style (composed once and kept; audio/mp4)
//   GET  /api/music/sfx/:kit/:role        -> one take of a sound effect, for the brief's preview
import fs from 'node:fs'
import path from 'node:path'
import { Hono } from 'hono'
import * as z from 'zod/v4'
import { MUSIC_STYLES, STYLE_SAMPLE_SECONDS, type MusicStyle, styleSampleCuts } from '@producer/core'
import { type AppEnv, requireUser } from '../auth'
import { ctx } from '../context'
import { assetRecord, jobDto } from '../dto'
import { HttpError, body, notFound, requireRole } from '../http'
import { log } from '../log'
import { MUSIC_VERSION, SFX_DIR, composeMusicFile, sfxManifest } from '../ai/soundtrack'
import { serveObject } from '../media/serve'
import { addLibraryItem, listMusic, madeItem, queueCustom, requireItem } from '../services/media-library'
import { queueProjectMusic } from '../services/project-music'
import { assertProjectInWorkspace, loadProjectRow } from '../services/projects'

/** What composes a style sample (tests stand in a quick one: the real composer takes tens of seconds). */
export const SAMPLES = { compose: composeMusicFile }

const sampleDir = () => path.join(ctx().config.dataDir, 'style-samples')
/** The kept sample of a style: a new composer version is another file. */
export const styleSampleFile = (style: MusicStyle) => path.join(sampleDir(), `${style}-m${MUSIC_VERSION}.m4a`)

const making = new Map<string, Promise<string>>()

/** A style's kept sample: composed now (once, however many ask at the same time) when it isn't kept yet. */
export function styleSample(style: MusicStyle): Promise<string> {
  const file = styleSampleFile(style)
  if (fs.existsSync(file)) return Promise.resolve(file)
  let p = making.get(style)
  if (!p) {
    fs.mkdirSync(sampleDir(), { recursive: true })
    const tmp = `${file}.${process.pid}.part.m4a`
    p = SAMPLES.compose({ style, cuts: styleSampleCuts(STYLE_SAMPLE_SECONDS), duration: STYLE_SAMPLE_SECONDS, seed: `sample ${style}`, out: tmp, voiced: false })
      .then(() => {
        fs.renameSync(tmp, file)
        return file
      })
      .catch((err) => {
        fs.rmSync(tmp, { force: true })
        throw err
      })
      .finally(() => making.delete(style))
    making.set(style, p)
  }
  return p
}

/** A file from this server's disk, with Range (the audio element asks for parts to seek). */
function fileResponse(file: string, contentType: string, range: string | undefined): Response {
  const size = fs.statSync(file).size
  const m = range && /^bytes=(\d*)-(\d*)$/.exec(range.trim())
  if (m && (m[1] || m[2])) {
    let start = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2]))
    let end = m[1] && m[2] ? Math.min(Number(m[2]), size - 1) : size - 1
    if (start >= size || start > end) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } })
    start = Math.max(0, start)
    end = Math.max(start, end)
    const buf = Buffer.alloc(end - start + 1)
    const fd = fs.openSync(file, 'r')
    try {
      fs.readSync(fd, buf, 0, buf.length, start)
    } finally {
      fs.closeSync(fd)
    }
    return new Response(buf, { status: 206, headers: { 'Content-Type': contentType, 'Content-Length': String(buf.length), 'Content-Range': `bytes ${start}-${end}/${size}`, 'Accept-Ranges': 'bytes', 'Cache-Control': 'private, max-age=86400' } })
  }
  return new Response(fs.readFileSync(file), { headers: { 'Content-Type': contentType, 'Content-Length': String(size), 'Accept-Ranges': 'bytes', 'Cache-Control': 'private, max-age=86400' } })
}

export const musicRoutes = new Hono<AppEnv>()

musicRoutes.get('/', async (c) => {
  requireUser(c)
  return c.json(await listMusic())
})

const SFX_TYPES: Record<string, string> = { '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.m4a': 'audio/mp4', '.flac': 'audio/flac' }

musicRoutes.get('/sfx/:kit/:role', (c) => {
  requireUser(c)
  const m = sfxManifest()
  const take = m?.kits[c.req.param('kit')]?.roles[c.req.param('role')]?.takes[0]
  if (!take) throw notFound('No such sound effect')
  const root = path.resolve(SFX_DIR())
  const file = path.resolve(root, take.file)
  if (!file.startsWith(root + path.sep) || !fs.existsSync(file)) throw notFound('No such sound effect')
  return fileResponse(file, SFX_TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream', c.req.header('range'))
})

musicRoutes.get('/style/:style/preview', async (c) => {
  requireUser(c)
  const style = MUSIC_STYLES.find((m) => m.id === c.req.param('style'))?.id
  if (!style) throw notFound('No such music style')
  let file: string
  try {
    file = await styleSample(style)
  } catch (err) {
    log.warn('music: a style sample could not be composed', { style, err })
    throw new HttpError(503, 'server', 'This sample could not be made just now. Try again in a minute.')
  }
  return fileResponse(file, 'audio/mp4', c.req.header('range'))
})

musicRoutes.get('/:id/preview', async (c) => {
  requireUser(c)
  const info = await madeItem(requireItem(c.req.param('id'), 'music'))
  return serveObject(c, { key: info.key, contentType: info.mime }, { cache: 'private, max-age=86400' })
})

musicRoutes.post('/:id/add', async (c) => {
  const u = requireUser(c)
  const it = requireItem(c.req.param('id'), 'music')
  const b = await body(c, z.object({ workspaceId: z.string().min(1), projectId: z.string().max(80).optional() }))
  await requireRole(u.id, b.workspaceId, 'editor')
  if (b.projectId) await assertProjectInWorkspace(b.projectId, b.workspaceId)
  const row = await addLibraryItem({ it, workspaceId: b.workspaceId, userId: u.id, projectId: b.projectId, signal: c.req.raw.signal })
  return c.json(assetRecord(row, { light: true }))
})

/** The song as a video's music, in place of the music it has (services/project-music.ts): a job. */
musicRoutes.post('/:id/use', async (c) => {
  const u = requireUser(c)
  const it = requireItem(c.req.param('id'), 'music')
  const b = await body(c, z.object({ projectId: z.string().min(1).max(80) }))
  const row = await loadProjectRow(b.projectId)
  await requireRole(u.id, row.workspaceId, 'editor')
  await madeItem(it)
  const job = await queueProjectMusic({ projectId: row.id, songId: it.id, workspaceId: row.workspaceId, userId: u.id, title: it.title })
  return c.json(jobDto(job))
})

musicRoutes.post('/:id/customize', async (c) => {
  const u = requireUser(c)
  const it = requireItem(c.req.param('id'), 'music')
  const b = await body(c, z.object({ workspaceId: z.string().min(1), projectId: z.string().max(80).optional(), mode: z.literal('topic'), topic: z.string().max(300).optional(), aspect: z.enum(['16:9', '9:16', '1:1']).optional() }))
  await requireRole(u.id, b.workspaceId, 'editor')
  if (b.projectId) await assertProjectInWorkspace(b.projectId, b.workspaceId)
  const job = await queueCustom({ it, mode: b.mode, topic: b.topic, aspect: b.aspect, workspaceId: b.workspaceId, userId: u.id, projectId: b.projectId })
  return c.json(jobDto(job))
})
