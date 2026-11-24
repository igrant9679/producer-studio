// A video's music changed to a song from the media library (24 Nov 2026, the owner: "change the music in all of the
// recent projects - the current music is out of tune. choose different music for each recent project"). The music
// composed on a video's cuts (scripts/music) is replaced by a library song: fitted where the old music played (cut,
// faded, at the level composed music sits at under a narrator, or louder in a video with none), on the Music track
// (ducked under the voice), with any other music clip in the video taken off. The project is saved with the version
// before it kept, so the change can be undone from Versions, and its brief now asks for that song, so assembling the
// video again keeps it. A 'project.music' job (POST /api/music/:id/use {projectId}).
import fs from 'node:fs'
import { type Asset, type AudioItem, type Item, type LibraryTrack, type Project, createAudioItem, createTrack } from '@producer/core'
import { enqueue } from '../jobs/queue'
import type { JobContext } from '../jobs/worker'
import { MUSIC_DUCK_DB, makeLibraryMusic } from '../ai/soundtrack'
import { saveOnLatest } from '../ai/produce'
import { tmpDir } from './assets'
import { requireItem } from './media-library'
import { loadProjectRow } from './projects'

/** An audio item that is the video's music: on its Music track, or a music clip anywhere (a song or composed music). */
export function isMusicItem(p: Project, trackName: string, it: Item): boolean {
  if (it.type !== 'audio') return false
  return trackName === 'Music' || /^Music · /.test(p.assets[(it as AudioItem).assetId]?.name ?? '')
}

/** Where a video's music plays: its Music track's span, else its music clips', else the whole video. */
export function musicSpan(p: Project): { start: number; end: number } {
  const all = p.tracks.flatMap((t) => t.items)
  const end = Math.max(0, ...all.map((i) => i.start + i.duration))
  const onTrack = p.tracks.filter((t) => t.kind === 'audio' && t.name === 'Music').flatMap((t) => t.items)
  const music = onTrack.length ? onTrack : p.tracks.flatMap((t) => t.items.filter((i) => isMusicItem(p, t.name, i)))
  if (!music.length) return { start: 0, end }
  return { start: Math.min(...music.map((i) => i.start)), end: Math.max(...music.map((i) => i.start + i.duration)) }
}

/** The video has a narrator: the music sits under the voice, and ducks while it speaks. */
export const isVoiced = (p: Project) => p.tracks.some((t) => t.kind === 'audio' && t.name === 'Voiceover' && t.items.length > 0)

/**
 * `p` with `song` as its music, from `start`: the only item on its Music track (made after the voiceover's when it has
 * none), every other music clip taken off, and an audio track that held nothing but music left out.
 */
export function withMusic(p: Project, song: Asset, start: number, voiced: boolean): Project {
  let tracks = p.tracks
    .map((t) => ({ ...t, items: t.items.filter((i) => !isMusicItem(p, t.name, i)) }))
    .filter((t, k) => t.items.length > 0 || t.main || t.kind !== 'audio' || t.name === 'Music' || p.tracks[k].items.length === 0)
  let music = tracks.find((t) => t.kind === 'audio' && t.name === 'Music')
  if (!music) {
    music = createTrack('audio', { name: 'Music' })
    const at = tracks.findIndex((t) => t.name === 'Voiceover')
    tracks = [...tracks.slice(0, at + 1), music, ...tracks.slice(at + 1)]
  }
  music.items = [createAudioItem(song, Math.max(0, start), { name: 'Music', duration: song.duration ?? 0, fadeIn: 0.3, fadeOut: 1.2 })]
  if (voiced) music.duck = MUSIC_DUCK_DB
  else delete music.duck
  return { ...p, tracks, assets: { ...p.assets, [song.id]: song } }
}

/** Queues the change of a project's music to library song `songId`. */
export function queueProjectMusic(o: { projectId: string; songId: string; workspaceId: string; userId: string; title: string }) {
  return enqueue('project.music', { projectId: o.projectId, song: o.songId }, { workspaceId: o.workspaceId, userId: o.userId, projectId: o.projectId, message: `Changing the music to “${o.title}”` })
}

/** The 'project.music' job. */
export async function projectMusicJob(jc: JobContext): Promise<{ version: number; song: string; seconds: number }> {
  const { projectId, song: songId } = jc.job.input as { projectId: string; song: string }
  const song = requireItem(songId, 'music') as LibraryTrack & { kind: 'music' }
  const row = await loadProjectRow(projectId)
  const span = musicSpan(row.doc)
  const voiced = isVoiced(row.doc)
  const seconds = Math.max(1, Math.round((span.end - span.start) * 100) / 100)
  const work = tmpDir('project-music')
  let fitted: Asset
  try {
    jc.progress(0.05, `Fitting “${song.title}” to the video`)
    fitted = await makeLibraryMusic(jc, { workspaceId: row.workspaceId, userId: jc.job.userId, projectId: row.id, jobId: jc.job.id, song, duration: seconds, work, voiced })
  } finally {
    fs.rm(work, { recursive: true, force: true }, () => undefined)
  }
  jc.check()
  const saved = await saveOnLatest(
    row.id,
    (cur) => {
      const next = withMusic(cur, fitted, span.start, isVoiced(cur))
      // assembling the video again keeps this song
      if (cur.ai?.brief) next.ai = { ...cur.ai, brief: { ...cur.ai.brief, music: `library:${song.id}` } }
      return next
    },
    5,
    { userId: jc.job.userId, before: 'before-ai', note: `Music changed to “${song.title}”` },
  )
  jc.progress(1, `The music is now “${song.title}”`)
  return { version: saved.version, song: song.id, seconds }
}
