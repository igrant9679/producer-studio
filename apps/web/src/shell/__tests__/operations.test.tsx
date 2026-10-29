// Operations in the shell (R4-A): a space's Audit tab beside Activity, for owners (P-8), and the Operator page (P-10).
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { AuditEntry, OperatorJob, OperatorUser, OperatorUserDetail, User, Workspace } from '@producer/core'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useSession } from '../../lib/session'
import ActivityPage from '../pages/ActivityPage'
import AuditPage from '../pages/AuditPage'
import OperatorPage from '../pages/OperatorPage'

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
})

const me = { id: 'u1', email: 'ada@example.com', name: 'Ada', avatarColor: '#fff', createdAt: 0 } as User
const spaces = (role: Workspace['role']): Workspace[] => [
  { id: 'w1', name: 'Team', role, personal: false, memberCount: 2 },
  { id: 'w2', name: 'Other team', role: 'owner', personal: false, memberCount: 3 },
]
function signIn(role: Workspace['role'], operator = false) {
  useSession.setState({ status: 'ready', user: me, workspaces: spaces(role), workspaceId: 'w1', operator } as never)
}

const entry = (over: Partial<AuditEntry>): AuditEntry => ({ id: `au_${Math.random()}`, at: Date.now() - 60_000, kind: 'invite.created', actor: { id: 'u1', email: 'ada@example.com' }, workspaceId: 'w1', target: 'ben@example.com', ip: '203.0.113.9', userAgent: 'Mozilla/5.0 Chrome/130', data: { role: 'editor' }, ...over })

const at = (path: string) =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/activity" element={<ActivityPage />} />
        <Route path="/audit" element={<AuditPage />} />
        <Route path="/operator" element={<OperatorPage />} />
      </Routes>
    </MemoryRouter>,
  )

describe('the Audit tab (P-8)', () => {
  it('owners get Activity | Audit tabs; the audit lists who changed access, with where from, and filters by kind', async () => {
    signIn('owner')
    handler = (c) =>
      c.path.startsWith('/api/workspaces/w1/audit')
        ? { body: { items: [entry({ kind: 'member.role', target: 'ben@example.com', data: { from: 'editor', to: 'viewer' }, requestId: 'req-42' }), entry({}), entry({ kind: 'ai.key.set', target: 'openai', data: { provider: 'openai', last4: 'WXYZ' } })] } }
        : { body: { items: [] } }
    at('/audit')
    const tabs = screen.getByRole('navigation', { name: 'Space history' })
    expect(within(tabs).getByRole('link', { name: 'Audit' }).getAttribute('aria-current')).toBe('page')
    expect(within(tabs).getByRole('link', { name: 'Activity' }).getAttribute('href')).toBe('/activity')
    const list = await screen.findByRole('list', { name: 'Audit log, newest first' })
    const items = within(list).getAllByRole('listitem')
    expect(items[0].textContent).toContain('ada@example.com changed ben@example.com’s role from editor to viewer')
    expect(items[0].textContent).toContain('203.0.113.9 · Chrome · reference req-42')
    expect(items[2].textContent).toContain('saved a openai AI key (…WXYZ)')
    fireEvent.click(screen.getByRole('button', { name: 'AI' }))
    expect(within(screen.getByRole('list', { name: 'Audit log, newest first' })).getAllByRole('listitem')).toHaveLength(1)
    expect(screen.getByRole('button', { name: 'AI' }).getAttribute('aria-pressed')).toBe('true')
  })

  it('an editor or viewer gets no Audit tab, and the page says only owners can read it (nothing is fetched)', async () => {
    signIn('editor')
    handler = () => ({ body: { items: [] } })
    at('/activity')
    await screen.findByRole('heading', { name: 'Activity' })
    expect(screen.queryByRole('navigation', { name: 'Space history' })).toBeNull()
    cleanup()
    at('/audit')
    expect(screen.getByText('Only owners can read the audit log')).toBeTruthy()
    expect(calls.some((c) => c.path.includes('/audit'))).toBe(false)
  })

  it('switching spaces loads the other space’s audit', async () => {
    signIn('owner')
    handler = (c) => ({ body: { items: [entry({ target: c.path.includes('/w2/') ? 'other@example.com' : 'ben@example.com', workspaceId: c.path.includes('/w2/') ? 'w2' : 'w1' })] } })
    at('/audit')
    await screen.findByText(/invited ben@example.com/)
    useSession.setState({ workspaceId: 'w2' } as never)
    await screen.findByText(/invited other@example.com/)
    expect(calls.filter((c) => c.path.includes('/audit')).map((c) => c.path.split('?')[0])).toEqual(['/api/workspaces/w1/audit', '/api/workspaces/w2/audit'])
  })

  it('a failed load says so in an alert', async () => {
    signIn('owner')
    handler = () => ({ status: 500, body: { error: 'Something went wrong on our side. If it keeps happening, quote reference r-1.', code: 'server', requestId: 'r-1' } })
    at('/audit')
    expect((await screen.findByRole('alert')).textContent).toContain('quote reference r-1')
  })
})

const person: OperatorUser = { id: 'u9', email: 'pat@example.com', name: 'Pat', createdAt: Date.now() - 86400_000, emailVerified: true, spaces: 1, sessions: 2, devices: 1 }
const detail = (over: Partial<OperatorUserDetail> = {}): OperatorUserDetail => ({ ...person, memberships: [{ workspaceId: 'w9', name: "Pat's space", role: 'owner', personal: true }], deviceList: [], recent: [], ...over })
const job: OperatorJob = { id: 'j1', kind: 'export.render', status: 'error', progress: 0, message: 'Failed', workspaceId: 'w9', workspaceName: "Pat's space", userId: 'u9', attempts: 3, error: 'The export failed on the server.', errorDetail: 'Render failed (exit 1): /srv/x', createdAt: Date.now() - 60_000, updatedAt: Date.now(), runMs: 4200, waitMs: 800, peakRssBytes: 2 * 1024 ** 3 }

describe('the Operator page (P-10)', () => {
  it('is not there for someone who isn’t an operator', () => {
    signIn('owner', false)
    at('/operator')
    expect(screen.getByText('This page isn’t here')).toBeTruthy()
    expect(calls).toHaveLength(0)
  })

  it('finds a person and disables them after a confirmation with a reason; Escape cancels and gives focus back', async () => {
    signIn('owner', true)
    let disabled = false
    handler = (c) => {
      if (c.path.startsWith('/api/operator/users?')) return { body: [{ ...person, ...(disabled ? { disabledAt: Date.now() } : {}) }] }
      if (c.path === '/api/operator/users/u9/disable') {
        disabled = true
        return { body: detail({ disabledAt: Date.now(), sessions: 0 }) }
      }
      if (c.path === '/api/operator/users/u9') return { body: detail() }
      return { body: {} }
    }
    at('/operator')
    expect(screen.getByRole('tab', { name: 'People' }).getAttribute('aria-selected')).toBe('true')
    const search = screen.getByRole('searchbox', { name: 'Find a person' })
    fireEvent.change(search, { target: { value: 'pat' } })
    fireEvent.submit(screen.getByRole('search', { name: 'Find a person' }))
    await waitFor(() => expect(calls.some((c) => c.path === '/api/operator/users?q=pat')).toBe(true))
    const open = await screen.findByRole('button', { name: 'pat@example.com' })
    fireEvent.click(open)
    expect(open.getAttribute('aria-expanded')).toBe('true')
    const card = await screen.findByRole('region', { name: 'Pat, pat@example.com' })
    const disable = within(card).getByRole('button', { name: 'Disable…' })
    disable.focus()
    fireEvent.click(disable)
    const dialog = await screen.findByRole('alertdialog', { name: 'Disable pat@example.com?' })
    fireEvent.keyDown(dialog, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
    expect(document.activeElement).toBe(disable)
    fireEvent.click(disable)
    fireEvent.change(await screen.findByLabelText('Reason (kept in the audit log)'), { target: { value: 'Chargeback' } })
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Disable' }))
    await waitFor(() => expect(calls.find((c) => c.path === '/api/operator/users/u9/disable')?.body).toEqual({ reason: 'Chargeback' }))
    expect(await within(card).findByRole('button', { name: 'Enable' })).toBeTruthy()
  })

  it('makes a one-time reset link and shows it once, ready to copy', async () => {
    signIn('owner', true)
    handler = (c) => {
      if (c.path === '/api/operator/users' || c.path.startsWith('/api/operator/users?')) return { body: [person] }
      if (c.path === '/api/operator/users/u9') return { body: detail() }
      if (c.path === '/api/operator/users/u9/reset') return { body: { ok: true, mode: 'link', url: 'https://studio.test/reset/tok123' } }
      return { body: {} }
    }
    at('/operator')
    fireEvent.click(await screen.findByRole('button', { name: 'pat@example.com' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Make a one-time reset link' }))
    const link = (await screen.findByLabelText(/One-time reset link/)) as HTMLInputElement
    expect(link.value).toBe('https://studio.test/reset/tok123')
    expect(link.readOnly).toBe(true)
    expect(screen.getByRole('button', { name: 'Copy the reset link' })).toBeTruthy()
    expect(calls.find((c) => c.path === '/api/operator/users/u9/reset')?.body).toEqual({ mode: 'link' })
  })

  it('inspects a failed job (what people see, the raw error, its timings) and requeues it', async () => {
    signIn('owner', true)
    handler = (c) => {
      if (c.path.startsWith('/api/operator/jobs?')) return { body: { items: [job] } }
      if (c.path === '/api/operator/jobs/j1') return { body: { ...job, input: { projectId: 'p1' } } }
      if (c.path === '/api/operator/jobs/j1/requeue') return { body: { ...job, status: 'queued', attempts: 0, error: undefined } }
      if (c.path.startsWith('/api/operator/users')) return { body: [] }
      return { body: {} }
    }
    at('/operator')
    const tabs = screen.getByRole('tablist', { name: 'Operator tools' })
    fireEvent.keyDown(within(tabs).getByRole('tab', { name: 'People' }), { key: 'ArrowRight' })
    expect(screen.getByRole('tab', { name: 'Jobs' }).getAttribute('aria-selected')).toBe('true')
    expect(document.activeElement).toBe(screen.getByRole('tab', { name: 'Jobs' }))
    fireEvent.click(await screen.findByRole('button', { name: 'export.render' }))
    expect((await screen.findByLabelText('Raw error')).textContent).toBe('Render failed (exit 1): /srv/x')
    expect(screen.getByText(/waited 0.8 s · ran 4.2 s · peak memory 2(\.0)? GB · attempts 3/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Requeue' }))
    await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.path === '/api/operator/jobs/j1/requeue')).toBe(true))
    await waitFor(() => expect((screen.getByRole('button', { name: 'Requeue' }) as HTMLButtonElement).disabled).toBe(true))
  })

  it('looks for orphaned files first, and removes them only after a confirmation', async () => {
    signIn('owner', true)
    handler = (c) => {
      if (c.path.startsWith('/api/operator/storage?') || c.path === '/api/operator/storage') return { body: [{ workspaceId: 'w9', name: "Pat's space", personal: true, owner: 'pat@example.com', bytes: 3 * 1024 ** 3, files: 12 }] }
      if (c.path === '/api/operator/storage/orphans')
        return c.body?.scanId
          ? { body: { scanId: 'scan_1', dryRun: false, objects: [], count: 1, bytes: 1000, scanned: 50, removed: 1 } }
          : { body: { scanId: 'scan_1', dryRun: true, objects: [{ key: 'ws/gone/assets/a/source.mp4', size: 1000, mtimeMs: 0, reason: 'workspace' }], count: 1, bytes: 1000, scanned: 50 } }
      return { body: [] }
    }
    at('/operator')
    fireEvent.click(screen.getByRole('tab', { name: 'Storage' }))
    const table = await screen.findByRole('table', { name: 'Storage per space, largest first' })
    expect(within(table).getByText('pat@example.com')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Look for orphaned files' }))
    expect(await screen.findByText('ws/gone/assets/a/source.mp4 · 1000 B · workspace')).toBeTruthy()
    expect(calls.filter((c) => c.path === '/api/operator/storage/orphans').map((c) => c.body)).toEqual([{}])
    fireEvent.click(screen.getByRole('button', { name: 'Remove 1 files…' }))
    const dialog = await screen.findByRole('alertdialog', { name: 'Remove 1 orphaned files?' })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove for good' }))
    await waitFor(() => expect(calls.filter((c) => c.path === '/api/operator/storage/orphans').map((c) => c.body)).toEqual([{}, { scanId: 'scan_1' }]))
  })
})
