// Tools links the voice tools that exist (APP-21); unfinished Producer projects resume in the wizard (APP-25); Voice
// Studio tabs are history entries (APP-26); copy and small behaviour fixes (APP-37).
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ProjectSummary, SystemInfo, Workspace } from '@producer/core'
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api, HttpError } from '../../lib/api'
import { useSession } from '../../lib/session'
import { projectPath } from '../actions'
import { authErrorMessage } from '../AuthPage'
import { AspectPickerModal } from '../modals'
import EditorHome from '../pages/EditorHome'
import HomePage from '../pages/HomePage'
import ToolsPage from '../pages/ToolsPage'
import VoiceStudio from '../pages/VoiceStudio'
import { useSystem } from '../system'

vi.mock('../voicestudio/MyVoices', () => ({ MyVoices: () => <div>My voices panel</div> }))
vi.setConfig({ testTimeout: 30_000 })

const ws: Workspace = { id: 'ws_me', name: 'Me', role: 'owner', personal: true, memberCount: 1 }
const summary = (over: Partial<ProjectSummary>): ProjectSummary => ({ id: 'p_1', workspaceId: ws.id, name: 'Tour', width: 1920, height: 1080, duration: 0, isTemplate: false, trashed: false, kind: 'edit', updatedAt: 2, createdAt: 1, createdBy: 'u', ...over })
const info = (mode: 'cloud' | 'desktop'): SystemInfo => ({ mode, version: '1', ai: { provider: 'anthropic-api', available: true, detail: '' }, capabilities: { transcribe: true, tts: true, render: true } })

function Where() {
  const l = useLocation()
  const navigate = useNavigate()
  return (
    <>
      <span data-testid="where">{l.pathname + l.search}</span>
      <button onClick={() => navigate(-1)}>Browser back</button>
    </>
  )
}
const at = (path: string, page: React.ReactNode, route = '*') =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path={route} element={<>{page}<Where /></>} />
        <Route path="/producer/:id" element={<Where />} />
        <Route path="/edit/:id" element={<Where />} />
        <Route path="/voice" element={<Where />} />
        <Route path="/templates" element={<Where />} />
      </Routes>
    </MemoryRouter>,
  )

beforeEach(() => {
  useSession.setState({ status: 'ready', workspaces: [ws], workspaceId: ws.id, user: { id: 'u', email: 'a@b.c', name: 'Alex' } as never })
  useSystem.setState({ info: info('cloud'), loaded: true })
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('All tools (APP-21)', () => {
  it('Voice cloning and Voice changer open Voice Studio, marked as desktop-app tools on the web', () => {
    at('/tools', <ToolsPage />, '/tools')
    const cloning = screen.getByRole('button', { name: /Voice cloning/ })
    const changer = screen.getByRole('button', { name: /Voice changer/ })
    expect(cloning.textContent).not.toMatch(/Coming soon/)
    expect(cloning.textContent).toMatch(/Desktop app/)
    expect(changer.textContent).toMatch(/Desktop app/)
    fireEvent.click(cloning)
    expect(screen.getByTestId('where').textContent).toBe('/voice?tab=voices')
  })

  it('on the desktop app there is no badge', () => {
    useSystem.setState({ info: info('desktop') })
    at('/tools', <ToolsPage />, '/tools')
    expect(screen.getByRole('button', { name: /Voice changer/ }).textContent).not.toMatch(/Desktop app/)
    fireEvent.click(screen.getByRole('button', { name: /Voice changer/ }))
    expect(screen.getByTestId('where').textContent).toBe('/voice?tab=dub')
  })
})

describe('unfinished Producer projects (APP-25)', () => {
  it('projectPath sends a Producer project with nothing assembled to the wizard', () => {
    expect(projectPath(summary({ kind: 'producer', duration: 0 }))).toBe('/producer/p_1')
    expect(projectPath(summary({ kind: 'producer', duration: 42 }))).toBe('/edit/p_1')
    expect(projectPath(summary({ kind: 'edit', duration: 0 }))).toBe('/edit/p_1')
  })

  it('Home and Editor home open it in the wizard instead of an empty editor', async () => {
    vi.spyOn(api, 'projects').mockResolvedValue([summary({ id: 'p_draft', name: 'Draft tour', kind: 'producer', duration: 0 }), summary({ id: 'p_done', name: 'Done tour', kind: 'producer', duration: 30, updatedAt: 1 })])
    at('/', <HomePage />, '/')
    fireEvent.click(await screen.findByRole('button', { name: 'Open Draft tour' }))
    expect(screen.getByTestId('where').textContent).toBe('/producer/p_draft')
    cleanup()
    at('/editor', <EditorHome />, '/editor')
    fireEvent.click(await screen.findByRole('button', { name: 'Open Done tour' }))
    expect(screen.getByTestId('where').textContent).toBe('/edit/p_done')
  })
})

describe('Voice Studio tabs (APP-26)', () => {
  it('push history like the Library, so Back returns to the previous tab', async () => {
    vi.spyOn(api, 'assets').mockResolvedValue([])
    vi.spyOn(api, 'voices').mockResolvedValue([])
    vi.spyOn(api, 'brand').mockResolvedValue({ name: 'Me', colors: [], fonts: { headline: 'Inter', body: 'Inter' } })
    at('/voice', <VoiceStudio />, '/voice')
    fireEvent.click(screen.getByRole('tab', { name: /My voices/ }))
    expect(screen.getByTestId('where').textContent).toBe('/voice?tab=voices')
    fireEvent.click(screen.getByRole('button', { name: 'Browser back' }))
    await waitFor(() => expect(screen.getByTestId('where').textContent).toBe('/voice'))
    expect(screen.getByRole('tab', { name: /Text to speech/ }).getAttribute('aria-selected')).toBe('true')
  })
})

describe('copy and small fixes (APP-37)', () => {
  it('a sign-in lockout says how long it lasts (the server’s words), not “wait a minute”', () => {
    expect(authErrorMessage(new HttpError(429, { error: 'Too many sign-in attempts. Try again in 14 minutes.', code: 'quota' }), 'login')).toBe('Too many sign-in attempts. Try again in 14 minutes.')
    expect(authErrorMessage(new HttpError(429, { error: '' }), 'login')).not.toMatch(/minute/)
  })

  it('the new-video picker uses the typed name on double-click and Enter', () => {
    const onPick = vi.fn()
    render(<AspectPickerModal onClose={() => undefined} onPick={onPick} />)
    fireEvent.change(screen.getByLabelText('Project name (optional)'), { target: { value: 'Spring teaser' } })
    fireEvent.doubleClick(screen.getByRole('radio', { name: /9:16|Vertical|Portrait/ }))
    expect(onPick).toHaveBeenLastCalledWith(expect.objectContaining({ name: 'Spring teaser' }))
    fireEvent.keyDown(screen.getByLabelText('Project name (optional)'), { key: 'Enter' })
    expect(onPick).toHaveBeenCalledTimes(2)
    expect(onPick).toHaveBeenLastCalledWith(expect.objectContaining({ name: 'Spring teaser' }))
  })

  it('every Home quick-start card does something different', async () => {
    vi.spyOn(api, 'projects').mockResolvedValue([])
    const { container } = at('/', <HomePage />, '/')
    const titles = [...container.querySelectorAll('.ps-quick .ps-qcard h3')].map((h) => h.textContent)
    expect(titles).not.toContain('Remove pauses')
    fireEvent.click(screen.getByRole('button', { name: /Start from a template/ }))
    expect(screen.getByTestId('where').textContent).toBe('/templates')
  })
})
