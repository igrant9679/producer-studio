// export.render: compile the project to a HyperFrames composition, lint, render, scale, store as an asset.
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { and, eq, inArray } from 'drizzle-orm'
import { EXPORT_RESOLUTIONS, compileToHyperFrames, projectDuration, type ExportRequest, type ExportResult, type Project } from '@producer/core'
import { REPO_ROOT } from '../config'
import { ctx } from '../context'
import { assets, exportsTable } from '../db/schema'
import { HttpError } from '../http'
import { newId } from '../ids'
import type { JobContext } from '../jobs/worker'
import { log } from '../log'
import { probe } from '../media/process'
import { ffmpeg, ffmpegProgress, run } from '../media/proc'
import { type AssetRow, assetPrefix, createAssetFromFile, localSource, updateAsset } from '../services/assets'
import { hydrateAssets, loadProjectRow } from '../services/projects'
import { buildFontFaces, fontsUsed } from './fonts'

const require = createRequire(import.meta.url)

let runtimeJs: Promise<string> | undefined

/** Bundle packages/core/src/runtime.ts to an IIFE (global ProducerRuntime) once per process. */
export function runtimeBundle(): Promise<string> {
  if (!runtimeJs) {
    runtimeJs = (async () => {
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

function assetIdsUsed(p: Project): string[] {
  const ids = new Set<string>()
  for (const t of p.tracks)
    for (const it of t.items) {
      if (it.type === 'video' || it.type === 'image' || it.type === 'audio') ids.add(it.assetId)
      if ((it.type === 'video' || it.type === 'image') && it.background?.type === 'image') ids.add(it.background.assetId)
    }
  return [...ids]
}

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
export async function prepareRenderDir(project: Project, workspaceId: string, dir: string, opts: { useProxy?: boolean; signal?: AbortSignal; progress?: (f: number, m: string) => void } = {}): Promise<PreparedRender> {
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
    const key = opts.useProxy && r.kind === 'video' && r.proxyKey ? r.proxyKey : r.sourceKey
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
  // freeze-frame stills and reversed clips
  const freeze = new Map<string, string>()
  const reversed = new Map<string, string>()
  for (const t of project.tracks)
    for (const it of t.items) {
      if (it.type !== 'video') continue
      const src = localFiles.get(it.assetId)
      if (!src) continue
      if (it.freezeAt !== undefined) {
        const out = `stills/${it.id}.png`
        fs.mkdirSync(path.join(dir, 'stills'), { recursive: true })
        await ffmpeg(['-ss', String(Math.max(0, it.freezeAt)), '-i', src, '-frames:v', '1', path.join(dir, out)], { signal: opts.signal })
        if (!fs.existsSync(path.join(dir, out))) await ffmpeg(['-sseof', '-0.1', '-i', src, '-frames:v', '1', path.join(dir, out)], { signal: opts.signal })
        freeze.set(it.id, out)
        files.push(out)
      } else if (it.reverse) {
        const out = `reversed/${it.id}.mp4`
        fs.mkdirSync(path.join(dir, 'reversed'), { recursive: true })
        const span = it.duration * it.speed
        await ffmpeg(['-ss', String(it.in), '-t', String(span), '-i', src, '-vf', 'reverse', '-an', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p', path.join(dir, out)], { signal: opts.signal })
        reversed.set(it.id, out)
        files.push(out)
      }
    }
  fs.writeFileSync(path.join(dir, 'runtime.js'), await runtimeBundle())
  fs.copyFileSync(gsapPath(), path.join(dir, 'gsap.min.js'))
  files.push('runtime.js', 'gsap.min.js')
  const fonts = buildFontFaces(fontsUsed(project), dir)
  files.push(...fonts.files)
  const html = compileToHyperFrames(project, {
    assetPath: (id) => rel.get(id) ?? '',
    freezeFramePath: (id) => freeze.get(id),
    reversedPath: (id) => reversed.get(id),
    runtimePath: 'runtime.js',
    gsapPath: 'gsap.min.js',
    fontFaceCss: fonts.css,
    title: project.name,
  })
  const index = path.join(dir, 'index.html')
  fs.writeFileSync(index, html)
  files.push('index.html')
  return { dir, index, files, project, duration: projectDuration(project) }
}

function hfEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env }
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

export async function renderComposition(dir: string, out: string, opts: { fps: number; quality: ExportRequest['quality']; format: ExportRequest['format']; signal?: AbortSignal; progress?: (f: number) => void }) {
  const args = [hyperframesCli(), 'render', dir, '-o', out, '-q', QUALITY[opts.quality], '--fps', String(opts.fps)]
  if (opts.format !== 'mp4') args.push('--format', opts.format)
  const pt = ctx().config.hyperframesProtocolTimeout
  if (pt) args.push('--protocol-timeout', pt)
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

const MIME: Record<ExportRequest['format'], string> = { mp4: 'video/mp4', webm: 'video/webm', gif: 'image/gif' }

export async function exportRender(jc: JobContext): Promise<ExportResult> {
  const input = jc.job.input as unknown as ExportRequest & { projectId: string }
  const row = await loadProjectRow(input.projectId)
  const project = await hydrateAssets(row.doc, row.workspaceId)
  if (projectDuration(project) <= 0) throw new HttpError(400, 'invalid', 'The project is empty')
  const dir = path.join(ctx().config.dataDir, 'renders', jc.job.id)
  fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(dir, { recursive: true })
  try {
    const prep = await prepareRenderDir(project, row.workspaceId, dir, { useProxy: input.quality === 'draft', signal: jc.signal, progress: (f, m) => jc.progress(f * 0.08, m) })
    jc.check()
    jc.progress(0.09, 'Checking composition')
    const lint = await lintComposition(dir, jc.signal)
    if (lint.errors.length) throw new Error(`Composition lint failed: ${lint.errors.slice(0, 5).join('; ')}`)
    jc.check()
    const ext = input.format
    const raw = path.join(dir, `render.${ext}`)
    jc.progress(0.1, 'Rendering')
    await renderComposition(dir, raw, { fps: input.fps, quality: input.quality, format: input.format, signal: jc.signal, progress: (f) => jc.progress(0.1 + f * 0.8, 'Rendering') })
    jc.check()
    let final = raw
    const tgt = targetSize(project.width, project.height, input.resolution)
    if (tgt.w !== project.width || tgt.h !== project.height) {
      jc.progress(0.91, `Scaling to ${tgt.w}×${tgt.h}`)
      final = path.join(dir, `final.${ext}`)
      const scale = `scale=${tgt.w}:${tgt.h}:flags=lanczos`
      const codec =
        ext === 'mp4'
          ? ['-c:v', 'libx264', '-preset', input.quality === 'draft' ? 'veryfast' : 'medium', '-crf', input.quality === 'high' ? '16' : '19', '-pix_fmt', 'yuv420p', '-c:a', 'copy', '-movflags', '+faststart']
          : ext === 'webm'
            ? ['-c:v', 'libvpx-vp9', '-b:v', '0', '-crf', '32', '-row-mt', '1', '-c:a', 'copy']
            : []
      await ffmpegProgress(['-i', raw, '-vf', scale, ...codec, final], prep.duration, (f) => jc.progress(0.91 + f * 0.06, 'Scaling'), { signal: jc.signal })
    }
    jc.progress(0.97, 'Saving export')
    const info = await probe(final, jc.signal).catch(() => null)
    const name = (input.name?.trim() || `${project.name} ${input.resolution}`).slice(0, 180)
    const assetRow = await createAssetFromFile({
      workspaceId: row.workspaceId,
      userId: jc.job.userId,
      projectId: row.id,
      filePath: final,
      name: `${name}.${ext}`,
      mime: MIME[input.format],
      kind: input.format === 'gif' ? 'image' : 'video',
      origin: 'render',
      status: 'ready',
      meta: { duration: info?.duration ?? prep.duration, width: info?.width ?? tgt.w, height: info?.height ?? tgt.h, fps: info?.fps ?? input.fps, hasAudio: info?.hasAudio },
    })
    // cheap thumbnail for the library
    try {
      const thumb = path.join(dir, 'thumb.jpg')
      await ffmpeg(['-ss', String(Math.min(1, (info?.duration ?? 1) / 2)), '-i', final, '-frames:v', '1', '-vf', 'scale=-2:360', '-q:v', '4', thumb], { signal: jc.signal })
      const key = `${assetPrefix(row.workspaceId, assetRow.id)}/thumb.jpg`
      await ctx().storage.putFile(key, thumb, 'image/jpeg')
      await updateAsset(assetRow.id, { thumbKey: key })
    } catch (err) {
      log.warn('export thumbnail failed', { err })
    }
    const exportId = newId('ex')
    const sizeBytes = assetRow.size
    const duration = info?.duration ?? prep.duration
    await ctx()
      .db.insert(exportsTable)
      .values({ id: exportId, projectId: row.id, workspaceId: row.workspaceId, assetId: assetRow.id, jobId: jc.job.id, name, resolution: input.resolution, fps: input.fps, format: input.format, sizeBytes, duration, createdBy: jc.job.userId, createdAt: Date.now() })
    jc.progress(1, 'Export ready')
    return { exportId, url: `/api/media/${assetRow.id}/source`, sizeBytes, duration }
  } finally {
    if (process.env.KEEP_RENDERS !== '1') fs.rm(dir, { recursive: true, force: true, maxRetries: 3 }, () => undefined)
  }
}
