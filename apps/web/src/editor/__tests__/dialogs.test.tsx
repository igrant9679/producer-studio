// The export dialog mid-render and voiceovers that finish later (EDT-36).
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createProject, type Asset, type AssetRecord, type ExportResult, type Job } from '@producer/core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '../../lib/api'
import { ExportDialog } from '../Dialogs'
import { useExports } from '../exportJobs'
import { VoiceoverBox } from '../LeftPanel'
import { useEditor } from '../store'

const S = () => useEditor.getState()

beforeEach(() => {
  S().load({ project: createProject({ id: 'p1', name: 'On screen' }), version: 3, projectId: 'p1', demo: false, workspaceId: 'w1' })
  vi.spyOn(api, 'exports').mockResolvedValue([])
  vi.spyOn(api, 'voices').mockResolvedValue([])
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('the export dialog (EDT-36, E-5)', { timeout: 20_000 }, () => {
  // EDT-36 kept the dialog open mid-render so the progress wasn't lost; since E-5 the export carries on in the
  // background, so closing it loses nothing and opening it again shows the same render
  it('Escape closes it while the video renders, and the render carries on', async () => {
    const running = { id: 'j1', kind: 'export.render', status: 'running', progress: 0.3, message: 'Rendering' } as unknown as Job<ExportResult>
    vi.spyOn(api, 'exportProject').mockResolvedValue(running as never)
    vi.spyOn(api, 'job').mockResolvedValue(running as never)
    S().set({ exportOpen: true })
    const view = render(<ExportDialog />)
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^Export$/ }))
      await new Promise((r) => setTimeout(r, 10))
    })
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(S().exportOpen).toBe(false)
    view.unmount()
    render(<ExportDialog />)
    expect(screen.getByText('Rendering')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Keep working' })).toBeTruthy()
    // stop following it, so it doesn't poll into the next test
    useExports.setState({ byProject: {} })
  })
})

describe('a voiceover that finishes later (EDT-36)', { timeout: 20_000 }, () => {
  const voice: Asset = { id: 'vo1', kind: 'audio', name: 'Voiceover', src: '/api/media/vo1/source', duration: 2 }

  async function generate(): Promise<(job: Job) => void> {
    let finish!: (job: Job) => void
    vi.spyOn(api, 'tts').mockResolvedValue({ id: 'j2', status: 'queued', progress: 0 } as never)
    vi.spyOn(api, 'job').mockImplementation(() => new Promise((r) => (finish = r as never)) as never)
    render(<VoiceoverBox />)
    fireEvent.change(screen.getByPlaceholderText(/narrator should say/), { target: { value: 'Welcome back' } })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Generate and add/ }))
      await new Promise((r) => setTimeout(r, 10))
    })
    return finish
  }
  const done = { id: 'j2', status: 'done', progress: 1, result: { asset: { asset: voice } as AssetRecord, duration: 2 } } as unknown as Job

  it('lands where the playhead was when it was asked for', async () => {
    S().setPlayhead(3)
    const finish = await generate()
    S().setPlayhead(7)
    await act(async () => {
      finish(done)
      await new Promise((r) => setTimeout(r, 10))
    })
    // a loaded machine can take longer than one tick to add it
    await waitFor(() => expect(S().project.tracks.flatMap((t) => t.items).find((i) => i.type === 'audio')?.start).toBe(3))
  })

  it('is not added to another project opened meanwhile', async () => {
    const finish = await generate()
    S().load({ project: createProject({ id: 'p2', name: 'Other' }), version: 1, projectId: 'p2', demo: false, workspaceId: 'w1' })
    await act(async () => {
      finish(done)
      await new Promise((r) => setTimeout(r, 10))
    })
    expect(S().project.id).toBe('p2')
    expect(S().project.tracks.flatMap((t) => t.items)).toHaveLength(0)
    expect(S().project.assets.vo1).toBeUndefined()
  })
})
