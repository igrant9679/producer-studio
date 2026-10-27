// The editor plays the copy the server made of a picture or a sound browsers can't use (TIFF → PNG, AIFF → AAC),
// and the original otherwise. (PIP-24)
import type { Asset } from '@producer/core'
import { describe, expect, it } from 'vitest'
import { assetUrl, thumbUrl } from './media'

const asset = (over: Partial<Asset>): Asset => ({ id: 'as1', kind: 'image', name: 'x', src: '/api/media/as1/source', ...over })

describe('asset URLs (PIP-24)', () => {
  it('a TIFF is drawn from its PNG copy', () => {
    const tiff = asset({ kind: 'image', name: 'scan.tiff', proxySrc: '/api/media/as1/proxy' })
    expect(assetUrl(tiff, 'as1', 'media')).toBe('/api/media/as1/proxy')
    expect(thumbUrl({ ...tiff, thumbnail: undefined })).toBe('/api/media/as1/proxy')
  })

  it('an AIFF plays from its AAC copy', () => {
    expect(assetUrl(asset({ kind: 'audio', name: 'take.aiff', proxySrc: '/api/media/as1/proxy' }), 'as1', 'media')).toBe('/api/media/as1/proxy')
  })

  it('a photo or an MP3 without a copy plays as it is; a video plays its original unless the proxy is asked for', () => {
    expect(assetUrl(asset({ kind: 'image', name: 'a.jpg' }), 'as1', 'media')).toBe('/api/media/as1/source')
    expect(assetUrl(asset({ kind: 'audio', name: 'a.mp3' }), 'as1', 'media')).toBe('/api/media/as1/source')
    const video = asset({ kind: 'video', proxySrc: '/api/media/as1/proxy' })
    expect(assetUrl(video, 'as1', 'media')).toBe('/api/media/as1/source')
    expect(assetUrl(video, 'as1', 'proxy')).toBe('/api/media/as1/proxy')
  })
})
