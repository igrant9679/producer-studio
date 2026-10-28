// export.render: compile the project to a HyperFrames composition, lint, render, scale, store as an asset.
import fs from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { and, eq, inArray } from 'drizzle-orm'
import { EXPORT_RESOLUTIONS, compileToHyperFrames, exportVideoTiming, isAudioFormat, loudnessLufs, projectDuration, projectForExport, sidecarCaptions, type ExportPreviewResult, type ExportRequest, type ExportResult, type Project } from '@producer/core'
import { childEnv } from '../child-env'
import { REPO_ROOT } from '../config'
import { ctx } from '../context'
import { assets, exportsTable, jobs } from '../db/schema'
import { HttpError } from '../http'
import { newId } from '../ids'
import { emitJob } from '../jobs/queue'
import { CancelledError, type JobContext } from '../jobs/worker'
import { log } from '../log'
import { probe, renderMediaKey, sdrStillArgs } from '../media/process'
import { ffmpeg, run } from '../media/proc'
import { type AssetRow, assetPrefix, createAssetFromFile, localSource, updateAsset } from '../services/assets'
import { recordActivity } from '../services/activity'
import { hydrateAssets, loadProjectRow } from '../services/projects'
import { brandFontFaces } from './brandFonts'
import { buildFontFaces, fontsUsed } from './fonts'
import { normalizeLoudness } from './loudness'
import { makePitchShiftCopies } from './pitch'

const require = createRequire(import.meta.url)

let runtimeJs: Promise<string> | undefined

/** Bundle packages/core/src/runtime.ts to an IIFE (global ProducerRuntime) once per process. */
export function runtimeBundle(): Promise<string> {
  if (!runtimeJs) {
    runtimeJs = (async () => {
      // packaged desktop app: prebuilt bundle (no esbuild / TypeScript sources at runtime)
      if (process.env.RUNTIME_JS && fs.existsSync(process.env.RUNTIME_JS)) return fs.readFileSync(process.env.RUNTIME_JS, 'utf8')
      const esbuild = await import('esbuild')
      const entry = path.join(REPO_ROOT, 'packages', 'core', 'src', 'runtime.ts')
      const r = await esbuild.build({ entryPoints: [entry], bundle: true, format: 'iife', globalName: 'ProducerRuntime', minify: true, write: false, target: 'es2020', platform: 'browser', logLevel: 'silent' })
      return r.outputFiles[0].text
    })()
    runtimeJs.catch(() => (runtimeJs = undefined))
  }
  return runtimeJs
}

export function gsapPath(): string {
  return path.join(path.dirname(require.resolve('gsap/package.json')), 'dist', 'gsap.min.js')
}

export function hyperframesCli(): string {
  const dir = path.dirname(require.resolve('hyperframes/package.json'))
  const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')) as { bin?: Record<string, string> | string }
  const bin = typeof pkg.bin === 'string' ? pkg.bin : (pkg.bin?.hyperframes ?? 'bin/hyperframes.mjs')
  return path.join(dir, bin)
}

function assetIdsUsed(project: Project): string[] {
  const p = project
  const ids = new Set<string>()
  for (const t of p.tracks)
    for (const it of t.items) {
      if (it.type === 'video' || it.type === 'image' || it.type === 'audio') ids.add(it.assetId)
      if ((it.type === 'video' || it.type === 'image') && it.background?.type === 'image') ids.add(it.background.assetId)
      // a smooth slow-motion copy the clip's picture plays from (E-17)
      if (it.type === 'video' && it.smooth?.assetId && project.assets[it.smooth.assetId]) ids.add(it.smooth.assetId)
    }
  return [...ids]
}

/**
 * Size for a reversed copy: the source scaled down until it just covers the output frame (the largest a fitted clip
 * is drawn), never up. Even dimensions; undefined when the source size isn't known (it is then kept).
 */
export function reversedSize(srcW: number | undefined, srcH: number | undefined, output: { w: number; h: number }): { w: number; h: number } | undefined {
  if (!srcW || !srcH) return undefined
  const s = Math.min(1, Math.max(output.w / srcW, output.h / srcH))
  const even = (n: number) => Math.max(2, Math.round(n / 2) * 2)
  return { w: even(srcW * s), h: even(srcH * s) }
}

/** Frames reversed at a time: ffmpeg's reverse filter keeps every decoded frame of its input in memory. */
const REVERSE_CHUNK_FRAMES = 60

/**
 * Write source `range` of `src`, played backwards, to `out`: reversed a couple of seconds at a time (last chunk
 * first) at the output size and frame rate, then joined, so memory stays at one chunk whatever the clip's length or
 * resolution. The copy is silent (reversed clips are, in the preview too).
 */
export async function reverseRange(src: string, out: string, range: { from: number; to: number }, opts: { size?: { w: number; h: number }; fps: number; toneMap?: string; signal?: AbortSignal }) {
  const parts = `${out}.parts`
  fs.mkdirSync(parts, { recursive: true })
  const fps = Math.min(120, Math.max(1, opts.fps))
  const chunk = Math.max(0.25, REVERSE_CHUNK_FRAMES / fps)
  const len = Math.max(1 / fps, range.to - range.from)
  const n = Math.max(1, Math.ceil(len / chunk - 1e-6))
  // never upscale (a draft reverses the smaller proxy)
  const vf = `${opts.size ? `scale='min(iw,${opts.size.w})':-2,` : ''}fps=${fps},${opts.toneMap ? `${opts.toneMap},` : ''}reverse`
  const list: string[] = []
  try {
    for (let i = n - 1; i >= 0; i--) {
      const start = range.from + i * chunk
      const part = path.join(parts, `${n - 1 - i}.mp4`)
      const t = Math.min(chunk, range.from + len - start)
      await ffmpeg(['-ss', String(round3(start)), '-t', String(round3(t)), '-i', src, '-vf', vf, '-an', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p', part], { signal: opts.signal })
      list.push(`file '${part.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`)
    }
    const listFile = path.join(parts, 'list.txt')
    fs.writeFileSync(listFile, list.join('\n') + '\n')
    await ffmpeg(['-f', 'concat', '-safe', '0', '-i', listFile, '-c', 'copy', '-movflags', '+faststart', out], { signal: opts.signal })
  } finally {
    fs.rmSync(parts, { recursive: true, force: true })
  }
}

const round3 = (n: number) => Math.round(n * 1000) / 1000

export interface PreparedRender {
  dir: string
  index: string
  files: string[]
  project: Project
  duration: number
}

/**
 * Write everything the composition needs into `dir`: media (hardlinked/copied or downloaded), freeze-frame stills,
 * reversed clips, runtime.js, gsap.min.js, font files, and index.html.
 */
export async function prepareRenderDir(
  project: Project,
  workspaceId: string,
  dir: string,
  opts: { useProxy?: boolean; signal?: AbortSignal; progress?: (f: number, m: string) => void; output?: { w: number; h: number }; fps?: number } = {},
): Promise<PreparedRender> {
  fs.mkdirSync(path.join(dir, 'assets'), { recursive: true })
  const files: string[] = []
  const ids = assetIdsUsed(project)
  const rows: AssetRow[] = ids.length ? await ctx().db.select().from(assets).where(and(eq(assets.workspaceId, workspaceId), inArray(assets.id, ids))) : []
  const missing = ids.filter((id) => !rows.some((r) => r.id === id))
  if (missing.length) throw new HttpError(409, 'conflict', `The project uses media that is not in this workspace: ${missing.join(', ')}`)
  const notReady = rows.filter((r) => r.status === 'uploading')
  if (notReady.length) throw new HttpError(409, 'conflict', `Some media has not finished uploading: ${notReady.map((r) => r.name).join(', ')}`)
  const rel = new Map<string, string>()
  const localFiles = new Map<string, string>()
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]
    opts.progress?.(i / Math.max(1, rows.length), `Gathering media (${i + 1}/${rows.length})`)
    const key = renderMediaKey(r, opts.useProxy)
    const name = `${r.id}${path.extname(key) || '.bin'}`
    const dest = path.join(dir, 'assets', name)
    const src = await localSource(r, path.join(dir, '.dl'), key)
    if (src !== dest) {
      try {
        fs.linkSync(src, dest)
      } catch {
        fs.copyFileSync(src, dest)
      }
    }
    rel.set(r.id, `assets/${name}`)
    localFiles.set(r.id, dest)
    files.push(`assets/${name}`)
  }
  fs.rmSync(path.join(dir, '.dl'), { recursive: true, force: true })
  // freeze-frame stills, reversed clips and the frames clips hold before their files start
  const freeze = new Map<string, string>()
  const reversed = new Map<string, string>()
  const holds = new Map<string, string>()
  for (let ti = 0; ti < project.tracks.length; ti++)
    for (let ii = 0; ii < project.tracks[ti].items.length; ii++) {
      const it = project.tracks[ti].items[ii]
      if (it.type !== 'video') continue
      const src = localFiles.get(it.assetId)
      if (!src) continue
      const timing = exportVideoTiming(project, ti, ii)
      // an HDR clip's stills and reversed copy are tone-mapped like its proxy
      const sdr = it.freezeAt !== undefined || timing.hold || (it.reverse && timing.reversed) ? await sdrStillArgs(src, opts.signal) : []
      if (it.freezeAt === undefined && timing.hold) {
        const out = `stills/${it.id}-hold.png`
        fs.mkdirSync(path.join(dir, 'stills'), { recursive: true })
        await ffmpeg(['-ss', String(timing.hold.at), '-i', src, ...sdr, '-frames:v', '1', path.join(dir, out)], { signal: opts.signal })
        if (!fs.existsSync(path.join(dir, out))) await ffmpeg(['-sseof', '-0.1', '-i', src, ...sdr, '-frames:v', '1', path.join(dir, out)], { signal: opts.signal })
        holds.set(it.id, out)
        files.push(out)
      }
      if (it.freezeAt !== undefined) {
        const out = `stills/${it.id}.png`
        fs.mkdirSync(path.join(dir, 'stills'), { recursive: true })
        await ffmpeg(['-ss', String(Math.max(0, it.freezeAt)), '-i', src, ...sdr, '-frames:v', '1', path.join(dir, out)], { signal: opts.signal })
        if (!fs.existsSync(path.join(dir, out))) await ffmpeg(['-sseof', '-0.1', '-i', src, ...sdr, '-frames:v', '1', path.join(dir, out)], { signal: opts.signal })
        freeze.set(it.id, out)
        files.push(out)
      } else if (it.reverse && timing.reversed) {
        const out = `reversed/${it.id}.mp4`
        const a = project.assets[it.assetId]
        await reverseRange(src, path.join(dir, out), timing.reversed, { size: reversedSize(a?.width, a?.height, opts.output ?? { w: project.width, h: project.height }), fps: opts.fps ?? project.fps ?? 30, toneMap: sdr[1], signal: opts.signal })
        reversed.set(it.id, out)
        files.push(out)
      }
    }
  // sound whose pitch follows its speed (E-17)
  const pitch = await makePitchShiftCopies(project, localFiles, dir, opts.signal)
  files.push(...pitch.values())
  fs.writeFileSync(path.join(dir, 'runtime.js'), await runtimeBundle())
  fs.copyFileSync(gsapPath(), path.join(dir, 'gsap.min.js'))
  files.push('runtime.js', 'gsap.min.js')
  const fonts = buildFontFaces(fontsUsed(project), dir)
  files.push(...fonts.files)
  // fonts uploaded to the space for a brand kit (A-21)
  const brand = await brandFontFaces(workspaceId, fontsUsed(project), dir)
  files.push(...brand.files)
  const html = compileToHyperFrames(project, {
    assetPath: (id) => rel.get(id) ?? '',
    freezeFramePath: (id) => freeze.get(id),
    reversedPath: (id) => reversed.get(id),
    holdFramePath: (id) => holds.get(id),
    pitchShiftPath: (id) => pitch.get(id),
    runtimePath: 'runtime.js',
    gsapPath: 'gsap.min.js',
    fontFaceCss: [fonts.css, brand.css].filter(Boolean).join('\n'),
    outputWidth: opts.output?.w,
    outputHeight: opts.output?.h,
    title: project.name,
  })
  const index = path.join(dir, 'index.html')
  fs.writeFileSync(index, html)
  files.push('index.html')
  return { dir, index, files, project, duration: projectDuration(project) }
}

function hfEnv(): NodeJS.ProcessEnv {
  const env = childEnv()
  // Windows hosts behind TLS inspection need the system trust store for any browser download
  if (process.platform === 'win32' && !/--use-system-ca/.test(env.NODE_OPTIONS ?? '')) env.NODE_OPTIONS = `${env.NODE_OPTIONS ?? ''} --use-system-ca`.trim()
  if (!env.CHROME_PATH && ctx().config.chromePath && process.env.HF_USE_CACHED_CHROME === '1') env.CHROME_PATH = ctx().config.chromePath
  env.HYPERFRAMES_NO_TELEMETRY = '1'
  env.DO_NOT_TRACK = '1'
  env.FORCE_COLOR = '0'
  env.NO_COLOR = '1'
  return env
}

const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')

export async function lintComposition(dir: string, signal?: AbortSignal): Promise<{ errors: string[]; warnings: number }> {
  const r = await run(process.execPath, [hyperframesCli(), 'lint', dir, '--json'], { cwd: dir, env: hfEnv(), signal })
  const out = stripAnsi(r.stdout)
  try {
    const start = out.indexOf('{')
    const j = JSON.parse(out.slice(start)) as { findings?: Array<{ severity?: string; message?: string; code?: string; rule?: string }>; errorCount?: number; warningCount?: number }
    const findings = j.findings ?? []
    const errors = findings.filter((f) => f.severity === 'error').map((f) => `${f.code ?? f.rule ?? 'lint'}: ${f.message ?? ''}`)
    if (!errors.length && (j.errorCount ?? 0) > 0) errors.push(`${j.errorCount} lint error(s)`)
    return { errors, warnings: j.warningCount ?? findings.filter((f) => f.severity === 'warning').length }
  } catch {
    if (r.code !== 0) return { errors: [stripAnsi(r.stderr || r.stdout).trim().slice(-600) || `lint exited ${r.code}`], warnings: 0 }
    return { errors: [], warnings: 0 }
  }
}

const QUALITY: Record<ExportRequest['quality'], string> = { draft: 'draft', standard: 'looks', high: 'delivery' }

/** Parse HyperFrames render progress from a stdout chunk. */
export function parseRenderProgress(chunk: string): number | undefined {
  let last: number | undefined
  // stdout progress bar: "████░░░  64%  Streaming frame 180/281"
  for (const m of chunk.matchAll(/(\d{1,3})%\s+[A-Z][a-z]/g)) last = Number(m[1]) / 100
  if (last !== undefined) return Math.min(1, last)
  // stderr JSON trace lines
  for (const m of chunk.matchAll(/"framesCompleted"\s*:\s*(\d+)[^}]*?"totalFrames"\s*:\s*(\d+)/g)) if (+m[2] > 0) last = +m[1] / +m[2]
  for (const m of chunk.matchAll(/"totalFrames"\s*:\s*(\d+)[^}]*?"framesCompleted"\s*:\s*(\d+)/g)) if (+m[1] > 0) last = +m[2] / +m[1]
  if (last === undefined) for (const m of chunk.matchAll(/(\d+)\s*\/\s*(\d+)\s*frames/gi)) if (+m[2] > 0) last = +m[1] / +m[2]
  return last === undefined ? undefined : Math.min(1, Math.max(0, last))
}

/** Memory the server may use: the container's limit when it has one, else the machine's. */
export function systemMemoryMb(): number {
  const total = os.totalmem() / 2 ** 20
  for (const f of ['/sys/fs/cgroup/memory.max', '/sys/fs/cgroup/memory/memory.limit_in_bytes']) {
    try {
      const n = Number(fs.readFileSync(f, 'utf8').trim())
      if (Number.isFinite(n) && n > 0 && n < 2 ** 60) return Math.min(total, n / 2 ** 20)
    } catch {
      /* not limited, or not Linux */
    }
  }
  return total
}

/**
 * Chrome workers for one render. HyperFrames on its own sizes them for the whole machine (half its memory at 1.5 GB
 * each, all but two cores) on every render, so exports running side by side each take all of it; this gives each
 * of the `concurrency` job slots its share, and one worker per 30 frames at most, as HyperFrames does.
 */
export function renderWorkers(o: { memoryMb: number; cpus: number; concurrency: number; frames: number }): number {
  const share = Math.max(1, o.concurrency)
  const byMemory = Math.floor((o.memoryMb * 0.5) / 1536 / share)
  const byCpu = Math.floor(Math.max(1, o.cpus - 2) / share)
  return Math.max(1, Math.min(byMemory, byCpu, Math.floor(o.frames / 30), 24))
}

export function renderArgs(dir: string, out: string, opts: { fps: number; quality: ExportRequest['quality']; format: RenderFormat; workers?: number }): string[] {
  const args = [hyperframesCli(), 'render', dir, '-o', out, '-q', QUALITY[opts.quality], '--fps', String(opts.fps)]
  if (opts.format !== 'mp4') args.push('--format', opts.format)
  if (opts.workers) args.push('--workers', String(opts.workers))
  const pt = ctx().config.hyperframesProtocolTimeout
  if (pt) args.push('--protocol-timeout', pt)
  return args
}

export async function renderComposition(dir: string, out: string, opts: { fps: number; quality: ExportRequest['quality']; format: RenderFormat; workers?: number; signal?: AbortSignal; progress?: (f: number) => void }) {
  const args = renderArgs(dir, out, opts)
  let buf = ''
  const r = await run(process.execPath, args, {
    cwd: dir,
    env: hfEnv(),
    signal: opts.signal,
    onStdout: (s) => {
      buf = (buf + stripAnsi(s)).slice(-4000)
      const f = parseRenderProgress(buf)
      if (f !== undefined) opts.progress?.(f)
    },
  })
  if (r.code !== 0 || !fs.existsSync(out)) {
    const tail = stripAnsi(`${r.stderr}\n${r.stdout}`).trim().split(/\r?\n/).filter(Boolean).slice(-8).join(' | ')
    throw new Error(`Render failed (exit ${r.code}): ${tail.slice(-900)}`)
  }
}

/** Output size for a resolution preset: scale so the short side matches, even dimensions, never upscale past 4k. */
export function targetSize(w: number, h: number, resolution: ExportRequest['resolution']): { w: number; h: number } {
  const short = EXPORT_RESOLUTIONS.find((r) => r.id === resolution)?.short ?? 1080
  const s = short / Math.min(w, h)
  const even = (n: number) => Math.max(2, Math.round(n / 2) * 2)
  return { w: even(w * s), h: even(h * s) }
}

const MIME: Record<ExportRequest['format'], string> = { mp4: 'video/mp4', webm: 'video/webm', gif: 'image/gif', mp3: 'audio/mpeg', wav: 'audio/wav' }

/**
 * Record the export and finish its job in one transaction, unless the job was cancelled meanwhile (or another worker
 * took it over): a cancel that arrives after this finds the job done, one before it leaves no export.
 */
async function saveExport(jobId: string, lockedBy: string | null | undefined, values: typeof exportsTable.$inferInsert, result: ExportResult) {
  const job = await ctx().db.transaction(async (tx) => {
    const [done] = await tx
      .update(jobs)
      .set({ status: 'done', progress: 1, message: 'Done', result: result as never, updatedAt: Date.now(), lockedBy: null })
      .where(and(eq(jobs.id, jobId), eq(jobs.status, 'running'), eq(jobs.cancelRequested, false), lockedBy ? eq(jobs.lockedBy, lockedBy) : undefined))
      .returning()
    if (!done) throw new CancelledError()
    await tx.insert(exportsTable).values(values)
    return done
  })
  emitJob(job)
}

/** The render steps (tests stand in for Chrome). */
export interface RenderSteps {
  lint: typeof lintComposition
  render: typeof renderComposition
}

export async function exportRender(jc: JobContext, steps: RenderSteps = { lint: lintComposition, render: renderComposition }): Promise<ExportResult | ExportPreviewResult> {
  const input = jc.job.input as unknown as ExportRequest & { projectId: string }
  const row = await loadProjectRow(input.projectId)
  const whole = await hydrateAssets(row.doc, row.workspaceId)
  // the range, the platform shape and only the captions that are burned in
  const project = projectForExport(whole, input)
  if (projectDuration(project) <= 0) throw new HttpError(400, 'invalid', input.range ? 'There is nothing on the timeline in that range' : 'The project is empty')
  const plan = renderPlan(project, input)
  const dir = path.join(ctx().config.dataDir, 'renders', jc.job.id)
  fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(dir, { recursive: true })
  try {
    // Render natively at the requested size: the stage is scaled inside the composition so text, shapes and
    // captions are drawn at full resolution and source footage keeps its detail (no post-render upscale).
    const tgt = plan.size
    const prep = await prepareRenderDir(project, row.workspaceId, dir, { useProxy: plan.quality === 'draft', signal: jc.signal, progress: (f, m) => jc.progress(f * 0.08, m), output: tgt, fps: plan.fps })
    jc.check()
    jc.progress(0.09, 'Checking composition')
    const lint = await steps.lint(dir, jc.signal)
    if (lint.errors.length) throw new Error(`Composition lint failed: ${lint.errors.slice(0, 5).join('; ')}`)
    jc.check()
    const raw = path.join(dir, `render.${plan.format}`)
    jc.progress(0.1, 'Rendering')
    const workers = renderWorkers({ memoryMb: systemMemoryMb(), cpus: os.cpus().length, concurrency: ctx().config.workerConcurrency, frames: Math.ceil(prep.duration * plan.fps) })
    await steps.render(dir, raw, { fps: plan.fps, quality: plan.quality, format: plan.format, workers, signal: jc.signal, progress: (f) => jc.progress(0.1 + f * 0.8, 'Rendering') })
    jc.check()
    // a draft preview is for looking at the edit: it skips loudness, which needs two more passes over the sound
    const lufs = input.format === 'gif' || input.preview ? undefined : loudnessLufs(input.loudness)
    if (lufs !== undefined) jc.progress(0.92, 'Normalising loudness')
    const final = lufs !== undefined ? await normalizeLoudness(raw, path.join(dir, `loud.${plan.format}`), lufs, { format: plan.format, signal: jc.signal }) : raw
    jc.check()
    if (input.preview) return await savePreview(jc, row, final, prep.duration)
    const out = await deliverable(final, input.format, dir, prep.duration, jc.signal)
    const ext = input.format
    const audioOnly = isAudioFormat(input.format)
    jc.progress(0.97, 'Saving export')
    const info = await probe(out, jc.signal).catch(() => null)
    const name = (input.name?.trim() || `${project.name} ${audioOnly ? 'audio' : input.resolution}`).slice(0, 180)
    const assetRow = await createAssetFromFile({
      workspaceId: row.workspaceId,
      userId: jc.job.userId,
      projectId: row.id,
      filePath: out,
      name: `${name}.${ext}`,
      mime: MIME[input.format],
      kind: audioOnly ? 'audio' : input.format === 'gif' ? 'image' : 'video',
      origin: 'render',
      status: 'ready',
      // the job that made it, like voiceovers and Producer AI clips record theirs
      meta: audioOnly
        ? { duration: info?.duration ?? prep.duration, hasAudio: true, jobId: jc.job.id }
        : { duration: info?.duration ?? prep.duration, width: info?.width ?? tgt.w, height: info?.height ?? tgt.h, fps: info?.fps ?? input.fps, hasAudio: info?.hasAudio, jobId: jc.job.id },
    })
    try {
      // cheap thumbnail for the library and the share page's poster: the cover frame picked, else near the start
      if (!audioOnly)
        try {
          const thumb = path.join(dir, 'thumb.jpg')
          await ffmpeg(['-ss', String(coverTime(input.coverAt, info?.duration ?? prep.duration)), '-i', out, '-frames:v', '1', '-vf', 'scale=-2:360', '-q:v', '4', thumb], { signal: jc.signal })
          const key = `${assetPrefix(row.workspaceId, assetRow.id)}/thumb.jpg`
          await ctx().storage.putFile(key, thumb, 'image/jpeg')
          await updateAsset(assetRow.id, { thumbKey: key })
        } catch (err) {
          log.warn('export thumbnail failed', { err })
        }
      const exportId = newId('ex')
      const captions = input.captions === 'sidecar' && !audioOnly ? await saveSidecar(whole, input, row.workspaceId, assetRow.id, dir) : false
      jc.check()
      const sizeBytes = assetRow.size
      const duration = info?.duration ?? prep.duration
      const result: ExportResult = { exportId, url: `/api/media/${assetRow.id}/source`, sizeBytes, duration, format: input.format, ...(captions ? { captionsUrl: captionsPath(exportId) } : {}) }
      await saveExport(
        jc.job.id,
        jc.job.lockedBy,
        { id: exportId, projectId: row.id, workspaceId: row.workspaceId, assetId: assetRow.id, jobId: jc.job.id, name, resolution: audioOnly ? 'audio' : input.resolution, fps: input.fps, format: input.format, sizeBytes, duration, createdBy: jc.job.userId, createdAt: Date.now() },
        result,
      )
      await recordActivity({ workspaceId: row.workspaceId, projectId: row.id, actorId: jc.job.userId, kind: 'project.exported', data: { project: row.name, name, format: input.format, resolution: audioOnly ? undefined : input.resolution } })
      jc.progress(1, 'Export ready')
      return result
    } catch (err) {
      // cancelled (or failed) after the file was stored: no export, and no video left in the library without one
      await ctx()
        .db.delete(assets)
        .where(eq(assets.id, assetRow.id))
        .catch((e) => log.warn('could not remove an unsaved export', { assetId: assetRow.id, err: e }))
      await ctx().storage.deletePrefix(assetPrefix(row.workspaceId, assetRow.id) + '/').catch(() => undefined)
      throw err
    }
  } finally {
    if (process.env.KEEP_RENDERS !== '1') fs.rm(dir, { recursive: true, force: true, maxRetries: 3 }, () => undefined)
  }
}

// ---------- export options: range, audio only, captions, cover, draft preview (E-5, E-23) ----------

/** What HyperFrames itself renders: an audio-only export renders a small video and keeps its sound. */
export type RenderFormat = 'mp4' | 'webm' | 'gif'

/** Short side of a draft preview, and of the picture rendered only for its sound. */
export const PREVIEW_SHORT = 360
const AUDIO_RENDER_SHORT = 144
/** Frame rate of a draft preview (fast, smooth enough to judge a transition), and of an audio-only render. */
const PREVIEW_FPS = 24
const AUDIO_RENDER_FPS = 10

/** Size with short side `short` (never above the project's), even dimensions. */
export function shortSideSize(w: number, h: number, short: number): { w: number; h: number } {
  const s = Math.min(1, short / Math.min(w, h))
  const even = (n: number) => Math.max(2, Math.round(n / 2) * 2)
  return { w: even(w * s), h: even(h * s) }
}

/** How the composition is rendered for a request: a full export at its size, a small fast draft, or just for the sound. */
export function renderPlan(p: Pick<Project, 'width' | 'height'>, input: ExportRequest): { size: { w: number; h: number }; fps: number; quality: ExportRequest['quality']; format: RenderFormat } {
  if (input.preview) return { size: shortSideSize(p.width, p.height, PREVIEW_SHORT), fps: Math.min(PREVIEW_FPS, input.fps), quality: 'draft', format: 'mp4' }
  if (isAudioFormat(input.format)) return { size: shortSideSize(p.width, p.height, AUDIO_RENDER_SHORT), fps: AUDIO_RENDER_FPS, quality: 'draft', format: 'mp4' }
  return { size: targetSize(p.width, p.height, input.resolution), fps: input.fps, quality: input.quality, format: input.format as RenderFormat }
}

/** The thumbnail's time: the cover picked (inside the file), else 1 s in or half way. */
export function coverTime(coverAt: number | undefined, duration: number): number {
  if (coverAt === undefined || !Number.isFinite(coverAt)) return Math.min(1, duration / 2)
  return Math.round(Math.max(0, Math.min(coverAt, duration - 0.05)) * 1000) / 1000
}

/** ffmpeg arguments that keep only the sound of `src`, `duration` long, as MP3 (192 kb/s) or 16-bit WAV. */
export function audioArgs(src: string, out: string, format: 'mp3' | 'wav', duration: number): string[] {
  const codec = format === 'mp3' ? ['-c:a', 'libmp3lame', '-b:a', '192k'] : ['-c:a', 'pcm_s16le']
  return ['-i', src, '-vn', '-map', '0:a:0', '-t', String(Math.round(duration * 1000) / 1000), ...codec, out]
}

/** The file the person downloads: the render itself, or its sound for an audio-only export. */
async function deliverable(render: string, format: ExportRequest['format'], dir: string, duration: number, signal?: AbortSignal): Promise<string> {
  if (!isAudioFormat(format)) return render
  const info = await probe(render, signal).catch(() => null)
  if (info && !info.hasAudio) throw new HttpError(400, 'invalid', 'There is no sound to export here: every clip is muted or silent')
  const out = path.join(dir, `audio.${format}`)
  await ffmpeg(audioArgs(render, out, format, duration), { signal })
  return out
}

export const captionsPath = (exportId: string) => `/api/exports/${exportId}/captions`

/** Write the export's sidecar captions next to its file; false when the range has no caption lines. */
async function saveSidecar(whole: Project, input: ExportRequest, workspaceId: string, assetId: string, dir: string): Promise<boolean> {
  const format = input.captionFormat ?? 'srt'
  // from the same range of the edit, before the captions were left out of the picture
  const text = sidecarCaptions(projectForExport(whole, { range: input.range }), format, input.captionTrackId)
  if (!text.replace(/^WEBVTT\s*/, '').trim()) return false
  const file = path.join(dir, `captions.${format}`)
  fs.writeFileSync(file, text)
  const key = `${assetPrefix(workspaceId, assetId)}/captions.${format}`
  await ctx().storage.putFile(key, file, format === 'srt' ? 'application/x-subrip' : 'text/vtt')
  await updateAsset(assetId, { meta: { captions: { key, format } } })
  return true
}

/** Where a project's draft preview is kept: only the latest (each new draft replaces the one before). */
export const previewPrefix = (workspaceId: string, projectId: string) => `ws/${workspaceId}/previews/${projectId}/`
export const previewKey = (workspaceId: string, projectId: string, jobId: string) => `${previewPrefix(workspaceId, projectId)}${jobId}.mp4`

async function savePreview(jc: JobContext, row: { id: string; workspaceId: string }, file: string, duration: number): Promise<ExportPreviewResult> {
  jc.progress(0.97, 'Saving the draft')
  await ctx().storage.deletePrefix(previewPrefix(row.workspaceId, row.id)).catch(() => undefined)
  const { size } = await ctx().storage.putFile(previewKey(row.workspaceId, row.id, jc.job.id), file, 'video/mp4')
  jc.check()
  return { previewUrl: `/api/projects/${row.id}/previews/${jc.job.id}`, sizeBytes: size, duration }
}
