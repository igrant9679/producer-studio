// The editor's media library (19 Nov 2026, the owner: "unable to hear/listen/sample to the audio samples before adding
// them to the timeline"; 21 Nov: the music replaced by 20 AI songs of different genres, and a clip library of 10
// animations and 10 full-motion clips): what has been made is listed, can be heard or watched first, and + puts it at
// the playhead; the space's own sounds can be heard too.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { CLIP_LIBRARY, MUSIC_LIBRARY, createProject, type AssetRecord, type Project } from '@producer/core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '../../lib/api'
import { AssetPanel } from '../LeftPanel'
import { useEditor } from '../store'
import { useLibrary } from '../uploads'

const S = () => useEditor.getState()

/** Audio elements made for previews: what they were asked to play, and their events to fire. */
const made: Array<{ src: string; played: number; paused: number; el: HTMLAudioElement }> = []
class FakeAudio {
  src: string
  volume = 1
  onended: (() => void) | null = null
  onwaiting: (() => void) | null = null
  onplaying: (() => void) | null = null
  private rec: (typeof made)[number]
  constructor(src: string) {
    this.src = src
    this.rec = { src, played: 0, paused: 0, el: this as unknown as HTMLAudioElement }
    made.push(this.rec)
  }
  play() {
    this.rec.played++
    return Promise.resolve()
  }
  pause() {
    this.rec.paused++
  }
}

function open(tab: 'audio' | 'media' = 'audio', project: Project = createProject({ id: 'p1', name: 'Film' }), records: AssetRecord[] = []) {
  S().load({ project, version: 1, projectId: 'p1', demo: false, workspaceId: 'w1' })
  S().set({ activeLeftTab: tab, leftCollapsed: false, readOnly: false, playhead: 4 })
  useLibrary.setState({ records, loaded: true, loading: false, uploads: [] })
  return render(<AssetPanel />)
}

/** Every track made but the first; each 1:52 long. */
const someMade = () => MUSIC_LIBRARY.map((t, i) => ({ ...t, ready: i > 0, ...(i > 0 ? { seconds: 112 } : {}) }))

beforeEach(() => {
  made.length = 0
  vi.stubGlobal('Audio', FakeAudio)
  vi.spyOn(api, 'voices').mockResolvedValue([])
  vi.spyOn(api, 'musicLibrary').mockResolvedValue(someMade())
  vi.spyOn(api, 'clipLibrary').mockResolvedValue(CLIP_LIBRARY.map((c, i) => ({ ...c, ready: i !== 1, seconds: 8 })))
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('the music library in the Audio panel', () => {
  it('lists the songs that have been made, with their genre, mood and length', async () => {
    open()
    const lib = screen.getByRole('group', { name: 'Music library' })
    await waitFor(() => expect(within(lib).getByText('Music library · 19')).toBeTruthy())
    expect(within(lib).getAllByRole('button', { name: /^Listen to / })).toHaveLength(19)
    // the one not made yet isn't offered
    expect(within(lib).queryByText(MUSIC_LIBRARY[0].title)).toBeNull()
    const t = MUSIC_LIBRARY[1]
    expect(within(lib).getByText(t.title)).toBeTruthy()
    expect(within(lib).getByText(`${t.genre} · ${t.mood} · 1:52`)).toBeTruthy()
  })

  it('says when none has been made yet', async () => {
    vi.mocked(api.musicLibrary).mockResolvedValue(MUSIC_LIBRARY.map((t) => ({ ...t, ready: false })))
    open()
    expect(await screen.findByText(/music is being made/)).toBeTruthy()
    expect(screen.queryAllByRole('button', { name: /^Listen to / })).toHaveLength(0)
  })

  it('plays a song before it is used, says it is on its way until it plays, and stops it on a second press', async () => {
    open()
    const t = MUSIC_LIBRARY[2]
    fireEvent.click(await screen.findByRole('button', { name: `Listen to ${t.title}` }))
    expect(made.at(-1)).toMatchObject({ src: `/api/music/${t.id}/preview`, played: 1 })
    const stop = screen.getByRole('button', { name: `Stop ${t.title}` })
    expect(stop.querySelector('.spin')).toBeTruthy()
    act(() => (made.at(-1)!.el as unknown as FakeAudio).onplaying?.())
    expect(stop.querySelector('.spin')).toBeNull()
    fireEvent.click(stop)
    expect(made.at(-1)!.paused).toBeGreaterThan(0)
    // another song stops the first
    fireEvent.click(screen.getByRole('button', { name: `Listen to ${MUSIC_LIBRARY[5].title}` }))
    fireEvent.click(screen.getByRole('button', { name: `Listen to ${MUSIC_LIBRARY[6].title}` }))
    expect(made.at(-2)!.paused).toBeGreaterThan(0)
    expect(made.at(-1)!.src).toBe(`/api/music/${MUSIC_LIBRARY[6].id}/preview`)
  })

  it('+ adds the song to the space and puts it at the playhead', async () => {
    const t = MUSIC_LIBRARY[1]
    const rec: AssetRecord = { asset: { id: 'as_lib1', kind: 'audio', name: `Music · ${t.title}`, src: '/api/media/as_lib1/source', duration: 112 }, workspaceId: 'w1', status: 'ready', origin: 'ai', createdAt: 1, projectId: 'p1' }
    const add = vi.spyOn(api, 'addLibraryMusic').mockResolvedValue(rec)
    open()
    fireEvent.click(await screen.findByRole('button', { name: `Add ${t.title} at the playhead` }))
    await waitFor(() => expect(S().project.tracks.some((tr) => tr.items.some((it) => 'assetId' in it && it.assetId === 'as_lib1'))).toBe(true))
    expect(add).toHaveBeenCalledWith(t.id, { workspaceId: 'w1', projectId: 'p1' })
    expect(S().project.tracks.flatMap((tr) => tr.items).find((it) => 'assetId' in it && it.assetId === 'as_lib1')!.start).toBe(4)
    expect(useLibrary.getState().records.some((r) => r.asset.id === 'as_lib1')).toBe(true)
  })

  it('the space’s own sounds can be heard too', () => {
    const rec: AssetRecord = { asset: { id: 'as_up', kind: 'audio', name: 'theme.mp3', src: '', duration: 30 }, workspaceId: 'w1', status: 'ready', origin: 'upload', createdAt: 1 }
    open('audio', undefined, [rec])
    fireEvent.click(screen.getByRole('button', { name: 'Listen to theme.mp3' }))
    expect(made.at(-1)).toMatchObject({ src: '/api/media/as_up/audio', played: 1 })
  })
})

describe('the clip library in the Media panel', () => {
  it('shows the animations and the full-motion clips that have been made, each with its frame, and plays one on hover', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      open('media')
      fireEvent.click(screen.getByRole('tab', { name: 'Clip library' }))
      const lib = screen.getByRole('group', { name: 'Clip library' })
      const animations = CLIP_LIBRARY.filter((c) => c.kind === 'animation')
      // the second animation isn't made yet
      await waitFor(() => expect(within(lib).getByRole('button', { name: 'Animations · 9' })).toBeTruthy())
      expect(within(lib).getByRole('button', { name: 'Full motion · 10' })).toBeTruthy()
      expect(within(lib).queryByText(animations[1].title)).toBeNull()
      const first = within(lib).getByText(animations[0].title).closest('.ed-libclip') as HTMLElement
      expect(first.querySelector('img')!.getAttribute('src')).toBe(`/api/clips/${animations[0].id}/poster`)
      expect(within(first).getByText('Clean and simple')).toBeTruthy()
      fireEvent.mouseEnter(first.querySelector('.thumb')!)
      act(() => vi.advanceTimersByTime(200))
      expect(first.querySelector('video')!.getAttribute('src')).toBe(`/api/clips/${animations[0].id}/preview`)
      fireEvent.click(within(lib).getByRole('button', { name: 'Full motion · 10' }))
      const motion = CLIP_LIBRARY.filter((c) => c.kind === 'motion')
      expect(within(lib).getByText(motion[0].title)).toBeTruthy()
      expect(within(lib).queryByText(animations[0].title)).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('+ adds a clip to the space and puts it at the playhead', async () => {
    const c = CLIP_LIBRARY.find((x) => x.kind === 'motion')!
    const rec: AssetRecord = { asset: { id: 'as_clip1', kind: 'video', name: `Clip · ${c.title}`, src: '/api/media/as_clip1/source', duration: 8, width: 1280, height: 720 }, workspaceId: 'w1', status: 'ready', origin: 'ai', createdAt: 1, projectId: 'p1' }
    const add = vi.spyOn(api, 'addLibraryClip').mockResolvedValue(rec)
    open('media')
    fireEvent.click(screen.getByRole('tab', { name: 'Clip library' }))
    fireEvent.click(await screen.findByRole('button', { name: /^Full motion/ }))
    fireEvent.click(screen.getByRole('button', { name: `Add ${c.title} at the playhead` }))
    await waitFor(() => expect(S().project.tracks.some((tr) => tr.items.some((it) => 'assetId' in it && it.assetId === 'as_clip1'))).toBe(true))
    expect(add).toHaveBeenCalledWith(c.id, { workspaceId: 'w1', projectId: 'p1' })
    // on the main track, which keeps no gaps: an empty project's first clip starts at 0
    const main = S().project.tracks.find((tr) => tr.items.some((it) => 'assetId' in it && it.assetId === 'as_clip1'))!
    expect(main.kind).toBe('video')
    expect(main.items.find((it) => 'assetId' in it && it.assetId === 'as_clip1')!.start).toBe(0)
  })

  it('says when the clips are still being made', async () => {
    vi.mocked(api.clipLibrary).mockResolvedValue(CLIP_LIBRARY.map((c) => ({ ...c, ready: false })))
    open('media')
    fireEvent.click(screen.getByRole('tab', { name: 'Clip library' }))
    expect(await screen.findByText(/clips are being made/)).toBeTruthy()
  })

  it('opens from the Help’s button', async () => {
    open('media')
    expect(screen.queryByRole('group', { name: 'Clip library' })).toBeNull()
    act(() => useEditor.setState((s) => ({ clipLibraryAsk: s.clipLibraryAsk + 1 })))
    expect(await screen.findByRole('group', { name: 'Clip library' })).toBeTruthy()
  })
})
