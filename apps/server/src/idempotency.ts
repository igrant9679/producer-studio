// Idempotency keys (P-14). A POST sent with `Idempotency-Key: <key>` by a signed-in person runs once: the same key
// again (a retry after a dropped connection, a double click) answers with the first request's response, marked
// `Idempotent-Replayed: true`, instead of starting a second export or voiceover. While the first is still running the
// retry gets 409; the same key on a different request gets 422. Only successful answers are kept (a refusal or a
// failure can be retried with the same key), for a day.
import crypto from 'node:crypto'
import type { MiddlewareHandler } from 'hono'
import { and, eq, lt } from 'drizzle-orm'
import type { AppEnv } from './auth'
import { ctx } from './context'
import { idempotencyKeys } from './db/schema'
import { HttpError } from './http'
import { log } from './log'

export const IDEMPOTENCY_TTL_MS = 24 * 3600_000
/** Answers larger than this aren't kept (job and record JSON is a few KB). */
const MAX_KEPT_BYTES = 1024 * 1024
const SWEEP_EVERY_MS = 10 * 60_000
let lastSweep = 0

const KEY_RE = /^[\x21-\x7e]{1,200}$/

export const idempotency: MiddlewareHandler<AppEnv> = async (c, next) => {
  const key = c.req.header('idempotency-key')
  const user = c.get('user')
  if (c.req.method !== 'POST' || !key || !user) return next()
  if (!KEY_RE.test(key)) throw new HttpError(400, 'invalid', 'Idempotency-Key must be 1 to 200 visible characters')
  const db = ctx().db
  const now = Date.now()
  if (now - lastSweep > SWEEP_EVERY_MS) {
    lastSweep = now
    void db.delete(idempotencyKeys).where(lt(idempotencyKeys.createdAt, now - IDEMPOTENCY_TTL_MS)).catch((err) => log.warn('idempotency sweep failed', { err }))
  }
  const path = c.req.path
  const bodyHash = crypto.createHash('sha256').update(new Uint8Array(await c.req.raw.clone().arrayBuffer())).digest('hex')
  const mine = and(eq(idempotencyKeys.userId, user.id), eq(idempotencyKeys.key, key))
  // an expired claim doesn't hold the key
  await db.delete(idempotencyKeys).where(and(mine, lt(idempotencyKeys.createdAt, now - IDEMPOTENCY_TTL_MS)))
  const claimed = await db.insert(idempotencyKeys).values({ userId: user.id, key, method: c.req.method, path, bodyHash, createdAt: now }).onConflictDoNothing().returning({ key: idempotencyKeys.key })
  if (!claimed.length) {
    const prev = (await db.select().from(idempotencyKeys).where(mine).limit(1))[0]
    if (!prev) throw new HttpError(409, 'conflict', 'The same request was just handled. Try again.')
    if (prev.method !== c.req.method || prev.path !== path || prev.bodyHash !== bodyHash) throw new HttpError(422, 'invalid', 'This Idempotency-Key was already used for a different request')
    if (prev.status == null) throw new HttpError(409, 'conflict', 'The same request is still being handled. Try again in a moment.')
    return new Response(prev.response ?? '', { status: prev.status, headers: { 'content-type': prev.contentType ?? 'application/json', 'idempotent-replayed': 'true' } })
  }
  let kept = false
  try {
    await next()
    const res = c.res
    const type = res.headers.get('content-type') ?? ''
    if (res.status < 400 && !type.includes('text/event-stream')) {
      const text = await res.clone().text()
      if (text.length <= MAX_KEPT_BYTES) {
        await db.update(idempotencyKeys).set({ status: res.status, response: text, contentType: type || null }).where(mine)
        kept = true
      }
    }
  } finally {
    // refused, failed, streamed or too big: the key is free for the retry
    if (!kept) await db.delete(idempotencyKeys).where(mine).catch(() => undefined)
  }
}
