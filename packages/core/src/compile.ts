// Project -> HyperFrames composition (index.html). Media elements are declared statically with HyperFrames timing
// attributes (HyperFrames owns decode/seek/mix); one paused GSAP timeline drives the bundled StageRenderer so every
// frame is produced by the same evaluate() the editor preview uses.
import { itemEnd, projectDuration } from './ops'
import { MAX_GAIN, type SoundSpan, laneParts, soloActive, trackAudible, trackSpans } from './audio'
import { exportVideoTiming } from './runtime'
import { rateLane, smoothSource } from './speed'
import type { Project } from './types'
import { escapeHtml, round, safeColor } from './util'

export interface CompileOptions {
  /** Path (relative to index.html) of an asset's source file. */
  assetPath: (assetId: string) => string
  /** Path of a pre-extracted still for a freeze-frame item (server extracts it with ffmpeg). */
  freezeFramePath?: (itemId: string) => string | undefined
  /** Path of a server-made reversed copy of a video item's source (exportVideoTiming's `reversed` range). */
  reversedPath?: (itemId: string) => string | undefined
  /** Path of a still of the frame a video item holds before its file starts (exportVideoTiming's `hold`). */
  holdFramePath?: (itemId: string) => string | undefined
  /**
   * Path of a server-made copy of a clip's sound with its pitch following its speed (speed.ts `shiftsPitch`): it
   * covers the clip's sound span (audio.ts) in timeline time, so it plays at 1x from the span's start.
   */
  pitchShiftPath?: (itemId: string) => string | undefined
  /** Relative path of the bundled renderer (packages/core dist/runtime.js). */
  runtimePath: string
  /** Relative path of gsap.min.js. */
  gsapPath: string
  /** @font-face rules for every font the project uses (local files). */
  fontFaceCss: string
  title?: string
  /**
   * Render size. When it differs from the project canvas, the stage keeps canvas coordinates and is scaled up/down
   * inside a composition of this size, so text, shapes and captions are drawn natively at the output resolution
   * (no bitmap upscaling) and source footage keeps its full detail.
   */
  outputWidth?: number
  outputHeight?: number
}

function attr(v: string | number): string {
  return escapeHtml(String(v))
}

/**
 * One clip's sound. Its level over time (clip keyframes and fades, crossfades into transitions, track volume, ducking:
 * see audio.ts) goes in as a volume lane, which HyperFrames plays as the gain itself in place of data-volume, so the
 * export is heard at the levels the preview plays.
 */
function audioTag(p: Project, span: SoundSpan, trackIndex: number, src: string, solo: boolean, shifted?: string): string {
  const it = span.item
  return laneParts(p, span, solo)
    .map((part, k) => {
      const pts = part.points
      const flat = pts.every((x) => Math.abs(x.v - pts[0].v) < 1e-4)
      // a speed ramp plays as a rate lane (speed.ts): the source times the preview plays. A pitch-shifted copy is
      // already at the clip's speed, so it plays at 1× from the span's start.
      const rate = shifted ? null : rateLane(it, part.start)
      const lanes = [...(flat ? [] : [{ target: 'volume', points: pts }]), ...(rate ? [{ target: 'rate', points: rate }] : [])]
      const lane = lanes.length ? ` data-automation='${JSON.stringify({ version: 1, lanes })}'` : ''
      const volume = flat ? (pts[0]?.v ?? 0) : Math.min(MAX_GAIN, Math.max(0, it.volume))
      const mediaStart = shifted ? part.start - span.start : part.mediaStart
      const speed = !shifted && !rate && it.speed !== 1 ? ` data-playback-rate="${clampRate(it.speed)}"` : ''
      // the parts of a long lane overlap at their joins: they alternate tracks too
      return `<audio id="a-${attr(it.id)}${k ? `-p${k + 1}` : ''}" src="${attr(shifted ?? src)}" data-start="${round(part.start, 4)}" data-duration="${round(part.end - part.start, 4)}" data-media-start="${round(mediaStart, 4)}" data-volume="${round(volume, 3)}" data-track-index="${trackIndex + (k % 2 ? 2000 : 0)}"${speed}${lane}></audio>`
    })
    .join('\n')
}

function clampRate(speed: number): number {
  return Math.min(10, Math.max(0.1, speed))
}

export function compileToHyperFrames(p: Project, opts: CompileOptions): string {
  const duration = Math.max(0.1, projectDuration(p))
  const outW = Math.round(opts.outputWidth ?? p.width)
  const outH = Math.round(opts.outputHeight ?? p.height)
  const scaled = outW !== p.width || outH !== p.height
  const body: string[] = []
  const audio: string[] = []
  let trackIndex = 0
  const solo = soloActive(p)
  for (let ti = 0; ti < p.tracks.length; ti++) {
    const track = p.tracks[ti]
    if (track.kind === 'audio' || track.kind === 'caption') continue
    trackIndex++
    const spans = new Map(trackAudible(p, track, solo) ? trackSpans(p, track).map((x) => [x.item.id, x]) : [])
    for (let ii = 0; ii < track.items.length; ii++) {
      const it = track.items[ii]
      if (it.type === 'video') {
        const freeze = it.freezeAt !== undefined ? opts.freezeFramePath?.(it.id) : undefined
        const reversed = it.reverse ? opts.reversedPath?.(it.id) : undefined
        if (freeze) {
          body.push(`<div data-ps-layer="${attr(it.id)}" style="position:absolute;display:none"><img data-ps-content src="${attr(freeze)}" alt=""></div>`)
        } else {
          // smooth slow motion: the copy with frames made in between, whose time 0 is source `from`
          const smooth = reversed ? null : smoothSource(p, it)
          const src = reversed ?? opts.assetPath(smooth?.assetId ?? it.assetId)
          // the file starts at the clip's true offset and pre-rolls into an incoming transition only the footage that
          // exists before its first frame (a reversed copy is padded with it); before that the held frame shows, as
          // in the preview. A reversed clip without its copy just plays the source from its in-point.
          const tm = exportVideoTiming(p, ti, ii)
          const from = it.reverse && !reversed ? it.start : tm.from
          const mediaStart = it.reverse && !reversed ? it.in : tm.mediaStart - (smooth?.from ?? 0)
          // a speed ramp is a rate lane from the element's start (speed.ts)
          const rate = rateLane(it, from)
          const holdSrc = tm.hold && (reversed || !it.reverse) ? opts.holdFramePath?.(it.id) : undefined
          const hold = holdSrc ? `<img data-ps-hold="${round(tm.hold!.until, 4)}" src="${attr(holdSrc)}" alt="">` : ''
          const timing = `data-start="${round(from, 4)}" data-duration="${round(tm.end - from, 4)}" data-media-start="${round(mediaStart, 4)}" data-track-index="${trackIndex}"${rate ? ` data-automation='${JSON.stringify({ version: 1, lanes: [{ target: 'rate', points: rate }] })}'` : it.speed !== 1 ? ` data-playback-rate="${clampRate(it.speed)}"` : ''}`
          body.push(`<div data-ps-layer="${attr(it.id)}" style="position:absolute;display:none"><video id="v-${attr(it.id)}" data-ps-content src="${attr(src)}" ${timing} muted playsinline></video>${hold}</div>`)
          if (it.background?.type === 'blur' && track.main) {
            body.push(`<div data-ps-bg="${attr(it.id)}" style="position:absolute;inset:0;display:none;overflow:hidden"><video id="vb-${attr(it.id)}" src="${attr(src)}" ${timing} muted playsinline></video>${hold}</div>`)
          }
          // its sound (none for a reversed clip, as in the preview), widened into the transitions either side;
          // neighbours overlap there, so they alternate tracks
          const span = spans.get(it.id)
          if (span) audio.push(audioTag(p, span, 100 + trackIndex + (ii % 2 ? 1000 : 0), opts.assetPath(it.assetId), solo, opts.pitchShiftPath?.(it.id)))
        }
      } else if (it.type === 'image') {
        body.push(`<div data-ps-layer="${attr(it.id)}" style="position:absolute;display:none"><img data-ps-content src="${attr(opts.assetPath(it.assetId))}" alt=""></div>`)
        if (it.background?.type === 'blur' && track.main)
          body.push(`<div data-ps-bg="${attr(it.id)}" style="position:absolute;inset:0;display:none;overflow:hidden"><img src="${attr(opts.assetPath(it.assetId))}" alt=""></div>`)
      } else if (it.type === 'text' || it.type === 'shape' || it.type === 'adjustment') {
        body.push(`<div data-ps-layer="${attr(it.id)}" style="position:absolute;display:none"><div data-ps-content></div></div>`)
      }
    }
  }
  let audioTrack = 200
  for (const track of p.tracks) {
    if (track.kind !== 'audio' || !trackAudible(p, track, solo)) continue
    audioTrack++
    for (const span of trackSpans(p, track)) audio.push(audioTag(p, span, audioTrack + (track.items.indexOf(span.item) % 2 ? 1000 : 0), opts.assetPath(span.item.assetId), solo, opts.pitchShiftPath?.(span.item.id)))
  }
  // captions and text layers are created by the renderer at runtime (no media)
  const projectJson = JSON.stringify(p).replace(/</g, '\\u003c')
  // goes into a <style> block: only a checked colour, never the raw document string
  const background = safeColor(p.background, '#000000')
  const assetMap: Record<string, string> = {}
  for (const id of Object.keys(p.assets)) assetMap[id] = opts.assetPath(id)
  const lastEnd = Math.max(...p.tracks.flatMap((t) => t.items.map(itemEnd)), 0)
  void lastEnd
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=${outW}, height=${outH}">
<title>${escapeHtml(opts.title ?? p.name)}</title>
<script src="${attr(opts.gsapPath)}"></script>
<script src="${attr(opts.runtimePath)}"></script>
<style>
${opts.fontFaceCss}
html, body { margin: 0; padding: 0; background: ${background}; }
#root { position: relative; width: 100%; height: 100%; overflow: hidden; background: ${background}; font-family: 'Inter', sans-serif; }
#stage { position: absolute; left: 0; top: 0; width: ${p.width}px; height: ${p.height}px; overflow: hidden; background: ${background};${scaled ? ` transform: scale(${(outW / p.width).toFixed(6)}, ${(outH / p.height).toFixed(6)}); transform-origin: 0 0;` : ''} }
</style>
</head>
<body>
<div id="root" data-composition-id="main" data-start="0" data-width="${outW}" data-height="${outH}" data-duration="${round(duration, 4)}">
<div id="stage">
${body.join('\n')}
</div>
${audio.join('\n')}
</div>
<script>
(function () {
  var project = ${projectJson};
  var assets = ${JSON.stringify(assetMap)};
  var root = document.getElementById('stage');
  var renderer = new ProducerRuntime.StageRenderer(root, project, {
    mode: 'export',
    resolveUrl: function (id) { return assets[id] || ''; }
  });
  var proxy = { t: 0 };
  var tl = gsap.timeline({ paused: true });
  tl.to(proxy, { t: ${round(duration, 4)}, duration: ${round(duration, 4)}, ease: 'none', onUpdate: function () { renderer.render(proxy.t); } });
  renderer.render(0);
  window.__timelines['main'] = tl;
})();
</script>
</body>
</html>
`
}
