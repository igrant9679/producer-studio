// Resend's HTTP API (https://resend.com/docs/api-reference/emails/send-email) with plain fetch: no SDK.
import type { MailTransport } from './index'

export const RESEND_URL = 'https://api.resend.com/emails'
const TIMEOUT_MS = 15_000

/** `fetchImpl` is for tests: they hand in a fake so nothing leaves the machine. */
export function resendTransport(apiKey: string, fetchImpl: typeof fetch = fetch): MailTransport {
  return {
    name: 'resend',
    async send(m) {
      const res = await fetchImpl(RESEND_URL, {
        method: 'POST',
        headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({ from: m.from, to: [m.to], subject: m.subject, html: m.html, text: m.text }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
      if (!res.ok) {
        let detail = ''
        try {
          detail = ((await res.json()) as { message?: string }).message ?? ''
        } catch {
          /* not JSON */
        }
        throw new Error(`Resend answered ${res.status}${detail ? `: ${detail}` : ''}`)
      }
    },
  }
}
