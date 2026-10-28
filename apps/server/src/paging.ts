// Cursor paging for the list routes: `?limit=` (default 200, at most 500) and `?cursor=` (the previous page's
// `nextCursor`, opaque to clients). Lists run newest first by a timestamp, the id breaking ties, so a page starts
// exactly where the last one ended (keyset: no offsets, nothing skipped or repeated while rows are only added).
import type { Context } from 'hono'
import { type SQL, and, desc, eq, lt, or } from 'drizzle-orm'
import type { AnyPgColumn } from 'drizzle-orm/pg-core'
import type { Page } from '@producer/core'
import { HttpError } from './http'

export const DEFAULT_PAGE = 200
export const MAX_PAGE = 500

interface After {
  t: number
  id: string
}

export function encodeCursor(t: number, id: string): string {
  return Buffer.from(JSON.stringify([t, id])).toString('base64url')
}

function decodeCursor(raw: string): After {
  try {
    const v = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as unknown
    if (Array.isArray(v) && v.length === 2 && typeof v[0] === 'number' && Number.isFinite(v[0]) && typeof v[1] === 'string' && v[1].length <= 200) return { t: v[0], id: v[1] }
  } catch {
    /* below */
  }
  throw new HttpError(400, 'invalid', 'That cursor isn’t one this list gave out')
}

/** The page asked for: how many, and after which row. */
export function pageQuery(c: Context): { limit: number; after?: After } {
  const n = Number(c.req.query('limit') ?? DEFAULT_PAGE)
  const limit = Math.min(MAX_PAGE, Math.max(1, Number.isFinite(n) ? Math.floor(n) : DEFAULT_PAGE))
  const cursor = c.req.query('cursor')
  return { limit, ...(cursor ? { after: decodeCursor(cursor) } : {}) }
}

/** Rows after the cursor, in list order (newest first). */
export function afterCursor(ts: AnyPgColumn, id: AnyPgColumn, after: After | undefined): SQL | undefined {
  if (!after) return undefined
  return or(lt(ts, after.t), and(eq(ts, after.t), lt(id, after.id)))
}

export const pageOrder = (ts: AnyPgColumn, id: AnyPgColumn) => [desc(ts), desc(id)]

/** Rows fetched with `limit + 1` into a page; the extra row only says that there is more. */
export function toPage<R, T>(rows: R[], limit: number, key: (r: R) => [number, string], map: (r: R) => T): Page<T> {
  const items = rows.slice(0, limit)
  const last = items[items.length - 1]
  return { items: items.map(map), ...(rows.length > limit && last ? { nextCursor: encodeCursor(...key(last)) } : {}) }
}
