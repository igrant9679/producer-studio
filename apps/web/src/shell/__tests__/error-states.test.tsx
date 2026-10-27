// APP-34: a failed load says it failed and offers Retry, instead of looking empty, showing a hint, or a skeleton
// forever; a failed Cancel says so.
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { Job, ProjectSummary, User, Workspace } from '@producer/core'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '../../lib/api'
import { useSession } from '../../lib/session'
import { useToasts } from '../../lib/toast'
import { Layout } from '../Layout'
import EditorHome from '../pages/EditorHome'
import SettingsPage from '../pages/SettingsPage'
import TemplatesPage from '../pages/TemplatesPage'
import { useJobs } from '../stores'
import { useSystem } from '../system'

const me: User = { id: 'u_me', email: 'sam@example.com', name: 'Sam', avatarColor: '#ffc24d', createdAt: 0 }
const ws: Workspace = { id: 'ws_me', name: "Sam's space", role: 'owner', personal: true, memberCount: 1 }
const offline = () => Promise.reject(new Error('offline'))

beforeEach(() => {
  useSession.setState({ status: 'ready', user: me, workspaces: [ws], workspaceId: ws.id })
  useToasts.setState({ toasts: [] })
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify({ error: 'offline' }), { status: 503 }))
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const inRouter = (ui: React.ReactNode) => render(<MemoryRouter>{ui}</MemoryRouter>)

describe('failed loads', () => {
  it('Editor home: recent projects say they failed, and Retry loads them', async () => {
    const projects = vi.spyOn(api, 'projects').mockImplementationOnce(offline).mockResolvedValue([{ id: 'p_1', name: 'Launch cut', updatedAt: 1, trashed: false } as ProjectSummary])
    inRouter(<EditorHome />)
    expect(await screen.findByText(/Couldn’t load your projects/)).toBeTruthy()
    expect(screen.queryByText('Your edits will live here')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(await screen.findByText('Launch cut')).toBeTruthy()
    expect(projects).toHaveBeenCalledTimes(2)
  })

  it('Templates: the team section says it failed instead of showing the how-to hint', async () => {
    vi.spyOn(api, 'templates').mockImplementation(offline)
    inRouter(<TemplatesPage />)
    expect(await screen.findByText(/Couldn’t load your team’s templates/)).toBeTruthy()
    expect(screen.queryByText(/Save any project as a template/)).toBeNull()
  })

  it('Settings: AI status says it couldn’t check, with Retry, instead of a skeleton forever', async () => {
    useSystem.setState({ info: undefined, loaded: true, error: 'offline' })
    const load = vi.spyOn(useSystem.getState(), 'load')
    inRouter(<SettingsPage />)
    const retry = await screen.findByText(/Couldn’t check AI status: offline/)
    fireEvent.click(within(retry.closest('.ps-alert')!).getByRole('button', { name: 'Retry' }))
    expect(load).toHaveBeenCalled()
  })
})

describe('a failed Cancel on a background job', () => {
  it('shows why', async () => {
    vi.spyOn(api, 'jobs').mockResolvedValue([])
    vi.spyOn(api, 'cancelJob').mockRejectedValue(new Error('The job already finished'))
    inRouter(
      <Layout>
        <p>page</p>
      </Layout>,
    )
    useJobs.getState().upsert({ id: 'j_1', kind: 'export', status: 'running', progress: 0.5, message: '', createdAt: 0, updatedAt: Date.now() } as unknown as Job)
    fireEvent.click(await screen.findByRole('button', { name: /Background jobs/ }))
    fireEvent.click(screen.getByRole('button', { name: /^Cancel / }))
    await waitFor(() => expect(useToasts.getState().toasts.map((t) => t.text).join()).toMatch(/Couldn’t cancel .*: The job already finished/))
  })
})
