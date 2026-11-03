// Composes a video's background music in its own process (a minute of number crunching must not stall the server).
// stdin: one JSON request (soundtrack.js composeMusic's input plus `out`, the WAV to write); stdout: one JSON reply,
// {"ok":true,"lufs":-24,"style":"mallet","bpm":104,"about":"…"} or {"ok":false,"error":"…"}.
import { writeFileSync } from 'node:fs'
import { composeMusic } from './soundtrack.js'

let input = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (s) => (input += s))
process.stdin.on('end', () => {
  try {
    const req = JSON.parse(input)
    const { wav, ...info } = composeMusic(req)
    writeFileSync(req.out, wav)
    process.stdout.write(JSON.stringify({ ok: true, ...info }) + '\n')
  } catch (err) {
    process.stdout.write(JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }) + '\n')
    process.exitCode = 1
  }
})
