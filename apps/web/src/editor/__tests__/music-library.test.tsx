// The editor's media library (19 Nov 2026, the owner: "unable to hear/listen/sample to the audio samples before adding
// them to the timeline"; 21 Nov: the music replaced by 20 AI songs of different genres, and a clip library of 10
// animations and 10 full-motion clips): what has been made is listed, can be heard or watched first, and + puts it at
// the playhead; the space's own sounds can be heard too.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { CLIP_LIBRARY, MUSIC_LIBRARY, addAsset, addItem, createProject, createVideoItem, type AssetRecord, type AudioItem, type ImageItem, type Project, type TextItem } from '@producer/core'
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
  vi.spyOn(api, 'clipLibrary').mockResolvedValue(CLIP_LIBRARY.map((c, i) => ({ ...c, ready: i !== 1, seconds: 8.04 })))
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('the music library in the Audio panel', () => {
  it('makes a song the video’s music after asking (24 Nov 2026), and takes the new version in', async () => {
    open()
    const t = MUSIC_LIBRARY[1]
    const use = vi.spyOn(api, 'setVideoMusic').mockResolvedValue({ id: 'j9', kind: 'project.music', status: 'queued', progress: 0, message: '' } as never)
    vi.spyOn(api, 'job').mockResolvedValue({ id: 'j9', kind: 'project.music', status: 'done', progress: 1, message: 'Done', result: { version: 2, song: t.id, seconds: 30 } } as never)
    const changed = createProject({ id: 'p1', name: 'Film with new music' })
    vi.spyOn(api, 'project').mockResolvedValue({ summary: { id: 'p1', workspaceId: 'w1', name: changed.name }, project: changed, version: 2 } as never)
    const lib = screen.getByRole('group', { name: 'Music library' })
    fireEvent.click(await within(lib).findByRole('button', { name: `Use ${t.title} as this video’s music` }))
    // it asks first, saying what happens to the music there is
    expect(screen.getByText(`Use “${t.title}” as this video’s music?`)).toBeTruthy()
    expect(screen.getByText(/The version before is kept in Versions/)).toBeTruthy()
    expect(use).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Use this song' }))
    await waitFor(() => expect(use).toHaveBeenCalledWith(t.id, { projectId: 'p1' }))
    await waitFor(() => expect(S().version).toBe(2))
    expect(S().project.name).toBe('Film with new music')
    await waitFor(() => expect(screen.queryByText(`Use “${t.title}” as this video’s music?`)).toBeNull())
  })

  it('offers no swap in the demo, which has no server to change the music', async () => {
    S().load({ project: createProject({ id: 'p1', name: 'Film' }), version: 1, projectId: 'p1', demo: true, workspaceId: 'w1' })
    S().set({ activeLeftTab: 'audio', leftCollapsed: false, readOnly: false })
    render(<AssetPanel />)
    const lib = screen.getByRole('group', { name: 'Music library' })
    await within(lib).findByText(MUSIC_LIBRARY[1].title)
    expect(within(lib).queryByRole('button', { name: /as this video’s music/ })).toBeNull()
  })

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

describe('making a library item your own (21 Nov 2026: “customize based on their needs/brand/topic”)', () => {
  const clipRec = (id: string, name: string): AssetRecord => ({ asset: { id, kind: 'video', name, src: `/api/media/${id}/source`, duration: 8, width: 1920, height: 1080 }, workspaceId: 'w1', status: 'ready', origin: 'ai', createdAt: 1, projectId: 'p1' })
  const finished = (asset: AssetRecord) => ({ id: 'j1', kind: 'library.custom', status: 'done', progress: 1, message: 'Done', result: { asset }, createdAt: 1, updatedAt: 2 }) as never

  it('adds a clip in the space’s brand: its title, narrative text and logo stamp over it, in the brand’s fonts and colours, free', async () => {
    const anim = CLIP_LIBRARY.find((c) => c.kind === 'animation')!
    vi.spyOn(api, 'brand').mockResolvedValue({ name: 'Northwind', colors: ['#0b1830', '#ff5a5f', '#f3f5fa'], fonts: { headline: 'Montserrat', body: 'Inter' }, logoAssetId: 'as_logo' } as never)
    vi.spyOn(api, 'asset').mockResolvedValue({ asset: { id: 'as_logo', kind: 'image', name: 'logo.png', src: '/api/media/as_logo/source', width: 400, height: 200 }, workspaceId: 'w1', status: 'ready', origin: 'upload', createdAt: 1 })
    vi.spyOn(api, 'addLibraryClip').mockResolvedValue(clipRec('as_anim', `Animation · ${anim.title}`))
    const custom = vi.spyOn(api, 'customizeLibrary')
    open('media')
    fireEvent.click(screen.getByRole('tab', { name: 'Clip library' }))
    fireEvent.click(await screen.findByRole('button', { name: `Make ${anim.title} your own` }))
    const dlg = screen.getByRole('dialog', { name: `Make “${anim.title}” your own` })
    fireEvent.change(await within(dlg).findByLabelText('Title (optional)'), { target: { value: 'Spring launch' } })
    fireEvent.change(within(dlg).getByLabelText('Narrative text (optional)'), { target: { value: 'Faster checkout for everyone' } })
    expect((within(dlg).getByRole('checkbox', { name: /Stamp your logo in the corner/ }) as HTMLInputElement).checked).toBe(true)
    fireEvent.click(within(dlg).getByRole('button', { name: /Add it in my brand/ }))
    await waitFor(() => expect(S().project.tracks.some((tr) => tr.items.some((it) => 'assetId' in it && it.assetId === 'as_anim'))).toBe(true))
    expect(custom).not.toHaveBeenCalled()
    const items = S().project.tracks.flatMap((tr) => tr.items)
    const clip = items.find((it) => 'assetId' in it && it.assetId === 'as_anim')!
    const texts = items.filter((it): it is TextItem => it.type === 'text')
    const titleItem = texts.find((x) => x.text === 'Spring launch')!
    const textItem = texts.find((x) => x.text === 'Faster checkout for everyone')!
    expect(titleItem.style).toMatchObject({ fontFamily: 'Montserrat', color: '#f3f5fa', background: expect.objectContaining({ color: '#0b1830' }) })
    expect(textItem.style).toMatchObject({ fontFamily: 'Inter', background: expect.objectContaining({ color: '#ff5a5f' }) })
    // the title over the first half, the text over the rest
    expect(titleItem.start).toBeGreaterThanOrEqual(clip.start)
    expect(textItem.start).toBeCloseTo(titleItem.start + titleItem.duration, 3)
    // the logo, small, in the bottom-right corner, over the whole clip, on its own track above the clip
    const stampTrack = S().project.tracks.find((tr) => tr.items.some((it) => 'assetId' in it && it.assetId === 'as_logo'))!
    const logoItem = stampTrack.items.find((it) => 'assetId' in it && it.assetId === 'as_logo') as ImageItem
    expect(stampTrack.kind).toBe('overlay')
    expect(logoItem).toMatchObject({ start: clip.start, duration: clip.duration })
    expect(logoItem.transform.scale).toBeLessThan(0.25)
    expect(logoItem.transform.x).toBeGreaterThan(0)
    expect(logoItem.transform.y).toBeGreaterThan(0)
    expect(S().project.assets.as_logo).toBeTruthy()
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('stamps the brand’s name while the kit has no logo', async () => {
    const motion = CLIP_LIBRARY.find((c) => c.kind === 'motion')!
    vi.spyOn(api, 'brand').mockResolvedValue({ name: 'Northwind', colors: ['#0b1830', '#ff5a5f', '#f3f5fa'], fonts: { headline: 'Montserrat', body: 'Inter' } } as never)
    vi.spyOn(api, 'addLibraryClip').mockResolvedValue(clipRec('as_m', `Clip · ${motion.title}`))
    open('media')
    fireEvent.click(screen.getByRole('tab', { name: 'Clip library' }))
    fireEvent.click(await screen.findByRole('button', { name: /^Full motion/ }))
    fireEvent.click(screen.getByRole('button', { name: `Make ${motion.title} your own` }))
    const dlg = screen.getByRole('dialog', { name: `Make “${motion.title}” your own` })
    expect(await within(dlg).findByRole('checkbox', { name: /Stamp “Northwind” in the corner/ })).toBeTruthy()
    fireEvent.click(within(dlg).getByRole('button', { name: /Add it in my brand/ }))
    await waitFor(() => expect(S().project.tracks.flatMap((tr) => tr.items).some((it) => it.type === 'text' && (it as TextItem).text === 'Northwind')).toBe(true))
    const stamp = S().project.tracks.flatMap((tr) => tr.items).find((it) => it.type === 'text' && (it as TextItem).text === 'Northwind') as TextItem
    expect(stamp.style.fontFamily).toBe('Montserrat')
  })

  it('remakes a clip for the video’s topic, saying what it costs first', async () => {
    const motion = CLIP_LIBRARY.find((c) => c.kind === 'motion')!
    const custom = vi.spyOn(api, 'customizeLibrary').mockResolvedValue({ id: 'j1', kind: 'library.custom', status: 'queued', progress: 0, message: '' } as never)
    vi.spyOn(api, 'job').mockResolvedValue(finished(clipRec('as_topic', `Clip · ${motion.title} (“a bakery at dawn”)`)))
    open('media')
    fireEvent.click(screen.getByRole('tab', { name: 'Clip library' }))
    fireEvent.click(await screen.findByRole('button', { name: /^Full motion/ }))
    fireEvent.click(screen.getByRole('button', { name: `Make ${motion.title} your own` }))
    const dlg = screen.getByRole('dialog', { name: `Make “${motion.title}” your own` })
    expect(within(dlg).getByText(/One 8-second AI clip, on this space’s video key/)).toBeTruthy()
    const remake = within(dlg).getByRole('button', { name: /Remake it for this topic/ }) as HTMLButtonElement
    expect(remake.disabled).toBe(true)
    fireEvent.change(within(dlg).getByLabelText('What is your video about?'), { target: { value: 'a bakery at dawn' } })
    fireEvent.click(remake)
    await waitFor(() => expect(S().project.tracks.some((tr) => tr.items.some((it) => 'assetId' in it && it.assetId === 'as_topic'))).toBe(true))
    expect(custom).toHaveBeenCalledWith('clip', motion.id, { workspaceId: 'w1', projectId: 'p1', mode: 'topic', topic: 'a bakery at dawn', aspect: '16:9' })
  })

  it('a song added to a video ends where the video ends, with a fade out', async () => {
    const t = MUSIC_LIBRARY[1]
    const rec: AssetRecord = { asset: { id: 'as_song', kind: 'audio', name: `Music · ${t.title}`, src: '/api/media/as_song/source', duration: 112 }, workspaceId: 'w1', status: 'ready', origin: 'ai', createdAt: 1, projectId: 'p1' }
    vi.spyOn(api, 'addLibraryMusic').mockResolvedValue(rec)
    const p = createProject({ id: 'p1', name: 'Film' })
    const clip: AssetRecord['asset'] = { id: 'as_v', kind: 'video', name: 'v.mp4', src: '', duration: 30, width: 1920, height: 1080 }
    let proj = addAsset(p, clip)
    proj = addItem(proj, createVideoItem(clip, 0), proj.tracks.find((tr) => tr.kind === 'video')!.id)
    S().load({ project: proj, version: 1, projectId: 'p1', demo: false, workspaceId: 'w1' })
    S().set({ activeLeftTab: 'audio', leftCollapsed: false, readOnly: false, playhead: 4 })
    useLibrary.setState({ records: [], loaded: true, loading: false, uploads: [] })
    render(<AssetPanel />)
    fireEvent.click(await screen.findByRole('button', { name: `Add ${t.title} at the playhead` }))
    await waitFor(() => expect(S().project.tracks.some((tr) => tr.items.some((it) => 'assetId' in it && it.assetId === 'as_song'))).toBe(true))
    const song = S().project.tracks.flatMap((tr) => tr.items).find((it) => 'assetId' in it && it.assetId === 'as_song') as AudioItem
    expect(song.start).toBe(4)
    expect(song.duration).toBe(26)
    expect(song.fadeOut).toBe(2)
  })
})

describe('watching a clip before it goes on the timeline (21 Nov 2026: “play/sample the videos in the library before deciding”)', () => {
  it('a library clip plays with sound and controls, and can be added from the player', async () => {
    const c = CLIP_LIBRARY.find((x) => x.kind === 'motion')!
    const rec: AssetRecord = { asset: { id: 'as_w1', kind: 'video', name: `Clip · ${c.title}`, src: '/api/media/as_w1/source', duration: 8, width: 1280, height: 720 }, workspaceId: 'w1', status: 'ready', origin: 'ai', createdAt: 1, projectId: 'p1' }
    const add = vi.spyOn(api, 'addLibraryClip').mockResolvedValue(rec)
    open('media')
    fireEvent.click(screen.getByRole('tab', { name: 'Clip library' }))
    fireEvent.click(await screen.findByRole('button', { name: /^Full motion/ }))
    fireEvent.click(screen.getByRole('button', { name: `Watch ${c.title}` }))
    const dlg = screen.getByRole('dialog', { name: c.title })
    const video = within(dlg).getByLabelText(`${c.title}, preview`) as HTMLVideoElement
    expect(video.getAttribute('src')).toBe(`/api/clips/${c.id}/preview`)
    expect(video.hasAttribute('controls')).toBe(true)
    expect(video.muted).toBe(false)
    expect(within(dlg).getByRole('button', { name: /Make it your own/ })).toBeTruthy()
    fireEvent.click(within(dlg).getByRole('button', { name: /Add at playhead/ }))
    await waitFor(() => expect(S().project.tracks.some((tr) => tr.items.some((it) => 'assetId' in it && it.assetId === 'as_w1'))).toBe(true))
    expect(add).toHaveBeenCalled()
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('the space’s own clips can be watched too', () => {
    const rec: AssetRecord = { asset: { id: 'as_own', kind: 'video', name: 'beach.mp4', src: '', duration: 12, width: 1920, height: 1080 }, workspaceId: 'w1', status: 'ready', origin: 'upload', createdAt: 1 }
    open('media', undefined, [rec])
    fireEvent.click(screen.getByRole('tab', { name: /^Library/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Watch beach.mp4' }))
    const dlg = screen.getByRole('dialog', { name: 'beach.mp4' })
    expect((within(dlg).getByLabelText('beach.mp4, preview') as HTMLVideoElement).getAttribute('src')).toMatch(/as_own/)
    expect(within(dlg).getByRole('button', { name: /Add at playhead/ })).toBeTruthy()
    expect(within(dlg).queryByRole('button', { name: /Make it your own/ })).toBeNull()
  })
})
