// Account tokens (P-22) and deleting an account (A-17).
//
// A reset or email-confirmation token is 32 random bytes that only ever travel in the mail; the database keeps their
// sha256. Each is single use (claimed by one conditional UPDATE), expires (reset 1 hour, confirmations 24 hours),
// and a new one cancels the earlier ones of the same kind. Sending is rate limited from the table itself, so the
// limit holds across server replicas: a few per account per hour, and a few dozen per client address.
import { and, eq, gt, isNull, sql } from 'drizzle-orm'
import { RESET_TTL_MS, VERIFY_TTL_MS } from '@producer/core'
import { ctx } from '../context'
import { authTokens, memberships, users, workspaces } from '../db/schema'
import { HttpError } from '../http'
import { randomToken, sha256 } from '../ids'
import { purgeWorkspace } from '../routes/workspaces'

export type TokenPurpose = 'reset' | 'verify' | 'email'

/** Mails of one kind one account can be sent in an hour; and account mails one client address can ask for. */
export const TOKENS_PER_HOUR = 3
export const TOKENS_PER_IP_PER_HOUR = 20

const HOUR = 3600_000
const ttl = (p: TokenPurpose) => (p === 'reset' ? RESET_TTL_MS : VERIFY_TTL_MS)

async function count(where: ReturnType<typeof and>): Promise<number> {
  const [r] = await ctx().db.select({ n: sql<number>`count(*)::int` }).from(authTokens).where(where)
  return Number(r?.n ?? 0)
}

/** Too many account mails asked for from this address in the last hour: 429 (said whether or not the account exists). */
export async function checkTokenIpRate(ip: string) {
  // 'unknown': no socket address to count by (only in-process requests); the per-account limit still holds
  if (ctx().config.mode !== 'cloud' || ip === 'unknown') return
  if ((await count(and(eq(authTokens.ip, ip), gt(authTokens.createdAt, Date.now() - HOUR)))) >= TOKENS_PER_IP_PER_HOUR)
    throw new HttpError(429, 'quota', 'Too many requests from this network. Try again in an hour.')
}

/**
 * A new token for `purpose`, cancelling that account's earlier unused ones; null when the account already had
 * TOKENS_PER_HOUR of this kind in the last hour (the caller sends nothing, and says the same as when it sends).
 */
export async function issueToken(userId: string, purpose: TokenPurpose, email: string, ip: string | null): Promise<string | null> {
  const now = Date.now()
  if ((await count(and(eq(authTokens.userId, userId), eq(authTokens.purpose, purpose), gt(authTokens.createdAt, now - HOUR)))) >= TOKENS_PER_HOUR) return null
  const db = ctx().db
  await db.update(authTokens).set({ usedAt: now }).where(and(eq(authTokens.userId, userId), eq(authTokens.purpose, purpose), isNull(authTokens.usedAt)))
  const token = randomToken(32)
  await db.insert(authTokens).values({ id: sha256(token), userId, purpose, email: email.toLowerCase(), ip, createdAt: now, expiresAt: now + ttl(purpose) })
  return token
}

type TokenRow = typeof authTokens.$inferSelect

function check(row: TokenRow | undefined, purposes: TokenPurpose[]): TokenRow {
  if (!row || !purposes.includes(row.purpose as TokenPurpose)) throw new HttpError(404, 'not_found', 'This link doesn’t work. It may be mistyped.')
  if (row.usedAt) throw new HttpError(410, 'conflict', 'This link was already used, or a newer one was sent. Ask for a new one.')
  if (row.expiresAt <= Date.now()) throw new HttpError(410, 'conflict', 'This link has expired. Ask for a new one.')
  return row
}

/** Look at a token without using it (the reset page shows whose password it changes). */
export async function peekToken(token: string, purposes: TokenPurpose[]): Promise<TokenRow> {
  const row = (await ctx().db.select().from(authTokens).where(eq(authTokens.id, sha256(token))).limit(1))[0]
  return check(row, purposes)
}

/** Use a token: exactly once, even when two requests race with it. */
export async function consumeToken(token: string, purposes: TokenPurpose[]): Promise<TokenRow> {
  const row = await peekToken(token, purposes)
  const claimed = await ctx()
    .db.update(authTokens)
    .set({ usedAt: Date.now() })
    .where(and(eq(authTokens.id, row.id), isNull(authTokens.usedAt), gt(authTokens.expiresAt, Date.now())))
    .returning()
  if (!claimed[0]) throw new HttpError(410, 'conflict', 'This link was already used, or a newer one was sent. Ask for a new one.')
  return claimed[0]
}

/** The unconfirmed new address an account is waiting on, if any. */
export async function pendingEmail(userId: string): Promise<string | undefined> {
  const row = (
    await ctx()
      .db.select({ email: authTokens.email })
      .from(authTokens)
      .where(and(eq(authTokens.userId, userId), eq(authTokens.purpose, 'email'), isNull(authTokens.usedAt), gt(authTokens.expiresAt, Date.now())))
      .limit(1)
  )[0]
  return row?.email
}

interface SpacePlan {
  /** Spaces only they are in (and their personal space): deleted with the account. */
  purge: string[]
  /** Spaces they are the only owner of while other people are members: the account can't go until handed over. */
  blocked: Array<{ id: string; name: string }>
}

export async function planAccountDelete(userId: string): Promise<SpacePlan> {
  const db = ctx().db
  const mine = await db
    .select({ id: workspaces.id, name: workspaces.name, role: memberships.role })
    .from(memberships)
    .innerJoin(workspaces, eq(workspaces.id, memberships.workspaceId))
    .where(eq(memberships.userId, userId))
  const plan: SpacePlan = { purge: [], blocked: [] }
  for (const w of mine) {
    const people = await db.select({ userId: memberships.userId, role: memberships.role }).from(memberships).where(eq(memberships.workspaceId, w.id))
    const others = people.filter((p) => p.userId !== userId)
    if (!others.length) plan.purge.push(w.id)
    else if (w.role === 'owner' && !others.some((p) => p.role === 'owner')) plan.blocked.push({ id: w.id, name: w.name })
  }
  return plan
}

/**
 * Delete an account: refused while they are the only owner of a space others are in. Spaces only they are in go with
 * it (projects, media and all); in other spaces their work stays and they simply leave. Sessions, app links,
 * preferences and tokens cascade with the user row.
 */
export async function deleteAccount(userId: string): Promise<void> {
  const plan = await planAccountDelete(userId)
  if (plan.blocked.length)
    throw new HttpError(
      409,
      'conflict',
      `You’re the only owner of ${plan.blocked.map((b) => `“${b.name}”`).join(', ')}. Make someone else an owner (or remove the others) first.`,
      { spaces: plan.blocked },
    )
  for (const id of plan.purge) await purgeWorkspace(id)
  await ctx().db.delete(users).where(eq(users.id, userId))
  ctx().bus.accessChanged(userId)
}
