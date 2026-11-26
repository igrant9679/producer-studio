// Memberships bought on a membership website (meyousocial.com, WordPress + MemberPress) for a Producer Studio space,
// and the provisioning that keeps them in step (routes/provision.ts; the contract is docs/integrations/meyousocial.md).
//
//   The website signs every call with PROVISION_SECRET (HMAC-SHA256 over "<timestamp>.<body>", ±5 minutes, each
//   signature once). A signup creates the space (and the account, when the email has none) and returns a one-time
//   sign-in link the website sends its member to; a status or plan change updates the membership; a "claim" (made in
//   the app by a space's owner, carried through the website's checkout) puts a membership on a space that already exists.
//
// What a membership gives a space (applyMembership): while active, the server's own AI key (it can't be turned on by
// the owner otherwise once a membership has ended) and its seats (members + pending invites). Nothing is ever deleted
// when a membership ends: the space stays, readable and exportable. Spaces with no membership are as before.
import crypto from 'node:crypto'
import { and, eq, isNull, sql } from 'drizzle-orm'
import type { Workspace } from '@producer/core'
import { ctx } from '../context'
import { invites, memberships, users, workspacePlans, workspaces } from '../db/schema'
import { HttpError } from '../http'
import { newId } from '../ids'
import { issueToken } from './account'

export type PlanRow = typeof workspacePlans.$inferSelect

export const MEMBERSHIP_STATUSES = ['active', 'past_due', 'paused', 'cancelled', 'expired'] as const
export type MembershipStatus = (typeof MEMBERSHIP_STATUSES)[number]

/** How far a signed call's timestamp may be from this server's clock. */
export const SIGNATURE_WINDOW_MS = 5 * 60_000
/** A claim link from the app lasts this long (time to go through the website's checkout). */
export const CLAIM_TTL_MS = 7 * 24 * 3600_000
/** A password hash nobody can sign in with: an account the website made, until its person chooses a password. */
export const UNSET_PASSWORD_PREFIX = 'unset$'

export const provisioningOn = () => !!ctx().config.provisionSecret

const hmac = (key: string, data: string) => crypto.createHmac('sha256', key).update(data).digest()
const b64url = (b: Buffer) => b.toString('base64url')

// ---------------- signed calls from the website ----------------

/** Signatures already used within the window (a replayed call is refused). One process serves the API. */
const seen = new Map<string, number>()

/**
 * Check a provisioning call's signature: `X-PS-Timestamp` (milliseconds or seconds since 1970) and
 * `X-PS-Signature: sha256=<hex HMAC-SHA256 of "<timestamp>.<raw body>">`. Throws 401 with the reason.
 */
export function verifySignature(o: { timestamp?: string | null; signature?: string | null; body: string; now?: number }): void {
  const secret = ctx().config.provisionSecret
  if (!secret) throw new HttpError(404, 'not_found', 'Provisioning isn’t set up on this server (PROVISION_SECRET).')
  const now = o.now ?? Date.now()
  const ts = Number(o.timestamp)
  if (!o.timestamp || !Number.isFinite(ts)) throw new HttpError(401, 'unauthorized', 'Missing X-PS-Timestamp')
  const ms = ts < 1e12 ? ts * 1000 : ts
  if (Math.abs(now - ms) > SIGNATURE_WINDOW_MS) throw new HttpError(401, 'unauthorized', 'X-PS-Timestamp is more than 5 minutes from the server’s clock')
  const m = /^sha256=([0-9a-f]{64})$/i.exec(o.signature?.trim() ?? '')
  if (!m) throw new HttpError(401, 'unauthorized', 'Missing or malformed X-PS-Signature (sha256=<hex>)')
  const want = hmac(secret, `${o.timestamp}.${o.body}`)
  const got = Buffer.from(m[1].toLowerCase(), 'hex')
  if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) throw new HttpError(401, 'unauthorized', 'Bad signature')
  for (const [k, at] of seen) if (now - at > 2 * SIGNATURE_WINDOW_MS) seen.delete(k)
  const key = m[1].toLowerCase()
  if (seen.has(key)) throw new HttpError(401, 'unauthorized', 'This signed request was already used')
  seen.set(key, now)
}

/** The headers for a call signed with `secret` (tests; docs show the same in PHP). */
export function signedHeaders(secret: string, body: string, now = Date.now()): Record<string, string> {
  const ts = String(now)
  return { 'x-ps-timestamp': ts, 'x-ps-signature': `sha256=${hmac(secret, `${ts}.${body}`).toString('hex')}` }
}

// ---------------- claims: a space's owner buys a membership for it ----------------

/** A claim for `workspaceId` by its owner `userId`: "v1.<ws>.<user>.<exp>.<sig>" (signed with the provisioning secret). */
export function makeClaim(workspaceId: string, userId: string, now = Date.now()): { token: string; expiresAt: number } {
  const secret = ctx().config.provisionSecret
  if (!secret) throw new HttpError(404, 'not_found', 'Memberships aren’t set up on this server.')
  const exp = now + CLAIM_TTL_MS
  const payload = `v1.${workspaceId}.${userId}.${exp}`
  return { token: `${payload}.${b64url(hmac(secret, `claim.${payload}`))}`, expiresAt: exp }
}

/** The space and owner a claim names, or 400 when it is malformed, forged or expired. */
export function readClaim(token: string, now = Date.now()): { workspaceId: string; userId: string } {
  const secret = ctx().config.provisionSecret
  const parts = token.split('.')
  if (!secret || parts.length !== 5 || parts[0] !== 'v1') throw new HttpError(400, 'invalid', 'That claim isn’t one this server made')
  const [, ws, uid, exp, sig] = parts
  const want = hmac(secret, `claim.v1.${ws}.${uid}.${exp}`)
  const got = Buffer.from(sig, 'base64url')
  if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) throw new HttpError(400, 'invalid', 'That claim isn’t one this server made')
  if (!(Number(exp) > now)) throw new HttpError(400, 'invalid', 'That claim has expired: start again from the space’s settings')
  return { workspaceId: ws, userId: uid }
}

// ---------------- the memberships ----------------

export async function planOf(workspaceId: string): Promise<PlanRow | undefined> {
  return (await ctx().db.select().from(workspacePlans).where(eq(workspacePlans.workspaceId, workspaceId)).limit(1))[0]
}

export async function planByExternal(source: string, externalId: string): Promise<PlanRow | undefined> {
  return (await ctx().db.select().from(workspacePlans).where(and(eq(workspacePlans.source, source), eq(workspacePlans.externalId, externalId))).limit(1))[0]
}

/** What the space gets from its membership: the server's AI key while active (off when it ends). */
async function applyMembership(row: PlanRow, by: string): Promise<void> {
  const { setBuiltinAi } = await import('./metering')
  await setBuiltinAi(row.workspaceId, row.status === 'active', by)
}

/** A space whose membership has ended may not turn the server's AI key back on (null: it may). */
export async function builtinAiBlocked(workspaceId: string): Promise<string | null> {
  const p = await planOf(workspaceId)
  if (!p || p.status === 'active') return null
  return `This space’s membership has ${p.status === 'past_due' ? 'a payment due' : 'ended'}, so it can’t use the server’s AI until it’s renewed at ${ctx().config.membershipUrl} (its own keys in Settings → AI still work).`
}

/**
 * 409 when adding one more person (a member or an invite) would go past the membership's seats. `accepting`: an invite
 * being accepted already holds its seat, so only the members are counted.
 */
export async function checkSeat(workspaceId: string, o: { accepting?: boolean } = {}): Promise<void> {
  const p = await planOf(workspaceId)
  if (!p?.seats) return
  const db = ctx().db
  const [m] = await db.select({ n: sql<number>`count(*)::int` }).from(memberships).where(eq(memberships.workspaceId, workspaceId))
  if (o.accepting) {
    if (Number(m?.n ?? 0) >= p.seats) throw new HttpError(409, 'conflict', `This space’s membership has ${p.seats} seat${p.seats === 1 ? '' : 's'}, all taken. Ask its owner to add seats at ${ctx().config.membershipUrl}.`)
    return
  }
  const [i] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(invites)
    // pending: not accepted, not revoked, not expired (rows from before v7 expire 7 days after they were made)
    .where(and(eq(invites.workspaceId, workspaceId), isNull(invites.acceptedAt), isNull(invites.revokedAt), sql`coalesce(${invites.expiresAt}, ${invites.createdAt} + ${7 * 24 * 3600_000}) > ${Date.now()}`))
  if (Number(m?.n ?? 0) + Number(i?.n ?? 0) >= p.seats)
    throw new HttpError(409, 'conflict', `This space’s membership has ${p.seats} seat${p.seats === 1 ? '' : 's'}, all taken (members and invitations). Add seats at ${ctx().config.membershipUrl}, or remove someone first.`)
}

export interface ProvisionInput {
  source: string
  externalId: string
  email: string
  name: string
  plan: string
  status: MembershipStatus
  seats?: number | null
  workspaceName?: string
  claim?: string
}

export interface ProvisionResult {
  user: { id: string; email: string; created: boolean; needsPassword: boolean }
  workspace: { id: string; name: string; created: boolean }
  membership: PlanRow
}

/** Signups being made, per membership: a webhook sent twice at once makes one space, not two. One process serves the API. */
const making = new Map<string, Promise<ProvisionResult>>()

/**
 * A membership the website sold: the same space again for an externalId already seen (nothing new is made); the
 * claimed space for a claim; else a new space, for the account with this email or a new account (its personal space,
 * with no usable password until its person chooses one through a sign-in link).
 */
export async function provision(input: ProvisionInput): Promise<ProvisionResult> {
  const key = `${input.source}:${input.externalId}`
  const run = (making.get(key) ?? Promise.resolve()).catch(() => undefined).then(() => provisionOnce(input))
  making.set(key, run)
  try {
    return await run
  } finally {
    if (making.get(key) === run) making.delete(key)
  }
}

async function provisionOnce(input: ProvisionInput): Promise<ProvisionResult> {
  const db = ctx().db
  const email = input.email.trim().toLowerCase()
  const now = Date.now()
  const by = `provision:${input.source}`
  const again = await planByExternal(input.source, input.externalId)
  if (again) {
    const u = (await db.select().from(users).where(eq(users.id, (await ownerOf(again.workspaceId)) ?? '')).limit(1))[0]
    const w = (await db.select().from(workspaces).where(eq(workspaces.id, again.workspaceId)).limit(1))[0]
    return { user: userPart(u, false), workspace: { id: again.workspaceId, name: w?.name ?? '', created: false }, membership: again }
  }
  let userId: string
  let userCreated = false
  let workspaceId: string
  let workspaceName: string
  let workspaceCreated = false
  if (input.claim) {
    const claim = readClaim(input.claim)
    const role = (await db.select({ role: memberships.role }).from(memberships).where(and(eq(memberships.workspaceId, claim.workspaceId), eq(memberships.userId, claim.userId))).limit(1))[0]?.role
    if (role !== 'owner') throw new HttpError(409, 'conflict', 'Whoever made that claim no longer owns the space')
    const held = await planOf(claim.workspaceId)
    if (held && held.status === 'active') throw new HttpError(409, 'conflict', `That space already has an active membership (${held.source} ${held.externalId})`)
    userId = claim.userId
    workspaceId = claim.workspaceId
    workspaceName = (await db.select({ name: workspaces.name }).from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1))[0]?.name ?? ''
  } else {
    const existing = (await db.select().from(users).where(eq(users.email, email)).limit(1))[0]
    if (existing) {
      if (existing.disabledAt) throw new HttpError(409, 'conflict', 'The Producer Studio account with this email is disabled')
      userId = existing.id
      const { createWorkspace } = await import('../routes/workspaces')
      const w: Workspace = await createWorkspace(userId, input.workspaceName?.trim() || `${input.name.trim().split(/\s+/)[0] || 'New'}'s space`)
      workspaceId = w.id
      workspaceName = w.name
    } else {
      const made = await createProvisionedUser(email, input.name, input.workspaceName)
      userId = made.userId
      workspaceId = made.workspaceId
      workspaceName = made.workspaceName
      userCreated = true
    }
    workspaceCreated = true
  }
  const row: PlanRow = { workspaceId, source: input.source, externalId: input.externalId, plan: input.plan, status: input.status, seats: input.seats ?? null, email, createdAt: now, updatedAt: now }
  await db
    .insert(workspacePlans)
    .values(row)
    .onConflictDoUpdate({ target: workspacePlans.workspaceId, set: { source: row.source, externalId: row.externalId, plan: row.plan, status: row.status, seats: row.seats, email: row.email, updatedAt: now } })
  await applyMembership(row, by)
  const u = (await db.select().from(users).where(eq(users.id, userId)).limit(1))[0]
  return { user: userPart(u, userCreated), workspace: { id: workspaceId, name: workspaceName, created: workspaceCreated }, membership: (await planOf(workspaceId))! }
}

/** A plan, status or seats change from the website. 404 for a membership it never provisioned. */
export async function updateMembership(source: string, externalId: string, patch: { plan?: string; status?: MembershipStatus; seats?: number | null; email?: string }): Promise<PlanRow> {
  const row = await planByExternal(source, externalId)
  if (!row) throw new HttpError(404, 'not_found', `No membership ${externalId} from ${source}`)
  const next = { ...(patch.plan ? { plan: patch.plan } : {}), ...(patch.status ? { status: patch.status } : {}), ...(patch.seats !== undefined ? { seats: patch.seats } : {}), ...(patch.email ? { email: patch.email.trim().toLowerCase() } : {}), updatedAt: Date.now() }
  await ctx().db.update(workspacePlans).set(next).where(eq(workspacePlans.workspaceId, row.workspaceId))
  const updated = (await planOf(row.workspaceId))!
  await applyMembership(updated, `provision:${source}`)
  return updated
}

/**
 * A one-time sign-in link for an account (15 minutes; `ws` opens that space), on `base`: the app's address (PUBLIC_URL,
 * else the request's own, as password-reset links are). Null when too many were made this hour.
 */
export async function signInLink(userId: string, workspaceId: string | undefined, base: string): Promise<{ url: string; expiresAt: number } | null> {
  const u = (await ctx().db.select().from(users).where(eq(users.id, userId)).limit(1))[0]
  if (!u) throw new HttpError(404, 'not_found', 'No such account')
  if (u.disabledAt) throw new HttpError(409, 'conflict', 'That account is disabled')
  const token = await issueToken(u.id, 'signin', u.email, null)
  if (!token) return null
  const { SIGNIN_TTL_MS } = await import('./account')
  return { url: `${base.replace(/\/+$/, '')}/link/${token}${workspaceId ? `?ws=${encodeURIComponent(workspaceId)}` : ''}`, expiresAt: Date.now() + SIGNIN_TTL_MS }
}

async function ownerOf(workspaceId: string): Promise<string | undefined> {
  return (await ctx().db.select({ id: memberships.userId }).from(memberships).where(and(eq(memberships.workspaceId, workspaceId), eq(memberships.role, 'owner'))).limit(1))[0]?.id
}

function userPart(u: typeof users.$inferSelect | undefined, created: boolean) {
  return { id: u?.id ?? '', email: u?.email ?? '', created, needsPassword: !!u?.passwordHash.startsWith(UNSET_PASSWORD_PREFIX) }
}

/** A new account for a member (no usable password yet) and its personal space, named as the website asked. */
async function createProvisionedUser(email: string, name: string, workspaceName?: string): Promise<{ userId: string; workspaceId: string; workspaceName: string }> {
  const { AVATAR_COLORS } = await import('../routes/auth')
  const { createWorkspace } = await import('../routes/workspaces')
  const id = newId('u')
  await ctx()
    .db.insert(users)
    .values({
      id,
      email,
      name: name.trim() || email.split('@')[0],
      passwordHash: `${UNSET_PASSWORD_PREFIX}${crypto.randomBytes(24).toString('base64url')}`,
      avatarColor: AVATAR_COLORS[Math.floor(Math.random() * AVATAR_COLORS.length)],
      // the website took the address at checkout
      emailVerifiedAt: Date.now(),
      createdAt: Date.now(),
    })
  const w = await createWorkspace(id, workspaceName?.trim() || `${name.trim().split(/\s+/)[0] || 'My'}'s space`, true)
  return { userId: id, workspaceId: w.id, workspaceName: w.name }
}
