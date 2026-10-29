// Resumable multipart uploads (P-5). A big file is sent in parts, each to its own URL that takes exactly that part's
// bytes (S3: the length is signed into the presigned URL; local storage: the server counts), in any order and again
// after a drop. The upload session (v17 upload_sessions) remembers which storage upload holds the parts, so a client
// that comes back with the same asset id (the browser keeps it, the desktop has it) sends only what's missing.
import { eq, lt } from 'drizzle-orm'
import type { MultipartPlan, UploadPartUrl } from '@producer/core'
import { ctx } from '../context'
import { assets, uploadSessions } from '../db/schema'
import { HttpError, invalid } from '../http'
import { log } from '../log'
import type { AssetRow } from './assets'

export type UploadSession = typeof uploadSessions.$inferSelect

const MB = 1024 * 1024
/** S3's smallest part (but the last) is 5 MB; parts of 16 MB keep a 1 GB file at 64 requests. */
export const MULTIPART_MIN_PART = 16 * MB
/** S3 allows 10,000 parts per upload. */
export const MULTIPART_MAX_PARTS = 10_000
/** One PUT to S3 takes at most 5 GB: bigger files have to be sent in parts. */
export const SINGLE_PUT_MAX = 5 * 1024 ** 3
/** An upload nobody has added to for this long is given up on and its parts removed. */
export const UPLOAD_SESSION_MAX_IDLE_MS = 7 * 24 * 3600_000

/** How a file of `size` bytes is cut: whole megabytes, at least 16 MB, few enough for S3's 10,000 parts. */
export function partPlan(size: number): { partSize: number; partCount: number } {
  const partSize = Math.max(MULTIPART_MIN_PART, Math.ceil(size / MULTIPART_MAX_PARTS / MB) * MB)
  return { partSize, partCount: Math.max(1, Math.ceil(size / partSize)) }
}

/** Bytes in part `n` (1-based). */
export function partBytes(s: Pick<UploadSession, 'size' | 'partSize'>, n: number): number {
  const count = Math.max(1, Math.ceil(s.size / s.partSize))
  if (n < 1 || n > count) return 0
  return n < count ? s.partSize : s.size - s.partSize * (count - 1)
}

export async function sessionOf(assetId: string): Promise<UploadSession | undefined> {
  return (await ctx().db.select().from(uploadSessions).where(eq(uploadSessions.assetId, assetId)).limit(1))[0]
}

/**
 * The session for an upload of `row` (`size` bytes): the one already there when it is for the same file and its
 * parts are still in storage (a resume), else a new one (any old one is aborted).
 */
export async function openSession(row: Pick<AssetRow, 'id' | 'sourceKey' | 'mime'>, size: number): Promise<{ session: UploadSession; done: number[] }> {
  const storage = ctx().storage
  const old = await sessionOf(row.id)
  if (old && old.size === size && old.key === row.sourceKey) {
    const parts = await storage.listParts(old.key, old.uploadId).catch(() => undefined)
    if (parts) {
      const [touched] = await ctx().db.update(uploadSessions).set({ updatedAt: Date.now() }).where(eq(uploadSessions.assetId, row.id)).returning()
      return { session: touched ?? old, done: parts.filter((p) => p.size === partBytes(old, p.partNumber)).map((p) => p.partNumber) }
    }
  }
  if (old) await dropSession(old)
  const { partSize } = partPlan(size)
  const uploadId = await storage.createMultipart(row.sourceKey, row.mime)
  const now = Date.now()
  const [session] = await ctx()
    .db.insert(uploadSessions)
    .values({ assetId: row.id, key: row.sourceKey, uploadId, partSize, size, createdAt: now, updatedAt: now })
    .onConflictDoUpdate({ target: uploadSessions.assetId, set: { key: row.sourceKey, uploadId, partSize, size, createdAt: now, updatedAt: now } })
    .returning()
  return { session, done: [] }
}

export function planOf(s: UploadSession, done: number[]): MultipartPlan {
  return { size: s.size, partSize: s.partSize, partCount: Math.max(1, Math.ceil(s.size / s.partSize)), done }
}

/** Which parts are in storage (sized right), for a client resuming. */
export async function uploadedParts(s: UploadSession): Promise<number[]> {
  const parts = await ctx().storage.listParts(s.key, s.uploadId)
  return parts.filter((p) => p.size === partBytes(s, p.partNumber)).map((p) => p.partNumber)
}

/** URLs for `numbers`, each taking exactly its part's bytes. Asking for parts keeps the upload alive. */
export async function partUrls(s: UploadSession, numbers: number[]): Promise<UploadPartUrl[]> {
  const storage = ctx().storage
  const count = Math.ceil(s.size / s.partSize)
  const out: UploadPartUrl[] = []
  for (const n of [...new Set(numbers)]) {
    if (!Number.isInteger(n) || n < 1 || n > count) throw invalid(`There is no part ${n}: this upload has ${count}`)
    const size = partBytes(s, n)
    out.push(
      storage.presignPart
        ? { partNumber: n, size, url: await storage.presignPart(s.key, s.uploadId, n, size), headers: {} }
        : { partNumber: n, size, url: `/api/uploads/${encodeURIComponent(s.assetId)}/parts/${n}`, headers: { 'content-type': 'application/octet-stream' } },
    )
  }
  const now = Date.now()
  await ctx().db.update(uploadSessions).set({ updatedAt: now }).where(eq(uploadSessions.assetId, s.assetId))
  // the abandoned-upload sweep goes by the clip's last change: a long upload still sending parts isn't abandoned
  await ctx().db.update(assets).set({ updatedAt: now }).where(eq(assets.id, s.assetId))
  return out
}

/** Join the parts into the clip's file. Refuses (409, naming what's missing) until every part has arrived. */
export async function finishSession(s: UploadSession): Promise<void> {
  const storage = ctx().storage
  const parts = await storage.listParts(s.key, s.uploadId)
  const count = Math.ceil(s.size / s.partSize)
  const have = new Map(parts.map((p) => [p.partNumber, p]))
  const missing: number[] = []
  for (let n = 1; n <= count; n++) if (have.get(n)?.size !== partBytes(s, n)) missing.push(n)
  if (missing.length)
    throw new HttpError(409, 'conflict', `The upload isn't complete: ${missing.length} of ${count} parts still have to be sent`, { missingParts: missing.slice(0, 1000) })
  await storage.completeMultipart(s.key, s.uploadId, [...have.values()].filter((p) => p.partNumber <= count).sort((a, b) => a.partNumber - b.partNumber))
  await ctx().db.delete(uploadSessions).where(eq(uploadSessions.assetId, s.assetId))
}

/** Give an upload up: its parts leave storage. */
export async function dropSession(s: UploadSession): Promise<void> {
  await ctx()
    .storage.abortMultipart(s.key, s.uploadId)
    .catch((err) => log.warn('could not abort an upload in storage', { assetId: s.assetId, err }))
  await ctx().db.delete(uploadSessions).where(eq(uploadSessions.assetId, s.assetId))
}

/** Uploads nobody has added to for a week: their parts go (the clip already says the upload didn't finish). */
export async function sweepUploadSessions(now = Date.now()): Promise<number> {
  const old = await ctx().db.select().from(uploadSessions).where(lt(uploadSessions.updatedAt, now - UPLOAD_SESSION_MAX_IDLE_MS)).limit(200)
  for (const s of old) await dropSession(s)
  return old.length
}
