import type { SceneDiagram } from '@producer/core'
import { describe, expect, it } from 'vitest'
import { defaultVisual, diagramFromText, diagramToText, withPrompt } from '../producer/sceneVisuals'
import { canAdvance, initialState, newScene, stateFromProject } from '../producer/wizardLogic'

describe('diagrams as editable lines', () => {
  const samples: SceneDiagram[] = [
    { type: 'steps', items: ['Plan', 'Build', 'Ship'] },
    { type: 'cycle', items: ['Listen', 'Learn', 'Change'] },
    { type: 'hub', center: 'Platform', items: ['Data', 'Apps'] },
    { type: 'bars', items: [{ label: '2024', value: 40 }, { label: '2025', value: 65 }], unit: '%' },
    { type: 'compare', left: { title: 'Before', points: ['Manual'] }, right: { title: 'After', points: ['Automatic', 'Fast'] } },
    { type: 'timeline', items: [{ label: 'Jan', detail: 'Kickoff' }, { label: 'Mar' }] },
    { type: 'stat', value: '3x', label: 'faster onboarding' },
  ]
  for (const d of samples) {
    it(`round-trips ${d.type}`, () => {
      expect(diagramFromText(d.type, diagramToText(d)).diagram).toEqual(d)
    })
  }

  it('says what is missing instead of drawing half a diagram', () => {
    expect(diagramFromText('steps', 'Only one').error).toMatch(/at least 2/)
    expect(diagramFromText('bars', 'Sales: lots\nCosts: 4').error).toMatch(/label: number/)
    expect(diagramFromText('compare', 'Before\nManual').error).toMatch(/---/)
    // blank lines while typing are fine
    expect(diagramFromText('steps', 'Plan\n\nBuild\n').diagram).toEqual({ type: 'steps', items: ['Plan', 'Build'] })
  })
})

describe('scene visuals', () => {
  it('changing what a made visual asks for means making it again', () => {
    const made = { kind: 'image' as const, prompt: 'a lighthouse', assetId: 'as_1' }
    expect(withPrompt(made, 'a lighthouse')).toBe(made)
    expect(withPrompt(made, 'a harbour')).toEqual({ kind: 'image', prompt: 'a harbour' })
    expect(withPrompt({ kind: 'stock', query: 'city', assetId: 'as_2', credit: { author: 'A', url: 'https://x' } }, 'forest')).toEqual({ kind: 'stock', query: 'forest' })
  })

  it('starts a new visual from the scene', () => {
    expect(defaultVisual('stock', { headline: 'Teams that ship faster', narration: '' })).toEqual({ kind: 'stock', query: 'Teams that ship faster' })
    expect(defaultVisual('diagram', { headline: '', narration: '' }).kind).toBe('diagram')
  })
})

describe('starting from an idea', () => {
  it('needs a sentence of idea instead of recordings', () => {
    const s = initialState()
    expect(canAdvance(s).ok).toBe(false)
    const idea = { ...s, brief: { ...s.brief, source: 'idea' as const, idea: 'Too short' } }
    expect(canAdvance(idea)).toMatchObject({ ok: false, reason: expect.stringMatching(/sentence/) })
    expect(canAdvance({ ...idea, brief: { ...idea.brief, idea: 'Explain our three-step onboarding to new customers.' } }).ok).toBe(true)
  })

  it('new scenes in an idea video show animated text, not footage', () => {
    const sc = newScene('as_rec', undefined, true)
    expect(sc.footage).toEqual([])
    expect(sc.visual).toEqual({ kind: 'motion', points: [] })
  })

  it('resumes an idea project at the brief, not the upload step', () => {
    const s = stateFromProject({
      summary: { id: 'p1', workspaceId: 'ws', name: 'Idea' } as never,
      project: { assets: {}, ai: { brief: { title: 'Idea', audience: '', goal: '', tone: 'warm', template: '', voice: 'af_heart', aspect: '16:9', source: 'idea', idea: 'Explain onboarding' } } } as never,
      version: 1,
    })
    expect(s.step).toBe('brief')
  })
})
