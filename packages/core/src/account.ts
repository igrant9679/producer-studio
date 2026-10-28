// Account settings, password reset, email checks and notifications (A-17, P-22, A-8). Routes:
//
// POST /api/auth/forgot {email}                      -> {ok, mail}   (always ok: never says whether the account exists;
//                                                       mail false = this server sends no mail, so no link was sent)
// GET  /api/auth/reset/:token                        -> {email}      (404 unknown, 410 used or expired)
// POST /api/auth/reset {token, password}             -> MeResponse   (sets a new password, signs out every other
//                                                       session and app link, signs this browser in)
// POST /api/auth/verify {token}                      -> {ok, email, purpose}  (confirms an address; signed in or not)
//
// GET    /api/account                                -> AccountInfo
// PATCH  /api/account {name?, avatarColor?}          -> AccountInfo
// POST   /api/account/password {current, password}   -> {ok}         (other sessions end)
// POST   /api/account/email {email, password}        -> EmailChangeResult
// POST   /api/account/verify                         -> {ok, emailed} (send the confirmation mail again)
// PUT    /api/account/notifications Partial<NotificationPrefs> -> NotificationPrefs
// GET    /api/account/sessions                      -> AccountSession[]
// DELETE /api/account/sessions/:id                  -> {ok}
// POST   /api/account/sign-out-everywhere           -> {ok, sessions, devices}  (every other session and every app link)
// DELETE /api/account {password}                    -> {ok}  (409 with `details.spaces` while they are the only owner
//                                                       of a space other people are in)
//
// Invites (owner): POST /api/workspaces/:id/invites/:token/resend -> PendingInvite (mails it again and renews the
// 7 days; with mail off it only renews, and the link is copied by hand)
// POST /api/workspaces/:id/members/:userId/transfer  -> {ok}  (owner: they become an owner, you become an editor)
import type { User } from './api'

export interface NotificationPrefs {
  /** Browser notifications when an export or long job ends while the tab is in the background. */
  browser: boolean
  /** An email when an export or long job of yours finishes or fails (off unless turned on; needs mail on the server). */
  emailJobs: boolean
}

export const DEFAULT_NOTIFICATIONS: Readonly<NotificationPrefs> = Object.freeze({ browser: true, emailJobs: false })

export function normalizeNotifications(raw: unknown): NotificationPrefs {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  return {
    browser: typeof o.browser === 'boolean' ? o.browser : DEFAULT_NOTIFICATIONS.browser,
    emailJobs: typeof o.emailJobs === 'boolean' ? o.emailJobs : DEFAULT_NOTIFICATIONS.emailJobs,
  }
}

export interface AccountInfo {
  user: User
  /** The address was confirmed through mail. */
  emailVerified: boolean
  /** A new address waiting to be confirmed from its inbox. */
  pendingEmail?: string
  /** This server sends mail (else links are shown, and reset needs an administrator). */
  mail: boolean
  notifications: NotificationPrefs
  /** Spaces where they are the only owner and other people are members: the account can't be deleted until handed over. */
  soleOwnerOf: Array<{ id: string; name: string }>
}

export type EmailChangeResult =
  /** Mail is on: a confirmation went to the new address; the account keeps the old one until it's used. */
  | { ok: true; pending: string }
  /** Mail is off: the change is made at once (nothing could confirm it). */
  | { ok: true; email: string }

export interface AccountSession {
  id: string
  /** The session this request came from. */
  current: boolean
  userAgent?: string
  createdAt: number
  lastSeenAt?: number
  expiresAt: number
}

/** Long jobs that end with a toast, a browser notification and (when chosen) an email. */
export const NOTIFY_JOB_KINDS = [
  'export.render',
  'ai.produce.script',
  'ai.produce.assemble',
  'ai.transcribe',
  'ai.tts',
  'media.stabilise',
  'media.denoise',
  'media.bgremove',
  'media.smooth',
  'voicestudio.install',
] as const

/** Emails only for work that ran at least this long: a quick one is over before anyone leaves the tab. */
export const JOB_EMAIL_MIN_MS = 60_000

/** How long a reset link and an email confirmation work. */
export const RESET_TTL_MS = 3600_000
export const VERIFY_TTL_MS = 24 * 3600_000
