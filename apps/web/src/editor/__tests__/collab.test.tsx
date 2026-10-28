// Collaboration in the editor (E-22, A-23): the Comments panel (viewers comment too), comment marks on the ruler, pins
// on the canvas, live comment updates, and who else has the project open.
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { addAsset, addItem, createProject, createVideoItem, type Asset, type ReviewComment, type User, type Workspace } from '@producer/core'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { useSession } from '../../lib/session'
import { CanvasCommentPins, CommentMarks } from '../collab/CommentMarks'
import { CommentsPanel } from '../collab/CommentsPanel'
import { loadComments, onCommentEvent, resetComments, useComments } from '../collab/comments'
import { onPresenceEvent, PresenceAvatars, startPresence, usePresence } from '../collab/presence'
import { useEditor } from '../store'
import { TopBar } from '../TopBar'
import { startViewerMode } from '../viewer'

const S = () => useEditor.getState()
const me = { id: 'u_me', email: 'me@example.com', name: 'Mia', avatarColor: '#35e0ff', createdAt: 0 } as User
const space = (role: Workspace['role']): Workspace => ({ id: 'w1', name: 'Client review', role, personal: false, memberCount: 3 })
const clip: Asset = { id: 'as_a', kind: 'video', name: 'talk.mp4', src: '/api/media/as_a/source', duration: 30, width: 1920, height: 1080 }

type Call = { method: string; path: string; body?: any; keepalive?: boolean }
let calls: Call[] = []
let comments: ReviewComment[] = []
let stopViewer = () => undefined as void

const cm = (id: string, over: Partial<ReviewComment> = {}): ReviewComment => ({ id, projectId: 'p1', author: { id: 'u_ada', name: 'Ada', guest: false, color: '#ffc24d' }, body: `note ${id}`, at: 5, createdAt: 1, updatedAt: 1, canEdit: false, canDelete: false, ...over })

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver
  Element.prototype.scrollIntoView ??= () => undefined
})

function open(role: Workspace['role']) {
  useSession.setState({ status: 'ready', user: me, workspaces: [space(role)], workspaceId: 'w1' } as never)
  const p = addItem(addAsset(createProject({ id: 'p1', name: 'Cut' }), clip), createVideoItem(clip, 0, { id: 'v1' }))
  S().load({ project: p, version: 1, projectId: 'p1', demo: false, workspaceId: 'w1' })
  stopViewer = startViewerMode()
}

beforeEach(() => {
  calls = []
  useComments.setState({ showResolved: false })
  comments = [cm('c1'), cm('r1', { parentId: 'c1', at: undefined, body: 'agreed', createdAt: 2 }), cm('c2', { at: 12, body: 'done here', resolved: { at: 3, by: 'Ada' } })]
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const u = new URL(url, 'http://localhost')
      const c: Call = { method: (init.method ?? 'GET').toUpperCase(), path: u.pathname, body: init.body ? JSON.parse(String(init.body)) : undefined, keepalive: init.keepalive }
      calls.push(c)
      let body: unknown = { ok: true }
      if (c.path === '/api/projects/p1/comments' && c.method === 'GET') body = comments
      else if (c.path === '/api/projects/p1/comments') body = { id: `n${calls.length}`, projectId: 'p1', author: { id: me.id, name: me.name, guest: false }, body: c.body.body, ...(c.body.parentId ? { parentId: c.body.parentId } : { at: c.body.at, x: c.body.x, y: c.body.y }), createdAt: 9, updatedAt: 9, canEdit: true, canDelete: true }
      else if (c.path.startsWith('/api/comments/') && c.method === 'PATCH') body = { ...comments.find((x) => c.path.endsWith(x.id))!, canDelete: true, ...(c.body.resolved ? { resolved: { at: 9, by: me.name } } : { resolved: undefined }) }
      else if (c.path.startsWith('/api/comments/') && c.method === 'DELETE') body = { ok: true, removed: ['c1', 'r1'] }
      else if (c.path === '/api/projects/p1/presence') body = { projectId: 'p1', people: c.body?.open === false ? [] : [{ userId: me.id, name: me.name, color: me.avatarColor, role: 'editor', since: 1 }] }
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
    }),
  )
})
afterEach(() => {
  cleanup()
  stopViewer()
  resetComments()
  S().set({ readOnly: false, readOnlyTip: undefined })
  vi.unstubAllGlobals()
})

describe('the Comments panel (E-22)', () => {
  it('lists open threads by time with replies; jumps to a thread; adds a comment at the playhead with a point; replies', async () => {
    open('editor')
    await act(() => loadComments('p1'))
    render(<CommentsPanel />)
    const list = screen.getByRole('list', { name: 'Comment threads' })
    expect(within(list).getAllByRole('listitem', { name: /^At / }).map((li) => li.getAttribute('aria-label'))).toEqual(['At 0:05: Ada'])
    expect(within(list).getByText('agreed')).toBeTruthy()
    // the resolved one shows on asking
    fireEvent.click(screen.getByLabelText('Show resolved'))
    expect(within(list).getAllByRole('listitem', { name: /^At / })).toHaveLength(2)
    fireEvent.click(within(list).getByRole('button', { name: 'Go to 0:12' }))
    expect(S().playhead).toBe(12)
    // a new one at the playhead, pinned on the frame
    fireEvent.click(screen.getByRole('button', { name: /Point at the frame/ }))
    expect(useComments.getState().picking).toBe(true)
    render(<div style={{ position: 'relative' }}><CanvasCommentPins /></div>)
    const pick = screen.getByRole('button', { name: /Click the picture/ })
    pick.getBoundingClientRect = () => ({ left: 0, top: 0, width: 400, height: 200, right: 400, bottom: 200, x: 0, y: 0, toJSON: () => ({}) })
    fireEvent.click(pick, { clientX: 100, clientY: 150 })
    expect(useComments.getState().point).toEqual({ x: 0.25, y: 0.75 })
    fireEvent.change(screen.getByLabelText(/Comment at 0:12/), { target: { value: 'Too dark' } })
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Comment' })))
    expect(calls.find((c) => c.method === 'POST' && c.path === '/api/projects/p1/comments')!.body).toEqual({ body: 'Too dark', at: 12, x: 0.25, y: 0.75 })
    expect(useComments.getState().point).toBeUndefined()
    expect(await within(list).findByText('Too dark')).toBeTruthy()
    // reply by keyboard: Ctrl+Enter sends, the box closes
    const first = within(list).getAllByRole('listitem', { name: /^At 0:05/ })[0]
    fireEvent.click(within(first).getByRole('button', { name: 'Reply' }))
    const box = within(first).getByLabelText('Reply to Ada')
    expect(document.activeElement).toBe(box)
    fireEvent.change(box, { target: { value: 'on it' } })
    await act(async () => fireEvent.keyDown(box, { key: 'Enter', ctrlKey: true }))
    expect(calls.filter((c) => c.method === 'POST').at(-1)!.body).toEqual({ body: 'on it', parentId: 'c1' })
    expect(within(first).queryByLabelText('Reply to Ada')).toBeNull()
  })

  it('an editor resolves and removes; a viewer comments but can’t resolve someone else’s thread', async () => {
    open('editor')
    await act(() => loadComments('p1'))
    useComments.setState({ list: useComments.getState().list.map((c) => ({ ...c, canDelete: true })) })
    const { unmount } = render(<CommentsPanel />)
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Resolve' })))
    expect(calls.find((c) => c.method === 'PATCH')).toMatchObject({ path: '/api/comments/c1', body: { resolved: true } })
    fireEvent.click(screen.getByLabelText('Show resolved'))
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Delete the comment by Ada and its replies' })))
    expect(useComments.getState().list.map((c) => c.id)).toEqual(['c2'])
    unmount()
    stopViewer()
    open('viewer')
    await act(() => loadComments('p1'))
    render(<CommentsPanel />)
    const resolve = screen.getByRole('button', { name: 'Resolve' }) as HTMLButtonElement
    expect(resolve.disabled).toBe(true)
    expect(resolve.getAttribute('data-tip')).toMatch(/You’re a viewer/)
    // the composer is open to a viewer
    const box = screen.getByLabelText(/Comment at/) as HTMLTextAreaElement
    expect(box.disabled).toBe(false)
    fireEvent.change(box, { target: { value: 'From the client' } })
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Comment' })))
    expect(calls.filter((c) => c.method === 'POST' && c.path === '/api/projects/p1/comments')).toHaveLength(1)
  })

  it('live updates add, change and remove comments, with what this person may do', async () => {
    open('viewer')
    await act(() => loadComments('p1'))
    act(() => onCommentEvent({ projectId: 'p1', comment: cm('c9', { author: { id: me.id, name: me.name, guest: false }, at: 20 }) }))
    expect(useComments.getState().list.find((c) => c.id === 'c9')).toMatchObject({ canEdit: true, canDelete: true })
    act(() => onCommentEvent({ projectId: 'p1', comment: cm('c8', { at: 21 }) }))
    expect(useComments.getState().list.find((c) => c.id === 'c8')).toMatchObject({ canEdit: false, canDelete: false })
    act(() => onCommentEvent({ projectId: 'other', comment: cm('x') }))
    act(() => onCommentEvent({ projectId: 'p1', removed: ['c1', 'r1'] }))
    expect(useComments.getState().list.map((c) => c.id).sort()).toEqual(['c2', 'c8', 'c9'])
  })
})

describe('comment marks on the ruler (E-22)', () => {
  it('a mark per open thread; clicking one jumps there and opens it in the Comments panel', async () => {
    open('viewer')
    await act(() => loadComments('p1'))
    render(<div style={{ position: 'relative' }}><CommentMarks zoom={10} /></div>)
    const marks = within(screen.getByRole('group', { name: 'Comments on the timeline' })).getAllByRole('button')
    expect(marks.map((m) => m.getAttribute('aria-label'))).toEqual(['Comment by Ada at 0:05, 1 reply'])
    expect((marks[0] as HTMLElement).style.left).toBe('50px')
    fireEvent.click(marks[0])
    expect(S().playhead).toBe(5)
    expect(S().activeLeftTab).toBe('comments')
    expect(useComments.getState().activeId).toBe('c1')
  })
})

describe('presence (A-23)', () => {
  it('beats while open, shows the others with their role, and says goodbye on close', async () => {
    open('editor')
    vi.useFakeTimers()
    let stop!: () => void
    await act(async () => {
      stop = startPresence('p1')
    })
    expect(calls.filter((c) => c.path === '/api/projects/p1/presence' && c.body.open)).toHaveLength(1)
    await act(async () => void vi.advanceTimersByTime(20_000))
    expect(calls.filter((c) => c.path === '/api/projects/p1/presence' && c.body.open)).toHaveLength(2)
    vi.useRealTimers()
    render(
      <MemoryRouter>
        <TopBar />
      </MemoryRouter>,
    )
    // only me: no avatars
    expect(screen.queryByRole('group', { name: /this project open/ })).toBeNull()
    act(() =>
      onPresenceEvent({
        projectId: 'p1',
        people: [
          { userId: me.id, name: me.name, color: '#000', role: 'editor', since: 1 },
          { userId: 'u_ada', name: 'Ada', color: '#ffc24d', role: 'owner', since: 2 },
          { userId: 'u_bo', name: 'Bo', color: '#5be49b', role: 'viewer', since: 3 },
        ],
      }),
    )
    expect(screen.getByRole('group', { name: '2 other people have this project open: Ada (owner), Bo (viewing)' })).toBeTruthy()
    act(() => onPresenceEvent({ projectId: 'elsewhere', people: [] }))
    expect(usePresence.getState().people).toHaveLength(3)
    stop()
    const bye = calls.at(-1)!
    expect(bye).toMatchObject({ path: '/api/projects/p1/presence', body: { open: false }, keepalive: true })
    expect(usePresence.getState().people).toEqual([])
    render(<PresenceAvatars />)
  })
})
