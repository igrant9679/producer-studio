// P-14 in the client: base versions sent as If-Match, and job requests sent with an Idempotency-Key that a retry reuses.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { HttpError, IDEMPOTENT_RETRY_MS, api } from './api'

const ok = (body: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json', ...headers } })
const header = (init: RequestInit | undefined, name: string) => (init?.headers as Record<string, string> | undefined)?.[name]

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('idempotency keys on job requests', () => {
  it('a lost answer is asked again with the same key, so the server can answer with the job it made', async () => {
    vi.useFakeTimers()
    const calls: RequestInit[] = []
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      calls.push(init!)
      if (calls.length === 1) throw new TypeError('Failed to fetch')
      if (calls.length === 2) return new Response('{"error":"bad gateway"}', { status: 502 })
      return ok({ id: 'job_1', status: 'queued' })
    })
    const done = api.tts({ workspaceId: 'w1', text: 'Hello', voice: 'af_heart' })
    await vi.advanceTimersByTimeAsync(IDEMPOTENT_RETRY_MS[0] + IDEMPOTENT_RETRY_MS[1])
    expect((await done).id).toBe('job_1')
    expect(calls).toHaveLength(3)
    const keys = calls.map((c) => header(c, 'idempotency-key'))
    expect(keys[0]).toBeTruthy()
    expect(new Set(keys).size).toBe(1)
  })

  it('a refusal is not retried, and each new request gets its own key', async () => {
    const keys: Array<string | undefined> = []
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      keys.push(header(init, 'idempotency-key'))
      return new Response('{"error":"Viewers cannot make changes"}', { status: 403 })
    })
    await expect(api.exportProject('p1', { resolution: '1080p', fps: 30, format: 'mp4' } as never)).rejects.toBeInstanceOf(HttpError)
    await expect(api.exportProject('p1', { resolution: '1080p', fps: 30, format: 'mp4' } as never)).rejects.toBeInstanceOf(HttpError)
    expect(keys).toHaveLength(2)
    expect(keys[0]).not.toBe(keys[1])
  })
})

describe('base versions', () => {
  it('a save sends back the ETag its record was read with, and a 412 says someone else changed it', async () => {
    const seen: Array<string | undefined> = []
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      if ((init?.method ?? 'GET') === 'GET') return ok({ name: 'Brand' }, { etag: '"v1"' })
      seen.push(header(init, 'if-match'))
      if (seen.length === 1) return ok({ name: 'Mine' }, { etag: '"v2"' })
      return new Response(JSON.stringify({ error: 'The brand kit was changed by someone else since you opened it.' }), { status: 412 })
    })
    await api.brand('w9')
    await api.saveBrand('w9', { name: 'Mine' } as never)
    // the next save carries the base the last one answered with
    const err = await api.saveBrand('w9', { name: 'Again' } as never).catch((e) => e)
    expect(seen).toEqual(['"v1"', '"v2"'])
    expect(err).toBeInstanceOf(HttpError)
    expect(err.status).toBe(412)
    expect(err.message).toMatch(/changed by someone else/)
  })

  it('a rename from a list sends that record’s base', async () => {
    const seen: Array<string | undefined> = []
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      seen.push(header(init, 'if-match'))
      return ok({ asset: { id: 'a1', name: 'New' } })
    })
    await api.renameAsset('a1', 'New', '"tag-a1"')
    await api.renameWorkspace('w1', 'Team', '"tag-w1"')
    expect(seen).toEqual(['"tag-a1"', '"tag-w1"'])
  })
})
