// Outgoing mail: one HTTP transport (Resend; Railway blocks SMTP). Off unless RESEND_API_KEY and MAIL_FROM are set:
// then nothing is sent and callers fall back to showing the link (invites) or saying mail is off (password reset).
// Tests swap in a fake with setMailTransport, so no test ever reaches the real provider.
import { ctx } from '../context'
import { log } from '../log'
import { resendTransport } from './resend'

export interface Mail {
  to: string
  subject: string
  html: string
  text: string
}

export interface MailTransport {
  readonly name: string
  send(mail: Mail & { from: string }): Promise<void>
}

let override: { transport: MailTransport; from: string } | null | undefined
let cached: { key: string; transport: MailTransport } | undefined

/** Tests: use this transport (null = mail off; undefined = back to the configuration). */
export function setMailTransport(t: MailTransport | null | undefined, from = 'Producer Studio <test@example.com>') {
  override = t === undefined ? undefined : t === null ? null : { transport: t, from }
}

function current(): { transport: MailTransport; from: string } | null {
  if (override !== undefined) return override
  const m = ctx().config.mail
  if (!m) return null
  if (cached?.key !== m.resendApiKey) cached = { key: m.resendApiKey, transport: resendTransport(m.resendApiKey) }
  return { transport: cached.transport, from: m.from }
}

/** Whether this server sends mail at all. */
export function mailEnabled(): boolean {
  return current() !== null
}

/** Send one message. False when mail is off or the provider refused it (logged, never thrown: mail is a courtesy). */
export async function sendMail(mail: Mail): Promise<boolean> {
  const t = current()
  if (!t) return false
  try {
    await t.transport.send({ ...mail, from: t.from })
    return true
  } catch (err) {
    log.warn('mail: not sent', { via: t.transport.name, subject: mail.subject, err: err instanceof Error ? err.message : String(err) })
    return false
  }
}
