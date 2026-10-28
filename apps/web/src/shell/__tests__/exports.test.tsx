// Exports & sharing: Download saves the file under its real type (APP-11), the share page shows the export's poster
// (APP-24).
import { cleanup, render, screen } from '@testing-library/react'
import type { ExportRecord, ProjectSummary, Workspace } from '@producer/core'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '../../lib/api'
import { useSession } from '../../lib/session'
import ExportsPage from '../pages/ExportsPage'
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

describe('<ExportsPage> downloads', () => {
  it('Download asks the server for an attachment and leaves the name (and extension) to it', async () => {
    vi.spyOn(api, 'projects').mockResolvedValue([project])
    vi.spyOn(api, 'exports').mockResolvedValue([webm])
    vi.spyOn(api, 'shares').mockResolvedValue([])
    render(<MemoryRouter><ExportsPage /></MemoryRouter>)
    const link = (await screen.findByRole('link', { name: /Download/ })) as HTMLAnchorElement
    expect(link.getAttribute('href')).toBe('/api/media/as_r/source?download=1')
    // no hard-coded ".mp4": a WebM or GIF export keeps its own extension
    expect(link.getAttribute('download')).toBe('')
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
