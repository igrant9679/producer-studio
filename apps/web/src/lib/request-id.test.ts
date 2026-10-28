// P-7: a server failure the app shows names the request, so a person can quote it.
import { describe, expect, it } from 'vitest'
import { HttpError } from './api'

describe('the reference on server errors', () => {
  it('is added to a 5xx message that lacks it, and never to a person’s own mistakes', () => {
    expect(new HttpError(502, { error: 'The storage bucket refused the request.', code: 'server', requestId: 'abc123xyz' }).message).toBe('The storage bucket refused the request. (reference abc123xyz)')
    // the server's own 500 sentence already says it
    const own = 'Something went wrong on our side. If it keeps happening, quote reference abc123xyz.'
    expect(new HttpError(500, { error: own, code: 'server', requestId: 'abc123xyz' }).message).toBe(own)
    expect(new HttpError(400, { error: 'name: Required', code: 'invalid', requestId: 'abc123xyz' }).message).toBe('name: Required')
    expect(new HttpError(500, { error: 'Internal server error' }).message).toBe('Internal server error')
  })
})
