// Templates (A-22): the viewer opens from a link (?t=) and moves with ← →; built-in looks preview as the project they
// make (drawn by the renderer, in the aspect and brand kit picked); the aspect filter; a team template from a kit.
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { TemplateSummary, Workspace } from '@producer/core'
import { createProject } from '@producer/core'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '../../lib/api'
import { brandApi, templateApi } from '../../lib/brandApi'
import { useSession } from '../../lib/session'
import TemplatesPage, { filterTemplates } from '../pages/TemplatesPage'

vi.setConfig({ testTimeout: 30_000 })

const ws: Workspace = { id: 'ws_team', name: 'Agency', role: 'editor', personal: false, memberCount: 3 }
const tpl = (id: string, name: string, over: Partial<TemplateSummary> = {}): TemplateSummary => ({ id, name, category: 'Business', aspect: '16:9', duration: 11, builtIn: true, clipCount: 0, textCount: 4, ...over })
const LIST = [tpl('tpl:studio-dark', 'Studio Dark'), tpl('tpl:editorial-light', 'Editorial Light', { category: 'Editorial' }), tpl('tpl:minimal-mono', 'Minimal Mono'), tpl('p_team', 'Launch reel', { builtIn: false, category: 'My templates', thumbnailUrl: '/t.jpg' })]

function Where() {
  const l = useLocation()
  return <span data-testid="where">{l.pathname + l.search}</span>
}
const at = (path: string) =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/templates" element={<><TemplatesPage /><Where /></>} />
        <Route path="/edit/:id" element={<Where />} />
      </Routes>
    </MemoryRouter>,
  )
const where = () => screen.getByTestId('where').textContent

beforeEach(() => {
  useSession.setState({ status: 'ready', workspaces: [ws], workspaceId: ws.id, user: { id: 'u', email: 'a@b.c', name: 'Alex' } as never })
  vi.spyOn(api, 'templates').mockResolvedValue(LIST)
  vi.spyOn(brandApi, 'kits').mockResolvedValue({ items: [{ id: 'default', default: true, doc: { name: 'Agency', colors: [], fonts: { headline: 'Inter', body: 'Inter' } }, updatedAt: 1 }, { id: 'bk_retail', default: false, doc: { name: 'Retail', colors: [], fonts: { headline: 'Inter', body: 'Inter' } }, updatedAt: 1 }] })
  vi.spyOn(templateApi, 'doc').mockImplementation(async (id, o) => {
    const [w, h] = o?.aspect === '9:16' ? [1080, 1920] : [1920, 1080]
    return createProject({ name: `${id} ${o?.kitId ?? 'default'}`, width: w, height: h })
  })
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('<TemplatesPage>', () => {
  it('opens the template a link names and moves through them with the arrow keys; closing takes it out of the address', async () => {
    at('/templates?t=tpl:editorial-light')
    const dialog = await screen.findByRole('dialog', { name: 'Editorial Light' })
    expect(dialog.textContent).toMatch(/2 of 3/)
    fireEvent.keyDown(document.body, { key: 'ArrowRight' })
    await screen.findByRole('dialog', { name: 'Minimal Mono' })
    expect(where()).toBe('/templates?t=tpl%3Aminimal-mono')
    // the last one: → stays
    fireEvent.keyDown(document.body, { key: 'ArrowRight' })
    expect(screen.getByRole('dialog', { name: 'Minimal Mono' })).toBeTruthy()
    fireEvent.keyDown(document.body, { key: 'ArrowLeft' })
    fireEvent.keyDown(document.body, { key: 'ArrowLeft' })
    await screen.findByRole('dialog', { name: 'Studio Dark' })
    expect((screen.getByRole('button', { name: 'Previous template' }) as HTMLButtonElement).disabled).toBe(true)
    // the preview is the look's own project, drawn by the renderer
    await waitFor(() => expect(document.querySelector('[data-look-preview="tpl:studio-dark default"]')).toBeTruthy())
    fireEvent.keyDown(document.body, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(where()).toBe('/templates')
  })

  it('a link to a template the space can’t see says so and opens nothing', async () => {
    at('/templates?t=p_elsewhere')
    await screen.findByText('Launch reel')
    await waitFor(() => expect(where()).toBe('/templates'))
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('filters by aspect: looks are shown and made in it, team templates of other aspects are hidden', async () => {
    const create = vi.spyOn(api, 'createProject').mockResolvedValue({ summary: { id: 'p_new' }, project: createProject({}), version: 1 } as never)
    at('/templates')
    await screen.findByText('Launch reel')
    fireEvent.click(within(screen.getByRole('group', { name: 'Aspect ratio' })).getByRole('button', { name: /9:16/ }))
    await waitFor(() => expect(screen.queryByText('Launch reel')).toBeNull())
    expect(where()).toBe('/templates?aspect=9%3A16')
    expect(screen.getByRole('button', { name: 'Studio Dark, Business, 9:16' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Studio Dark, Business, 9:16' }))
    const dialog = await screen.findByRole('dialog', { name: 'Studio Dark' })
    // with another brand kit picked
    fireEvent.change(within(dialog).getByLabelText('Brand kit'), { target: { value: 'bk_retail' } })
    await waitFor(() => expect(document.querySelector('[data-look-preview="tpl:studio-dark bk_retail"]')).toBeTruthy())
    fireEvent.click(within(dialog).getByRole('button', { name: /Use this template/ }))
    await waitFor(() => expect(create).toHaveBeenCalledWith(expect.objectContaining({ templateId: 'tpl:studio-dark', aspect: '9:16', brandKitId: 'bk_retail' })))
    expect(filterTemplates(LIST, 'All', '', '1:1').map((t) => t.id)).toEqual(['tpl:studio-dark', 'tpl:editorial-light', 'tpl:minimal-mono'])
  })

  it('saves a look in a brand kit as a team template, and a viewer can’t', async () => {
    const fromBrand = vi.spyOn(templateApi, 'fromBrand').mockResolvedValue(tpl('p_made', 'Retail · Studio Dark', { builtIn: false }))
    at('/templates?t=tpl:studio-dark')
    const dialog = await screen.findByRole('dialog', { name: 'Studio Dark' })
    fireEvent.change(within(dialog).getByLabelText('Brand kit'), { target: { value: 'bk_retail' } })
    fireEvent.click(within(dialog).getByRole('button', { name: /Save as a team template/ }))
    await waitFor(() => expect(fromBrand).toHaveBeenCalledWith({ workspaceId: 'ws_team', lookId: 'studio-dark', kitId: 'bk_retail', aspect: '16:9' }))
    await waitFor(() => expect(api.templates).toHaveBeenCalledTimes(2))
    cleanup()
    useSession.setState({ workspaces: [{ ...ws, role: 'viewer' }] })
    at('/templates?t=tpl:studio-dark')
    const v = await screen.findByRole('dialog', { name: 'Studio Dark' })
    expect((within(v).getByRole('button', { name: /Use this template/ }) as HTMLButtonElement).disabled).toBe(true)
    expect((within(v).getByRole('button', { name: /Save as a team template/ }) as HTMLButtonElement).disabled).toBe(true)
  })
})
