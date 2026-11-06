// Long exports that failed at "Extracting video frames" (tracker #13/#25): HyperFrames' ffmpeg goes through a gate
// (scripts/hf-ffmpeg.mjs) that lets a few frame extractions run at a time with few threads each, and logs what failed
// so the export can name the clip; the export checks its frames fit on the disk before it starts.
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createProject, createVideoItem, type Asset, type Project } from '@producer/core'
import { beforeAll, describe, expect, it } from 'vitest'
import { SERVER_ROOT } from '../config'
import { extractionBytes, extractionFailure, extractionSlots, ffmpegGate, freeBytes } from '../render/export'
import { setup } from './helpers'

beforeAll(async () => {
  await setup()
}, 120_000)

const GATE = path.join(SERVER_ROOT, 'scripts', 'hf-ffmpeg.mjs')

/** A stand-in ffmpeg: records when it ran and with what, sleeps, and fails when its input says so. */
function fakeFfmpeg(dir: string): string {
  const f = path.join(dir, 'fake-ffmpeg.mjs')
  fs.writeFileSync(
    f,
    [
      "import fs from 'node:fs'",
      'const args = process.argv.slice(2)',
      "const log = process.env.FAKE_LOG",
      "fs.appendFileSync(log, JSON.stringify({ at: 'start', t: Date.now(), args }) + String.fromCharCode(10))",
      'await new Promise((r) => setTimeout(r, 400))',
      "fs.appendFileSync(log, JSON.stringify({ at: 'end', t: Date.now() }) + String.fromCharCode(10))",
      "if (args.some((a) => a.includes('broken'))) { process.stderr.write('[mov,mp4 @ 0x1] moov atom not found' + String.fromCharCode(10) + 'broken.mp4: Invalid data found when processing input' + String.fromCharCode(10)); process.exit(1) }",
    ].join(String.fromCharCode(10)),
  )
  return f
}

function runGate(env: NodeJS.ProcessEnv, args: string[]): Promise<number> {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [GATE, ...args], { env: { ...process.env, ...env }, stdio: ['ignore', 'ignore', 'ignore'] })
    p.on('close', (code) => resolve(code ?? -1))
  })
}

describe('the ffmpeg gate', () => {
  it('lets only its slots of extractions run at once, with its threads; everything else passes straight through', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-gate-'))
    const log = path.join(dir, 'runs.jsonl')
    const env = { PS_FFMPEG_REAL: fakeFfmpeg(dir), PS_FFMPEG_SLOTS: '2', PS_FFMPEG_THREADS: '3', PS_FFMPEG_LOCKS: path.join(dir, 'locks'), FAKE_LOG: log }
    const extract = (i: number) => ['-ss', '0', '-i', `assets/as_${i}~1.mp4`, '-t', '2', '-vf', 'fps=30', '-q:v', '7', '-y', path.join(dir, `v${i}`, 'frame_%05d.jpg')]
    const codes = await Promise.all([1, 2, 3, 4, 5].map((i) => runGate(env, extract(i))))
    expect(codes).toEqual([0, 0, 0, 0, 0])
    const events = fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
    let running = 0
    let most = 0
    for (const e of [...events].sort((a, b) => a.t - b.t || (a.at === 'end' ? -1 : 1))) {
      running += e.at === 'start' ? 1 : -1
      most = Math.max(most, running)
    }
    expect(most).toBeLessThanOrEqual(2)
    expect(events.filter((e) => e.at === 'start').every((e) => e.args[0] === '-threads' && e.args[1] === '3')).toBe(true)
    // an encode (no frame pattern) is left as HyperFrames wrote it
    fs.writeFileSync(log, '')
    expect(await runGate(env, ['-i', 'in.mp4', '-c:v', 'libx264', 'out.mp4'])).toBe(0)
    expect(JSON.parse(fs.readFileSync(log, 'utf8').split('\n')[0]).args).toEqual(['-i', 'in.mp4', '-c:v', 'libx264', 'out.mp4'])
    // every slot is free again
    expect(fs.readdirSync(path.join(dir, 'locks'))).toEqual([])
  }, 60_000)

  it('takes over a slot whose owner died, and logs a failed extraction for the export to name', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-gate-'))
    const locks = path.join(dir, 'locks')
    fs.mkdirSync(path.join(locks, 'slot-0'), { recursive: true })
    fs.writeFileSync(path.join(locks, 'slot-0', 'pid'), '999999')
    const failures = path.join(dir, 'failures.jsonl')
    const env = { PS_FFMPEG_REAL: fakeFfmpeg(dir), PS_FFMPEG_SLOTS: '1', PS_FFMPEG_LOCKS: locks, PS_FFMPEG_LOG: failures, FAKE_LOG: path.join(dir, 'runs.jsonl') }
    const code = await runGate(env, ['-ss', '0', '-i', path.join(dir, 'assets', 'as_broken~2.mp4'), '-y', path.join(dir, 'f_%05d.png')])
    expect(code).toBe(1)
    const line = JSON.parse(fs.readFileSync(failures, 'utf8').trim())
    expect(line).toMatchObject({ input: path.join(dir, 'assets', 'as_broken~2.mp4'), code: 1 })
    expect(line.tail).toMatch(/moov atom not found/)
  }, 60_000)
})

describe('what the export says and checks', () => {
  const video = (id: string, name: string, duration = 600): Asset => ({ id, kind: 'video', name, src: '', duration, width: 1080, height: 1920 }) as Asset

  it('names the clips the render could not read, and why', () => {
    const p: Project = { ...createProject({ id: 'p', name: 'x' }), assets: { as_a: video('as_a', 'Video Tutorial.mov'), as_b: video('as_b', 'Interview.mp4') } }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-gate-'))
    const f = path.join(dir, 'f.jsonl')
    fs.writeFileSync(f, [JSON.stringify({ input: '/data/renders/j/assets/as_a~1.mp4', code: 1, signal: null, tail: 'av_interleaved_write_frame(): No space left on device' }), JSON.stringify({ input: '/data/renders/j/assets/as_b.mp4', code: null, signal: 'SIGKILL', tail: '' })].join('\n'))
    expect(extractionFailure(f, p)).toBe('The render couldn’t read the video in “Video Tutorial.mov”, “Interview.mp4”: the server ran out of disk space for its frames.')
    fs.writeFileSync(f, JSON.stringify({ input: 'assets/as_b.mp4', code: 1, signal: null, tail: 'moov atom not found' }))
    expect(extractionFailure(f, p)).toMatch(/“Interview.mp4”: the file is damaged/)
    expect(extractionFailure(path.join(dir, 'none.jsonl'), p)).toBeUndefined()
  })

  it('knows the disk its frames need: every used second of video at the export’s rate and size', () => {
    const a = video('as_a', 'A')
    let p: Project = { ...createProject({ id: 'p', name: 'x', width: 1080, height: 1920 }), assets: { as_a: a } }
    p.tracks[0].items.push(createVideoItem(a, 0, { in: 10, duration: 60 }))
    p = { ...p }
    const bytes = extractionBytes(p, { fps: 30, size: { w: 1080, h: 1920 } })
    // ~60 s (plus the trimming pad) of 1080x1920 frames at 30 fps: ~0.2 GB, so a 26-minute edit needs ~6 GB
    expect(bytes / 2 ** 30).toBeGreaterThan(0.15)
    expect(bytes / 2 ** 30).toBeLessThan(0.4)
    expect(extractionBytes(p, { fps: 30, size: { w: 720, h: 1280 } })).toBeLessThan(bytes / 2)
  })

  it('sizes the gate by the container, not the host; and tells free space', async () => {
    expect(extractionSlots({ cpus: 48, memoryMb: 8192, concurrency: 2 })).toEqual({ slots: 3, threads: 2 })
    expect(extractionSlots({ cpus: 2, memoryMb: 2048, concurrency: 1 })).toEqual({ slots: 1, threads: 2 })
    expect(extractionSlots({ cpus: 64, memoryMb: 65536, concurrency: 1 }).slots).toBe(8)
    expect(await freeBytes(path.join(os.tmpdir(), 'not', 'made', 'yet'))).toBeGreaterThan(0)
    // no shim on Windows (Node can't start one without a shell); elsewhere a shell script that runs the gate
    const env = ffmpegGate(fs.mkdtempSync(path.join(os.tmpdir(), 'ps-gate-')))
    if (process.platform === 'win32') expect(env).toEqual({})
    else expect(fs.readFileSync(env.HYPERFRAMES_FFMPEG_PATH!, 'utf8')).toMatch(/^#!\/bin\/sh\nexec .*hf-ffmpeg\.mjs' "\$@"\n$/)
  })
})
