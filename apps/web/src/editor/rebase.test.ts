import { addAsset, addItem, createImageItem, createProject, createTextItem, deleteItems, importSrt, updateItem, updateProject, type Asset, type Project } from '@producer/core'
import { describe, expect, it } from 'vitest'
import { rebase, rebaseDetailed } from './rebase'

const still: Asset = { id: 'as_still', kind: 'image', name: 'still.png', src: '/api/media/as_still/source', width: 1920, height: 1080 }

/** A project with two main-track stills and a title on a text track. */
function start(): Project {
  let p = addAsset(createProject({ id: 'p1', name: 'Base' }), still)
  p = addItem(p, createImageItem(still, 0, { id: 'img1', duration: 4 }))
  p = addItem(p, createImageItem(still, 4, { id: 'img2', duration: 4 }))
  return addItem(p, createTextItem(0, 'heading', { id: 'title', duration: 2 }))
}

const item = (p: Project, id: string) => p.tracks.flatMap((t) => t.items).find((i) => i.id === id)

describe('rebase (apply a result made from an older document)', () => {
  it('applies their new items onto my edits made meanwhile', () => {
    const base = start()
    const theirs = addItem(base, createTextItem(5, 'heading', { id: 'outro', duration: 2 }))
    const mine = updateItem(updateProject(base, { background: '#223344' }), 'title', { duration: 3 })
    const out = rebase(base, theirs, mine)!
    expect(out).not.toBeNull()
    expect(out.background).toBe('#223344')
    expect(item(out, 'title')?.duration).toBe(3)
    expect(item(out, 'outro')).toBeTruthy()
  })

  it('applies a new caption track while I added a text track', () => {
    const base = start()
    const theirs = importSrt(base, '1\n00:00:00,000 --> 00:00:01,500\nHello there\n')
    // the title's track is taken at 1 s, so this lands on a new text track
    const mine = addItem(base, createTextItem(1, 'heading', { id: 'second', duration: 2 }))
    expect(mine.tracks).toHaveLength(base.tracks.length + 1)
    const out = rebase(base, theirs, mine)!
    expect(out).not.toBeNull()
    expect(item(out, 'second')).toBeTruthy()
    expect(out.tracks).toHaveLength(base.tracks.length + 2)
    expect(out.tracks[out.tracks.length - 1].kind).toBe('caption')
    expect(out.tracks.find((t) => t.kind === 'caption')!.items.map((c) => (c as { text: string }).text)).toEqual(['Hello there'])
  })

  it('refuses when both changed the same item differently', () => {
    const base = start()
    const theirs = updateItem(base, 'title', { duration: 1 })
    const mine = updateItem(base, 'title', { duration: 3 })
    expect(rebase(base, theirs, mine)).toBeNull()
  })

  it('refuses when they changed an item I deleted', () => {
    const base = start()
    const theirs = updateItem(base, 'title', { duration: 1 })
    const mine = deleteItems(base, ['title'])
    expect(rebase(base, theirs, mine)).toBeNull()
  })

  it('refuses a result that would stack two clips on one track', () => {
    const base = start()
    const textTrack = base.tracks.find((t) => t.items.some((i) => i.id === 'title'))!.id
    const theirs = addItem(base, createTextItem(3, 'heading', { id: 'a', duration: 2 }), textTrack)
    const mine = addItem(base, createTextItem(4, 'heading', { id: 'b', duration: 2 }), textTrack)
    expect(rebase(base, theirs, mine)).toBeNull()
  })

  it('combines a ripple on the magnetic main track with a trim of the clip it moved (E-3)', () => {
    const base = start()
    // they deleted the first still (the second moves up to 0); I shortened the second
    const theirs = deleteItems(base, ['img1'], { ripple: true })
    const mine = updateItem(base, 'img2', { duration: 2 })
    const out = rebase(base, theirs, mine)!
    expect(out).not.toBeNull()
    expect(item(out, 'img1')).toBeUndefined()
    expect(item(out, 'img2')).toMatchObject({ start: 0, duration: 2 })
  })

  it('refuses when both changed the magnetic main track (ripples collide)', () => {
    const base = start()
    const theirs = deleteItems(base, ['img1'], { ripple: true })
    const mine = updateItem(base, 'img1', { duration: 2 })
    expect(rebase(base, theirs, mine)).toBeNull()
  })

  it('merges two people changing different things about the same clip, field by field (E-3)', () => {
    const base = start()
    const title = item(base, 'title') as unknown as { style: Record<string, unknown> }
    // they recoloured the title, I lengthened it and changed its font size
    const theirs = updateItem(base, 'title', { style: { ...title.style, color: '#ff0000' } } as never)
    const mine = updateItem(base, 'title', { duration: 3, style: { ...title.style, fontSize: 99 } } as never)
    const out = rebase(base, theirs, mine)!
    expect(out).not.toBeNull()
    expect(item(out, 'title')).toMatchObject({ duration: 3, style: { color: '#ff0000', fontSize: 99 } })
  })

  it('says what overlapped when the same field changed both ways', () => {
    const base = start()
    const r = rebaseDetailed(base, updateItem(base, 'title', { duration: 1 }), updateItem(base, 'title', { duration: 3 }))
    expect(r).toEqual({ conflict: expect.stringMatching(/^“.+”$|^a text$/) })
    const bg = rebaseDetailed(base, updateProject(base, { background: '#111111' }), updateProject(base, { background: '#222222' }))
    expect(bg).toEqual({ conflict: 'the background colour' })
  })

  it('keeps the media records that arrived meanwhile', () => {
    const base = start()
    const theirs = updateItem(base, 'title', { duration: 1 })
    const mine = { ...base, assets: { ...base.assets, as_still: { ...still, thumbnail: '/api/media/as_still/thumb' } } }
    const out = rebase(base, theirs, mine)!
    expect(out.assets.as_still.thumbnail).toBe('/api/media/as_still/thumb')
    expect(item(out, 'title')?.duration).toBe(1)
  })
})
