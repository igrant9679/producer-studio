// Export renders what's on screen: it waits for the save, and refuses (saying why) when the save can't finish.
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { createProject, updateProject, type ExportResult, type Job } from '@producer/core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HttpError, api } from '../../lib/api'
import { ExportDialog } from '../Dialogs'
import { useExports } from '../exportJobs'
import { flush } from '../persistence'
import { useEditor } from '../store'

const S = () => useEditor.getState()

const doneJob = { id: 'j1', kind: 'export.render', status: 'done', progress: 1, message: 'Done', result: { exportId: 'e1', url: '/x.mp4', sizeBytes: 1000, duration: 1 } } as unknown as Job<ExportResult>

beforeEach(() => {
  S().load({ project: createProject({ id: 'p1', name: 'On screen' }), version: 3, projectId: 'p1', demo: false, workspaceId: 'w1' })
  // exports carry on in the background: each test starts with none
  useExports.setState({ byProject: {} })
  vi.spyOn(api, 'exports').mockResolvedValue([])
  vi.spyOn(api, 'job').mockResolvedValue(doneJob as never)
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

async function clickExport() {
  render(<ExportDialog />)
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: /^Export$/ }))
    await new Promise((r) => setTimeout(r, 10))
  })
}

// the first render of the dialog is slow on a busy machine
describe('export and unsaved changes', { timeout: 20_000 }, () => {
  it('saves the latest edit first, then renders', async () => {
    const order: string[] = []
    vi.spyOn(api, 'saveProject').mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 5))
      order.push('save')
      return { version: 4, updatedAt: 1 }
    })
    const exp = vi.spyOn(api, 'exportProject').mockImplementation(async () => {
      order.push('export')
      return { ...doneJob, status: 'queued' } as never
    })
    S().commit(updateProject(S().project, { name: 'Latest' }), 'Rename project')
    await clickExport()
    expect(order).toEqual(['save', 'export'])
    expect(exp).toHaveBeenCalledTimes(1)
  })

  it('does not render an older version while the save is in conflict', async () => {
    S().commit(updateProject(S().project, { name: 'Latest' }), 'Rename project')
    vi.spyOn(api, 'saveProject').mockRejectedValueOnce(new HttpError(409, { error: 'conflict', details: { version: 7 } }))
    await act(() => flush())
    const exp = vi.spyOn(api, 'exportProject')
    await clickExport()
    expect(exp).not.toHaveBeenCalled()
    expect(screen.getByRole('alert').textContent).toMatch(/conflict/i)
  })

  it('does not render while the server refuses the save, and says why', async () => {
    vi.spyOn(api, 'saveProject').mockRejectedValue(new HttpError(401, { error: 'Not signed in', code: 'unauthorized' }))
    const exp = vi.spyOn(api, 'exportProject')
    S().commit(updateProject(S().project, { name: 'Latest' }), 'Rename project')
    await clickExport()
    expect(exp).not.toHaveBeenCalled()
    expect(screen.getByRole('alert').textContent).toMatch(/signed out/i)
  })

  it('does not render while offline', async () => {
    vi.spyOn(api, 'saveProject').mockRejectedValue(new TypeError('Failed to fetch'))
    const exp = vi.spyOn(api, 'exportProject')
    S().commit(updateProject(S().project, { name: 'Latest' }), 'Rename project')
    await clickExport()
    expect(exp).not.toHaveBeenCalled()
    expect(screen.getByRole('alert').textContent).toMatch(/reach the server/i)
  })
})
