// Exports & sharing: Download saves the file under its real type (APP-11), the share page shows the export's poster
// (APP-24).
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { ExportRecord, ProjectSummary, SpaceExport, Workspace } from '@producer/core'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '../../lib/api'
import { collabApi } from '../../lib/collabApi'
import { useSession } from '../../lib/session'
import ExportsPage, { rerenderRequest } from '../pages/ExportsPage'
import { SharePage } from '../SharePage'

vi.setConfig({ testTimeout: 30_000 })

const ws: Workspace = { id: 'ws_me', name: 'Me', role: 'owner', personal: true, memberCount: 1 }
const project: ProjectSummary = { id: 'p_1', workspaceId: ws.id, name: 'Launch', width: 1920, height: 1080, duration: 12, isTemplate: false, trashed: false, kind: 'edit', updatedAt: 2, createdAt: 1, createdBy: 'u' }
const webm: ExportRecord = { exportId: 'ex_1', url: '/api/media/as_r/source', sizeBytes: 1000, duration: 12, projectId: 'p_1', name: 'Launch cut', resolution: '1080p', fps: 30, createdAt: 3 }

beforeEach(() => {
  useSession.setState({ status: 'ready', workspaces: [ws], workspaceId: ws.id })
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const row = (over: Partial<SpaceExport> = {}): SpaceExport => ({ ...webm, format: 'webm', projectName: project.name, assetId: 'as_r', shares: 0, ...over })

describe('<ExportsPage> downloads', () => {
  it('Download asks the server for an attachment and leaves the name (and extension) to it', async () => {
    vi.spyOn(api, 'spaceExports').mockResolvedValue({ items: [row()] })
    vi.spyOn(collabApi, 'spaceShares').mockResolvedValue([])
    render(<MemoryRouter><ExportsPage /></MemoryRouter>)
    const link = (await screen.findByRole('link', { name: /Download/ })) as HTMLAnchorElement
    expect(link.getAttribute('href')).toBe('/api/media/as_r/source?download=1')
    // no hard-coded ".mp4": a WebM or GIF export keeps its own extension
    expect(link.getAttribute('download')).toBe('')
  })
})

describe('<ExportsPage> every export of the space (A-19)', () => {
  it('lists them a page at a time, with format badges, search and a format filter', async () => {
    const list = vi.spyOn(api, 'spaceExports').mockImplementation(async (_ws, o) =>
      o?.cursor ? { items: [row({ exportId: 'ex_old', name: 'Old cut', createdAt: 1 })] } : { items: [row(), row({ exportId: 'ex_2', name: 'Podcast', format: 'mp3', resolution: 'audio' })], nextCursor: 'c1' },
    )
    vi.spyOn(collabApi, 'spaceShares').mockResolvedValue([])
    render(<MemoryRouter><ExportsPage /></MemoryRouter>)
    expect(await screen.findByLabelText('Format WEBM')).toBeTruthy()
    expect(screen.getByLabelText('Format MP3')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /Show more exports/ }))
    expect(await screen.findByText('Old cut')).toBeTruthy()
    expect(list).toHaveBeenLastCalledWith('ws_me', expect.objectContaining({ cursor: 'c1' }))
    expect(screen.queryByRole('button', { name: /Show more exports/ })).toBeNull()

    fireEvent.change(screen.getByRole('combobox', { name: 'Format' }), { target: { value: 'mp3,wav' } })
    await waitFor(() => expect(list).toHaveBeenLastCalledWith('ws_me', expect.objectContaining({ format: 'mp3,wav' })))
    fireEvent.change(screen.getByRole('textbox', { name: 'Search exports' }), { target: { value: 'launch' } })
    await waitFor(() => expect(list).toHaveBeenLastCalledWith('ws_me', expect.objectContaining({ q: 'launch', format: 'mp3,wav' })))
  })

  it('deletes an export after saying what stops working, and renders one again with its settings', async () => {
    vi.spyOn(api, 'spaceExports').mockResolvedValue({ items: [row({ shares: 2 })] })
    vi.spyOn(collabApi, 'spaceShares').mockResolvedValue([])
    const del = vi.spyOn(api, 'deleteExport').mockResolvedValue({ ok: true, links: 2, keptFile: false })
    const again = vi.spyOn(api, 'exportProject').mockResolvedValue({ id: 'j', kind: 'export.render', status: 'queued', progress: 0, message: '', workspaceId: 'ws_me', createdAt: 1, updatedAt: 1 })
    render(<MemoryRouter><ExportsPage /></MemoryRouter>)
    fireEvent.click(await screen.findByRole('button', { name: 'Render Launch cut again' }))
    await waitFor(() => expect(again).toHaveBeenCalledWith('p_1', { resolution: '1080p', fps: 30, quality: 'standard', format: 'webm', name: 'Launch cut' }))
    fireEvent.click(screen.getByRole('button', { name: 'Delete Launch cut' }))
    const dialog = screen.getByRole('alertdialog')
    expect(dialog.textContent).toMatch(/its 2 share links stop working/)
    // Cancel has the focus: Enter never deletes
    expect(document.activeElement?.textContent).toBe('Cancel')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete export' }))
    await waitFor(() => expect(del).toHaveBeenCalledWith('ex_1'))
    await waitFor(() => expect(screen.queryByText('Launch cut')).toBeNull())
  })

  it('a viewer downloads but can’t share, re-render or delete', async () => {
    useSession.setState({ workspaces: [{ ...ws, role: 'viewer' }] })
    vi.spyOn(api, 'spaceExports').mockResolvedValue({ items: [row()] })
    vi.spyOn(collabApi, 'spaceShares').mockResolvedValue([])
    render(<MemoryRouter><ExportsPage /></MemoryRouter>)
    expect(await screen.findByRole('link', { name: /Download/ })).toBeTruthy()
    for (const name of [/Copy link/, 'Render Launch cut again', 'Delete Launch cut']) expect((screen.getByRole('button', { name }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('the re-render request keeps an audio export’s format and falls back to 1080p', () => {
    expect(rerenderRequest({ resolution: 'audio', fps: 30, format: 'mp3', name: 'Pod' })).toEqual({ resolution: '1080p', fps: 30, quality: 'standard', format: 'mp3', name: 'Pod' })
  })
})

describe('<SharePage>', () => {
  it('shows the export’s poster before the video plays', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ project: { name: 'Launch', width: 1920, height: 1080, duration: 12, updatedAt: 1 }, videoUrl: '/api/share/tok/video', posterUrl: '/api/share/tok/poster' }), { status: 200 })))
    const { container } = render(<MemoryRouter initialEntries={['/r/tok']}><Routes><Route path="/r/:token" element={<SharePage />} /></Routes></MemoryRouter>)
    await screen.findByRole('heading', { name: 'Launch' })
    expect(container.querySelector('video')!.getAttribute('poster')).toBe('/api/share/tok/poster')
    vi.unstubAllGlobals()
  })
})
