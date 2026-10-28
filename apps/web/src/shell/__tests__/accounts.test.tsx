// Release 3, accounts and mail in the app: the Account page (A-17), forgot / reset password and email confirmation
// pages (P-22), invites with Resend and expiry and handing a space over (A-1, A-2), toasts with several buttons, job
// notices and export Retry (A-8).
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { AccountInfo, Job, Member, PendingInvite, User, Workspace } from '@producer/core'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '../../lib/api'
import { claimJobNotice, setNotifyPrefs } from '../../lib/notify'
import { useSession } from '../../lib/session'
import { toast, useToasts } from '../../lib/toast'
import { Toasts } from '../../lib/Toasts'
import { ForgotPage, ResetPage, VerifyPage } from '../AccountAuthPages'
import { AuthPage } from '../AuthPage'
import { jobTarget, useJobNotices } from '../jobNotices'
import AccountPage, { describeAgent } from '../pages/AccountPage'
import SpacePage, { inviteLine } from '../pages/SpacePage'
import { liveBus } from '../stores'
import { useSystem } from '../system'

type Call = { method: string; path: string; body?: any }
let calls: Call[] = []
let handler: (c: Call) => { status?: number; body: unknown } = () => ({ body: {} })

const me: User = { id: 'u_me', email: 'sam@example.com', name: 'Sam Lee', avatarColor: '#ff5a5f', createdAt: 1 }
const team: Workspace = { id: 'ws_team', name: 'Launch crew', role: 'owner', personal: false, memberCount: 2 }
const cloud = (mail: boolean) => useSystem.setState({ info: { mode: 'cloud', version: '1', ai: { provider: 'anthropic-api', available: true, detail: '' }, capabilities: { transcribe: true, tts: true, render: true }, mail }, loaded: true })

const account = (o: Partial<AccountInfo> = {}): AccountInfo => ({ user: me, emailVerified: false, mail: true, notifications: { browser: true, emailJobs: false }, soleOwnerOf: [], ...o })

beforeEach(() => {
  calls = []
  localStorage.clear()
  useToasts.setState({ toasts: [] })
  useSession.setState({ status: 'ready', user: me, workspaces: [team], workspaceId: team.id })
  cloud(true)
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
  vi.restoreAllMocks()
})

const at = (path: string, el: React.ReactNode, route = path) =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path={route} element={el} />
        <Route path="/" element={<div>Home page</div>} />
        <Route path="/login" element={<div>Sign-in page</div>} />
      </Routes>
    </MemoryRouter>,
  )

describe('signed-out account pages (P-22)', () => {
  it('the sign-in page links to Forgot password', () => {
    useSession.setState({ status: 'anon', user: undefined })
    at('/login', <AuthPage mode="login" />)
    expect(screen.getByRole('link', { name: 'Forgot password?' }).getAttribute('href')).toBe('/forgot')
  })

  it('Forgot password says to check the inbox, or that this server sends no mail', async () => {
    handler = () => ({ body: { ok: true, mail: true } })
    at('/forgot', <ForgotPage />)
    fireEvent.click(screen.getByRole('button', { name: 'Send reset link' }))
    expect((await screen.findByRole('alert')).textContent).toMatch(/Enter the email/)
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'sam@example.com' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send reset link' }))
    expect(await screen.findByRole('heading', { name: 'Check your inbox' })).toBeTruthy()
    expect(calls.at(-1)).toMatchObject({ method: 'POST', path: '/api/auth/forgot', body: { email: 'sam@example.com' } })
    cleanup()
    handler = () => ({ body: { ok: true, mail: false } })
    at('/forgot', <ForgotPage />)
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'sam@example.com' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send reset link' }))
    expect(await screen.findByRole('heading', { name: 'Email isn’t set up here' })).toBeTruthy()
    expect(screen.getByRole('link', { name: /Back to sign in/ })).toBeTruthy()
  })

  it('a reset link sets a new password and signs this browser in', async () => {
    useSession.setState({ status: 'anon', user: undefined })
    handler = (c) => {
      if (c.path === '/api/auth/reset/tok1') return { body: { email: 'sam@example.com' } }
      if (c.path === '/api/auth/reset') return { body: { user: me, workspaces: [team] } }
      if (c.path === '/api/auth/me') return { body: { user: me, workspaces: [team] } }
      return { body: {} }
    }
    at('/reset/tok1', <ResetPage />, '/reset/:token')
    expect(await screen.findByText(/For sam@example.com/)).toBeTruthy()
    const pw = screen.getByLabelText('New password')
    expect(document.activeElement).toBe(pw)
    fireEvent.change(pw, { target: { value: 'short' } })
    fireEvent.click(screen.getByRole('button', { name: 'Set new password' }))
    expect(screen.getByRole('alert').textContent).toMatch(/at least 8/)
    fireEvent.change(pw, { target: { value: 'a-much-better-one' } })
    fireEvent.click(screen.getByRole('button', { name: 'Set new password' }))
    expect(await screen.findByText('Home page')).toBeTruthy()
    expect(calls.find((c) => c.path === '/api/auth/reset')?.body).toEqual({ token: 'tok1', password: 'a-much-better-one' })
    expect(useSession.getState().status).toBe('ready')
  })

  it('a used or expired reset link says so and offers a new one', async () => {
    handler = () => ({ status: 410, body: { error: 'This link has expired. Ask for a new one.', code: 'conflict' } })
    at('/reset/old', <ResetPage />, '/reset/:token')
    expect(await screen.findByRole('heading', { name: 'This link doesn’t work' })).toBeTruthy()
    expect(screen.getByRole('alert').textContent).toMatch(/expired/)
    expect(screen.getByRole('link', { name: 'Send a new link' }).getAttribute('href')).toBe('/forgot')
  })

  it('a confirmation link is used once and says what changed', async () => {
    handler = (c) => (c.path === '/api/auth/verify' ? { body: { ok: true, email: 'new@example.com', purpose: 'email' } } : { body: { user: me, workspaces: [team] } })
    at('/verify/v1', <VerifyPage />, '/verify/:token')
    expect(await screen.findByRole('heading', { name: 'Your email changed' })).toBeTruthy()
    expect(screen.getByRole('status').textContent).toMatch(/You now sign in with new@example.com/)
    expect(calls.filter((c) => c.path === '/api/auth/verify')).toHaveLength(1)
  })
})

describe('the Account page (A-17)', () => {
  function routes(info: AccountInfo, extra: (c: Call) => { status?: number; body: unknown } | undefined = () => undefined) {
    handler = (c) => {
      const e = extra(c)
      if (e) return e
      if (c.path === '/api/account' && c.method === 'GET') return { body: info }
      if (c.path === '/api/account/sessions') return { body: [{ id: 's1', current: true, userAgent: 'Mozilla/5.0 (Windows NT 10.0) Chrome/130', createdAt: Date.now() - 3600_000, expiresAt: Date.now() + 1e9 }, { id: 's2', current: false, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Safari/604', createdAt: Date.now() - 86400_000, lastSeenAt: Date.now() - 60_000, expiresAt: Date.now() + 1e9 }] }
      if (c.path === '/api/devices') return { body: [{ id: 'd1', name: 'Studio PC', createdAt: Date.now() - 86400_000, lastSeenAt: Date.now() - 600_000, expiresAt: Date.now() + 80 * 86400_000 }] }
      return { body: { ok: true } }
    }
  }
  const open = () => at('/account', <AccountPage />)

  it('saves the name and picks an avatar colour with the arrow keys', async () => {
    routes(account(), (c) => (c.method === 'PATCH' ? { body: account({ user: { ...me, ...c.body } }) } : undefined))
    open()
    const name = await screen.findByLabelText('Name')
    fireEvent.change(name, { target: { value: 'Sam Rivera' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(useSession.getState().user?.name).toBe('Sam Rivera'))
    const group = screen.getByRole('radiogroup', { name: 'Avatar colour' })
    const first = within(group).getByRole('radio', { name: 'Colour 1' })
    expect(first.getAttribute('aria-checked')).toBe('true')
    expect(first.tabIndex).toBe(0)
    fireEvent.keyDown(first, { key: 'ArrowRight' })
    await waitFor(() => expect(calls.at(-1)).toMatchObject({ method: 'PATCH', body: { avatarColor: '#35e0ff' } }))
    expect(document.activeElement).toBe(within(group).getByRole('radio', { name: 'Colour 2' }))
  })

  it('shows whether the email is confirmed, resends the confirmation, and changes the address with the password', async () => {
    routes(account(), (c) => (c.path === '/api/account/email' ? (c.body.password === 'right-pass' ? { body: { ok: true, pending: c.body.email } } : { status: 403, body: { error: 'That password isn’t right' } }) : undefined))
    open()
    expect(await screen.findByText(/Not confirmed yet/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Send confirmation again' }))
    await waitFor(() => expect(calls.some((c) => c.path === '/api/account/verify')).toBe(true))
    const form = screen.getByRole('form', { name: 'Change email' })
    fireEvent.change(within(form).getByLabelText('New email'), { target: { value: 'sam@new.example' } })
    fireEvent.change(within(form).getByLabelText('Your password'), { target: { value: 'wrong' } })
    fireEvent.click(within(form).getByRole('button', { name: 'Change email' }))
    expect((await within(form).findByRole('alert')).textContent).toBe('That password isn’t right')
    fireEvent.change(within(form).getByLabelText('Your password'), { target: { value: 'right-pass' } })
    fireEvent.click(within(form).getByRole('button', { name: 'Change email' }))
    await waitFor(() => expect(useToasts.getState().toasts.some((t) => /Check sam@new.example/.test(t.text))).toBe(true))
  })

  it('changes the password, showing the server’s refusal', async () => {
    routes(account(), (c) => (c.path === '/api/account/password' ? (c.body.current === 'old-pass-1' ? { body: { ok: true } } : { status: 403, body: { error: 'That password isn’t right' } }) : undefined))
    open()
    const form = await screen.findByRole('form', { name: 'Change password' })
    fireEvent.change(within(form).getByLabelText('Current password'), { target: { value: 'nope' } })
    fireEvent.change(within(form).getByLabelText('New password'), { target: { value: 'new-pass-123' } })
    fireEvent.click(within(form).getByRole('button', { name: 'Change password' }))
    expect((await within(form).findByRole('alert')).textContent).toBe('That password isn’t right')
    fireEvent.change(within(form).getByLabelText('Current password'), { target: { value: 'old-pass-1' } })
    fireEvent.click(within(form).getByRole('button', { name: 'Change password' }))
    await waitFor(() => expect(useToasts.getState().toasts.some((t) => /Password changed/.test(t.text))).toBe(true))
    expect((within(form).getByLabelText('Current password') as HTMLInputElement).value).toBe('')
  })

  it('lists browsers and desktop apps, signs one out, and signs out everywhere after asking', async () => {
    routes(account(), (c) => (c.path === '/api/account/sign-out-everywhere' ? { body: { ok: true, sessions: 1, devices: 1 } } : undefined))
    open()
    const list = await screen.findByRole('list', { name: 'Signed-in browsers and apps' })
    expect(within(list).getByText(/Chrome on Windows/).textContent).toMatch(/this browser/)
    expect(within(list).getByText('Studio PC')).toBeTruthy()
    expect(within(list).getByText(/stops working if unused until/)).toBeTruthy()
    fireEvent.click(within(list).getByRole('button', { name: /Sign out Safari on iOS/ }))
    await waitFor(() => expect(calls.some((c) => c.method === 'DELETE' && c.path === '/api/account/sessions/s2')).toBe(true))
    expect(within(list).queryByText(/Safari on iOS/)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /Sign out everywhere/ }))
    const dialog = screen.getByRole('alertdialog', { name: 'Sign out everywhere else?' })
    expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: 'Cancel' }))
    fireEvent.click(within(dialog).getByRole('button', { name: 'Sign out everywhere' }))
    await waitFor(() => expect(calls.some((c) => c.path === '/api/account/sign-out-everywhere')).toBe(true))
    expect(useToasts.getState().toasts.at(-1)?.text).toBe('Signed out 1 other browser and unlinked 1 app')
  })

  it('turns job emails on, and can’t when the server sends no mail', async () => {
    routes(account(), (c) => (c.path === '/api/account/notifications' ? { body: { browser: true, emailJobs: c.body.emailJobs } } : undefined))
    open()
    const email = await screen.findByRole('switch', { name: 'Email when a job finishes' })
    expect(email.getAttribute('aria-checked')).toBe('false')
    fireEvent.click(email)
    await waitFor(() => expect(email.getAttribute('aria-checked')).toBe('true'))
    expect(calls.find((c) => c.path === '/api/account/notifications')?.body).toEqual({ emailJobs: true })
    cleanup()
    routes(account({ mail: false }))
    open()
    expect(((await screen.findByRole('switch', { name: 'Email when a job finishes' })) as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getAllByText(/doesn’t send email/).length).toBeGreaterThan(0)
  })

  it('won’t delete an account that is the only owner of a shared space; otherwise asks, then signs out', async () => {
    routes(account({ soleOwnerOf: [{ id: 'ws_team', name: 'Launch crew' }] }))
    open()
    expect((await screen.findByRole('note')).textContent).toMatch(/only owner of “Launch crew”/)
    expect(screen.queryByRole('button', { name: /Delete account/ })).toBeNull()
    cleanup()
    routes(account())
    const logout = vi.spyOn(useSession.getState(), 'logout').mockResolvedValue()
    useSession.setState({ logout })
    open()
    fireEvent.change(await screen.findByLabelText('Password to delete your account'), { target: { value: 'pw-123456' } })
    fireEvent.click(screen.getByRole('button', { name: /Delete account/ }))
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Delete my account' }))
    expect(await screen.findByText('Sign-in page')).toBeTruthy()
    expect(calls.find((c) => c.method === 'DELETE' && c.path === '/api/account')?.body).toEqual({ password: 'pw-123456' })
    expect(logout).toHaveBeenCalled()
  })

  it('on the desktop app only the profile and notifications are here', async () => {
    useSystem.setState({ info: { mode: 'desktop', version: '1', ai: { provider: 'claude-cli', available: true, detail: '' }, capabilities: { transcribe: true, tts: true, render: true } }, loaded: true })
    routes(account({ mail: false }))
    open()
    expect(await screen.findByRole('heading', { name: 'Profile' })).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'Notifications' })).toBeTruthy()
    expect(screen.queryByRole('heading', { name: 'Password' })).toBeNull()
    expect(screen.queryByRole('heading', { name: 'Delete account' })).toBeNull()
    expect(screen.getByText(/managed on Producer Studio cloud/)).toBeTruthy()
  })

  it('names browsers in plain words', () => {
    expect(describeAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit Version/17 Safari/605')).toBe('Safari on macOS')
    expect(describeAgent('Mozilla/5.0 (Windows NT 10.0; Win64) Chrome/130 Edg/130')).toBe('Edge on Windows')
    expect(describeAgent(undefined)).toBe('Unknown browser')
  })
})

describe('invites and handing a space over (A-1, A-2)', () => {
  const members: Member[] = [
    { userId: me.id, name: me.name, email: me.email, role: 'owner' },
    { userId: 'u_kim', name: 'Kim Park', email: 'kim@example.com', role: 'editor' },
  ]
  const soon = Date.now() + 5 * 86400_000
  const pendingList: PendingInvite[] = [
    { token: 't1', email: 'ana@example.com', role: 'editor', createdAt: Date.now() - 1000, expiresAt: soon, inviteUrl: '/invite/t1', status: 'pending', sentAt: Date.now() - 120_000 },
    { token: 't2', email: 'old@example.com', role: 'viewer', createdAt: Date.now() - 9 * 86400_000, expiresAt: Date.now() - 2 * 86400_000, inviteUrl: '/invite/t2', status: 'expired' },
  ]
  function open() {
    vi.spyOn(api, 'members').mockResolvedValue(members)
    vi.spyOn(api, 'invites').mockResolvedValue(pendingList)
    vi.spyOn(api, 'workspaces').mockResolvedValue([{ ...team, role: 'editor' }])
    return render(
      <MemoryRouter>
        <SpacePage />
      </MemoryRouter>,
    )
  }

  it('lists waiting invites with when they were emailed and when they expire, and resends one', async () => {
    handler = (c) => (c.path.endsWith('/resend') ? { body: { ...pendingList[1], status: 'pending', expiresAt: soon, emailed: true } } : { body: {} })
    open()
    expect(await screen.findByText('ana@example.com')).toBeTruthy()
    expect(screen.getByText(/Editor · emailed .* · link works until/)).toBeTruthy()
    expect(screen.getByText(/Viewer · expired .*send it again/)).toBeTruthy()
    // an expired link isn't offered to copy
    expect(screen.getByRole('button', { name: 'Copy the invite link for ana@example.com' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Copy the invite link for old@example.com' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Resend the invite to old@example.com' }))
    await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.path === '/api/workspaces/ws_team/invites/t2/resend')).toBe(true))
    expect(useToasts.getState().toasts.at(-1)?.text).toBe('Sent the invite to old@example.com again')
    expect(screen.getByRole('button', { name: 'Withdraw the invite for ana@example.com' })).toBeTruthy()
  })

  it('without mail, Renew gives the link 7 more days and says to send it by hand', async () => {
    cloud(false)
    handler = (c) => (c.path.endsWith('/resend') ? { body: { ...pendingList[0], emailed: false } } : { body: {} })
    open()
    fireEvent.click(await screen.findByRole('button', { name: 'Renew the invite link for ana@example.com' }))
    await waitFor(() => expect(useToasts.getState().toasts.at(-1)?.text).toMatch(/7 more days. Copy it/))
  })

  it('hands the space over after asking, and the owner becomes an editor', async () => {
    open()
    const select = await screen.findByLabelText('Member to hand the space to')
    await screen.findByRole('option', { name: 'Kim Park' })
    expect((screen.getByRole('button', { name: /Hand over/ }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.change(select, { target: { value: 'u_kim' } })
    fireEvent.click(screen.getByRole('button', { name: /Hand over/ }))
    const dialog = screen.getByRole('alertdialog', { name: 'Hand “Launch crew” over to Kim Park?' })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Hand over' }))
    await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.path === '/api/workspaces/ws_team/members/u_kim/transfer')).toBe(true))
    await waitFor(() => expect(useSession.getState().workspaces[0].role).toBe('editor'))
    expect(useToasts.getState().toasts.at(-1)?.text).toMatch(/Kim Park is now an owner/)
  })

  it('a role change can be undone from its toast', async () => {
    const setRole = vi.spyOn(api, 'setMemberRole').mockImplementation(async (_w, _u, role) => ({ ok: true, role }))
    open()
    fireEvent.change(await screen.findByLabelText('Role for Kim Park'), { target: { value: 'viewer' } })
    await waitFor(() => expect(useToasts.getState().toasts.at(-1)?.text).toBe('Kim Park is now viewer'))
    const t = useToasts.getState().toasts.at(-1)!
    expect(t.actions?.map((a) => a.label)).toEqual(['Undo'])
    act(() => t.action!.run())
    await waitFor(() => expect(setRole).toHaveBeenLastCalledWith('ws_team', 'u_kim', 'editor'))
    // undoing doesn't offer to undo again
    await waitFor(() => expect(useToasts.getState().toasts.at(-1)?.text).toBe('Kim Park is now editor'))
    expect(useToasts.getState().toasts.at(-1)?.actions).toBeUndefined()
  })

  it('describes an invite line', () => {
    expect(inviteLine({ ...pendingList[0], sentAt: undefined })).toMatch(/^Editor · link works until/)
  })
})

describe('toasts with several buttons (A-8)', () => {
  it('shows each button, runs one and closes, and Escape or the close button dismisses', () => {
    const open = vi.fn()
    const retry = vi.fn()
    render(<Toasts />)
    act(() => void toast('Export failed', [{ label: 'Retry', run: retry }, { label: 'Open', run: open }]))
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Open' }))
    expect(open).toHaveBeenCalled()
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull()
    act(() => void toast('Another', [{ label: 'Undo', run: retry }]))
    fireEvent.keyDown(screen.getByRole('button', { name: 'Undo' }), { key: 'Escape' })
    expect(screen.queryByText('Another')).toBeNull()
    act(() => void toast('Third', { label: 'Open', run: open }))
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    expect(screen.queryByText('Third')).toBeNull()
    expect(retry).not.toHaveBeenCalled()
  })
})

describe('job notices (A-8)', () => {
  const job = (o: Partial<Job>): Job => ({ id: 'j1', kind: 'ai.produce.assemble', status: 'running', progress: 0.5, message: '', workspaceId: 'ws_team', projectId: 'p1', createdAt: 1, updatedAt: 2, startedBy: me.id, ...o })
  function Probe() {
    useJobNotices()
    return null
  }
  const mount = () =>
    render(
      <MemoryRouter initialEntries={['/library']}>
        <Routes>
          <Route path="*" element={<Probe />} />
        </Routes>
      </MemoryRouter>,
    )

  it('announces the end of a long job you started and watched, with Open; never someone else’s', async () => {
    setNotifyPrefs({ browser: true, emailJobs: false })
    mount()
    act(() => liveBus.emitJob(job({ id: 'j-other', startedBy: 'u_else' })))
    act(() => liveBus.emitJob(job({ id: 'j-other', startedBy: 'u_else', status: 'done' })))
    // a job seen only after it ended (a reload) isn't announced
    act(() => liveBus.emitJob(job({ id: 'j-old', status: 'done' })))
    expect(useToasts.getState().toasts).toHaveLength(0)
    act(() => liveBus.emitJob(job({ id: 'j-mine' })))
    act(() => liveBus.emitJob(job({ id: 'j-mine', status: 'done' })))
    const t = useToasts.getState().toasts.find((x) => x.text === 'Your Producer AI video is ready')!
    expect(t.action?.label).toBe('Open')
    act(() => liveBus.emitJob(job({ id: 'j-bad', kind: 'ai.transcribe' })))
    act(() => liveBus.emitJob(job({ id: 'j-bad', kind: 'ai.transcribe', status: 'error', error: 'No speech found' })))
    expect(useToasts.getState().toasts.at(-1)).toMatchObject({ kind: 'error', text: 'Transcribing failed: No speech found' })
    // exports announce themselves
    claimJobNotice('j-exp')
    act(() => liveBus.emitJob(job({ id: 'j-exp', kind: 'export.render' })))
    act(() => liveBus.emitJob(job({ id: 'j-exp', kind: 'export.render', status: 'done' })))
    expect(useToasts.getState().toasts).toHaveLength(2)
  })

  it('offers browser notifications once, from a button, on the first long job', async () => {
    const requestPermission = vi.fn(async () => 'granted')
    vi.stubGlobal('Notification', Object.assign(function () {}, { permission: 'default', requestPermission }))
    setNotifyPrefs({ browser: true, emailJobs: false })
    mount()
    act(() => liveBus.emitJob(job({ id: 'j-a' })))
    await waitFor(() => expect(useToasts.getState().toasts.some((t) => /browser notification/.test(t.text))).toBe(true))
    const offer = useToasts.getState().toasts.find((t) => /browser notification/.test(t.text))!
    expect(offer.actions?.map((a) => a.label)).toEqual(['Turn on', 'Not now'])
    act(() => offer.action!.run())
    expect(requestPermission).toHaveBeenCalled()
    act(() => liveBus.emitJob(job({ id: 'j-b' })))
    await new Promise((r) => setTimeout(r, 20))
    expect(useToasts.getState().toasts.filter((t) => /browser notification/.test(t.text))).toHaveLength(1)
  })

  it('knows where Open goes', () => {
    expect(jobTarget({ kind: 'ai.produce.script', projectId: 'p9' })).toBe('/producer/p9')
    expect(jobTarget({ kind: 'media.denoise', projectId: 'p9' })).toBe('/edit/p9')
    expect(jobTarget({ kind: 'ai.tts' })).toBe('/library')
  })
})

describe('a failed export offers Retry (A-8)', () => {
  it('Retry starts the same export again', async () => {
    const { startExport } = await import('../../editor/exportJobs')
    const body = { resolution: '1080p', fps: 30, format: 'mp4', name: 'Launch cut' } as never
    const exportProject = vi.spyOn(api, 'exportProject').mockResolvedValue({ id: 'jx', kind: 'export.render', status: 'queued', progress: 0, message: '', workspaceId: 'ws_team', createdAt: 1, updatedAt: 1 } as never)
    vi.spyOn(api, 'job').mockResolvedValue({ id: 'jx', kind: 'export.render', status: 'error', error: 'Chrome crashed', progress: 0, message: '', workspaceId: 'ws_team', createdAt: 1, updatedAt: 2 } as never)
    await startExport('p1', body)
    await waitFor(() => expect(useToasts.getState().toasts.some((t) => /Export failed: Launch cut/.test(t.text))).toBe(true))
    const t = useToasts.getState().toasts.find((x) => /Export failed/.test(x.text))!
    expect(t.actions?.map((a) => a.label)).toEqual(['Retry', 'Open'])
    act(() => t.actions![0].run())
    await waitFor(() => expect(exportProject).toHaveBeenCalledTimes(2))
    expect(exportProject).toHaveBeenLastCalledWith('p1', body)
  })
})
