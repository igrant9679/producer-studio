// The editor's music library (19 Nov 2026, the owner: "unable to hear/listen/sample to the audio samples before adding
// them to the timeline" and "give me 20 available samples of music that I can use/insert into my video"): every track can
// be heard first, and + puts it at the playhead; the space's own sounds can be heard too.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MUSIC_LIBRARY, createProject, type AssetRecord, type Project } from '@producer/core'
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

function open(project: Project = createProject({ id: 'p1', name: 'Film' }), records: AssetRecord[] = []) {
  S().load({ project, version: 1, projectId: 'p1', demo: false, workspaceId: 'w1' })
  S().set({ activeLeftTab: 'audio', leftCollapsed: false, readOnly: false, playhead: 4 })
  useLibrary.setState({ records, loaded: true, loading: false, uploads: [] })
  return render(<AssetPanel />)
}

beforeEach(() => {
  made.length = 0
  vi.stubGlobal('Audio', FakeAudio)
  vi.spyOn(api, 'voices').mockResolvedValue([])
  vi.spyOn(api, 'musicLibrary').mockResolvedValue(MUSIC_LIBRARY.map((t, i) => ({ ...t, ready: i > 0 })))
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('the music library in the Audio panel', () => {
  it('lists the 20 tracks with their style, mood and length', async () => {
    open()
    const lib = screen.getByRole('group', { name: 'Music library' })
    expect(within(lib).getByText('Music library · 20')).toBeTruthy()
    expect(within(lib).getAllByRole('button', { name: /^Listen to / })).toHaveLength(20)
    expect(within(lib).getByText('Sunny Mallets')).toBeTruthy()
    expect(within(lib).getByText(/Friendly explainer · Friendly and light · 1:15/)).toBeTruthy()
    await waitFor(() => expect(api.musicLibrary).toHaveBeenCalled())
  })

  it('plays a track before it is used, says it is on its way until it plays, and stops it on a second press', async () => {
    open()
    const t = MUSIC_LIBRARY[2]
    fireEvent.click(screen.getByRole('button', { name: `Listen to ${t.title}` }))
    expect(made.at(-1)).toMatchObject({ src: `/api/music/${t.id}/preview`, played: 1 })
    const stop = screen.getByRole('button', { name: `Stop ${t.title}` })
    // still on its way: a spinner, not the pause sign
    expect(stop.querySelector('.spin')).toBeTruthy()
    act(() => (made.at(-1)!.el as unknown as FakeAudio).onplaying?.())
    expect(stop.querySelector('.spin')).toBeNull()
    fireEvent.click(stop)
    expect(made.at(-1)!.paused).toBeGreaterThan(0)
    expect(screen.getByRole('button', { name: `Listen to ${t.title}` })).toBeTruthy()
    // another track stops the first
    fireEvent.click(screen.getByRole('button', { name: `Listen to ${MUSIC_LIBRARY[5].title}` }))
    fireEvent.click(screen.getByRole('button', { name: `Listen to ${MUSIC_LIBRARY[6].title}` }))
    expect(made.at(-2)!.paused).toBeGreaterThan(0)
    expect(made.at(-1)!.src).toBe(`/api/music/${MUSIC_LIBRARY[6].id}/preview`)
  })

  it('+ adds the track to the space and puts it at the playhead', async () => {
    const t = MUSIC_LIBRARY[0]
    const rec: AssetRecord = { asset: { id: 'as_lib1', kind: 'audio', name: `Music · ${t.title}`, src: '/api/media/as_lib1/source', duration: t.seconds }, workspaceId: 'w1', status: 'ready', origin: 'ai', createdAt: 1, projectId: 'p1' }
    const add = vi.spyOn(api, 'addLibraryMusic').mockResolvedValue(rec)
    open()
    fireEvent.click(screen.getByRole('button', { name: `Add ${t.title} at the playhead` }))
    await waitFor(() => expect(S().project.tracks.some((tr) => tr.items.some((it) => 'assetId' in it && it.assetId === 'as_lib1'))).toBe(true))
    expect(add).toHaveBeenCalledWith(t.id, { workspaceId: 'w1', projectId: 'p1' })
    const item = S().project.tracks.flatMap((tr) => tr.items).find((it) => 'assetId' in it && it.assetId === 'as_lib1')!
    expect(item.start).toBe(4)
    expect(useLibrary.getState().records.some((r) => r.asset.id === 'as_lib1')).toBe(true)
  })

  it('the space’s own sounds can be heard too', () => {
    const rec: AssetRecord = { asset: { id: 'as_up', kind: 'audio', name: 'theme.mp3', src: '', duration: 30 }, workspaceId: 'w1', status: 'ready', origin: 'upload', createdAt: 1 }
    open(undefined, [rec])
    fireEvent.click(screen.getByRole('button', { name: 'Listen to theme.mp3' }))
    expect(made.at(-1)).toMatchObject({ src: '/api/media/as_up/audio', played: 1 })
  })
})
