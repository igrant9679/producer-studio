// What a storage error is: its codes and HTTP status, whether it means "not there", and whether it came from storage
// at all. (describeStorageError in services/storage-health turns one into words.)

type StorageErr = { name?: string; Code?: string; code?: string; message?: string; cause?: unknown; $metadata?: { httpStatusCode?: number } }

/** The codes an error carries, most specific first: the S3 error code, the system error (ECONNREFUSED, ENOSPC…),
 * the one it wraps (a fetch failure's cause), then its class name (TimeoutError). A plain Error's name says nothing. */
export function errorCodes(err: unknown): string[] {
  const codes: string[] = []
  for (let e = err as StorageErr | undefined, depth = 0; e && typeof e === 'object' && depth < 3; e = e.cause as StorageErr | undefined, depth++) {
    for (const c of [e.Code, e.code]) if (typeof c === 'string' && c) codes.push(c)
    if (e.name && e.name !== 'Error' && e.name !== 'TypeError') codes.push(e.name)
  }
  return codes
}

/** HTTP status of an S3 error (or of an error it wraps). */
export function storageStatus(err: unknown): number | undefined {
  for (let e = err as StorageErr | undefined, depth = 0; e && typeof e === 'object' && depth < 3; e = e.cause as StorageErr | undefined, depth++)
    if (e.$metadata?.httpStatusCode) return e.$metadata.httpStatusCode
  return undefined
}

export const UNREACHABLE = new Set(['ENOTFOUND', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH', 'EPIPE', 'TimeoutError', 'RequestTimeout', 'NetworkingError', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET'])
export const BUSY = new Set(['SlowDown', 'ServiceUnavailable', 'InternalError', 'RequestTimeTooSkewed'])

/** An error from the storage service or the way to it (as opposed to, say, ffmpeg's). */
export function isStorageError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false
  if ('$metadata' in err || (err as StorageErr).Code) return true
  return errorCodes(err).some((c) => UNREACHABLE.has(c) || BUSY.has(c))
}

/** Only a real 404 means an object isn't there; anything else (no access, no network) is an error to report. */
export function isStorageNotFound(err: unknown): boolean {
  const codes = errorCodes(err)
  if (codes.includes('NoSuchBucket')) return false
  return storageStatus(err) === 404 || codes.includes('NoSuchKey') || codes.includes('NotFound') || codes.includes('ENOENT') || codes.includes('ENOTDIR')
}
