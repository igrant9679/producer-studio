// The export dialog's options (E-5): a part of the video, audio only, captions, platform presets, the cover; the
// export carrying on in the background with a toast and a browser notification; the draft preview player (E-23).
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { addAsset, addItem, createCaptionItem, createProject, createVideoItem, insertTrack, type ExportRequest, type Job, type Project } from '@producer/core'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '../../lib/api'
import { useToasts } from '../../lib/toast'
import { ExportDialog } from '../Dialogs'
import { useExports } from '../exportJobs'
import { useEditor } from '../store'
import { useTransport } from '../transport'

const S = () => useEditor.getState()

const job = (o: Partial<Job>): Job => ({ id: 'j1', kind: 'export.render', status: 'running', progress: 0.4, message: 'Rendering', workspaceId: 'w1', createdAt: 1, updatedAt: 1, ...o })
const done = (result: unknown, id = 'j1') => job({ id, status: 'done', progress: 1, message: 'Done', result })

function project(captions = true): Project {
  let p = createProject({ id: 'p1', name: 'Launch' })
  p = addAsset(p, { id: 'a', kind: 'video', name: 'a.mp4', src: '/demo/a.mp4', duration: 10, width: 1920, height: 1080, hasAudio: true })
  p = addItem(p, createVideoItem(p.assets.a, 0, { id: 'va', duration: 10 }))
  if (captions) insertTrack(p, 'caption').items.push(createCaptionItem(1, 2, 'Hello'))
  return p
}

// the cover picture is drawn by the preview renderer: jsdom has no media playback
beforeAll(() => {
  const P = HTMLMediaElement.prototype as unknown as Record<string, unknown>
  P.play = () => Promise.resolve()
  P.pause = () => {}
  P.load = () => {}
})

let exp: unknown
let sent: ExportRequest[]
beforeEach(() => {
  S().load({ project: project(), version: 3, projectId: 'p1', demo: false, workspaceId: 'w1' })
  useExports.setState({ byProject: {} })
  useTransport.setState({ inPoint: undefined, outPoint: undefined })
  useToasts.setState({ toasts: [] })
  useEditor.setState({ exportOpen: true, saveState: 'saved' })
  sent = []
  vi.spyOn(api, 'exports').mockResolvedValue([])
  exp = vi.spyOn(api, 'exportProject').mockImplementation(async (_id, body) => {
    sent.push(body)
    return job({ id: body.preview ? 'jd' : 'j1', status: 'queued' }) as never
  })
  vi.spyOn(api, 'job').mockImplementation(async (id: string) => (id === 'jd' ? done({ previewUrl: '/api/projects/p1/previews/jd', sizeBytes: 1, duration: 2 }, 'jd') : done({ exportId: 'e1', url: '/api/media/x/source', sizeBytes: 2e6, duration: 10, format: 'mp4' })) as never)
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

async function exportNow() {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: /^Export( again)?$/ }))
    await new Promise((r) => setTimeout(r, 20))
  })
  return sent.at(-1)!
}

const pick = (group: string, name: string) => fireEvent.click(within(screen.getAllByRole('group', { name: group })[0]).getByRole('button', { name }))

describe('export options (E-5)', { timeout: 20_000 }, () => {
  it('exports the whole video by default, or in to out, or the selection', async () => {
    useTransport.setState({ inPoint: 2, outPoint: 5 })
    S().select(['va'])
    render(<ExportDialog />)
    expect((await exportNow()).range).toBeUndefined()
    pick('Part', 'In to out (00:02:00 – 00:05:00)')
    expect((await exportNow()).range).toEqual({ from: 2, to: 5 })
    pick('Part', 'Selected clips (00:00:00 – 00:10:00)')
    expect((await exportNow()).range).toEqual({ from: 0, to: 10 })
  })

  it('offers only the parts there are', () => {
    render(<ExportDialog />)
    const part = screen.getAllByRole('group', { name: 'Part' })[0]
    expect(within(part).getAllByRole('button').map((b) => b.textContent)).toEqual(['Whole video'])
  })

  it('audio only: MP3 or WAV, without picture settings', async () => {
    render(<ExportDialog />)
    pick('Format', 'MP3, sound only')
    expect(screen.queryAllByRole('group', { name: 'Resolution' })).toEqual([])
    expect(screen.queryByRole('combobox', { name: 'Preset' })).toBeNull()
    expect(screen.queryByRole('slider', { name: 'Cover frame' })).toBeNull()
    expect(screen.getByText('Sound only')).toBeTruthy()
    const body = await exportNow()
    expect(body).toMatchObject({ format: 'mp3' })
    expect(body.captions).toBeUndefined()
  })

  it('captions burned in, as an SRT or WebVTT file, or left out', async () => {
    render(<ExportDialog />)
    expect((await exportNow()).captions).toBe('burn')
    pick('Captions', 'Caption file beside the video')
    pick('Caption file', 'WebVTT')
    expect(await exportNow()).toMatchObject({ captions: 'sidecar', captionFormat: 'vtt' })
    pick('Captions', 'No captions')
    expect((await exportNow()).captions).toBe('none')
  })

  it('no caption controls when the project has no captions', async () => {
    S().load({ project: project(false), version: 3, projectId: 'p1', demo: false, workspaceId: 'w1' })
    render(<ExportDialog />)
    expect(screen.queryAllByRole('group', { name: 'Captions' })).toEqual([])
    expect((await exportNow()).captions).toBeUndefined()
  })

  it('a platform preset sets the shape, size, frame rate and quality', async () => {
    render(<ExportDialog />)
    fireEvent.change(screen.getByRole('combobox', { name: 'Preset' }), { target: { value: 'shorts' } })
    expect(screen.getByText(/1080×1920/)).toBeTruthy()
    expect(screen.getByText(/Reframed to 9:16 for this export/)).toBeTruthy()
    expect(await exportNow()).toMatchObject({ aspect: '9:16', resolution: '1080p', fps: 30, quality: 'standard', format: 'mp4' })
    // the project's own shape needs no reframing
    fireEvent.change(screen.getByRole('combobox', { name: 'Preset' }), { target: { value: 'youtube' } })
    const body = await exportNow()
    expect(body.aspect).toBeUndefined()
    expect(body.quality).toBe('high')
  })

  it('the cover frame: the slider, the playhead, or automatic', async () => {
    act(() => S().setPlayhead(4))
    render(<ExportDialog />)
    expect((await exportNow()).coverAt).toBeUndefined()
    fireEvent.change(screen.getByRole('slider', { name: 'Cover frame' }), { target: { value: '6.5' } })
    expect((await exportNow()).coverAt).toBe(6.5)
    fireEvent.click(screen.getByRole('button', { name: 'Use playhead' }))
    expect((await exportNow()).coverAt).toBe(4)
    fireEvent.click(screen.getByRole('button', { name: 'Auto' }))
    expect((await exportNow()).coverAt).toBeUndefined()
  })
})

describe('exporting in the background (E-5)', { timeout: 20_000 }, () => {
  it('Keep working closes the dialog; the finished export says so with Open, and in a notification', async () => {
    let calls = 0
    vi.spyOn(api, 'job').mockImplementation(async () => (++calls < 2 ? job({}) : done({ exportId: 'e1', url: '/api/media/x/source', sizeBytes: 2e6, duration: 10 })) as never)
    const shown: Array<{ title: string; body?: string }> = []
    const requestPermission = vi.fn(async () => 'granted')
    class FakeNotification {
      static permission = 'default'
      static requestPermission = requestPermission
      onclick: (() => void) | null = null
      constructor(title: string, o?: { body?: string }) {
        shown.push({ title, body: o?.body })
      }
      close() {}
    }
    vi.stubGlobal('Notification', FakeNotification)
    const view = render(<ExportDialog />)
    await exportNow()
    expect(screen.getByRole('progressbar', { name: 'Export progress' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Keep working' }))
    expect(requestPermission).toHaveBeenCalled()
    expect(S().exportOpen).toBe(false)
    view.unmount()
    FakeNotification.permission = 'granted'
    vi.spyOn(document, 'hasFocus').mockReturnValue(false)
    await act(() => new Promise((r) => setTimeout(r, 1300)))
    const t = useToasts.getState().toasts.find((x) => /Export ready: Launch/.test(x.text))!
    expect(t.action?.label).toBe('Open')
    expect(shown).toEqual([{ title: 'Export ready', body: 'Launch' }])
    // Open shows the finished export in its dialog
    act(() => t.action!.run())
    expect(S().exportOpen).toBe(true)
    render(<ExportDialog />)
    expect(screen.getByText('Export ready')).toBeTruthy()
    expect(screen.getByRole('link', { name: /Download · 2.0 MB/ })).toBeTruthy()
    // closing it clears it: the next export starts fresh
    fireEvent.click(screen.getByRole('button', { name: 'Done' }))
    expect(useExports.getState().byProject.p1).toBeUndefined()
  })

  it('Cancel export stops the render', async () => {
    vi.spyOn(api, 'job').mockResolvedValue(job({}) as never)
    const cancel = vi.spyOn(api, 'cancelJob').mockResolvedValue(job({ status: 'cancelled' }) as never)
    render(<ExportDialog />)
    await exportNow()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel export' }))
    expect(cancel).toHaveBeenCalledWith('j1')
  })

  it('the export links its sidecar caption file when it has one', async () => {
    vi.spyOn(api, 'job').mockResolvedValue(done({ exportId: 'e1', url: '/api/media/x/source', sizeBytes: 2e6, duration: 10, captionsUrl: '/api/exports/e1/captions' }) as never)
    render(<ExportDialog />)
    await exportNow()
    await act(() => new Promise((r) => setTimeout(r, 20)))
    expect(screen.getByRole('link', { name: 'Caption file' }).getAttribute('href')).toBe('/api/exports/e1/captions?download=1')
  })
})

describe('draft preview (E-23)', { timeout: 20_000 }, () => {
  it('renders the chosen part as a draft and plays it in the dialog, without an export', async () => {
    useTransport.setState({ inPoint: 1, outPoint: 3 })
    render(<ExportDialog />)
    pick('Part', 'In to out (00:01:00 – 00:03:00)')
    pick('Format', 'Animated GIF')
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Render draft/ }))
      await new Promise((r) => setTimeout(r, 30))
    })
    expect(sent.at(-1)).toMatchObject({ preview: true, format: 'mp4', range: { from: 1, to: 3 } })
    const player = screen.getByLabelText('Draft preview player') as HTMLVideoElement
    expect(player.getAttribute('src')).toBe('/api/projects/p1/previews/jd')
    // the export itself hasn't started
    expect(useExports.getState().byProject.p1).toBeUndefined()
    expect(screen.getByRole('button', { name: /^Export$/ })).toBeTruthy()
    expect(exp).toHaveBeenCalledTimes(1)
  })
})
