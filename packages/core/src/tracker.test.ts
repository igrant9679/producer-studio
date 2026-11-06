// The editor requests from the tracker that live in core: the media a project lists but doesn't use (#18), and the
// shapes drawn as paths (#8), the same in the preview and the export.
import { describe, expect, it } from 'vitest'
import { addAsset, addItem, createImageItem, createProject, createShapeItem, createVideoItem, removeUnusedAssets, shapePath, shapeSvg, unusedAssetIds, type Asset } from './index'

const asset = (id: string, kind: Asset['kind'] = 'video'): Asset => ({ id, kind, name: id, src: '', duration: 10, width: 1920, height: 1080 }) as Asset

describe('media a project lists but does not use', () => {
  it('is everything not on the timeline: not a clip, a fill, a slow-motion copy or the logo', () => {
    let p = createProject({ id: 'p', name: 'x' })
    for (const id of ['a', 'b', 'fill', 'smooth', 'logo', 'spare']) p = addAsset(p, asset(id, id === 'fill' || id === 'logo' ? 'image' : 'video'))
    const v = createVideoItem(asset('a'), 0, { duration: 5 })
    v.background = { type: 'image', assetId: 'fill' } as never
    v.smooth = { assetId: 'smooth' } as never
    p = addItem(p, v)
    p = addItem(p, createImageItem(asset('b', 'image'), 5, { duration: 2 }))
    p = { ...p, brand: { name: 'x', colors: [], fonts: { headline: 'Inter', body: 'Inter' }, logoAssetId: 'logo' } }
    expect(unusedAssetIds(p)).toEqual(['spare'])
    // taking out a clip still in use does nothing to it
    const q = removeUnusedAssets(p, ['spare', 'a'])
    expect(Object.keys(q.assets).sort()).toEqual(['a', 'b', 'fill', 'logo', 'smooth'])
    expect(removeUnusedAssets(q, ['a'])).toBe(q)
  })
})

describe('shapes drawn as paths', () => {
  it('fit their box and close', () => {
    for (const s of ['triangle', 'polygon', 'star', 'arrow', 'bubble'] as const) {
      const d = shapePath(s, 200, 100)
      expect(d.startsWith('M ')).toBe(true)
      expect(d.endsWith('Z')).toBe(true)
      const nums = d.match(/-?\d+(\.\d+)?/g)!.map(Number)
      expect(Math.min(...nums)).toBeGreaterThanOrEqual(0)
      expect(Math.max(...nums)).toBeLessThanOrEqual(200)
    }
    // a star has twice its points as corners; a polygon its sides
    expect(shapePath('star', 100, 100, 5).split(' L ').length).toBe(10)
    expect(shapePath('polygon', 100, 100, 8).split(' L ').length).toBe(8)
    expect(shapePath('polygon', 100, 100, 99).split(' L ').length).toBe(12)
  })

  it('draw with their fill and border, and only path shapes do', () => {
    const star = createShapeItem(0, { shape: 'star', width: 300, height: 300, stroke: { color: '#fff', width: 6 } })
    const svg = shapeSvg(star, '#ff0', '#fff')
    expect(svg).toMatch(/^<svg [^>]*viewBox="-3 -3 306 306"/)
    expect(svg).toMatch(/fill="#ff0" stroke="#fff" stroke-width="6"/)
    expect(shapeSvg(createShapeItem(0, { shape: 'rect' }), '#ff0')).toBe('')
  })
})
