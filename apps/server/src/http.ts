// HTTP helpers: typed API errors, JSON body validation, workspace access checks.
import type { Context } from 'hono'
import type { ApiError, Role } from '@producer/core'
import { and, eq } from 'drizzle-orm'
import type { z } from 'zod/v4'
import { ctx } from './context'
import { memberships } from './db/schema'

export class HttpError extends Error {
  constructor(
    public status: number,
    public code: NonNullable<ApiError['code']>,
    message: string,
    public details?: unknown,
  ) {
    super(message)
  }
}

export const notFound = (what = 'Not found') => new HttpError(404, 'not_found', what)
export const forbidden = (msg = 'You do not have access to this') => new HttpError(403, 'forbidden', msg)
export const invalid = (msg: string, details?: unknown) => new HttpError(400, 'invalid', msg, details)
export const unauthorized = () => new HttpError(401, 'unauthorized', 'Sign in required')

export async function body<T extends z.ZodType>(c: Context, schema: T): Promise<z.infer<T>> {
  let raw: unknown
  try {
    raw = await c.req.json()
  } catch {
    raw = undefined
  }
  const r = schema.safeParse(raw ?? {})
  if (!r.success) {
    const first = r.error.issues[0]
    throw invalid(first ? `${first.path.join('.') || 'body'}: ${first.message}` : 'Invalid request body', r.error.issues)
  }
  return r.data
}

const RANK: Record<Role, number> = { viewer: 1, editor: 2, owner: 3 }

export function roleAtLeast(role: Role, min: Role): boolean {
  return RANK[role] >= RANK[min]
}

/** Membership role of a user in a workspace, or null. */
export async function memberRole(userId: string, workspaceId: string): Promise<Role | null> {
  const rows = await ctx()
    .db.select({ role: memberships.role })
    .from(memberships)
    .where(and(eq(memberships.userId, userId), eq(memberships.workspaceId, workspaceId)))
    .limit(1)
  return (rows[0]?.role as Role | undefined) ?? null
}

/**
 * Throw unless the user is a member with at least `min` role. Non-members get 404 (don't reveal existence);
 * members below the role get 403.
 */
export async function requireRole(userId: string, workspaceId: string, min: Role = 'viewer'): Promise<Role> {
  const role = await memberRole(userId, workspaceId)
  if (!role) throw notFound()
  if (!roleAtLeast(role, min)) throw forbidden(min === 'editor' ? 'Viewers cannot make changes in this workspace' : 'Only workspace owners can do that')
  return role
}
