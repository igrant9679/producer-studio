// Resumable uploads in the browser (P-5): parts not yet in storage are sent (three at a time), a part that fails in
// passing is sent again with a fresh URL, an upload that can't go on stops with its parts kept, and the same file
// chosen again in this browser carries on from where it stopped.
import type { UploadPartUrl, UploadTicket } from '@producer/core'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { api } from './api'
import { MULTIPART_FROM_BYTES, type PartTransport, resumeKey, savedUpload, sendParts, UploadPausedError } from './multipartUpload'

const MB = 1024 * 1024
const plan = (size: number, done: number[] = []) => ({ size, partSize: 4 * MB, partCount: Math.ceil(size / (4 * MB)), done })
const ticket = (size: number, done: number[] = []): UploadTicket & { multipart: ReturnType<typeof plan> } => ({ assetId: 'as_big', url: '/api/uploads/as_big/parts', method: 'PUT', headers: {}, multipart: plan(size, done) })

/** A fake server: part URLs on request, PUTs answered by `answer` (default 200). */
function transport(answer: (n: number, attempt: number) => number = () => 200) {
  const tries = new Map<number, number>()
  const puts: Array<{ n: number; bytes: number }> = []
  const asked: number[][] = []
  const t: PartTransport = {
    wait: async () => undefined,
    json: async <T,>(_m: string, _p: string, body?: unknown) => {
      const parts = (body as { parts: number[] }).parts
      asked.push(parts)
      return { parts: parts.map((n): UploadPartUrl => ({ partNumber: n, url: `https://bucket/part${n}?sig=${asked.length}`, size: n === 3 ? 2 * MB : 4 * MB, headers: {} })) } as T
    },
    put: async (url, _h, body, onProgress) => {
      const n = Number(url.match(/part(\d+)/)![1])
      const attempt = (tries.get(n) ?? 0) + 1
      tries.set(n, attempt)
      onProgress(body.size / 2)
      const status = answer(n, attempt)
      if (status === 200) puts.push({ n, bytes: body.size })
      return status
    },
  }
  return { t, puts, asked, tries }
}

const file = (size: number) => new Blob([new Uint8Array(size)])

afterEach(() => {
  vi.restoreAllMocks()
  localStorage.clear()
})

describe('sending a file in parts (P-5)', () => {
  it('sends only the parts not yet in storage, each its own slice, and reports the whole file', async () => {
    const f = transport()
    const progress: number[] = []
    await sendParts(file(10 * MB), ticket(10 * MB, [2]), f.t, { onProgress: (p) => progress.push(p) })
    expect(f.puts.sort((a, b) => a.n - b.n)).toEqual([{ n: 1, bytes: 4 * MB }, { n: 3, bytes: 2 * MB }])
    // part 2 counted from the start; the end is the whole file
    expect(progress[0]).toBeCloseTo(0.4)
    expect(progress.at(-1)).toBe(1)
    // URLs asked for in one batch
    expect(f.asked[0]).toEqual([1, 3])
  })

  it('a part that fails in passing is sent again with a fresh URL', async () => {
    const f = transport((n, attempt) => (n === 1 && attempt < 3 ? (attempt === 1 ? 0 : 503) : 200))
    await sendParts(file(10 * MB), ticket(10 * MB), f.t)
    expect(f.tries.get(1)).toBe(3)
    expect(f.puts.map((p) => p.n).sort()).toEqual([1, 2, 3])
    expect(f.asked.length).toBeGreaterThan(1)
  })

  it('stops after the last try, saying how far it got, with what arrived kept', async () => {
    const f = transport((n) => (n === 2 ? 0 : 200))
    const err = await sendParts(file(10 * MB), ticket(10 * MB), f.t, { attempts: 3 }).catch((e) => e)
    expect(err).toBeInstanceOf(UploadPausedError)
    expect(err.message).toMatch(/stopped at 60%.*network dropped.*same file again/)
  })

  it('a part refused for good ends the upload at once', async () => {
    const f = transport((n) => (n === 1 ? 404 : 200))
    const err = await sendParts(file(10 * MB), ticket(10 * MB), f.t).catch((e) => e)
    expect(err).not.toBeInstanceOf(UploadPausedError)
    expect(f.tries.get(1)).toBe(1)
  })
})

describe('carrying on after a reload (P-5)', () => {
  it('the same file in the same space resumes the upload this browser started', async () => {
    const big = new File([new Uint8Array(8)], 'drone.mov', { type: 'video/quicktime', lastModified: 1000 })
    Object.defineProperty(big, 'size', { value: MULTIPART_FROM_BYTES + 1 })
    const bodies: Array<Record<string, unknown>> = []
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) : undefined
      if (url === '/api/uploads') {
        bodies.push(body)
        return new Response(JSON.stringify({ assetId: 'as_big', url: '', method: 'PUT', headers: {}, multipart: { size: big.size, partSize: big.size, partCount: 1, done: bodies.length > 1 ? [1] : [] } }))
      }
      if (url.endsWith('/parts')) return new Response(JSON.stringify({ parts: [{ partNumber: 1, url: 'https://bucket/p1', size: big.size, headers: {} }] }))
      if (url.endsWith('/complete')) return new Response(JSON.stringify({ asset: { id: 'as_big' }, status: 'processing' }))
      return new Response('{}')
    })
    vi.stubGlobal('fetch', fetchMock)
    // the first try: the part's PUT never gets through
    class DeadXHR {
      upload: { onprogress?: unknown } = {}
      onerror?: () => void
      open() {}
      setRequestHeader() {}
      send() {
        setTimeout(() => this.onerror?.(), 0)
      }
    }
    vi.stubGlobal('XMLHttpRequest', DeadXHR)
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void) => (fn(), 0)) as unknown as typeof setTimeout)
    await expect(api.upload('ws1', big)).rejects.toThrow(/same file again/)
    expect(savedUpload(resumeKey('ws1', big))).toBe('as_big')
    // chosen again: the server is asked to carry on with that upload, and all its parts are there
    const rec = await api.upload('ws1', big)
    expect(bodies[1]).toMatchObject({ assetId: 'as_big', multipart: true, size: big.size })
    expect(rec.status).toBe('processing')
    expect(savedUpload(resumeKey('ws1', big))).toBeUndefined()
  })
})
