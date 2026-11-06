// The ffmpeg HyperFrames runs during an export (HYPERFRAMES_FFMPEG_PATH points at a shell shim that runs this).
// HyperFrames extracts the frames of every video source at once, each ffmpeg sized for every core it can see: on a
// container that reports the host's cores (48 on Railway) a long edit with dozens of cut clips started dozens of
// decoders together, and some were refused (EAGAIN) or killed, failing the export at "Extracting video frames".
// Here an extraction (its output is a numbered frame pattern) waits for one of PS_FFMPEG_SLOTS slots and decodes
// with PS_FFMPEG_THREADS threads; everything else HyperFrames runs passes straight through. A failure is written to
// PS_FFMPEG_LOG (one JSON line: the input and the end of ffmpeg's output) so the export can say which clip it was.
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const real = process.env.PS_FFMPEG_REAL || 'ffmpeg'
const args = process.argv.slice(2)
const out = args.at(-1) ?? ''
const extraction = /%0?\d*d\.(jpe?g|png)$/i.test(out)
const slots = Math.max(1, Number(process.env.PS_FFMPEG_SLOTS) || 2)
const threads = Math.max(1, Number(process.env.PS_FFMPEG_THREADS) || 2)
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

const slot = await acquire()
const release = () => {
  if (slot) fs.rmSync(slot, { recursive: true, force: true })
}
// decoder threads go before the input they apply to
const argv = extraction ? ['-threads', String(threads), ...args] : args
// a .js/.mjs "ffmpeg" (tests) runs on this Node
const child = /\.m?js$/i.test(real) ? spawn(process.execPath, [real, ...argv], { stdio: ['inherit', 'inherit', 'pipe'] }) : spawn(real, argv, { stdio: ['inherit', 'inherit', 'pipe'] })
let tail = ''
child.stderr.on('data', (b) => {
  process.stderr.write(b)
  tail = (tail + b.toString()).slice(-2000)
})
for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(sig, () => child.kill(sig))
child.on('error', (err) => {
  release()
  process.stderr.write(`${err.message}\n`)
  process.exit(127)
})
child.on('close', (code, signal) => {
  release()
  if (code !== 0 && extraction && process.env.PS_FFMPEG_LOG) {
    const input = args[args.indexOf('-i') + 1] ?? ''
    try {
      fs.appendFileSync(process.env.PS_FFMPEG_LOG, JSON.stringify({ input, code, signal, tail: tail.trim().split(/\r?\n/).slice(-6).join('\n') }) + '\n')
    } catch {
      /* nowhere to say it */
    }
  }
  process.exit(code ?? 1)
})
