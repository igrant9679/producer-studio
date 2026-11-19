// The ffmpeg HyperFrames runs during an export (HYPERFRAMES_FFMPEG_PATH points at a shell shim that runs this).
// HyperFrames extracts the frames of every video source at once, each ffmpeg sized for every core it can see: on a
// container that reports the host's cores (48 on Railway) a long edit with dozens of cut clips started dozens of
// decoders together, and some were refused (EAGAIN) or killed, failing the export at "Extracting video frames".
// Here an extraction (its output is a numbered frame pattern) waits for one of PS_FFMPEG_SLOTS slots and runs with
// PS_FFMPEG_THREADS threads in each of its pools: the decoder's, the filter graph's and the frame encoder's (the last
// two sized themselves for every core too: about seventy threads an extraction, and a video of fourteen AI clips
// lost four to six of them at random on 18 Nov 2026). An extraction that fails for no reason of its file is run
// again, up to PS_FFMPEG_RETRIES more times; everything else HyperFrames runs passes straight through. What failed
// is written to PS_FFMPEG_LOG (one JSON line: the input, the end of ffmpeg's output, how many tries, and `ok` when a
// later try worked) so the export can say which clip it was and why.
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const real = process.env.PS_FFMPEG_REAL || 'ffmpeg'
const args = process.argv.slice(2)
const out = args.at(-1) ?? ''
const extraction = /%0?\d*d\.(jpe?g|png)$/i.test(out)
const slots = Math.max(1, Number(process.env.PS_FFMPEG_SLOTS) || 2)
const threads = Math.max(1, Number(process.env.PS_FFMPEG_THREADS) || 2)
const retries = extraction ? Math.max(0, Math.min(5, Number(process.env.PS_FFMPEG_RETRIES ?? 2) || 0)) : 0
const locks = process.env.PS_FFMPEG_LOCKS
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const alive = (pid) => {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return err.code === 'EPERM'
  }
}

/** A slot is a folder made atomically; one whose owner has gone is taken over. */
async function acquire() {
  if (!extraction || !locks) return null
  fs.mkdirSync(locks, { recursive: true })
  for (;;) {
    for (let i = 0; i < slots; i++) {
      const slot = path.join(locks, `slot-${i}`)
      try {
        fs.mkdirSync(slot)
        fs.writeFileSync(path.join(slot, 'pid'), String(process.pid))
        return slot
      } catch (err) {
        if (err.code !== 'EEXIST') throw err
        let pid = 0
        try {
          pid = Number(fs.readFileSync(path.join(slot, 'pid'), 'utf8'))
        } catch {
          /* being made or freed right now */
        }
        if (pid && !alive(pid)) fs.rmSync(slot, { recursive: true, force: true })
      }
    }
    await sleep(150)
  }
}

/** Processes and threads the container has and may have ("412/1024"), where the kernel says. */
function pids() {
  for (const dir of ['/sys/fs/cgroup', '/sys/fs/cgroup/pids']) {
    try {
      return `${fs.readFileSync(path.join(dir, 'pids.current'), 'utf8').trim()}/${fs.readFileSync(path.join(dir, 'pids.max'), 'utf8').trim()}`
    } catch {
      /* not this layout, or not Linux */
    }
  }
  return undefined
}

let slot = null
const release = () => {
  if (slot) fs.rmSync(slot, { recursive: true, force: true })
  slot = null
}
let child
let stopped = false
for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP'])
  process.on(sig, () => {
    stopped = true
    if (child) return void child.kill(sig)
    // told to stop while waiting for a slot or between tries
    release()
    process.exit(1)
  })
slot = await acquire()
// the decoder's threads go before the input they apply to, the encoder's before the output; the filter graph's are global
const argv = extraction ? ['-threads', String(threads), '-filter_threads', String(threads), ...args.slice(0, -1), '-threads', String(threads), out] : args

/** One run of ffmpeg: how it ended and the end of what it said. */
function once() {
  return new Promise((resolve) => {
    // a .js/.mjs "ffmpeg" (tests) runs on this Node
    child = /\.m?js$/i.test(real) ? spawn(process.execPath, [real, ...argv], { stdio: ['inherit', 'inherit', 'pipe'] }) : spawn(real, argv, { stdio: ['inherit', 'inherit', 'pipe'] })
    let said = ''
    child.stderr.on('data', (b) => {
      process.stderr.write(b)
      said = (said + b.toString()).slice(-3000)
    })
    child.on('error', (err) => {
      process.stderr.write(`${err.message}\n`)
      resolve({ code: 127, signal: null, tail: `${said}\n${err.message}` })
    })
    child.on('close', (code, signal) => resolve({ code, signal, tail: said }))
  })
}

/** A failure the same file would meet again: it was killed, the disk is full, or ffmpeg can't read the file. */
const lasting = (r) => r.signal != null || /No space left on device|ENOSPC|Invalid data found|moov atom not found|could not find codec/i.test(r.tail)

let last
let failed
let tries = 0
for (;;) {
  tries++
  last = await once()
  child = undefined
  if (last.code === 0) break
  failed = last
  if (stopped || tries > retries || lasting(last)) break
  process.stderr.write(`[hf-ffmpeg] extraction failed (exit ${last.code}) on try ${tries} of ${retries + 1}: running it again\n`)
  await sleep(400 * tries)
}
release()
// what failed, for the export to name: also a failure that a later try got past (`ok`), so the server log can say why
if (extraction && failed && process.env.PS_FFMPEG_LOG) {
  const input = args[args.indexOf('-i') + 1] ?? ''
  const count = pids()
  const line = { input, code: failed.code, signal: failed.signal, tail: failed.tail.trim().split(/\r?\n/).slice(-10).join('\n'), tries, ...(last.code === 0 ? { ok: true } : {}), ...(stopped ? { stopped: true } : {}), ...(count ? { pids: count } : {}) }
  try {
    fs.appendFileSync(process.env.PS_FFMPEG_LOG, JSON.stringify(line) + '\n')
  } catch {
    /* nowhere to say it */
  }
}
process.exit(last.code ?? 1)
