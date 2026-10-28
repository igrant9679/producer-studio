// Usage and the queue in the shell (A-18, P-1, A-9, A-8): the Usage page with its limits, AI cost estimate and the
// owner's switch for the server's AI key; queued jobs saying why they wait; the job history with Retry.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { Job, QueueInfo, UsageSummary, User, Workspace } from '@producer/core'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useSession } from '../../lib/session'
import { useToasts } from '../../lib/toast'
import { QueueNote, queueWords, resetQueueNotes, waitWords } from '../components/QueueNote'
import JobsPage, { canRetry, tookWords } from '../pages/JobsPage'
import UsagePage from '../pages/UsagePage'
import { liveBus, useJobs } from '../stores'

type Call = { method: string; path: string; body?: any }
let calls: Call[] = []
let handler: (c: Call) => { status?: number; body: unknown } = () => ({ body: {} })

beforeEach(() => {
  calls = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const u = new URL(url, 'http://localhost')
      const c: Call = { method: (init.method ?? 'GET').toUpperCase(), path: u.pathname + u.search, body: init.body ? JSON.parse(String(init.body)) : undefined }
      calls.push(c)
      const r = handler(c)
      return new Response(JSON.stringify(r.body), { status: r.status ?? 200, headers: { 'content-type': 'application/json' } })
    }),
  )
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.useRealTimers()
  resetQueueNotes()
  useJobs.setState({ jobs: {} })
})

const me = { id: 'u1', email: 'a@example.com', name: 'Ada', avatarColor: '#fff', createdAt: 0 } as User
function signIn(role: Workspace['role']) {
  const ws = { id: 'w1', name: 'Team', role, personal: false, memberCount: 2 } as Workspace
  useSession.setState({ status: 'ready', user: me, workspaces: [ws], workspaceId: 'w1' } as never)
}

function summary(over: Partial<UsageSummary> = {}): UsageSummary {
  return {
    workspaceId: 'w1',
    from: Date.now() - 29 * 86400_000,
    to: Date.now(),
    days: 30,
    ai: { providers: [{ provider: 'anthropic-key', model: 'claude-opus-5-5', requests: 3, inputTokens: 1200, outputTokens: 300, estCostUsd: 0.0108 }], requests: 3, inputTokens: 1200, outputTokens: 300, estCostUsd: 0.0108, estimate: true },
    jobs: { minutes: 12.5, byKind: [{ kind: 'export.render', minutes: 12.5, runs: 2 }] },
    storage: { bytes: 5 * 1024 * 1024, files: 2, byKind: [{ kind: 'video', bytes: 5 * 1024 * 1024, files: 2 }] },
    spaces: [
      { id: 'w1', name: 'Team', bytes: 5 * 1024 * 1024 },
      { id: 'w2', name: 'Personal', bytes: 0 },
    ],
    limits: [
      { label: 'Storage', used: 5 * 1024 * 1024, limit: 10 * 1024 * 1024, unit: 'bytes' },
      { label: 'Your AI requests today', used: 3, limit: 0, unit: 'requests' },
    ],
    builtinAi: { enabled: false, available: true, canChange: true },
    ...over,
  }
}

const openUsage = () =>
  render(
    <MemoryRouter>
      <UsagePage />
    </MemoryRouter>,
  )

describe('the Usage page (A-18)', () => {
  it('shows each limit with what is used of it, AI per provider with an estimated cost, processing and storage', async () => {
    signIn('owner')
    handler = (c) => ({ body: summary({ days: c.path.includes('days=7') ? 7 : 30, members: [{ userId: 'u1', name: 'Ada', aiRequests: 3, tokens: 1500, jobMinutes: 12.5 }] }) })
    openUsage()
    const meter = await screen.findByRole('meter', { name: 'Storage' })
    expect(meter.getAttribute('aria-valuetext')).toBe('5.0 MB of 10 MB')
    // a limit that is off says so, and has no meter
    expect(screen.getByText('3 · no limit')).toBeTruthy()
    expect(screen.queryByRole('meter', { name: 'Your AI requests today' })).toBeNull()
    const ai = screen.getByRole('table', { name: 'AI requests per provider and model' })
    expect(within(ai).getByText('Anthropic (your key)')).toBeTruthy()
    expect(within(ai).getAllByText('$0.01')).toHaveLength(2)
    expect(screen.getByText(/Costs are estimates from list prices/)).toBeTruthy()
    expect(within(screen.getByRole('list', { name: 'Processing time by kind' })).getByText('Rendering export')).toBeTruthy()
    expect(within(screen.getByRole('list', { name: 'Storage per space' })).getAllByRole('listitem').map((li) => li.textContent)).toEqual(['Team5.0 MB', 'Personal0 B'])
    expect(screen.getByRole('table', { name: 'Usage per person' })).toBeTruthy()
    expect(calls[0].path).toBe('/api/usage?workspaceId=w1&days=30')
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Last 7 days' })))
    await waitFor(() => expect(calls.at(-1)!.path).toBe('/api/usage?workspaceId=w1&days=7'))
    expect(screen.getByRole('button', { name: 'Last 7 days' }).getAttribute('aria-pressed')).toBe('true')
  })

  it('an owner turns the server’s AI key on and off with a switch', async () => {
    signIn('owner')
    let enabled = false
    handler = (c) => {
      if (c.method === 'PUT') {
        enabled = c.body.enabled
        return { body: { enabled } }
      }
      return { body: summary({ builtinAi: { enabled, available: true, canChange: true } }) }
    }
    openUsage()
    const sw = await screen.findByRole('switch', { name: 'Use the server’s AI key in this space' })
    expect(sw.getAttribute('aria-checked')).toBe('false')
    await act(async () => fireEvent.click(sw))
    expect(calls.find((c) => c.method === 'PUT')).toEqual({ method: 'PUT', path: '/api/usage/builtin-ai', body: { workspaceId: 'w1', enabled: true } })
    await waitFor(() => expect(screen.getByRole('switch', { name: 'Use the server’s AI key in this space' }).getAttribute('aria-checked')).toBe('true'))
  })

  it('viewers see the usage but no switch, and no per-person rows', async () => {
    signIn('viewer')
    handler = () => ({ body: summary({ builtinAi: { enabled: true, available: true, canChange: false } }) })
    openUsage()
    expect(await screen.findByText('Only an owner of this space can change this.')).toBeTruthy()
    expect(screen.queryByRole('switch')).toBeNull()
    expect(screen.queryByRole('table', { name: 'Usage per person' })).toBeNull()
  })

  it('says why when the usage can’t be loaded', async () => {
    signIn('owner')
    handler = () => ({ status: 500, body: { error: 'Internal server error' } })
    openUsage()
    expect((await screen.findByRole('alert')).textContent).toMatch(/Couldn’t load the usage/)
  })
})

describe('queued jobs say why they wait (A-9)', () => {
  it('words the reason and the wait', () => {
    expect(waitWords(30_000)).toBe('under a minute')
    expect(waitWords(4 * 60_000)).toBe('about 4 min')
    expect(waitWords(3 * 3600_000)).toBe('about 3 h')
    const q = (o: Partial<QueueInfo>): QueueInfo => ({ position: 2, waitMs: 120_000, reason: 'behind', detail: '1 job ahead of it', ...o })
    expect(queueWords(q({}))).toBe('1 job ahead of it · starts in about 2 min')
    expect(queueWords(q({ waitMs: null }))).toBe('1 job ahead of it · wait unknown')
    expect(queueWords(q({ reason: 'next', detail: 'Starting in a moment', waitMs: 0 }))).toBe('Starting in a moment')
  })

  it('a queued job in the list shows its note, kept current while shown and not asked for once gone', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const job = { id: 'j1', kind: 'export.render', status: 'queued', progress: 0, message: 'Waiting to render', workspaceId: 'w1', createdAt: 0, updatedAt: 0 } as Job
    let detail = 'Other spaces go first while this space has 2 jobs running (fair share)'
    handler = () => ({ body: { jobs: { j1: { position: 3, waitMs: 300_000, reason: 'fair-share', detail } } } })
    const { unmount } = render(<QueueNote job={job} />)
    expect(await screen.findByText('Other spaces go first while this space has 2 jobs running (fair share) · starts in about 5 min')).toBeTruthy()
    expect(calls).toEqual([{ method: 'GET', path: '/api/jobs/queue?workspaceId=w1' }])
    detail = '1 job ahead of it'
    await act(async () => void (await vi.advanceTimersByTimeAsync(10_500)))
    expect(await screen.findByText('1 job ahead of it · starts in about 5 min')).toBeTruthy()
    unmount()
    const n = calls.length
    await act(async () => void (await vi.advanceTimersByTimeAsync(30_000)))
    expect(calls.length).toBe(n)
  })
})

const finishedJob = (id: string, over: Partial<Job> = {}): Job => ({ id, kind: 'ai.tts', status: 'done', progress: 1, message: 'Done', workspaceId: 'w1', createdAt: Date.now() - 600_000, startedAt: Date.now() - 300_000, updatedAt: Date.now() - 120_000, ...over })

const openJobs = () =>
  render(
    <MemoryRouter>
      <JobsPage />
    </MemoryRouter>,
  )

describe('the job history (A-8)', () => {
  it('lists finished jobs newest first, linked to their project, filtered by outcome', async () => {
    signIn('editor')
    handler = (c) =>
      c.path.includes('status=error')
        ? { body: { items: [finishedJob('j2', { status: 'error', error: 'The voice engine stopped' })] } }
        : { body: { items: [finishedJob('j2', { status: 'error', error: 'The voice engine stopped', projectId: 'p1' }), finishedJob('j1', { kind: 'export.render' })] } }
    openJobs()
    const list = await screen.findByRole('list', { name: 'Finished jobs, newest first' })
    const rows = within(list).getAllByRole('listitem')
    expect(rows[0].textContent).toMatch(/Generating voiceover · Failed.*took 3 min.*The voice engine stopped/)
    expect(rows[1].textContent).toMatch(/Rendering export · Finished/)
    expect(within(rows[0]).getByRole('link', { name: 'Open the project of generating voiceover' }).getAttribute('href')).toBe('/edit/p1')
    // only failed and cancelled jobs can be retried
    expect(within(rows[1]).queryByRole('button', { name: /Retry/ })).toBeNull()
    expect(calls[0].path).toBe('/api/jobs/history?workspaceId=w1&limit=50')
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Failed' })))
    await waitFor(() => expect(calls.at(-1)!.path).toBe('/api/jobs/history?workspaceId=w1&status=error&limit=50'))
  })

  it('Retry queues the work again and puts it in the jobs list; a clip retries through its own route', async () => {
    signIn('editor')
    const again = { ...finishedJob('j9'), status: 'queued', message: 'Queued again' } as Job
    handler = (c) => {
      if (c.path === '/api/jobs/j2/retry') return { body: again }
      if (c.path === '/api/assets/as1/complete') return { body: { asset: { id: 'as1' } } }
      return { body: { items: [finishedJob('j2', { status: 'error', error: 'Failed' }), finishedJob('j3', { kind: 'asset.process', status: 'error', assetId: 'as1' })] } }
    }
    openJobs()
    const retry = await screen.findByRole('button', { name: 'Retry generating voiceover' })
    await act(async () => fireEvent.click(retry))
    await waitFor(() => expect(useJobs.getState().jobs.j9).toMatchObject({ status: 'queued' }))
    expect(useToasts.getState().toasts.some((t) => t.text === 'Generating voiceover: queued again')).toBe(true)
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Retry processing media' })))
    await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.path === '/api/assets/as1/complete')).toBe(true))
  })

  it('a viewer sees Retry disabled, saying who can', async () => {
    signIn('viewer')
    handler = () => ({ body: { items: [finishedJob('j2', { status: 'error' })] } })
    openJobs()
    const b = (await screen.findByRole('button', { name: 'Retry generating voiceover' })) as HTMLButtonElement
    expect(b.disabled).toBe(true)
    expect(b.getAttribute('data-tip')).toMatch(/view/i)
  })

  it('a job that finishes while the page is open joins the top', async () => {
    signIn('editor')
    handler = () => ({ body: { items: [finishedJob('j1')] } })
    openJobs()
    const list = await screen.findByRole('list', { name: 'Finished jobs, newest first' })
    act(() => liveBus.emitJob(finishedJob('j5', { kind: 'export.render', status: 'cancelled' })))
    act(() => liveBus.emitJob(finishedJob('j6', { status: 'running' })))
    expect(within(list).getAllByRole('listitem').map((li) => li.textContent?.split(' · ')[0])).toEqual(['Rendering export', 'Generating voiceover'])
  })

  it('says how long a run took and which jobs can be retried', () => {
    expect(tookWords(finishedJob('a', { startedAt: 1000, updatedAt: 46_000 }))).toBe('took 45 s')
    expect(tookWords(finishedJob('a', { startedAt: undefined }))).toBeUndefined()
    expect(canRetry(finishedJob('a', { status: 'cancelled' }))).toBe(true)
    expect(canRetry(finishedJob('a', { status: 'error', kind: 'voicestudio.task' }))).toBe(false)
  })
})
