// DEV-ONLY mock of the account routes (A-17, P-22, A-1 resend, A-2 hand-over), with the server's rules. Installed by
// mockApi.ts. Mail is off unless localStorage.psMockMail = '1': then "sent" links are logged to the console.
import { DEFAULT_NOTIFICATIONS, INVITE_TTL_MS, type AccountInfo, type AccountSession, type Device, type Member, type NotificationPrefs, type User, type Workspace } from '@producer/core'

type Json = Record<string, unknown>
type Handler = (m: RegExpMatchArray, q: URLSearchParams, body: Json) => Response | Promise<Response>

export const mockMail = () => {
  try {
    return localStorage.getItem('psMockMail') === '1'
  } catch {
    return false
  }
}

interface MockInvite {
  token: string
  workspaceId: string
  email: string
  role: Member['role']
  createdAt: number
  expiresAt: number
  acceptedAt?: number
  revokedAt?: number
  sentAt?: number
}

export interface AccountMockDeps {
  on: (method: string, pattern: string, h: Handler) => void
  json: (body: unknown, status?: number) => Response
  fail: (status: number, error: string, code?: string) => Response
  currentUser: () => User | undefined
  setUser: (u: User | undefined) => void
  users: Array<User & { password: string }>
  workspaces: Workspace[]
  members: Record<string, Member[]>
  invites: MockInvite[]
  devices: Device[]
}

export function installAccountMocks(d: AccountMockDeps) {
  const { on, json, fail } = d
  const now = Date.now()
  let notifications: NotificationPrefs = { ...DEFAULT_NOTIFICATIONS }
  let verified = false
  let pendingEmail: string | undefined
  const sessions: AccountSession[] = [
    { id: 's_here', current: true, userAgent: navigator.userAgent, createdAt: now - 3 * 86400_000, lastSeenAt: now, expiresAt: now + 27 * 86400_000 },
    { id: 's_phone', current: false, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Safari/604.1', createdAt: now - 9 * 86400_000, lastSeenAt: now - 2 * 3600_000, expiresAt: now + 21 * 86400_000 },
  ]
  const record = () => d.users.find((u) => u.id === d.currentUser()?.id)
  const signedIn = (h: (u: User) => Response | Promise<Response>): Handler => () => {
    const u = d.currentUser()
    return u ? h(u) : fail(401, 'Not signed in', 'unauthorized')
  }
  const soleOwnerOf = (u: User) =>
    d.workspaces
      .filter((w) => {
        const list = d.members[w.id] ?? []
        return list.some((m) => m.userId === u.id && m.role === 'owner') && list.some((m) => m.userId !== u.id) && !list.some((m) => m.userId !== u.id && m.role === 'owner')
      })
      .map((w) => ({ id: w.id, name: w.name }))
  const info = (u: User): AccountInfo => ({ user: { ...u, emailVerified: verified }, emailVerified: verified, ...(pendingEmail ? { pendingEmail } : {}), mail: mockMail(), notifications, soleOwnerOf: soleOwnerOf(u) })
  const wrongPassword = (password: unknown) => record()?.password !== password

  on('POST', '/api/auth/forgot', (_m, _q, b) => {
    if (!mockMail()) return json({ ok: true, mail: false })
    console.info('[mock mail] reset link: /reset/mock-reset-token for', b.email)
    return json({ ok: true, mail: true })
  })
  on('GET', '/api/auth/reset/([^/]+)', (m) => (m[1] === 'mock-reset-token' ? json({ email: d.users[0].email }) : fail(404, 'This link doesn’t work. It may be mistyped.', 'not_found')))
  on('POST', '/api/auth/reset', (_m, _q, b) => {
    if (b.token !== 'mock-reset-token') return fail(410, 'This link was already used, or a newer one was sent. Ask for a new one.', 'conflict')
    if (String(b.password ?? '').length < 8) return fail(400, 'password: Use at least 8 characters', 'invalid')
    const u = d.users[0]
    u.password = String(b.password)
    const { password: _p, ...user } = u
    d.setUser(user)
    return json({ user, workspaces: d.workspaces })
  })
  on('POST', '/api/auth/verify', () => {
    verified = true
    const u = record()
    if (pendingEmail && u) {
      u.email = pendingEmail
      pendingEmail = undefined
      const { password: _p, ...user } = u
      d.setUser(user)
      return json({ ok: true, email: u.email, purpose: 'email' })
    }
    return json({ ok: true, email: u?.email ?? d.users[0].email, purpose: 'verify' })
  })

  on('GET', '/api/account', signedIn((u) => json(info(u))))
  on('PATCH', '/api/account', (_m, _q, b) => {
    const r = record()
    if (!r) return fail(401, 'Not signed in', 'unauthorized')
    if (typeof b.name === 'string' && b.name.trim()) r.name = b.name.trim().slice(0, 80)
    if (typeof b.avatarColor === 'string') r.avatarColor = b.avatarColor
    const { password: _p, ...user } = r
    d.setUser(user)
    return json(info(user))
  })
  on('POST', '/api/account/password', (_m, _q, b) => {
    const r = record()
    if (!r) return fail(401, 'Not signed in', 'unauthorized')
    if (wrongPassword(b.current)) return fail(403, 'That password isn’t right', 'forbidden')
    if (String(b.password ?? '').length < 8) return fail(400, 'password: Use at least 8 characters', 'invalid')
    r.password = String(b.password)
    sessions.splice(0, sessions.length, ...sessions.filter((s) => s.current))
    return json({ ok: true })
  })
  on('POST', '/api/account/email', (_m, _q, b) => {
    const r = record()
    if (!r) return fail(401, 'Not signed in', 'unauthorized')
    if (wrongPassword(b.password)) return fail(403, 'That password isn’t right', 'forbidden')
    const email = String(b.email ?? '').trim().toLowerCase()
    if (d.users.some((u) => u.email.toLowerCase() === email)) return fail(409, 'Another account already uses that address', 'conflict')
    if (mockMail()) {
      pendingEmail = email
      console.info('[mock mail] confirm link: /verify/mock-verify-token for', email)
      return json({ ok: true, pending: email })
    }
    r.email = email
    verified = false
    const { password: _p, ...user } = r
    d.setUser(user)
    return json({ ok: true, email })
  })
  on('POST', '/api/account/verify', () => (mockMail() ? json({ ok: true, emailed: true }) : fail(409, 'This server sends no mail, so addresses can’t be confirmed.', 'conflict')))
  on('PUT', '/api/account/notifications', (_m, _q, b) => {
    notifications = { ...notifications, ...(typeof b.browser === 'boolean' ? { browser: b.browser } : {}), ...(typeof b.emailJobs === 'boolean' ? { emailJobs: b.emailJobs } : {}) }
    return json(notifications)
  })
  on('GET', '/api/account/sessions', signedIn(() => json(sessions)))
  on('DELETE', '/api/account/sessions/([^/]+)', (m) => {
    const i = sessions.findIndex((s) => s.id === m[1])
    if (i < 0) return fail(404, 'That session already ended', 'not_found')
    sessions.splice(i, 1)
    return json({ ok: true })
  })
  on('POST', '/api/account/sign-out-everywhere', () => {
    const n = { sessions: sessions.filter((s) => !s.current).length, devices: d.devices.length }
    sessions.splice(0, sessions.length, ...sessions.filter((s) => s.current))
    d.devices.splice(0, d.devices.length)
    return json({ ok: true, ...n })
  })
  on('DELETE', '/api/account', (_m, _q, b) => {
    const u = d.currentUser()
    if (!u) return fail(401, 'Not signed in', 'unauthorized')
    if (wrongPassword(b.password)) return fail(403, 'That password isn’t right', 'forbidden')
    const blocked = soleOwnerOf(u)
    if (blocked.length) return json({ error: `You’re the only owner of ${blocked.map((s) => `“${s.name}”`).join(', ')}. Make someone else an owner (or remove the others) first.`, code: 'conflict', details: { spaces: blocked } }, 409)
    d.setUser(undefined)
    return json({ ok: true })
  })

  // invites and members
  const ownerOnly = (wsId: string) => (d.workspaces.find((x) => x.id === wsId)?.role === 'owner' ? null : fail(403, 'Only workspace owners can do that', 'forbidden'))
  on('POST', '/api/workspaces/([^/]+)/invites/([^/]+)/resend', (m) => {
    const denied = ownerOnly(m[1])
    if (denied) return denied
    const inv = d.invites.find((i) => i.workspaceId === m[1] && i.token === m[2] && !i.acceptedAt && !i.revokedAt)
    if (!inv) return fail(404, 'Invite not found, or it was already used or withdrawn', 'not_found')
    if (inv.sentAt && Date.now() - inv.sentAt < 60_000) return fail(429, 'It was just sent. Wait a minute before sending it again.', 'quota')
    inv.expiresAt = Date.now() + INVITE_TTL_MS
    if (mockMail()) inv.sentAt = Date.now()
    return json({ token: inv.token, email: inv.email, role: inv.role, createdAt: inv.createdAt, expiresAt: inv.expiresAt, inviteUrl: `${location.origin}/invite/${inv.token}`, status: 'pending', sentAt: inv.sentAt, emailed: mockMail() })
  })
  on('POST', '/api/workspaces/([^/]+)/members/([^/]+)/transfer', (m) => {
    const denied = ownerOnly(m[1])
    if (denied) return denied
    const ws = d.workspaces.find((w) => w.id === m[1])
    if (ws?.personal) return fail(409, 'A personal space can’t be handed over. Create a team space to share work.', 'conflict')
    const me = d.currentUser()
    const list = d.members[m[1]] ?? []
    const target = list.find((x) => x.userId === m[2])
    if (!target) return fail(404, 'This person is not a member of the space', 'not_found')
    if (target.userId === me?.id) return fail(400, 'Choose someone else to hand the space to', 'invalid')
    target.role = 'owner'
    const mine = list.find((x) => x.userId === me?.id)
    if (mine) mine.role = 'editor'
    if (ws) ws.role = 'editor'
    return json({ ok: true })
  })
}
