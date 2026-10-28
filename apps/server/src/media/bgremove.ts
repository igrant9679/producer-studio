// media.bgremove (E-21): a copy of the part of a clip it shows with the background taken out, as a VP9 WebM with
// alpha (the editor plays it, the export reads its transparency). Producer Studio ships no model: the owner points
// BG_REMOVAL_CMD at a removal tool installed on the server. The command gets {in} (the part of the clip, an MP4) and
// {out} (an empty folder) and leaves there either out.webm with alpha or one PNG per frame; it runs without a shell.
import fs from 'node:fs'
import path from 'node:path'
import type { SmartJobResult } from '@producer/core'
import { ctx } from '../context'
import { HttpError } from '../http'
import type { JobContext } from '../jobs/worker'
import { ffmpeg, ffmpegProgress, run } from './proc'
import { probe } from './process'
import { type SmartInput, rangeInput, runSmartTool, sourceRange } from './smartTools'

/** Split a command line into arguments (double or single quotes group; no shell, no variables). */
export function splitCommand(cmd: string): string[] {
  const out: string[] = []
  let cur = ''
  let quote: string | null = null
  let any = false
  for (const ch of cmd.trim()) {
    if (quote) {
      if (ch === quote) quote = null
      else cur += ch
    } else if (ch === '"' || ch === "'") {
      quote = ch
      any = true
    } else if (/\s/.test(ch)) {
      if (cur || any) out.push(cur)
      cur = ''
      any = false
    } else cur += ch
  }
  if (cur || any) out.push(cur)
  return out
}

/** The configured command with {in} and {out} filled in: [program, ...args]. */
export function bgRemovalCommand(template: string, input: string, outDir: string): string[] {
  const parts = splitCommand(template)
  if (!parts.length) throw new HttpError(501, 'server', 'Background removal is not set up on this server')
  return parts.map((p) => p.replaceAll('{in}', input).replaceAll('{out}', outDir))
}

/** PNG frames the command left, in name order (numbers compared as numbers). */
export function frameFiles(dir: string): string[] {
  return fs
    .readdirSync(dir)
    .filter((f) => /\.png$/i.test(f))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
}

/** VP9 with alpha in WebM. */
const ALPHA_VIDEO = ['-c:v', 'libvpx-vp9', '-pix_fmt', 'yuva420p', '-b:v', '0', '-crf', '24', '-deadline', 'good', '-cpu-used', '4', '-row-mt', '1', '-auto-alt-ref', '0']

export async function removeBackground(jc: JobContext): Promise<SmartJobResult> {
  const input = jc.job.input as unknown as SmartInput
  const template = ctx().config.bgRemovalCmd
  if (!template) throw new HttpError(501, 'server', 'Background removal is not set up on this server: the owner sets BG_REMOVAL_CMD to a removal tool installed there.')
  return runSmartTool('removeBackground', jc, async ({ row, src, work, progress }) => {
    if (row.kind !== 'video' && row.kind !== 'image') throw new HttpError(400, 'invalid', 'Background removal works on video clips and pictures')
    const info = await probe(src, jc.signal)
    if (info.kind === 'image') throw new HttpError(400, 'invalid', 'Background removal works on video clips')
    const range = sourceRange(input, info.duration ?? row.meta?.duration)
    const length = range.length ?? info.duration ?? 1
    const fps = Math.min(60, info.fps ?? 30)
    // the part the clip shows, as a plain MP4 every tool reads
    progress(0, 'Cutting out the part to process')
    const part = path.join(work, 'in.mp4')
    await ffmpegProgress([...rangeInput(src, range), '-map', '0:v:0', ...(info.hasAudio ? ['-map', '0:a:0?'] : []), '-r', String(fps), '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '14', '-pix_fmt', 'yuv420p', ...(info.hasAudio ? ['-c:a', 'aac', '-b:a', '192k'] : ['-an']), part], length, (f) => progress(f * 0.1, 'Cutting out the part to process'), { signal: jc.signal, cwd: work })
    jc.check()
    const outDir = path.join(work, 'out')
    fs.mkdirSync(outDir)
    const [cmd, ...args] = bgRemovalCommand(template, part, outDir)
    progress(0.1, 'Removing the background')
    // the tool's own output is shown only when it fails (its last lines)
    const r = await run(cmd, args, { signal: jc.signal, cwd: work, maxCapture: 8000 })
    jc.check()
    if (r.code !== 0) throw new Error(`The background removal tool failed (exit ${r.code}): ${r.stderr.trim().split(/\r?\n/).slice(-4).join(' | ').slice(-500)}`)
    const webm = path.join(outDir, 'out.webm')
    const out = path.join(work, 'removed.webm')
    const sound = info.hasAudio ? ['-map', '1:a:0?', '-c:a', 'libopus', '-b:a', '160k'] : null
    if (fs.existsSync(webm)) {
      // its picture, with the part's sound put back (tools drop it)
      progress(0.85, 'Saving the cut-out')
      await ffmpeg(['-i', webm, '-i', part, '-map', '0:v:0', ...(sound ?? ['-an']), '-c:v', 'copy', '-shortest', out], { signal: jc.signal })
    } else {
      const frames = frameFiles(outDir)
      if (!frames.length) throw new Error('The background removal tool made no out.webm and no PNG frames')
      // numbered in order for ffmpeg's image sequence reader
      frames.forEach((f, i) => fs.renameSync(path.join(outDir, f), path.join(outDir, `f${String(i + 1).padStart(6, '0')}.png`)))
      progress(0.85, 'Encoding the cut-out')
      const seq = ['-framerate', String(fps), '-start_number', '1', '-i', path.join(outDir, 'f%06d.png'), '-i', part]
      await ffmpegProgress([...seq, '-map', '0:v:0', ...(sound ?? ['-an']), ...ALPHA_VIDEO, '-shortest', out], length, (f) => progress(0.85 + f * 0.15, 'Encoding the cut-out'), { signal: jc.signal })
    }
    return { file: out, mime: 'video/webm', kind: 'video', offset: range.from, length: range.length }
  })
}
