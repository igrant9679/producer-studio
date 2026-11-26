// /api/provision: a membership website's server-to-server calls (cloud only, signed with PROVISION_SECRET; see
// services/membership.ts and docs/integrations/meyousocial.md). Mounted before the session middleware: these calls
// carry a signature, not a session or a device token.
import { Hono } from 'hono'
import * as z from 'zod/v4'
import { eq } from 'drizzle-orm'
import { appUrl } from '../auth'
import { ctx } from '../context'
import { users } from '../db/schema'
import { HttpError } from '../http'
import { audit } from '../services/audit'
import { MEMBERSHIP_STATUSES, type PlanRow, planByExternal, provision, signInLink, updateMembership, verifySignature } from '../services/membership'

export const provisionRoutes = new Hono()

const Source = z.string().regex(/^[a-z0-9-]{2,40}$/).default('meyousocial')
const ExternalId = z.string().trim().min(1).max(120)
const Plan = z.string().trim().regex(/^[a-z0-9-]{1,40}$/, 'plan: a lowercase slug such as member, contributor, steward or founder')
const Status = z.enum(MEMBERSHIP_STATUSES)
const Seats = z.number().int().min(1).max(10_000).nullable()

/** The verified JSON body of a signed call (the signature is over the raw text). */
async function signed<T extends z.ZodType>(c: { req: { text: () => Promise<string>; header: (n: string) => string | undefined } }, schema: T): Promise<z.infer<T>> {
  if (ctx().config.mode !== 'cloud') throw new HttpError(404, 'not_found', 'Provisioning is for the web edition')
  const raw = await c.req.text()
  verifySignature({ timestamp: c.req.header('x-ps-timestamp'), signature: c.req.header('x-ps-signature'), body: raw })
  let json: unknown
  try {
    json = raw ? JSON.parse(raw) : {}
  } catch {
    throw new HttpError(400, 'invalid', 'The body isn’t JSON')
  }
  const r = schema.safeParse(json)
  if (!r.success) throw new HttpError(400, 'invalid', r.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; '))
  return r.data
}

const membershipDto = (m: PlanRow) => ({ source: m.source, externalId: m.externalId, workspaceId: m.workspaceId, plan: m.plan, status: m.status, seats: m.seats, email: m.email, createdAt: m.createdAt, updatedAt: m.updatedAt })

// POST /api/provision/ping {} → { ok, server }: checks the secret and the clock, changes nothing
provisionRoutes.post('/ping', async (c) => {
  await signed(c, z.object({}).passthrough())
  return c.json({ ok: true, server: 'producer-studio', time: Date.now() })
})

// POST /api/provision/signup → the space (and account) for a membership, and a one-time sign-in link
provisionRoutes.post('/signup', async (c) => {
  const b = await signed(
    c,
    z.object({
      source: Source,
      externalId: ExternalId,
      email: z.string().trim().email().max(254),
      name: z.string().trim().min(1).max(80),
      plan: Plan,
      status: Status.default('active'),
      seats: Seats.optional(),
      workspaceName: z.string().trim().min(1).max(80).optional(),
      claim: z.string().max(400).optional(),
    }),
  )
  const r = await provision(b)
  const link = await signInLink(r.user.id, r.workspace.id, appUrl(c, ''))
  await audit(null, { kind: 'membership.provisioned', actor: null, workspaceId: r.workspace.id, targetId: r.user.id, target: r.user.email, data: { source: b.source, externalId: b.externalId, plan: b.plan, status: b.status, userCreated: r.user.created, workspaceCreated: r.workspace.created, claimed: !!b.claim } })
  return c.json({ user: r.user, workspace: r.workspace, membership: membershipDto(r.membership), signIn: link })
})

// PUT /api/provision/memberships/:externalId {source?, plan?, status?, seats?, email?} → the membership
provisionRoutes.put('/memberships/:externalId', async (c) => {
  const b = await signed(c, z.object({ source: Source, plan: Plan.optional(), status: Status.optional(), seats: Seats.optional(), email: z.string().trim().email().max(254).optional() }))
  const m = await updateMembership(b.source, ExternalId.parse(c.req.param('externalId')), b)
  await audit(null, { kind: 'membership.updated', actor: null, workspaceId: m.workspaceId, target: m.email ?? undefined, data: { source: m.source, externalId: m.externalId, plan: m.plan, status: m.status, seats: m.seats } })
  return c.json({ membership: membershipDto(m) })
})

// POST /api/provision/memberships/:externalId/read {source?} → the membership (a signed read: POST so the body is signed)
provisionRoutes.post('/memberships/:externalId/read', async (c) => {
  const b = await signed(c, z.object({ source: Source }))
  const m = await planByExternal(b.source, ExternalId.parse(c.req.param('externalId')))
  if (!m) throw new HttpError(404, 'not_found', 'No such membership')
  return c.json({ membership: membershipDto(m) })
})

// POST /api/provision/sign-in-links {email} | {externalId, source?} → { url, expiresAt } (one use, 15 minutes)
provisionRoutes.post('/sign-in-links', async (c) => {
  const b = await signed(c, z.object({ source: Source, email: z.string().trim().email().max(254).optional(), externalId: ExternalId.optional() }).refine((x) => !!x.email !== !!x.externalId, 'Give an email or an externalId (one of them)'))
  let userId: string | undefined
  let workspaceId: string | undefined
  if (b.externalId) {
    const m = await planByExternal(b.source, b.externalId)
    if (!m) throw new HttpError(404, 'not_found', 'No such membership')
    workspaceId = m.workspaceId
    const { memberships } = await import('../db/schema')
    const { and } = await import('drizzle-orm')
    userId = (await ctx().db.select({ id: memberships.userId }).from(memberships).where(and(eq(memberships.workspaceId, m.workspaceId), eq(memberships.role, 'owner'))).limit(1))[0]?.id
  } else {
    userId = (await ctx().db.select({ id: users.id }).from(users).where(eq(users.email, b.email!.toLowerCase())).limit(1))[0]?.id
  }
  if (!userId) throw new HttpError(404, 'not_found', 'No Producer Studio account for that member')
  const link = await signInLink(userId, workspaceId, appUrl(c, ''))
  if (!link) throw new HttpError(429, 'quota', 'Too many sign-in links for this account in the last hour')
  await audit(null, { kind: 'membership.link', actor: null, targetId: userId, ...(workspaceId ? { workspaceId } : {}) })
  return c.json(link)
})
