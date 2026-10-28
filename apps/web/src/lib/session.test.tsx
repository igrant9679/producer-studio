// APP-8 (a session that ends is noticed, in every tab), APP-9 (what one person leaves in a tab is cleared before the
// next), QA-6 (one sign-in check, however many ask).
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import type { Job, MeResponse, User, Workspace } from '@producer/core'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { App } from '../App'
import { useUploads, useJobs } from '../shell/stores'
import { useWizard } from '../shell/producer/wizardStore'
import { api, HttpError } from './api'
import { saveNow, useAppearance } from './appearance'
import { onSessionEvent, SESSION_EVENT_KEY, useSession } from './session'

const sam: User = { id: 'u_sam', email: 'sam@example.com', name: 'Sam', avatarColor: '#ffc24d', createdAt: 0 }
const kim: User = { id: 'u_kim', email: 'kim@example.com', name: 'Kim', avatarColor: '#35e0ff', createdAt: 0 }
const space = (id: string): Workspace => ({ id, name: `${id} space`, role: 'owner', personal: true, memberCount: 1 })
const me = (u: User): MeResponse => ({ user: u, workspaces: [space(`ws_${u.id}`)] })
const unauthorized = () => new HttpError(401, { error: 'Sign in required', code: 'unauthorized' })
const job = { id: 'j_1', kind: 'export', status: 'running', progress: 0.4, message: '', createdAt: 0, updatedAt: Date.now() } as unknown as Job

async function signInAs(u: User) {
  vi.spyOn(api, 'login').mockResolvedValueOnce(me(u))
  await useSession.getState().login(u.email, 'pw')
}

beforeEach(async () => {
  localStorage.clear()
  sessionStorage.clear()
  vi.spyOn(api, 'logout').mockResolvedValue({ ok: true })
  vi.spyOn(api, 'savePreferences').mockResolvedValue({ preferences: useAppearance.getState().prefs, updatedAt: Date.now() })
  vi.spyOn(api, 'preferences').mockResolvedValue({ preferences: useAppearance.getState().prefs, updatedAt: null })
  // start every test signed out, with no one's state in the tab
  await useSession.getState().logout()
  vi.restoreAllMocks()
  vi.spyOn(api, 'logout').mockResolvedValue({ ok: true })
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('a session that ends while the app is open', () => {
  it('signs the tab out when a request is refused and /auth/me agrees, and sign-in comes back to the page', async () => {
    await signInAs(sam)
    vi.spyOn(api, 'me').mockRejectedValue(unauthorized())
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify({ error: 'Sign in required' }), { status: 401 }))
    render(
      <MemoryRouter initialEntries={['/library?tab=assets']}>
        <App />
      </MemoryRouter>,
    )
    await expect(api.projects('ws_x')).rejects.toThrow('Sign in required')
    await waitFor(() => expect(useSession.getState().status).toBe('anon'))
    expect(useSession.getState().signedOutReason).toBe('expired')
    // the guard sends the person to sign in, and back here afterwards
    expect(await screen.findByRole('heading', { name: 'Sign in to your studio' })).toBeTruthy()
    expect(screen.getByText(/Your session ended/)).toBeTruthy()
  })

  it('stays signed in when the 401 was about something else (a cloud password)', async () => {
    await signInAs(sam)
    const check = vi.spyOn(api, 'me').mockResolvedValue(me(sam))
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify({ error: 'The cloud rejected that email or password.' }), { status: 401 }))
    await expect(api.syncLink('https://cloud.test', 'a@b.c', 'nope')).rejects.toThrow('cloud rejected')
    await waitFor(() => expect(check).toHaveBeenCalled())
    expect(useSession.getState().status).toBe('ready')
  })

  it('keeps the same person’s work in the tab, so signing back in resumes it', async () => {
    await signInAs(sam)
    useJobs.getState().upsert(job)
    vi.spyOn(api, 'me').mockRejectedValueOnce(unauthorized())
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('{}', { status: 401 }))
    await api.jobs({ workspaceId: 'ws_x' }).catch(() => undefined)
    await waitFor(() => expect(useSession.getState().status).toBe('anon'))
    await signInAs(sam)
    expect(useJobs.getState().jobs.j_1).toBeTruthy()
  })
})

describe('signing out in another tab', () => {
  it('signs this tab out too, and clears what was left in it', async () => {
    await signInAs(sam)
    useJobs.getState().upsert(job)
    vi.spyOn(api, 'me').mockRejectedValue(unauthorized())
    onSessionEvent(JSON.stringify({ kind: 'signed-out', at: Date.now() }))
    await waitFor(() => expect(useSession.getState().status).toBe('anon'))
    expect(useSession.getState().signedOutReason).toBe('elsewhere')
    expect(useJobs.getState().jobs).toEqual({})
  })

  it('is announced to the other tabs', async () => {
    await signInAs(sam)
    await useSession.getState().logout()
    expect(JSON.parse(localStorage.getItem(SESSION_EVENT_KEY)!).kind).toBe('signed-out')
  })

  it('signing in in another tab signs this one in', async () => {
    const load = vi.spyOn(api, 'me').mockResolvedValue(me(kim))
    onSessionEvent(JSON.stringify({ kind: 'signed-in', userId: kim.id, at: Date.now() }))
    await waitFor(() => expect(useSession.getState().status).toBe('ready'))
    expect(load).toHaveBeenCalledTimes(1)
    expect(useSession.getState().user?.id).toBe(kim.id)
  })
})

describe('the next person to sign in on a tab', () => {
  it('doesn’t inherit the job list, uploads or Producer drafts', async () => {
    await signInAs(sam)
    useJobs.getState().upsert(job)
    useUploads.getState().patch('up1', { name: 'secret-interview.mov', status: 'processing', workspaceId: 'ws_u_sam' })
    useWizard.getState().patch({ brief: 'Sam’s confidential launch' } as never)
    sessionStorage.setItem('ps.producer.p_1', '{"brief":"Sam’s confidential launch"}')
    sessionStorage.setItem('ps.unrelated', 'kept')
    await useSession.getState().logout()
    await signInAs(kim)
    expect(useJobs.getState().jobs).toEqual({})
    expect(useUploads.getState().items).toEqual([])
    expect(JSON.stringify(useWizard.getState().s)).not.toContain('confidential')
    expect(sessionStorage.getItem('ps.producer.p_1')).toBeNull()
    expect(sessionStorage.getItem('ps.unrelated')).toBe('kept')
  })

  it('starts clean even when the last person’s session merely expired', async () => {
    await signInAs(sam)
    useJobs.getState().upsert(job)
    vi.spyOn(api, 'me').mockRejectedValueOnce(unauthorized())
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('{}', { status: 401 }))
    await api.jobs({ workspaceId: 'ws_x' }).catch(() => undefined)
    await waitFor(() => expect(useSession.getState().status).toBe('anon'))
    await signInAs(kim)
    expect(useJobs.getState().jobs).toEqual({})
  })

  it('doesn’t get the previous person’s unsaved appearance change saved to their account', async () => {
    await signInAs(sam)
    const save = vi.spyOn(api, 'savePreferences').mockResolvedValue({ preferences: useAppearance.getState().prefs, updatedAt: Date.now() })
    useAppearance.getState().update({ accent: 'violet' })
    // saved to Sam's account as Sam signs out, not later
    await useSession.getState().logout()
    expect(save).toHaveBeenCalledTimes(1)
    save.mockClear()
    // offline at sign-out: the change stays on this device only
    save.mockRejectedValueOnce(new Error('offline'))
    await signInAs(sam)
    useAppearance.getState().update({ accent: 'teal' })
    await useSession.getState().logout()
    save.mockClear()
    await signInAs(kim)
    await saveNow()
    expect(save).not.toHaveBeenCalled()
    expect(useAppearance.getState().dirty).toBe(false)
  })
})

describe('the sign-in check', () => {
  it('runs once however many ask at the same time', async () => {
    let answer: (m: MeResponse) => void = () => undefined
    const check = vi.spyOn(api, 'me').mockReturnValue(new Promise((r) => (answer = r)))
    const a = useSession.getState().load()
    const b = useSession.getState().load()
    answer(me(sam))
    await Promise.all([a, b])
    expect(check).toHaveBeenCalledTimes(1)
    expect(useSession.getState().status).toBe('ready')
  })
})
