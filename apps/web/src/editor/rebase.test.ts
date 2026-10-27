import { addAsset, addItem, createImageItem, createProject, createTextItem, deleteItems, importSrt, updateItem, updateProject, type Asset, type Project } from '@producer/core'
import { describe, expect, it } from 'vitest'
import { rebase } from './rebase'

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

  it('refuses when both changed the magnetic main track (ripples collide)', () => {
    const base = start()
    const theirs = deleteItems(base, ['img1'], { ripple: true })
    const mine = updateItem(base, 'img2', { duration: 2 })
    expect(rebase(base, theirs, mine)).toBeNull()
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
