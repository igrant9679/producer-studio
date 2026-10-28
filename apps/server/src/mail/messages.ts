// The mails the app sends. Each is plain HTML (inline styles, no images or tracking) plus a text part, and names
// the app and, where there is one, the space.
import type { Mail } from './index'

const APP = 'Producer Studio'

const esc = (s: string) => s.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!)

export const mailDate = (ms: number) => new Date(ms).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' })

interface Parts {
  to: string
  subject: string
  heading: string
  lines: string[]
  button?: { label: string; url: string }
  /** Small print under the button (why they got this, what to do if it wasn't them). */
  foot?: string
  space?: string
}

export function compose(p: Parts): Mail {
  const where = p.space ? `${APP} · ${p.space}` : APP
  const html = [
    '<!doctype html><html><body style="margin:0;padding:24px;background:#f3f5fa;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#0b1830">',
    '<div style="max-width:520px;margin:0 auto;background:#ffffff;border-radius:12px;padding:28px">',
    `<div style="font-size:13px;font-weight:600;color:#ff5a5f;margin-bottom:14px">${esc(where)}</div>`,
    `<h1 style="font-size:20px;margin:0 0 14px">${esc(p.heading)}</h1>`,
    ...p.lines.map((l) => `<p style="font-size:15px;line-height:1.5;margin:0 0 12px">${esc(l)}</p>`),
    p.button
      ? `<p style="margin:22px 0"><a href="${esc(p.button.url)}" style="display:inline-block;background:#ff5a5f;color:#ffffff;text-decoration:none;font-weight:600;padding:11px 18px;border-radius:8px">${esc(p.button.label)}</a></p>` +
        `<p style="font-size:12px;color:#5b6478;margin:0 0 12px;word-break:break-all">Or open this link: ${esc(p.button.url)}</p>`
      : '',
    p.foot ? `<p style="font-size:12px;color:#5b6478;margin:18px 0 0">${esc(p.foot)}</p>` : '',
    '</div></body></html>',
  ].join('')
  const text = [where, '', p.heading, '', ...p.lines, ...(p.button ? ['', `${p.button.label}: ${p.button.url}`] : []), ...(p.foot ? ['', p.foot] : [])].join('\n')
  return { to: p.to, subject: p.subject, html, text }
}

const ROLE_WORD: Record<string, string> = { owner: 'an owner', editor: 'an editor', viewer: 'a viewer' }

export const inviteMail = (o: { to: string; inviter: string; space: string; role: string; url: string; expiresAt: number }) =>
  compose({
    to: o.to,
    space: o.space,
    subject: `${o.inviter} invited you to ${o.space} on ${APP}`,
    heading: `Join ${o.space}`,
    lines: [
      `${o.inviter} invited you to the space “${o.space}” as ${ROLE_WORD[o.role] ?? o.role}. You’ll see its projects, media and brand kit.`,
      `Sign in or create an account with ${o.to} to accept. The link works once, until ${mailDate(o.expiresAt)}.`,
    ],
    button: { label: `Join ${o.space}`, url: o.url },
    foot: 'If you weren’t expecting this, you can ignore it: nothing happens unless you accept.',
  })

export const verifyMail = (o: { to: string; name: string; url: string }) =>
  compose({
    to: o.to,
    subject: `Confirm your email for ${APP}`,
    heading: 'Confirm your email address',
    lines: [`Hi ${o.name}, confirm that ${o.to} is your address so password resets and notices reach you. The link works for 24 hours.`],
    button: { label: 'Confirm my email', url: o.url },
    foot: `If you didn’t create a ${APP} account, ignore this mail.`,
  })

export const emailChangeMail = (o: { to: string; name: string; url: string }) =>
  compose({
    to: o.to,
    subject: `Confirm your new email for ${APP}`,
    heading: 'Confirm your new email address',
    lines: [`Hi ${o.name}, you asked to sign in to ${APP} with ${o.to} from now on. Confirm it to make the change. The link works for 24 hours.`],
    button: { label: 'Use this address', url: o.url },
    foot: 'If you didn’t ask for this, ignore this mail: your account keeps its current address.',
  })

export const emailChangedNotice = (o: { to: string; name: string; newEmail: string }) =>
  compose({
    to: o.to,
    subject: `Your ${APP} email was changed`,
    heading: 'Your sign-in email was changed',
    lines: [`Hi ${o.name}, your ${APP} account now signs in with ${o.newEmail} instead of this address.`],
    foot: 'If you didn’t do this, reset your password straight away and contact the owner of your space.',
  })

export const resetMail = (o: { to: string; name: string; url: string }) =>
  compose({
    to: o.to,
    subject: `Reset your ${APP} password`,
    heading: 'Reset your password',
    lines: [`Hi ${o.name}, someone (hopefully you) asked to reset the password for ${o.to}. The link works once, for one hour. Setting a new password signs you out everywhere else.`],
    button: { label: 'Choose a new password', url: o.url },
    foot: 'If you didn’t ask for this, ignore this mail: your password stays as it is.',
  })

export const passwordChangedNotice = (o: { to: string; name: string }) =>
  compose({
    to: o.to,
    subject: `Your ${APP} password was changed`,
    heading: 'Your password was changed',
    lines: [`Hi ${o.name}, the password for your ${APP} account (${o.to}) was just changed.`],
    foot: 'If you didn’t do this, use “Forgot password” on the sign-in page to take your account back.',
  })

export const jobMail = (o: { to: string; name: string; space: string; what: string; project?: string; ok: boolean; error?: string; url: string }) =>
  compose({
    to: o.to,
    space: o.space,
    subject: o.ok ? `${o.what} is ready${o.project ? `: ${o.project}` : ''}` : `${o.what} failed${o.project ? `: ${o.project}` : ''}`,
    heading: o.ok ? `${o.what} is ready` : `${o.what} failed`,
    lines: [
      o.ok
        ? `Hi ${o.name}, ${o.what.toLowerCase()}${o.project ? ` of “${o.project}”` : ''} in ${o.space} has finished.`
        : `Hi ${o.name}, ${o.what.toLowerCase()}${o.project ? ` of “${o.project}”` : ''} in ${o.space} didn’t finish.`,
      ...(o.error ? [`What went wrong: ${o.error}`] : []),
    ],
    button: { label: o.ok ? 'Open it' : 'Open and try again', url: o.url },
    foot: `You get these because job emails are on in your ${APP} account settings. Turn them off there.`,
  })
