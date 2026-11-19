// How the captions of a video made by Producer look (19 Nov 2026, the owner: "the ability to choose whether to have
// transcript/words in the video and the font, placement, size, etc. of the words").
import { describe, expect, it } from 'vitest'
import { CAPTION_PLACES, CAPTION_PRESETS, captionStyleForBrief, captionStyleFromPreset } from './presets'

const o = { brandFont: 'Inter', scale: 1, boxWidth: 1536 }

describe('the brief’s captions', () => {
  it('say nothing: the brand kit’s look in the brand’s body font, at the look’s own size and place', () => {
    const s = captionStyleForBrief({}, { ...o, brandPreset: 'boxed' })
    const boxed = captionStyleFromPreset('boxed')
    expect(s.preset).toBe('boxed')
    expect(s.style.fontFamily).toBe('Inter')
    expect(s.style.fontSize).toBe(boxed.style.fontSize)
    expect(s.position).toBe(boxed.position)
    expect(s.style.boxWidth).toBe(1536)
    // no kit look either: Clean
    expect(captionStyleForBrief({}, o).preset).toBe('clean')
  })

  it('take the look, font, size and place the brief picked', () => {
    const s = captionStyleForBrief({ captionPreset: 'karaoke', captionFont: 'Montserrat', captionSize: 'large', captionPosition: 'top' }, { ...o, brandPreset: 'boxed', scale: 0.5 })
    const k = captionStyleFromPreset('karaoke')
    expect(s.preset).toBe('karaoke')
    expect(s.mode).toBe('karaoke')
    expect(s.style.fontFamily).toBe('Montserrat')
    expect(s.style.fontSize).toBe(Math.round(k.style.fontSize * 0.5 * 1.3))
    expect(s.position).toBe(CAPTION_PLACES.top)
    expect(captionStyleForBrief({ captionPosition: 'middle', captionSize: 'small' }, o)).toMatchObject({ position: 0.5, style: { fontSize: Math.round(captionStyleFromPreset('clean').style.fontSize * 0.8) } })
    // bottom is the look's own place
    expect(captionStyleForBrief({ captionPreset: 'word-pop', captionPosition: 'bottom' }, o).position).toBe(captionStyleFromPreset('word-pop').position)
  })

  it('never take a font the renderer doesn’t have', () => {
    expect(captionStyleForBrief({ captionFont: 'Comic Sans MS' }, o).style.fontFamily).toBe('Inter')
    expect(CAPTION_PRESETS.length).toBeGreaterThanOrEqual(5)
  })
})
