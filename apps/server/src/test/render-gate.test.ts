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
import { HttpError } from '../http'
import { publicJobError, rawJobError } from '../jobs/errors'
import { extractionBytes, extractionFailure, extractionSlots, ffmpegGate, ffmpegSaid, freeBytes, gateFailures } from '../render/export'
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
      // a clip that is fine but meets a passing fault: its first FAKE_FAILS runs end as ffmpeg does when it can't start its threads
      "if (args.some((a) => a.includes('flaky'))) {",
      "  const f = log + '.count'",
      "  const n = (fs.existsSync(f) ? Number(fs.readFileSync(f, 'utf8')) : 0) + 1",
      '  fs.writeFileSync(f, String(n))',
      "  if (n <= Number(process.env.FAKE_FAILS || 1)) { process.stderr.write('frame=  137 fps=0.0 q=2.0 size=N/A' + String.fromCharCode(10) + 'Error while opening encoder for output stream #0:0 - maybe incorrect parameters such as bit_rate, rate, width or height' + String.fromCharCode(10) + 'Conversion failed!' + String.fromCharCode(10)); process.exit(1) }",
      '}',
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
    // the filter graph and the frame encoder size themselves for every core too: they get the same few threads, and
    // the frame pattern stays the last word
    const first = events.find((e) => e.at === 'start').args as string[]
    expect(first.slice(0, 4)).toEqual(['-threads', '3', '-filter_threads', '3'])
    expect(first.slice(-3, -1)).toEqual(['-threads', '3'])
    expect(first.at(-1)).toMatch(/frame_%05d\.jpg$/)
    expect(first.filter((a) => a === '-i').length).toBe(1)
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
    // a file ffmpeg can't read fails the same way every time: it is not run again
    expect(line.tries).toBe(1)
  }, 60_000)

  it('runs an extraction again when it failed for no reason of its file, and says so in its log', async () => {
    // 19 Nov 2026: a video of fourteen AI clips lost four to six of them, different ones each time, in seconds
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-gate-'))
    const failures = path.join(dir, 'failures.jsonl')
    const runs = path.join(dir, 'runs.jsonl')
    const env = { PS_FFMPEG_REAL: fakeFfmpeg(dir), PS_FFMPEG_SLOTS: '1', PS_FFMPEG_LOCKS: path.join(dir, 'locks'), PS_FFMPEG_LOG: failures, FAKE_LOG: runs, FAKE_FAILS: '1' }
    const extract = ['-ss', '0', '-i', path.join(dir, 'assets', 'as_flaky.mp4'), '-t', '2', '-y', path.join(dir, 'f_%05d.jpg')]
    expect(await runGate(env, extract)).toBe(0)
    expect(fs.readFileSync(runs, 'utf8').trim().split('\n').filter((l) => JSON.parse(l).at === 'start').length).toBe(2)
    const line = JSON.parse(fs.readFileSync(failures, 'utf8').trim())
    expect(line).toMatchObject({ code: 1, tries: 2, ok: true })
    expect(line.tail).toMatch(/Error while opening encoder/)
    // the export reads that as no failure at all
    const p: Project = { ...createProject({ id: 'p', name: 'x' }), assets: {} }
    expect(extractionFailure(failures, p)).toBeUndefined()
    expect(gateFailures(failures).length).toBe(1)

    // one that never works is given up after its tries, and logged once as a failure
    fs.rmSync(failures)
    fs.rmSync(runs + '.count')
    expect(await runGate({ ...env, FAKE_FAILS: '99', PS_FFMPEG_RETRIES: '2' }, extract)).toBe(1)
    const lost = JSON.parse(fs.readFileSync(failures, 'utf8').trim())
    expect(lost).toMatchObject({ code: 1, tries: 3 })
    expect(lost.ok).toBeUndefined()
    expect(fs.readdirSync(path.join(dir, 'locks'))).toEqual([])
    // an encode is never run twice
    fs.rmSync(runs + '.count')
    fs.writeFileSync(runs, '')
    expect(await runGate({ ...env, FAKE_FAILS: '99' }, ['-i', 'flaky.mp4', '-c:v', 'libx264', 'out.mp4'])).toBe(1)
    expect(fs.readFileSync(runs, 'utf8').trim().split('\n').filter((l) => JSON.parse(l).at === 'start').length).toBe(1)
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

  it('gives a cause it doesn’t know in ffmpeg’s own words, not as a damaged file', () => {
    const p: Project = { ...createProject({ id: 'p', name: 'x' }), assets: { as_a: video('as_a', 's05 · Government Services'), as_b: video('as_b', 's07 · Social Media') } }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-gate-'))
    const f = path.join(dir, 'f.jsonl')
    const encoder = '[mjpeg @ 0x55d0c8a1] ff_frame_thread_encoder_init failed\nError while opening encoder for output stream #0:0 - maybe incorrect parameters such as bit_rate, rate, width or height\nframe=  137 fps=0.0 q=2.0 size=N/A time=00:00:04.56\nConversion failed!'
    fs.writeFileSync(f, [JSON.stringify({ input: '/data/renders/j/assets/as_a.mp4', code: 1, signal: null, tail: encoder, tries: 3 }), JSON.stringify({ input: '/data/renders/j/assets/as_b.mp4', code: 1, signal: null, tail: encoder, tries: 3 })].join('\n'))
    // not "out of memory" for a frame count of 137, not "damaged", and no server path or log tag
    expect(extractionFailure(f, p)).toBe(
      'The render couldn’t read the video in “s05 · Government Services”, “s07 · Social Media”: ffmpeg stopped with “Error while opening encoder for output stream #0:0 - maybe incorrect parameters such as bit_rate, rate, width or height”.',
    )
    expect(ffmpegSaid('[image2 @ 0x1] Could not open file : /data/cache/hfx-1.partial-9-ab/frame_00001.jpg\nav_interleaved_write_frame(): Input/output error\nframe=    1 fps=0.0\nConversion failed!')).toBe('av_interleaved_write_frame(): Input/output error')
    expect(ffmpegSaid('')).toBeUndefined()
    // the server short of threads, after its tries
    fs.writeFileSync(f, JSON.stringify({ input: 'assets/as_a.mp4', code: 1, signal: null, tail: '[h264 @ 0x1] pthread_create failed: Resource temporarily unavailable', tries: 3, pids: '1021/1024' }))
    expect(extractionFailure(f, p)).toMatch(/“s05 · Government Services”: the server was too busy to read them, and trying again didn’t help\. Export again in a minute\.$/)
    // killed: memory, by the signal and not by a number in its output
    fs.writeFileSync(f, JSON.stringify({ input: 'assets/as_a.mp4', code: null, signal: 'SIGKILL', tail: '' }))
    expect(extractionFailure(f, p)).toMatch(/the server ran out of memory/)
    // nothing said at all
    fs.writeFileSync(f, JSON.stringify({ input: 'assets/as_a.mp4', code: 1, signal: null, tail: '' }))
    expect(extractionFailure(f, p)).toMatch(/ffmpeg stopped without saying why\.$/)
    // a clip that worked on its second try is not named
    fs.writeFileSync(f, [JSON.stringify({ input: 'assets/as_a.mp4', code: 1, signal: null, tail: encoder, tries: 2, ok: true }), JSON.stringify({ input: 'assets/as_b.mp4', code: 1, signal: null, tail: encoder, tries: 3 })].join('\n'))
    expect(extractionFailure(f, p)).toMatch(/^The render couldn’t read the video in “s07 · Social Media”: /)
  })

  it('keeps what ffmpeg said on the job for an operator, under the sentence people see', () => {
    const err = new HttpError(422, 'invalid', 'The render couldn’t read the video in “a”: ffmpeg stopped without saying why.', { ffmpeg: [{ input: 'assets/as_a.mp4', code: 1, signal: null, tail: 'the tail', tries: 3 }], renderer: 'Video extraction failed for 1 source(s)' })
    const raw = rawJobError(err)
    expect(raw.startsWith('The render couldn’t read the video in “a”')).toBe(true)
    expect(raw).toMatch(/"tail": "the tail"/)
    expect(raw).toMatch(/Video extraction failed for 1 source/)
    expect(publicJobError('export.render', err)).toBe('The render couldn’t read the video in “a”: ffmpeg stopped without saying why.')
    // an error with nothing kept reads as before
    expect(rawJobError(new Error('plain'))).toMatch(/^Error: plain|^plain/)
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
