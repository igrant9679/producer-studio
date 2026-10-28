// Request ids (P-7): every request gets one (the caller's X-Request-Id when it sends a sane one, else a new one),
// answered in the X-Request-Id header, written on every log line the request causes, and put in error bodies so a
// person can quote it ("reference …") and an operator can find the log lines.
import crypto from 'node:crypto'
import type { Context, MiddlewareHandler } from 'hono'
import type { AppEnv } from './auth'
import { withLogContext } from './log'

export const REQUEST_ID_HEADER = 'X-Request-Id'
const SANE = /^[\w.:-]{6,100}$/

export function newRequestId(): string {
  return crypto.randomBytes(9).toString('base64url')
}

export const requestId: MiddlewareHandler<AppEnv> = async (c, next) => {
  const sent = c.req.header(REQUEST_ID_HEADER)
  const id = sent && SANE.test(sent) ? sent : newRequestId()
  c.set('requestId', id)
  c.header(REQUEST_ID_HEADER, id)
  await withLogContext({ reqId: id }, next)
  // a response made by an error handler or a sub-app may have replaced the headers
  try {
    if (!c.res.headers.get(REQUEST_ID_HEADER)) c.res.headers.set(REQUEST_ID_HEADER, id)
  } catch {
    /* a response with fixed headers (a proxied fetch): the header was set before it */
  }
}

/** This request's id ('' outside a request). */
export function requestIdOf(c: Context<AppEnv>): string {
  return c.get('requestId') ?? ''
}

/** The sentence a 500 answers with: what happened, and the reference to quote. */
export function serverErrorMessage(id: string): string {
  return id ? `Something went wrong on our side. If it keeps happening, quote reference ${id}.` : 'Something went wrong on our side.'
}
