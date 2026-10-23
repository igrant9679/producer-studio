// Can this server actually use its object storage? (Added 23 Oct 2026.)
//
// Signed media URLs are computed locally from the access key, so signing never fails — a revoked or rotated
// key only shows up as a 403 in the browser: black thumbnails, refused uploads, clips that "process" forever.
// Railway rotated every bucket credential on 21 Oct 2026 and this server kept running on the old key for days
// with nothing anywhere saying so. This writes, reads and deletes a tiny object on start and every few
// minutes, keeps the outcome, and puts it in /api/health and /api/system so the editor can say so.
//
// It never fails the health check (that stays about the database): Railway gates deploys on /api/health, and
// the deploy that picks up new credentials must not be blocked by the old ones being bad.
import type { StorageHealth } from '@producer/core'
import { ctx } from '../context'
import { log } from '../log'

let state: StorageHealth = { status: 'unknown' }
let timer: NodeJS.Timeout | undefined

export function storageHealth(): StorageHealth {
  return state
}

/** Translate an S3 / filesystem error into what to do about it. */
export function describeStorageError(err: unknown): string {
  const e = err as { name?: string; Code?: string; code?: string; message?: string; $metadata?: { httpStatusCode?: number } }
  const code = e?.Code ?? e?.name ?? e?.code ?? ''
  const status = e?.$metadata?.httpStatusCode
  switch (code) {
    case 'InvalidAccessKeyId':
      return "The storage bucket doesn't recognise this server's access key (InvalidAccessKeyId) — the credentials were rotated or revoked. Redeploy so the service picks up the bucket's current credentials, or update S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY."
    case 'SignatureDoesNotMatch':
      return "The storage bucket rejected this server's secret key (SignatureDoesNotMatch) — S3_SECRET_ACCESS_KEY doesn't belong to S3_ACCESS_KEY_ID. Redeploy with the bucket's current credentials."
    case 'AccessDenied':
    case 'Forbidden':
      return "The storage bucket refused this server's credentials (AccessDenied) — the key has no access to this bucket, or was revoked. Check the bucket's credentials and redeploy."
    case 'NoSuchBucket':
      return 'The storage bucket named in S3_BUCKET does not exist.'
    case 'ENOTFOUND':
    case 'ECONNREFUSED':
    case 'ETIMEDOUT':
    case 'EAI_AGAIN':
      return `The storage endpoint can't be reached (${code}) — check S3_ENDPOINT.`
    case 'EACCES':
    case 'EPERM':
    case 'ENOSPC':
      return `Local storage can't be written (${code}).`
  }
  if (status === 403) return "The storage bucket refused this server's credentials (403) — they were rotated or revoked. Redeploy with the bucket's current credentials."
  return `Storage check failed: ${(e?.message ?? String(err)).slice(0, 300)}`
}

/** Write, read back and delete one small object. */
export async function checkStorage(): Promise<StorageHealth> {
  const storage = ctx().storage
  const key = `_health/${ctx().instanceId}.txt`
  const checkedAt = Date.now()
  try {
    await storage.put(key, Buffer.from(`storage check ${new Date(checkedAt).toISOString()}\n`), { contentType: 'text/plain' })
    const st = await storage.stat(key)
    if (!st) throw new Error('A test file was written but could not be read back')
    await storage.delete(key)
    if (state.status === 'error') log.info('storage reachable again', { kind: storage.kind })
    state = { status: 'ok', checkedAt }
  } catch (err) {
    const error = describeStorageError(err)
    if (state.status !== 'error' || state.error !== error) log.error('storage check failed', { kind: storage.kind, error, err })
    state = { status: 'error', error, checkedAt }
  }
  return state
}

export function startStorageMonitor(everyMs = 5 * 60_000) {
  if (timer) return
  void checkStorage()
  timer = setInterval(() => void checkStorage(), everyMs)
  timer.unref()
}

export function stopStorageMonitor() {
  if (timer) clearInterval(timer)
  timer = undefined
}
