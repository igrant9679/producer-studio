// The music library (19 Nov 2026, the owner: "give me 20 available samples of music that I can use/insert into my video
// as a part of a music library"): MUSIC_LIBRARY's tracks, composed by the server with the same composer as a video's own
// music (scripts/music), so they are free to use. A track is composed once, the first time anyone asks for it, and
// kept on the data volume (a cloud server also composes the missing ones in the background, one at a time, a few
// minutes after it starts), so it can be heard before it is used. Adding one to a project copies it into the space as
// an audio clip (once per space: adding it again reuses that clip).
//   GET  /api/music                 -> the tracks, each with `ready` (composed and kept)
//   GET  /api/music/:id/preview     -> the track (audio/mp4; composed now when it isn't kept yet), Range supported
//   GET  /api/music/sfx/:kit/:role  -> one take of a sound effect, for the brief's preview
//   POST /api/music/:id/add         -> { workspaceId, projectId? } -> AssetRecord: the space's clip of the track
import fs from 'node:fs'
import path from 'node:path'
import { and, eq, isNull, sql } from 'drizzle-orm'
import { Hono } from 'hono'
import * as z from 'zod/v4'
import { MUSIC_LIBRARY, MUSIC_LIBRARY_VERSION, libraryCuts, type LibraryTrack } from '@producer/core'
import { type AppEnv, requireUser } from '../auth'
import { ctx } from '../context'
import { assets } from '../db/schema'
import { assetRecord } from '../dto'
import { HttpError, body, notFound, requireRole } from '../http'
import { log } from '../log'
import { MUSIC_VERSION, SFX_DIR, composeMusicFile, sfxManifest } from '../ai/soundtrack'
import { processAsset } from '../media/process'
import { createAssetFromFile } from '../services/assets'
import { assertProjectInWorkspace } from '../services/projects'

/** What composes a library track (tests stand in a quick one: the real composer takes tens of seconds a track). */
export const LIBRARY = { compose: composeMusicFile }

const dir = () => path.join(ctx().config.dataDir, 'music-library')
/** The kept file of a track: a new library or composer version is another file. */
export const libraryFile = (t: LibraryTrack) => path.join(dir(), `${t.id}-l${MUSIC_LIBRARY_VERSION}-m${MUSIC_VERSION}.m4a`)
/** What a space's clip of a track is known by, so adding it again finds it. */
const libraryKey = (t: LibraryTrack) => `${t.id} l${MUSIC_LIBRARY_VERSION} m${MUSIC_VERSION}`

const making = new Map<string, Promise<string>>()

/** The track's kept file: composed now (once, however many ask at the same time) when it isn't kept yet. */
export function libraryTrackFile(t: LibraryTrack): Promise<string> {
  const file = libraryFile(t)
  if (fs.existsSync(file)) return Promise.resolve(file)
  let p = making.get(t.id)
  if (!p) {
    fs.mkdirSync(dir(), { recursive: true })
    const tmp = `${file}.${process.pid}.part.m4a`
    p = LIBRARY.compose({ style: t.style, cuts: libraryCuts(t.seconds), duration: t.seconds, seed: `library ${t.id}`, out: tmp, voiced: false })
      .then(() => {
        fs.renameSync(tmp, file)
        return file
      })
      .catch((err) => {
        fs.rmSync(tmp, { force: true })
        throw err
      })
      .finally(() => making.delete(t.id))
    making.set(t.id, p)
  }
  return p
}

const trackOf = (id: string) => {
  const t = MUSIC_LIBRARY.find((x) => x.id === id)
  if (!t) throw notFound('No such track in the music library')
  return t
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

musicRoutes.get('/', (c) => {
  requireUser(c)
  return c.json(MUSIC_LIBRARY.map((t) => ({ ...t, ready: fs.existsSync(libraryFile(t)) })))
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

musicRoutes.get('/:id/preview', async (c) => {
  requireUser(c)
  const t = trackOf(c.req.param('id'))
  let file: string
  try {
    file = await libraryTrackFile(t)
  } catch (err) {
    log.warn('music library: a track could not be composed', { track: t.id, err })
    throw new HttpError(503, 'server', 'This track could not be made just now. Try again in a minute.')
  }
  return fileResponse(file, 'audio/mp4', c.req.header('range'))
})

musicRoutes.post('/:id/add', async (c) => {
  const u = requireUser(c)
  const t = trackOf(c.req.param('id'))
  const b = await body(c, z.object({ workspaceId: z.string().min(1), projectId: z.string().max(80).optional() }))
  await requireRole(u.id, b.workspaceId, 'editor')
  if (b.projectId) await assertProjectInWorkspace(b.projectId, b.workspaceId)
  const key = libraryKey(t)
  // added before in this space (and not in its trash): that clip
  const had = (
    await ctx()
      .db.select()
      .from(assets)
      .where(and(eq(assets.workspaceId, b.workspaceId), eq(assets.status, 'ready'), isNull(assets.trashedAt), sql`${assets.meta}->'generated'->>'kind' = 'library'`, sql`${assets.meta}->'generated'->>'prompt' = ${key}`))
      .limit(1)
  )[0]
  if (had) return c.json(assetRecord(had, { light: true }))
  const file = await libraryTrackFile(t)
  const row = await createAssetFromFile({
    workspaceId: b.workspaceId,
    userId: u.id,
    projectId: b.projectId ?? null,
    filePath: file,
    name: `Music · ${t.title}`,
    mime: 'audio/mp4',
    kind: 'audio',
    origin: 'ai',
    meta: { generated: { kind: 'library', prompt: key, provider: 'huashu-motion', model: t.style } },
  })
  const ready = await processAsset(row.id, { signal: c.req.raw.signal, check: () => undefined, progress: () => undefined })
  return c.json(assetRecord(ready, { light: true }))
})

/**
 * A cloud server composes the tracks it doesn't keep yet, one at a time, starting a few minutes after it starts (so a
 * deploy's first minutes stay with people's work): the first person to open the library hears them at once.
 */
export function warmMusicLibrary(o: { delayMs?: number; gapMs?: number } = {}): () => void {
  let stopped = false
  const timer = setTimeout(async () => {
    for (const t of MUSIC_LIBRARY) {
      if (stopped) return
      if (fs.existsSync(libraryFile(t))) continue
      try {
        await libraryTrackFile(t)
        log.info('music library: composed a track', { track: t.id })
      } catch (err) {
        log.warn('music library: a track could not be composed; it is made when someone asks for it', { track: t.id, err })
        return
      }
      await new Promise((r) => setTimeout(r, o.gapMs ?? 5_000))
    }
  }, o.delayMs ?? 3 * 60_000)
  timer.unref?.()
  return () => {
    stopped = true
    clearTimeout(timer)
  }
}

