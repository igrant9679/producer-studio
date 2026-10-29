// Operations (R4-A): the security audit log (P-8) and the operator tools (P-10). Routes:
//
// GET  /api/workspaces/:id/audit?limit&cursor&kind   -> Page<AuditEntry>   (owner: what happened to the space's access)
//
// Operator only (OPERATOR_EMAILS; everyone else gets 404, as if the routes weren't there):
// GET  /api/operator/users?q                         -> OperatorUser[]     (email or name contains q; newest first)
// GET  /api/operator/users/:id                       -> OperatorUserDetail
// POST /api/operator/users/:id/disable {reason?}     -> OperatorUserDetail (signs them out everywhere, unlinks their apps)
// POST /api/operator/users/:id/enable                -> OperatorUserDetail
// POST /api/operator/users/:id/reset {mode}          -> {ok, mode, emailed?, url?}  (mail: a reset mail; link: a
//                                                       one-time reset link shown once, for when mail is off)
// GET  /api/operator/jobs?status&kind&workspaceId&q&limit&cursor -> Page<OperatorJob>
// GET  /api/operator/jobs/:id                        -> OperatorJob (with input and the raw error)
// POST /api/operator/jobs/:id/requeue                -> OperatorJob (a failed, cancelled or stuck running job runs again)
// POST /api/operator/jobs/:id/cancel                 -> OperatorJob
// GET  /api/operator/storage?q                       -> StorageUsageRow[]  (largest first)
// POST /api/operator/storage/orphans {scanId?}       -> OrphanScan  (no scanId: a dry run listing what would go;
//                                                       with the scanId of a dry run: removes those that are still
//                                                       orphaned, and says how many went)
// GET  /api/operator/audit?q&kind&workspaceId&userId&limit&cursor -> Page<AuditEntry>
// Every POST above is written to the audit log.

export type AuditKind =
  | 'signin.ok'
  | 'signin.failed'
  | 'signup'
  | 'password.changed'
  | 'password.reset'
  | 'reset.requested'
  | 'email.change.requested'
  | 'email.changed'
  | 'sessions.ended'
  | 'session.revoked'
  | 'device.created'
  | 'device.revoked'
  | 'invite.created'
  | 'invite.resent'
  | 'invite.accepted'
  | 'invite.withdrawn'
  | 'member.role'
  | 'member.transfer'
  | 'member.removed'
  | 'member.left'
  | 'ai.key.set'
  | 'ai.key.removed'
  | 'ai.builtin'
  | 'workspace.deleted'
  | 'account.deleted'
  | 'operator.user.disabled'
  | 'operator.user.enabled'
  | 'operator.reset.mailed'
  | 'operator.reset.link'
  | 'operator.job.requeued'
  | 'operator.job.cancelled'
  | 'operator.storage.orphans'

export interface AuditEntry {
  id: string
  at: number
  kind: AuditKind
  /** Who did it (absent: someone not signed in, such as a failed sign-in). */
  actor?: { id: string; email?: string }
  workspaceId?: string
  /** Who or what it was done to, in words (an email, a member's name, a job). */
  target?: string
  targetId?: string
  ip?: string
  userAgent?: string
  requestId?: string
  data: Record<string, unknown>
}

/** Kinds a space owner sees on the space's Audit tab (the rest is about accounts, for operators). */
export const SPACE_AUDIT_KINDS: readonly AuditKind[] = [
  'invite.created',
  'invite.resent',
  'invite.accepted',
  'invite.withdrawn',
  'member.role',
  'member.transfer',
  'member.removed',
  'member.left',
  'ai.key.set',
  'ai.key.removed',
  'ai.builtin',
  'workspace.deleted',
]

const str = (v: unknown) => (typeof v === 'string' ? v : v == null ? '' : String(v))

/** One line about an entry, for the Audit tab and the Operator page ("ada@x.com changed Ben's role to viewer"). */
export function auditSentence(e: AuditEntry): string {
  const who = e.actor?.email ?? (e.actor ? 'Someone' : 'Someone not signed in')
  const t = e.target ?? ''
  const d = e.data ?? {}
  switch (e.kind) {
    case 'signin.ok':
      return `${who} signed in${d.via === 'device' ? ' from the desktop app' : ''}`
    case 'signin.failed':
      return `A sign-in as ${t || 'an unknown address'} failed${d.reason === 'disabled' ? ' (the account is disabled)' : d.reason === 'limited' ? ' (too many attempts)' : ''}`
    case 'signup':
      return `${who} created an account`
    case 'password.changed':
      return `${who} changed their password`
    case 'password.reset':
      return `${who} set a new password with a reset link`
    case 'reset.requested':
      return `A password reset was mailed to ${t}`
    case 'email.change.requested':
      return `${who} asked to change their email to ${str(d.to)}`
    case 'email.changed':
      return `${who} changed their email${d.to ? ` to ${str(d.to)}` : ''}`
    case 'sessions.ended':
      return `${who} signed out everywhere else`
    case 'session.revoked':
      return `${who} ended one of their sessions`
    case 'device.created':
      return `${who} linked a desktop app${d.name ? ` (${str(d.name)})` : ''}`
    case 'device.revoked':
      return `${who} unlinked a desktop app${d.name ? ` (${str(d.name)})` : ''}`
    case 'invite.created':
      return `${who} invited ${t} as ${str(d.role)}`
    case 'invite.resent':
      return `${who} sent the invite to ${t} again`
    case 'invite.accepted':
      return `${who} accepted an invite as ${str(d.role)}`
    case 'invite.withdrawn':
      return `${who} withdrew the invite to ${t}`
    case 'member.role':
      return `${who} changed ${t}’s role from ${str(d.from)} to ${str(d.to)}`
    case 'member.transfer':
      return `${who} handed the space over to ${t}`
    case 'member.removed':
      return `${who} removed ${t} from the space`
    case 'member.left':
      return `${who} left the space`
    case 'ai.key.set':
      return `${who} saved a ${str(d.provider)} AI key (…${str(d.last4)})`
    case 'ai.key.removed':
      return `${who} removed the ${str(d.provider)} AI key`
    case 'ai.builtin':
      return `${who} turned the server’s built-in AI ${d.enabled ? 'on' : 'off'}`
    case 'workspace.deleted':
      return `${who} deleted the space${d.name ? ` “${str(d.name)}”` : ''}`
    case 'account.deleted':
      return `${who} deleted their account`
    case 'operator.user.disabled':
      return `Operator ${who} disabled ${t}${d.reason ? `: ${str(d.reason)}` : ''}`
    case 'operator.user.enabled':
      return `Operator ${who} enabled ${t} again`
    case 'operator.reset.mailed':
      return `Operator ${who} mailed ${t} a password reset`
    case 'operator.reset.link':
      return `Operator ${who} made a one-time reset link for ${t}`
    case 'operator.job.requeued':
      return `Operator ${who} requeued job ${t}`
    case 'operator.job.cancelled':
      return `Operator ${who} cancelled job ${t}`
    case 'operator.storage.orphans':
      return `Operator ${who} removed ${str(d.removed)} orphaned storage objects`
    default:
      return `${who}: ${String(e.kind)}`
  }
}

export interface OperatorUser {
  id: string
  email: string
  name: string
  createdAt: number
  emailVerified: boolean
  disabledAt?: number
  spaces: number
  sessions: number
  devices: number
  /** Last successful sign-in (from the audit log). */
  lastSignInAt?: number
}

export interface OperatorUserDetail extends OperatorUser {
  memberships: Array<{ workspaceId: string; name: string; role: string; personal: boolean }>
  deviceList: Array<{ id: string; name: string; createdAt: number; lastSeenAt?: number }>
  recent: AuditEntry[]
}

export interface OperatorJob {
  id: string
  kind: string
  status: string
  progress: number
  message: string
  workspaceId: string
  workspaceName?: string
  userId: string
  projectId?: string
  attempts: number
  /** What people see. */
  error?: string
  /** The raw error (tool output, paths): operators only. */
  errorDetail?: string
  lockedBy?: string
  createdAt: number
  startedAt?: number
  updatedAt: number
  waitMs?: number
  runMs?: number
  peakRssBytes?: number
  input?: Record<string, unknown>
}

export interface StorageUsageRow {
  workspaceId: string
  name: string
  personal: boolean
  owner?: string
  bytes: number
  files: number
}

export interface OrphanObject {
  key: string
  size: number
  mtimeMs: number
  /** Why it's orphaned: its space, clip, font or project no longer exists. */
  reason: 'workspace' | 'asset' | 'font' | 'preview'
}

export interface OrphanScan {
  scanId: string
  dryRun: boolean
  /** The first few hundred, largest first. */
  objects: OrphanObject[]
  count: number
  bytes: number
  /** Objects looked at. */
  scanned: number
  /** After a confirmed run: how many were removed (some may have stopped being orphans meanwhile). */
  removed?: number
}
