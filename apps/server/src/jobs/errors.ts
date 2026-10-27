// What people see when a job fails (GET /api/jobs, live updates): a sentence without server paths or internals.
// The raw error stays in the server log.
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

export function publicJobError(kind: string, err: unknown): string {
  const e = err as { $metadata?: unknown; Code?: unknown }
  if (e && typeof e === 'object' && ('$metadata' in e || 'Code' in e)) return describeStorageError(err)
  // the clip shows the same sentence (media/process.ts)
  if (kind === 'asset.process') return friendlyProcessingError(err)
  const msg = scrubPaths(err instanceof Error ? err.message : String(err))
  return (msg || 'Something went wrong while running this job.').slice(0, 500)
}
