// Collaboration in the shell (A-16, E-22, A-23): the share page honours a link's settings (expiry, password,
// downloads, comments with a name), share links are managed from a list, and the space's activity has a page.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { ActivityEntry, ShareLinkDetails, User, Workspace } from '@producer/core'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useSession } from '../../lib/session'
import { ShareLinkList, ShareLinksDialog } from '../components/ShareLinks'
import ActivityPage from '../pages/ActivityPage'
import { SharePage } from '../SharePage'

type Call = { method: string; path: string; body?: any; headers: Record<string, string>; credentials?: RequestCredentials }
let calls: Call[] = []
let handler: (c: Call) => { status?: number; body: unknown } = () => ({ body: {} })

beforeEach(() => {
  calls = []
  sessionStorage.clear()
  localStorage.clear()
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const u = new URL(url, 'http://localhost')
      const c: Call = { method: (init.method ?? 'GET').toUpperCase(), path: u.pathname + u.search, body: init.body ? JSON.parse(String(init.body)) : undefined, headers: (init.headers ?? {}) as Record<string, string>, credentials: init.credentials }
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

const page = { project: { name: 'Launch', width: 1920, height: 1080, duration: 30, updatedAt: Date.now() }, videoUrl: '/api/share/tok/video', allowDownload: true, allowComments: false }

function openShare() {
  return render(
    <MemoryRouter initialEntries={['/r/tok']}>
      <Routes>
        <Route path="/r/:token" element={<SharePage />} />
      </Routes>
    </MemoryRouter>,
  )
}

describe('the share page (A-16)', () => {
  it('asks for the password, unlocks with the key, and keeps it for the tab; never sends cookies', async () => {
    handler = (c) => {
      if (c.path === '/api/share/tok/unlock') return c.body.password === 'sesame' ? { body: { key: 'k1' } } : { status: 403, body: { error: 'That password isn’t right.' } }
      if (c.path === '/api/share/tok') return c.headers['x-share-key'] === 'k1' ? { body: page } : { status: 401, body: { error: 'locked', code: 'unauthorized', details: { password: true } } }
      return { body: {} }
    }
    openShare()
    const pw = await screen.findByLabelText('Password')
    expect(screen.getByRole('heading', { name: 'This video needs a password' })).toBeTruthy()
    expect(document.activeElement).toBe(pw)
    fireEvent.change(pw, { target: { value: 'nope' } })
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Watch' })))
    expect((await screen.findByRole('alert')).textContent).toMatch(/isn’t right/)
    fireEvent.change(pw, { target: { value: 'sesame' } })
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Watch' })))
    expect(await screen.findByRole('heading', { name: 'Launch' })).toBeTruthy()
    expect(sessionStorage.getItem('ps.share.key.tok')).toBe('k1')
    expect(calls.every((c) => c.credentials === 'omit')).toBe(true)
  })

  it('says an expired link has expired', async () => {
    handler = () => ({ status: 410, body: { error: 'This link has expired.' } })
    openShare()
    expect(await screen.findByRole('heading', { name: 'Link expired' })).toBeTruthy()
  })

  it('offers a download only when the link allows it', async () => {
    handler = () => ({ body: { ...page, downloadUrl: '/api/share/tok/video?download=1' } })
    const { unmount } = openShare()
    expect(((await screen.findByRole('link', { name: /Download/ })) as HTMLAnchorElement).getAttribute('href')).toBe('/api/share/tok/video?download=1')
    unmount()
    handler = () => ({ body: { ...page, allowDownload: false } })
    openShare()
    await screen.findByRole('heading', { name: 'Launch' })
    expect(screen.queryByRole('link', { name: /Download/ })).toBeNull()
    expect(document.querySelector('video')!.getAttribute('controlslist')).toBe('nodownload')
  })
})

describe('share-page comments (E-22)', () => {
  it('visitors read threads, jump to their moment, and comment with a name at the video’s time and a point', async () => {
    const thread = { id: 'c1', projectId: 'p', author: { name: 'Ada', guest: false, color: '#fff' }, body: 'Swap this shot', at: 4, createdAt: 1, updatedAt: 1 }
    handler = (c) => {
      if (c.path === '/api/share/tok') return { body: { ...page, allowComments: true } }
      if (c.path === '/api/share/tok/comments' && c.method === 'GET') return { body: [thread] }
      if (c.path === '/api/share/tok/comments') return { body: { id: 'c2', projectId: 'p', author: { name: c.body.name, guest: true }, body: c.body.body, at: c.body.at, x: c.body.x, y: c.body.y, createdAt: 2, updatedAt: 2 } }
      return { body: {} }
    }
    openShare()
    const list = await screen.findByRole('list', { name: 'Comment threads' })
    const video = document.querySelector('video')!
    video.pause = () => undefined
    fireEvent.click(within(list).getByRole('button', { name: 'Go to 0:04' }))
    expect(video.currentTime).toBe(4)
    // a name is needed
    fireEvent.change(screen.getByLabelText('Comment'), { target: { value: 'Love the colour' } })
    expect((screen.getByRole('button', { name: 'Comment' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.change(screen.getByLabelText('Your name'), { target: { value: 'Carla' } })
    // point at the frame: the next click on the video picks it
    fireEvent.click(screen.getByRole('button', { name: /Point at the frame/ }))
    const pick = screen.getByRole('button', { name: /Click the picture/ })
    pick.getBoundingClientRect = () => ({ left: 0, top: 0, width: 200, height: 100, right: 200, bottom: 100, x: 0, y: 0, toJSON: () => ({}) })
    fireEvent.click(pick, { clientX: 50, clientY: 25 })
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Comment' })))
    const sent = calls.find((c) => c.method === 'POST' && c.path === '/api/share/tok/comments')!
    expect(sent.body).toMatchObject({ body: 'Love the colour', name: 'Carla', at: 4, x: 0.25, y: 0.25 })
    expect(await within(list).findByText('Love the colour')).toBeTruthy()
    expect(localStorage.getItem('ps.share.name')).toBe('Carla')
  })
})

const link = (over: Partial<ShareLinkDetails> = {}): ShareLinkDetails => ({
  token: 't1',
  url: '/r/t1',
  exportId: 'e1',
  createdAt: Date.now() - 3600_000,
  projectId: 'p1',
  projectName: 'Launch',
  exportName: 'Cut 1',
  createdBy: { id: 'u1', name: 'Ada' },
  views: 3,
  lastViewedAt: Date.now() - 60_000,
  expiresAt: null,
  expired: false,
  hasPassword: false,
  allowDownload: true,
  allowComments: false,
  ...over,
})

describe('share-link management (A-16)', () => {
  it('lists who made each link, its views and settings; editors change settings and revoke', async () => {
    handler = (c) => (c.method === 'PATCH' ? { body: { ...link(), hasPassword: true, allowComments: true, expiresAt: Date.now() + 7 * 864e5 } } : { body: { ok: true } })
    let links = [link()]
    const onChange = vi.fn((l: ShareLinkDetails[]) => (links = l))
    const { rerender } = render(<ShareLinkList links={links} gate={{ canEdit: true }} showProject onChange={onChange} />)
    const row = screen.getByRole('listitem', { name: 'Launch link' })
    expect(row.textContent).toMatch(/Made by Ada/)
    expect(row.textContent).toMatch(/3 views, last 1 minute ago|3 views, last/)
    expect(row.textContent).toMatch(/Never expires/)
    fireEvent.click(within(row).getByRole('button', { name: 'Settings for the Launch link' }))
    const form = within(row).getByRole('form', { name: 'Link settings' })
    fireEvent.change(within(form).getByLabelText('Expiry'), { target: { value: '7d' } })
    fireEvent.change(within(form).getByLabelText('Password'), { target: { value: 'abc' } })
    fireEvent.click(within(form).getByLabelText(/Allow comments/))
    await act(async () => fireEvent.click(within(form).getByRole('button', { name: 'Save' })))
    expect(within(form).getByRole('alert').textContent).toMatch(/at least 4/)
    fireEvent.change(within(form).getByLabelText('Password'), { target: { value: 'abcd' } })
    await act(async () => fireEvent.click(within(form).getByRole('button', { name: 'Save' })))
    const patch = calls.find((c) => c.method === 'PATCH')!
    expect(patch.path).toBe('/api/share/t1')
    expect(patch.body).toMatchObject({ password: 'abcd', allowComments: true })
    expect(patch.body.expiresAt).toBeGreaterThan(Date.now() + 6 * 864e5)
    expect(onChange).toHaveBeenCalled()
    rerender(<ShareLinkList links={links} gate={{ canEdit: true }} showProject onChange={onChange} />)
    expect(screen.getByRole('listitem', { name: 'Launch link' }).textContent).toMatch(/Password.*Comments on/)
    // revoke asks first, Cancel focused
    fireEvent.click(screen.getByRole('button', { name: 'Revoke the Launch link' }))
    const dlg = screen.getByRole('alertdialog')
    expect(document.activeElement).toBe(within(dlg).getByRole('button', { name: 'Cancel' }))
    await act(async () => fireEvent.click(within(dlg).getByRole('button', { name: 'Revoke link' })))
    expect(calls.some((c) => c.method === 'DELETE' && c.path === '/api/share/t1')).toBe(true)
    expect(links).toEqual([])
  })

  it('a viewer sees the links and copies them, but Settings and Revoke say who can', () => {
    render(<ShareLinkList links={[link({ expired: true, expiresAt: Date.now() - 1000 })]} gate={{ canEdit: false, tip: 'Only owners and editors can do this.' }} onChange={() => undefined} />)
    expect(screen.getByText('Expired')).toBeTruthy()
    for (const name of [/^Settings for/, /^Revoke/]) {
      const b = screen.getByRole('button', { name })
      expect((b as HTMLButtonElement).disabled).toBe(true)
      expect(b.getAttribute('data-tip')).toMatch(/Only owners and editors/)
    }
    expect((screen.getByRole('button', { name: /^Copy/ }) as HTMLButtonElement).disabled).toBe(false)
  })

  it('the editor’s Share dialog makes a new link, and says to export first when there is nothing to show', async () => {
    let exported = false
    handler = (c) => {
      if (c.method === 'GET') return { body: [] }
      return exported ? { body: link({ token: 't2' }) } : { status: 409, body: { error: 'Export the video first', code: 'conflict' } }
    }
    const onExport = vi.fn()
    render(<ShareLinksDialog projectId="p1" gate={{ canEdit: true }} onClose={() => undefined} onExportFirst={onExport} />)
    await screen.findByText('No share links yet.')
    await act(async () => fireEvent.click(screen.getByRole('button', { name: /Create a link/ })))
    fireEvent.click(await screen.findByRole('button', { name: 'Export' }))
    expect(onExport).toHaveBeenCalled()
    exported = true
    await act(async () => fireEvent.click(screen.getByRole('button', { name: /Create a link/ })))
    expect(await screen.findByRole('listitem', { name: 'Cut 1 link' })).toBeTruthy()
    expect(calls.filter((c) => c.method === 'POST').at(-1)!.body).toEqual({ new: false })
  })
})

describe('the activity page (A-23)', () => {
  it('lists what happened, newest first, filters by kind and pages older entries', async () => {
    const me = { id: 'u1', email: 'a@example.com', name: 'Ada', avatarColor: '#fff', createdAt: 0 } as User
    const ws = { id: 'w1', name: 'Team', role: 'viewer', personal: false, memberCount: 2 } as Workspace
    useSession.setState({ status: 'ready', user: me, workspaces: [ws], workspaceId: 'w1' } as never)
    const e = (id: string, kind: ActivityEntry['kind'], data: Record<string, unknown>, projectId?: string): ActivityEntry => ({ id, workspaceId: 'w1', projectId, actor: { name: 'Ada' }, kind, data, createdAt: Date.now() - 60_000 })
    handler = (c) =>
      c.path.includes('cursor=')
        ? { body: { items: [e('a3', 'member.joined', { role: 'viewer' })] } }
        : { body: { items: [e('a1', 'project.exported', { project: 'Launch', format: 'mp4', resolution: '1080p' }, 'p1'), e('a2', 'comment.added', { project: 'Launch' }, 'p1')], nextCursor: 'c1' } }
    render(
      <MemoryRouter>
        <ActivityPage />
      </MemoryRouter>,
    )
    const list = await screen.findByRole('list', { name: 'Activity, newest first' })
    expect(within(list).getAllByRole('listitem').map((li) => li.textContent?.split(' · ')[0])).toEqual(['Ada exported “Launch” (1080p MP4)', 'Ada commented on “Launch”'])
    expect(within(list).getAllByRole('link', { name: 'Open Launch' })[0].getAttribute('href')).toBe('/edit/p1')
    expect(calls[0].path).toBe('/api/workspaces/w1/activity?limit=50')
    await act(async () => fireEvent.click(screen.getByRole('button', { name: /Show older/ })))
    await waitFor(() => expect(within(list).getAllByRole('listitem')).toHaveLength(3))
    expect(screen.queryByRole('button', { name: /Show older/ })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Members' }))
    expect(within(screen.getByRole('list', { name: 'Activity, newest first' })).getAllByRole('listitem').map((li) => li.textContent)).toEqual([expect.stringMatching(/joined the space as viewer/)])
  })
})
