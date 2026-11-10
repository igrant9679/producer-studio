// What people see when a job fails (GET /api/jobs, the job history, toasts, live updates): a plain sentence without
// server paths, tool output or internals. The raw error stays in the server log and on the job (`error_detail`, shown
// to operators only).
import { friendlyProcessingError } from '../media/process'
import { describeStorageError } from '../services/storage-health'

/** Drop file paths (server or desktop), file URLs and ffmpeg's `[codec @ 0x…]` tags from an error message. */
export function scrubPaths(msg: string): string {
  return msg
    .replace(/file:\/\/\S+/gi, '…')
    .replace(/[A-Za-z]:\\[^\s:|'"]+/g, '…')
    .replace(/\\\\[^\s:|'"]+/g, '…')
    .replace(/(?<![:\w/.])(?:\/[\w.@~+-]+){2,}\/?/g, '…')
    .replace(/\[[\w,]+ @ 0x?[0-9a-f]+\]\s*/gi, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/** What a kind of job is, as the start of a sentence. */
const WHAT: Record<string, string> = {
  'export.render': 'The export',
  'asset.process': 'Processing this clip',
  'ai.transcribe': 'The transcription',
  'ai.tts': 'The voiceover',
  'ai.produce.script': 'Producer AI',
  'ai.produce.assemble': 'Producer AI',
  'media.scenes': 'Finding scene changes',
  'media.stabilise': 'Stabilising',
  'media.denoise': 'Denoising',
  'media.bgremove': 'Removing the background',
  'media.smooth': 'Smooth slow motion',
  'media.sketch': 'Sketching the picture in',
}

/**
 * A message that is a tool's own output rather than a sentence written for people: "<step> failed (exit N): <stderr>",
 * a stack trace, or ffmpeg's log lines.
 */
export function isToolOutput(msg: string): boolean {
  return /\bfailed \(exit -?\d+\)/i.test(msg) || /\n\s+at\s/.test(msg) || /\[[\w,]+ @ 0x?[0-9a-f]+\]/i.test(msg) || /\b(ffmpeg|ffprobe|whisper-cli|chrome-headless)\b.*\|/i.test(msg)
}

/** The causes people can act on, whatever tool reported them. */
function knownCause(msg: string): string | undefined {
  if (/ENOSPC|No space left on device/i.test(msg)) return 'The server ran out of disk space. Try again in a while.'
  if (/out of memory|ENOMEM|Cannot allocate memory|heap out of memory|exit 137\b|SIGKILL/i.test(msg)) return 'The server ran out of memory. Try again, or try a shorter or smaller project.'
  if (/ETIMEDOUT|ECONNRESET|socket hang up/i.test(msg)) return 'A connection dropped on the server. Try again.'
  if (/Invalid data found when processing input|could not find codec parameters|Unknown format|moov atom not found/i.test(msg)) return 'The file is damaged or in a format the server can’t read.'
  if (/could not open|No such file or directory|ENOENT/i.test(msg)) return 'A file it needed couldn’t be opened on the server. Try again.'
}

export function publicJobError(kind: string, err: unknown): string {
  const e = err as { $metadata?: unknown; Code?: unknown }
  if (e && typeof e === 'object' && ('$metadata' in e || 'Code' in e)) return describeStorageError(err)
  const raw = err instanceof Error ? err.message : String(err)
  const what = WHAT[kind] ?? 'This job'
  if (kind === 'asset.process') {
    // the clip shows the same sentence (media/process.ts); tool output past its known causes becomes one sentence
    const friendly = friendlyProcessingError(err)
    if (!/^Processing failed: /.test(friendly) || !isToolOutput(raw)) return friendly
  }
  const cause = knownCause(raw)
  if (cause) return `${what} failed. ${cause}`
  if (isToolOutput(raw)) return `${what} failed on the server. Try again; if it keeps failing, an operator can see the details on the job.`
  const msg = scrubPaths(raw)
  return (msg || 'Something went wrong while running this job.').slice(0, 500)
}

/**
 * A stored job error as people see it. Jobs that failed before these rules (9c00d17, R4-A) still hold the tool's own
 * output and server paths, so the same rules apply when they are read.
 */
export function shownJobError(kind: string, stored: string): string {
  return isToolOutput(stored) ? publicJobError(kind, new Error(stored)) : scrubPaths(stored)
}

/** A stored clip error as people see it: the processing sentence for a tool's output, never a server path. */
export function shownAssetError(stored: string): string {
  return isToolOutput(stored) ? friendlyProcessingError(new Error(stored)) : scrubPaths(stored)
}

/** The raw error for operators (the job's error_detail): the message and, when there is one, the stack. */
export function rawJobError(err: unknown): string {
  if (err instanceof Error) return (err.stack && err.stack.includes(err.message) ? err.stack : `${err.message}\n${err.stack ?? ''}`).slice(0, 8000)
  return String(err).slice(0, 8000)
}
