// Base versions for small records (P-14): an update route answers with an `ETag` fingerprinting the editable state
// of what it changes (an asset's name and transcript, a brand kit, a workspace's name), and a client
// that sends it back as `If-Match` gets 412 instead of overwriting a change made since it read the record. Without
// If-Match (desktops, older clients) the write goes through as before.
import crypto from 'node:crypto'
import type { Context } from 'hono'
import { HttpError } from './http'

/** Sorted-key JSON: a record read back from Postgres (jsonb reorders keys) fingerprints like the one written. */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map((x) => (x === undefined ? 'null' : canonical(x))).join(',')}]`
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>
    return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(',')}}`
  }
  return JSON.stringify(v ?? null)
}

export function etagOf(value: unknown): string {
  return `"${crypto.createHash('sha256').update(canonical(value)).digest('base64url').slice(0, 22)}"`
}

/** 412 when the request carries an If-Match that isn't the record's current ETag. */
export function checkIfMatch(c: Context, current: unknown, what = 'This'): void {
  const want = c.req.header('if-match')
  if (!want || want.trim() === '*') return
  const tag = etagOf(current)
  const sent = want.split(',').map((s) => s.trim().replace(/^W\//, ''))
  if (!sent.includes(tag)) throw new HttpError(412, 'conflict', `${what} was changed by someone else since you opened it. Reload to see the latest, then make your change again.`, { etag: tag })
}

/** Set the ETag of what a route returns. */
export function setEtag(c: Context, value: unknown): string {
  const tag = etagOf(value)
  c.header('ETag', tag)
  return tag
}
