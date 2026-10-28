// What an export renders: a range of the edit, which captions are drawn, a reframed copy for a platform's shape,
// and the sidecar caption file written next to the video. The server renders `projectForExport(...)` exactly like a
// whole project, so a range or a preset looks the same as that part of the full export.
import type { ExportRequest } from './api'
import { captionsToText } from './captions'
import { clone, findItem, itemEnd, packMain, projectDuration, setAspect, splitAt } from './ops'
import { ASPECT_RATIOS, presetCanvasSize } from './presets'
import { shiftRamp, sourceOffset, syncAverageSpeed } from './speed'
import type { CaptionItem, Item, Project, Track } from './types'
import { EPS, clamp, round } from './util'

/** Platform presets for the export dialog: each sets the shape, size, frame rate and quality. */
export const EXPORT_PRESETS: ReadonlyArray<{
  id: string
  name: string
  hint: string
  aspect: (typeof ASPECT_RATIOS)[number]['id']
  resolution: ExportRequest['resolution']
  fps: ExportRequest['fps']
  quality: ExportRequest['quality']
}> = [
  { id: 'youtube', name: 'YouTube', hint: '16:9 · 1080p', aspect: '16:9', resolution: '1080p', fps: 30, quality: 'high' },
  { id: 'shorts', name: 'Shorts, Reels, TikTok', hint: '9:16 · 1080p', aspect: '9:16', resolution: '1080p', fps: 30, quality: 'standard' },
  { id: 'linkedin-square', name: 'LinkedIn square', hint: '1:1 · 1080p', aspect: '1:1', resolution: '1080p', fps: 30, quality: 'standard' },
  { id: 'linkedin-portrait', name: 'LinkedIn portrait', hint: '4:5 · 1080p', aspect: '4:5', resolution: '1080p', fps: 30, quality: 'standard' },
]

export const AUDIO_FORMATS = ['mp3', 'wav'] as const
export const isAudioFormat = (f: string): f is (typeof AUDIO_FORMATS)[number] => (AUDIO_FORMATS as readonly string[]).includes(f)

/** The aspect preset a canvas already has, if any. */
export function aspectOf(p: Pick<Project, 'width' | 'height'>): string | undefined {
  return ASPECT_RATIOS.find((a) => Math.abs(a.width / a.height - p.width / p.height) < 0.001)?.id
}

/** Timeline span of the given items (the selection), or undefined when there are none. */
export function selectionRange(p: Project, ids: string[]): { from: number; to: number } | undefined {
  let from = Infinity
  let to = -Infinity
  for (const id of ids) {
    const it = findItem(p, id)?.item
    if (!it) continue
    from = Math.min(from, it.start)
    to = Math.max(to, itemEnd(it))
  }
  return to > from ? { from: round(from, 4), to: round(to, 4) } : undefined
}

/**
 * The part of the edit between `from` and `to`, starting at 0: clips across either end are cut there (keeping their
 * source offset, keyframes, effects' phase and caption words, as a split does), everything outside is left out.
 * Locks don't matter here: this is a copy for rendering.
 */
export function projectRange(p0: Project, from: number, to: number): Project {
  const end = projectDuration(p0)
  const a = clamp(from, 0, end)
  const b = clamp(to, a, end)
  if (a <= EPS && b >= end - EPS) return p0
  let p = clone(p0)
  for (const t of p.tracks) {
    t.locked = false
    for (const it of t.items) it.locked = false
  }
  p = splitAt(splitAt(p, a), b)
  const len = round(b - a, 4)
  for (const t of p.tracks) {
    t.items = t.items.filter((it) => itemEnd(it) > a + EPS && it.start < b - EPS)
    for (const it of t.items) {
      it.start = round(it.start - a, 4)
      // a clip within a frame of the edge isn't cut by a split: trim what is left over by hand
      if (it.start < 0) trimLeft(it, -it.start)
      if (itemEnd(it) > len) it.duration = round(len - it.start, 4)
    }
    // a transition into a clip that is no longer there has nothing to play into
    t.items.forEach((it, i) => {
      const next = t.items[i + 1]
      if ('transitionOut' in it && it.transitionOut && (!next || Math.abs(next.start - itemEnd(it)) > 0.05)) it.transitionOut = undefined
    })
  }
  packMain(p)
  return p
}

function trimLeft(it: Item, d: number) {
  it.start = 0
  it.duration = round(Math.max(0, it.duration - d), 4)
  if ((it.type === 'video' || it.type === 'audio') && !(it.type === 'video' && (it.freezeAt !== undefined || it.reverse))) {
    it.in = round(it.in + sourceOffset(it, d), 4)
    if (it.speedRamp) it.speedRamp = shiftRamp(it.speedRamp, -d)
    syncAverageSpeed(it)
  }
  if ('keyframes' in it && it.keyframes)
    for (const k of Object.keys(it.keyframes) as Array<keyof typeof it.keyframes>) it.keyframes[k] = it.keyframes[k]?.map((kf) => ({ ...kf, t: round(kf.t - d, 4) }))
  if (it.type === 'caption' && it.words) it.words = it.words.filter((w) => w.end > d).map((w) => ({ ...w, start: Math.max(0, round(w.start - d, 4)), end: round(w.end - d, 4) }))
}

/** Caption tracks that have lines, in stacking order. */
export function filledCaptionTracks(p: Project): Track[] {
  return p.tracks.filter((t) => t.kind === 'caption' && t.items.some((i) => i.type === 'caption'))
}

/** How the export's captions come out: drawn on the picture (one track or all), as a file beside it, or not at all. */
export interface ExportCaptions {
  captions?: ExportRequest['captions']
  captionTrackId?: string
}

/**
 * The project an export renders: the range (if any), reframed to the platform shape (`aspect`, an ASPECT_RATIOS id;
 * positions scale as when the canvas ratio changes), and only the captions that are burned in.
 */
export function projectForExport(p0: Project, o: { range?: { from: number; to: number }; aspect?: string } & ExportCaptions): Project {
  let p = o.range ? projectRange(p0, o.range.from, o.range.to) : p0
  if (o.aspect && o.aspect !== aspectOf(p) && ASPECT_RATIOS.some((a) => a.id === o.aspect)) {
    const z = presetCanvasSize(o.aspect, Math.min(p.width, p.height))
    p = setAspect(p, z.width, z.height)
  }
  const mode = o.captions ?? 'burn'
  const keep = (t: Track) => t.kind !== 'caption' || (mode === 'burn' && (!o.captionTrackId || t.id === o.captionTrackId || !p.tracks.some((x) => x.id === o.captionTrackId)))
  if (p.tracks.some((t) => !keep(t))) p = { ...p, tracks: p.tracks.filter(keep) }
  return p
}

/**
 * The export's sidecar caption file (SRT or WebVTT) from one caption track (the given one, else the first with
 * lines), written by the caption ops' writer.
 */
export function sidecarCaptions(p: Project, format: 'srt' | 'vtt', trackId?: string): string {
  const tracks = filledCaptionTracks(p)
  const track = tracks.find((t) => t.id === trackId) ?? tracks[0]
  return track ? captionsToText(p, format, { trackId: track.id }) : ''
}
