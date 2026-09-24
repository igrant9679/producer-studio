// Project -> HyperFrames composition (index.html). Media elements are declared statically with HyperFrames timing
// attributes (HyperFrames owns decode/seek/mix); one paused GSAP timeline drives the bundled StageRenderer so every
// frame is produced by the same evaluate() the editor preview uses.
import { itemEnd, projectDuration } from './ops'
import { exportWindow } from './runtime'
import type { AudioItem, Project, VideoItem } from './types'
import { escapeHtml, round, sampleKeyframes } from './util'

export interface CompileOptions {
  /** Path (relative to index.html) of an asset's source file. */
  assetPath: (assetId: string) => string
  /** Path of a pre-extracted still for a freeze-frame item (server extracts it with ffmpeg). */
  freezeFramePath?: (itemId: string) => string | undefined
  /** Path of a pre-rendered reversed copy of a video item's source range. */
  reversedPath?: (itemId: string) => string | undefined
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

/** Volume automation lane (clip-local seconds) from keyframes + fades, sampled at 10 Hz where needed. */
function volumeLane(it: AudioItem | VideoItem): string | undefined {
  const kf = it.keyframes?.volume
  if (!kf?.length && !it.fadeIn && !it.fadeOut) return undefined
  const pts: Array<{ t: number; v: number }> = []
  const step = 0.1
  for (let t = 0; t <= it.duration + 1e-6; t += step) {
    let v = sampleKeyframes(kf, t, it.volume) / Math.max(0.0001, it.volume)
    if (it.fadeIn > 0 && t < it.fadeIn) v *= t / it.fadeIn
    const rem = it.duration - t
    if (it.fadeOut > 0 && rem < it.fadeOut) v *= Math.max(0, rem) / it.fadeOut
    pts.push({ t: round(t, 3), v: round(Math.max(0, v), 4) })
  }
  // drop collinear runs to keep the attribute small
  const out = pts.filter((p, i) => i === 0 || i === pts.length - 1 || !(pts[i - 1].v === p.v && pts[i + 1].v === p.v))
  return JSON.stringify({ version: 1, lanes: [{ target: 'volume', points: out.map((p) => ({ t: p.t, v: p.v })) }] })
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
  for (let ti = 0; ti < p.tracks.length; ti++) {
    const track = p.tracks[ti]
    if (track.kind === 'audio' || track.kind === 'caption') continue
    trackIndex++
    for (let ii = 0; ii < track.items.length; ii++) {
      const it = track.items[ii]
      if (it.type === 'video') {
        const win = exportWindow(p, ti, ii)
        const pre = it.start - win.start
        const freeze = it.freezeAt !== undefined ? opts.freezeFramePath?.(it.id) : undefined
        const reversed = it.reverse ? opts.reversedPath?.(it.id) : undefined
        if (freeze) {
          body.push(`<div data-ps-layer="${attr(it.id)}" style="position:absolute;display:none"><img data-ps-content src="${attr(freeze)}" alt=""></div>`)
        } else {
          const src = reversed ?? opts.assetPath(it.assetId)
          const mediaStart = reversed ? Math.max(0, -pre * it.speed) : Math.max(0, it.in - pre * it.speed)
          const timing = `data-start="${round(win.start, 4)}" data-duration="${round(win.end - win.start, 4)}" data-media-start="${round(mediaStart, 4)}" data-track-index="${trackIndex}"${it.speed !== 1 ? ` data-playback-rate="${clampRate(it.speed)}"` : ''}`
          body.push(`<div data-ps-layer="${attr(it.id)}" style="position:absolute;display:none"><video id="v-${attr(it.id)}" data-ps-content src="${attr(src)}" ${timing} muted playsinline></video></div>`)
          if (it.background?.type === 'blur' && track.main) {
            body.push(`<div data-ps-bg="${attr(it.id)}" style="position:absolute;inset:0;display:none;overflow:hidden"><video id="vb-${attr(it.id)}" src="${attr(src)}" ${timing.replace(/data-track-index="\d+"/, `data-track-index="${trackIndex}"`)} muted playsinline></video></div>`)
          }
          const asset = p.assets[it.assetId]
          if (!it.muted && !track.muted && asset?.hasAudio !== false && !reversed) {
            const lane = volumeLane(it)
            audio.push(
              `<audio id="a-${attr(it.id)}" src="${attr(opts.assetPath(it.assetId))}" data-start="${round(it.start, 4)}" data-duration="${round(it.duration, 4)}" data-media-start="${round(it.in, 4)}" data-volume="${round(Math.min(3.98, it.volume), 3)}" data-track-index="${100 + trackIndex}"${it.speed !== 1 ? ` data-playback-rate="${clampRate(it.speed)}"` : ''}${lane ? ` data-automation='${lane}'` : ''}></audio>`,
            )
          }
        }
      } else if (it.type === 'image') {
        body.push(`<div data-ps-layer="${attr(it.id)}" style="position:absolute;display:none"><img data-ps-content src="${attr(opts.assetPath(it.assetId))}" alt=""></div>`)
        if (it.background?.type === 'blur' && track.main)
          body.push(`<div data-ps-bg="${attr(it.id)}" style="position:absolute;inset:0;display:none;overflow:hidden"><img src="${attr(opts.assetPath(it.assetId))}" alt=""></div>`)
      } else if (it.type === 'text' || it.type === 'shape') {
        body.push(`<div data-ps-layer="${attr(it.id)}" style="position:absolute;display:none"><div data-ps-content></div></div>`)
      }
    }
  }
  let audioTrack = 200
  for (const track of p.tracks) {
    if (track.kind !== 'audio' || track.muted) continue
    audioTrack++
    for (const it of track.items) {
      if (it.type !== 'audio' || it.muted) continue
      const lane = volumeLane(it)
      audio.push(
        `<audio id="a-${attr(it.id)}" src="${attr(opts.assetPath(it.assetId))}" data-start="${round(it.start, 4)}" data-duration="${round(it.duration, 4)}" data-media-start="${round(it.in, 4)}" data-volume="${round(Math.min(3.98, it.volume), 3)}" data-track-index="${audioTrack}"${it.speed !== 1 ? ` data-playback-rate="${clampRate(it.speed)}"` : ''}${lane ? ` data-automation='${lane}'` : ''}></audio>`,
      )
    }
  }
  // captions and text layers are created by the renderer at runtime (no media)
  const projectJson = JSON.stringify(p).replace(/</g, '\\u003c')
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
html, body { margin: 0; padding: 0; background: ${p.background}; }
#root { position: relative; width: 100%; height: 100%; overflow: hidden; background: ${p.background}; font-family: 'Inter', sans-serif; }
#stage { position: absolute; left: 0; top: 0; width: ${p.width}px; height: ${p.height}px; overflow: hidden; background: ${p.background};${scaled ? ` transform: scale(${(outW / p.width).toFixed(6)}, ${(outH / p.height).toFixed(6)}); transform-origin: 0 0;` : ''} }
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
