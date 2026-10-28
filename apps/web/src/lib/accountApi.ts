// Client for the account routes (contract: packages/core/src/account.ts): the Account page, password reset, email
// confirmation, invite resend and handing a space over. Kept beside lib/api.ts so the two change independently.
import type { AccountInfo, AccountSession, EmailChangeResult, MeResponse, NotificationPrefs, PendingInvite } from '@producer/core'
import { HttpError, noteStatus } from './api'

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method,
    credentials: 'include',
    headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  noteStatus(path, res.status)
  if (!res.ok) {
    let err = { error: res.statusText } as { error: string; code?: never; details?: unknown }
    try {
      err = await res.json()
    } catch {
      /* not JSON */
    }
    throw new HttpError(res.status, err)
  }
  return (await res.json()) as T
}

const enc = encodeURIComponent

export const accountApi = {
  // signed out
  forgot: (email: string) => call<{ ok: true; mail: boolean }>('POST', '/auth/forgot', { email }),
  resetInfo: (token: string) => call<{ email: string }>('GET', `/auth/reset/${enc(token)}`),
  reset: (token: string, password: string) => call<MeResponse>('POST', '/auth/reset', { token, password }),
  verify: (token: string) => call<{ ok: true; email: string; purpose: 'verify' | 'email' }>('POST', '/auth/verify', { token }),

  // the account page
  get: () => call<AccountInfo>('GET', '/account'),
  update: (p: { name?: string; avatarColor?: string }) => call<AccountInfo>('PATCH', '/account', p),
  changePassword: (current: string, password: string) => call<{ ok: true }>('POST', '/account/password', { current, password }),
  changeEmail: (email: string, password: string) => call<EmailChangeResult>('POST', '/account/email', { email, password }),
  resendVerification: () => call<{ ok: true; emailed: boolean }>('POST', '/account/verify'),
  notifications: (p: Partial<NotificationPrefs>) => call<NotificationPrefs>('PUT', '/account/notifications', p),
  sessions: () => call<AccountSession[]>('GET', '/account/sessions'),
  endSession: (id: string) => call<{ ok: true }>('DELETE', `/account/sessions/${enc(id)}`),
  signOutEverywhere: () => call<{ ok: true; sessions: number; devices: number }>('POST', '/account/sign-out-everywhere'),
  deleteAccount: (password: string) => call<{ ok: true }>('DELETE', '/account', { password }),

  // spaces
  resendInvite: (workspaceId: string, token: string) => call<PendingInvite>('POST', `/workspaces/${enc(workspaceId)}/invites/${enc(token)}/resend`),
  transferOwnership: (workspaceId: string, userId: string) => call<{ ok: true }>('POST', `/workspaces/${enc(workspaceId)}/members/${enc(userId)}/transfer`),
}
