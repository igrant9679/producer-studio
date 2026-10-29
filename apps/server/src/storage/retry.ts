// Retries for storage calls that failed in passing (P-21): a reset connection, a bucket that said "slow down" or
// answered 500/503. Anything else (a 404, a refused key, a full disk) fails at once: trying again can't help.
import { log } from '../log'
import { BUSY, UNREACHABLE, errorCodes, storageStatus } from './errors'

/** Tries per call and the first wait; each wait is four times the one before, with jitter. Tests shorten them. */
export const STORAGE_RETRY = { attempts: 4, baseMs: 250 }

const TIMEOUTS = new Set(['TimeoutError', 'RequestTimeout', 'ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT'])

/** Whether trying the same call again may work. A timeout is retried once: a bucket that stays silent stays silent. */
export function isTransientStorageError(err: unknown, attempt = 1): boolean {
  const codes = errorCodes(err)
  if (codes.some((c) => TIMEOUTS.has(c))) return attempt < 2
  if (codes.some((c) => UNREACHABLE.has(c) || BUSY.has(c) || c === 'EBUSY' || c === 'EAGAIN' || c === 'EMFILE')) return true
  const status = storageStatus(err)
  return status !== undefined && (status >= 500 || status === 429)
}

/** Wait before try `attempt + 1` (1-based): base, 4×base, 16×base…, ±25%. */
export function backoffMs(attempt: number, baseMs = STORAGE_RETRY.baseMs): number {
  const d = baseMs * 4 ** (attempt - 1)
  return Math.round(d * (0.75 + Math.random() * 0.5))
}

/**
 * Run `fn` again after a passing failure. `fn` must make its request from scratch each time (a fresh file stream for
 * an upload), since a body already sent can't be sent again.
 */
export async function withRetry<T>(what: string, fn: () => Promise<T>, opts: { attempts?: number; signal?: AbortSignal } = {}): Promise<T> {
  const attempts = opts.attempts ?? STORAGE_RETRY.attempts
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn()
    } catch (err) {
      if (attempt >= attempts || opts.signal?.aborted || !isTransientStorageError(err, attempt)) throw err
      const wait = backoffMs(attempt)
      log.warn('storage call failed in passing; trying again', { what, attempt, waitMs: wait, err })
      await new Promise((r) => setTimeout(r, wait))
    }
  }
}
