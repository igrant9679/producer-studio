// Voice Studio runs that fail stop and offer a way on: batch polling retries with backoff and queueing keeps what
// couldn't be queued (APP-29), a failed dub stops its spinner and offers Try again (APP-30), and audiobooks and
// stories never use stale output (APP-32).
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { SystemInfo, VoiceProfile, Workspace } from '@producer/core'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useSession } from '../../lib/session'
import { useSystem } from '../system'
import { audiobookExt } from '../voicestudio/Audiobooks'
import Batch, { batchRetryMs } from '../voicestudio/Batch'
import Dubbing from '../voicestudio/Dubbing'
import Stories from '../voicestudio/Stories'
import { useVsStatusStore } from '../voicestudio/vsApi'

vi.mock('../../lib/storyStems', async (orig) => ({ ...(await orig<typeof import('../../lib/storyStems')>()), decodeMono: async () => new Float32Array(4800) }))
vi.setConfig({ testTimeout: 30_000 })

const ws: Workspace = { id: 'ws_me', name: 'Me', role: 'owner', personal: true, memberCount: 1 }
const desktop: SystemInfo = { mode: 'desktop', version: '1', ai: { provider: 'claude-cli', available: true, detail: '' }, capabilities: { transcribe: true, tts: true, render: true } }
const voice = { id: 'vp_1', workspaceId: ws.id, name: 'Narrator', kind: 'clone', local: true, vsProfileId: 'vs_1', consent: { agreed: true, statement: 'Mine', attestedAt: 1 }, createdAt: 1 } as unknown as VoiceProfile

type Handler = (url: URL, init: RequestInit) => unknown
let routes: Array<[string, RegExp, Handler]>
let calls: Array<{ method: string; path: string }>
const route = (method: string, re: RegExp, h: Handler) => routes.unshift([method, re, h])
const fail = (status = 500, error = 'Engine restarting') => new Response(JSON.stringify({ error }), { status, headers: { 'content-type': 'application/json' } })

beforeEach(() => {
  routes = []
  calls = []
  useSession.setState({ status: 'ready', workspaces: [ws], workspaceId: ws.id, user: { id: 'u', email: 'a@b.c', name: 'Alex' } as never })
  useSystem.setState({ info: desktop, loaded: true })
  useVsStatusStore.setState({ status: { state: 'running' } as never, loaded: true })
  route('GET', /\/api\/voicestudio\/status$/, () => ({ state: 'running' }))
  route('GET', /\/voice\/profiles$/, () => [voice])
  route('GET', /\/api\/assets$/, () => [])
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init: RequestInit = {}) => {
      const url = new URL(String(input), 'http://localhost')
      const method = init.method ?? 'GET'
      calls.push({ method, path: url.pathname })
      const hit = routes.find(([m, re]) => m === method && re.test(url.pathname))
      const out = hit ? await hit[2](url, init) : {}
      return out instanceof Response ? out : new Response(JSON.stringify(out ?? {}), { status: 200, headers: { 'content-type': 'application/json' } })
    }),
  )
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  delete (URL as { createObjectURL?: unknown }).createObjectURL
  delete (URL as { revokeObjectURL?: unknown }).revokeObjectURL
})

describe('Batch dubbing (APP-29)', () => {
  it('a failed poll says so and tries again, with backoff, instead of a spinner for good', async () => {
    let n = 0
    route('GET', /\/batch\/jobs$/, () => (n++ === 0 ? fail() : [{ id: 'b1', status: 'done', filename: 'launch.mp4', langs: ['es'], created_at: 1 }]))
    route('GET', /\/batch\/tracked$/, () => [])
    render(<Batch onOpenEngine={() => undefined} />)
    expect(await screen.findByText(/Can’t reach the batch queue/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /Retry now/ }))
    expect(await screen.findByText('launch.mp4')).toBeTruthy()
    expect(screen.queryByText(/Can’t reach the batch queue/)).toBeNull()
    expect([1, 2, 3, 10].map(batchRetryMs)).toEqual([3000, 6000, 12000, 60000])
  })

  it('queueing keeps the videos that couldn’t be queued', async () => {
    route('GET', /\/batch\/jobs$/, () => [])
    route('GET', /\/batch\/tracked$/, () => [])
    route('POST', /\/batch\/track$/, () => ({ ok: true }))
    let k = 0
    route('POST', /\/batch\/enqueue$/, () => (k++ === 0 ? { job_id: 'b1' } : fail(400, 'Unsupported codec')))
    const { container } = render(<Batch onOpenEngine={() => undefined} />)
    const input = container.querySelector('input[type="file"]') as HTMLInputElement
    fireEvent.change(input, { target: { files: [new File(['a'], 'a.mp4', { type: 'video/mp4' }), new File(['b'], 'b.mp4', { type: 'video/mp4' })] } })
    fireEvent.click(await screen.findByRole('button', { name: /Queue 2 videos/ }))
    await waitFor(() => expect(screen.getByRole('button', { name: /Queue 1 video/ })).toBeTruthy())
    expect(screen.getByRole('button', { name: 'Remove b.mp4' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Remove a.mp4' })).toBeNull()
  })
})

describe('Dubbing (APP-30)', () => {
  it('a failed step stops its spinner and progress bar and offers Try again', async () => {
    route('POST', /\/dub\/upload$/, () => ({ job_id: 'j1', task_id: 't1', filename: 'talk.mp4' }))
    let streams = 0
    route('GET', /\/tasks\/stream\/t1$/, () => {
      streams++
      return new Response('data: {"type":"error","error":"Separating the voice ran out of memory"}\n\n', { status: 200, headers: { 'content-type': 'text/event-stream' } })
    })
    const { container } = render(<Dubbing onOpenEngine={() => undefined} />)
    const input = (await waitFor(() => container.querySelector('input[type="file"]'))) as HTMLInputElement
    fireEvent.change(input, { target: { files: [new File(['v'], 'talk.mp4', { type: 'video/mp4' })] } })
    expect(await screen.findByText('Separating the voice ran out of memory')).toBeTruthy()
    expect(screen.queryByRole('progressbar')).toBeNull()
    expect(container.querySelector('.ps-spin')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /Try again/ }))
    await waitFor(() => expect(streams).toBe(2))
    expect(calls.filter((c) => c.path.endsWith('/dub/upload'))).toHaveLength(2)
  })
})

describe('Audiobooks and Stories (APP-32)', () => {
  it('an audiobook is imported with the format it was rendered in', () => {
    expect(audiobookExt('renders/book.mp3', 'm4b')).toBe('.mp3')
    expect(audiobookExt('renders/book.M4B', 'mp3')).toBe('.m4b')
    expect(audiobookExt('renders/book', 'mp3')).toBe('.mp3')
  })

  it('editing a line clears the built mix, and line previews release their audio', async () => {
    route('POST', /\/x\/generate$/, () => new Response(new Uint8Array(8), { status: 200 }))
    const created: string[] = []
    const revoked: string[] = []
    // jsdom has no object URLs
    Object.assign(URL, {
      createObjectURL: () => {
        created.push(`blob:${created.length}`)
        return created[created.length - 1]
      },
      revokeObjectURL: (u: string) => void revoked.push(u),
    })
    render(<MemoryRouter><Stories onOpenEngine={() => undefined} /></MemoryRouter>)
    fireEvent.change(await screen.findByLabelText('Story script'), { target: { value: 'The storm came.\n[Maya] Did you hear that?' } })
    fireEvent.click(screen.getByRole('button', { name: /Read the script/ }))
    fireEvent.click(await screen.findByRole('button', { name: /Build mix and stems/ }))
    expect(await screen.findByText('Mix and stems')).toBeTruthy()
    fireEvent.change(screen.getAllByRole('textbox').find((t) => (t as HTMLTextAreaElement).value === 'The storm came.')!, { target: { value: 'The storm came at midnight.' } })
    await waitFor(() => expect(screen.queryByText('Mix and stems')).toBeNull())
    // two line previews: the first one's audio is released when the second plays
    const play = () => screen.getAllByRole('button', { name: 'Preview line' })[0]
    fireEvent.click(play())
    await waitFor(() => expect(created.length).toBeGreaterThan(0))
    const first = created[created.length - 1]
    await waitFor(() => expect((play() as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(screen.getAllByRole('button', { name: 'Preview line' })[1])
    await waitFor(() => expect(revoked).toContain(first))
    // leaving releases the last one too
    cleanup()
    expect(revoked).toContain(created[created.length - 1])
  })
})
