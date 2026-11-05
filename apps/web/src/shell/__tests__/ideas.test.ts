import { videoParts, type SceneDiagram } from '@producer/core'
import { describe, expect, it } from 'vitest'
import { defaultVisual, diagramFromText, diagramToText, objectsFromText, objectsToText, withPrompt } from '../producer/sceneVisuals'
import { estimateAssemble } from '../producer/estimates'
import { failedReason } from '../../editor/LeftPanel'
import { animationOnly, canAdvance, defaultBrief, everything, initialState, newScene, stateFromProject, unsavedDraft, validateScenes } from '../producer/wizardLogic'

describe('a draft only this tab holds', () => {
  it('is unsaved once it has an idea, a title, recordings or scenes, and never once a project holds it', () => {
    const s = initialState()
    expect(unsavedDraft(s)).toBe(false)
    expect(unsavedDraft({ ...s, brief: { ...s.brief, idea: 'A tour of the studio' } })).toBe(true)
    expect(unsavedDraft({ ...s, brief: { ...s.brief, title: 'Spring tour' } })).toBe(true)
    expect(unsavedDraft({ ...s, scenes: [newScene()] })).toBe(true)
    expect(unsavedDraft({ ...s, projectId: 'p1', scenes: [newScene()] })).toBe(false)
  })
})

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

describe('animations and stock photos', () => {
  it('an animation is edited as lines of “thing: caption”, keeping the illustration found while the name stays', () => {
    const prev = [{ name: 'rocket', label: 'Launch', assetId: 'as_r', icon: 'fluent-emoji:rocket' }, { name: 'globe', assetId: 'as_g' }]
    expect(objectsToText(prev)).toBe('rocket: Launch\nglobe')
    const r = objectsFromText('Rocket: Lift off\n\nmoney bag:  Revenue \nglobe', prev)
    expect(r.objects).toEqual([
      { name: 'Rocket', label: 'Lift off', assetId: 'as_r', icon: 'fluent-emoji:rocket' },
      { name: 'money bag', label: 'Revenue' },
      { name: 'globe', assetId: 'as_g' },
    ])
    expect(objectsFromText('a\nb\nc\nd\ne\nf').objects).toHaveLength(5)
    expect(objectsFromText('  \n ').error).toMatch(/at least one/)
  })

  it('a new animation or photo starts from the scene; a changed photo search finds a new one', () => {
    const sc = { headline: 'Fresh from the farm', narration: '' }
    expect(defaultVisual('animation', sc)).toEqual({ kind: 'animation', style: 'row', objects: [{ name: 'light bulb', label: 'Fresh from the' }] })
    expect(defaultVisual('photo', sc)).toEqual({ kind: 'photo', query: 'Fresh from the farm' })
    const made = { kind: 'photo' as const, query: 'farm', assetId: 'as_1', credit: { author: 'Kim', url: 'https://x.test/' } }
    expect(withPrompt(made, 'farm')).toBe(made)
    expect(withPrompt(made, 'barn')).toEqual({ kind: 'photo', query: 'barn' })
  })
})

describe('AI-drawn scenes', () => {
  it('start from the headline, and a changed note means drawing it again (its code and clip dropped)', () => {
    expect(defaultVisual('drawn', { headline: 'Small ideas grow', narration: '' })).toEqual({ kind: 'drawn', prompt: 'A simple hand-drawn animation that shows: Small ideas grow' })
    const made = { kind: 'drawn' as const, prompt: 'A seed grows', code: 'function draw() {}', assetId: 'as_d' }
    expect(withPrompt(made, 'A seed grows')).toBe(made)
    expect(withPrompt(made, 'A seed grows into a tree')).toEqual({ kind: 'drawn', prompt: 'A seed grows into a tree' })
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

describe('music and sound effects', () => {
  it('a new brief has music that suits the tone and sound effects; one saved before has neither', () => {
    expect(defaultBrief()).toMatchObject({ music: 'auto', soundEffects: true })
    const s = stateFromProject({
      summary: { id: 'p1', workspaceId: 'ws', name: 'Old' } as never,
      project: { assets: {}, ai: { brief: { title: 'Old', audience: '', goal: '', tone: 'warm', template: '', voice: 'af_heart', aspect: '16:9' } } } as never,
      version: 1,
    })
    expect(s.brief.music).toBeUndefined()
    expect(s.brief.soundEffects).toBeUndefined()
  })

  it('composing the music adds about the video’s length to the wait', () => {
    const scenes = [newScene(), newScene()].map((sc) => ({ ...sc, narration: 'A line of narration that takes a few seconds to say out loud.' }))
    const plain = estimateAssemble(scenes)
    expect(estimateAssemble(scenes, { music: true }) - plain).toBeGreaterThan(10)
  })
})

describe('a video without some of its parts', () => {
  it('has everything unless the brief says otherwise; captions need narration, and only an idea can go without one', () => {
    expect(videoParts({})).toEqual({ narration: true, captions: true, onScreenText: true, cards: true })
    expect(videoParts({ source: 'idea', narration: false })).toEqual({ narration: false, captions: false, onScreenText: true, cards: true })
    expect(videoParts({ source: 'recordings', narration: false }).narration).toBe(true)
    expect(videoParts({ captions: false, onScreenText: false, cards: false })).toEqual({ narration: true, captions: false, onScreenText: false, cards: false })
  })

  it('“Just the animation” turns the words off and asks for drawn visuals, and undoes', () => {
    const b = { ...defaultBrief(), source: 'idea' as const }
    const only = animationOnly(b)
    expect(videoParts(only)).toEqual({ narration: false, captions: false, onScreenText: false, cards: false })
    expect(only.visualKinds).toEqual(['animation', 'drawn'])
    expect(only.music).toBe('auto')
    const back = everything(only)
    expect(videoParts(back)).toEqual({ narration: true, captions: true, onScreenText: true, cards: true })
    expect(back.visualKinds).toBeUndefined()
  })

  it('a silent scene is asked for what happens, not for narration', () => {
    const blank = { ...newScene(), narration: ' ' }
    expect(validateScenes([blank])).toBe('Scene 1 has no narration')
    expect(validateScenes([blank], true)).toBe('Scene 1 doesn’t say what happens')
  })
})

describe('a failed clip’s tile', () => {
  it('says why in a few words, and offers Retry only when the file reached storage', () => {
    expect(failedReason('Upload failed: storage refused the upload (403 InvalidAccessKeyId). Upload the file again.')).toEqual({ short: 'The file never reached storage: upload it again', canRetry: false })
    expect(failedReason("The uploaded file couldn't be found in storage. Upload it again.").canRetry).toBe(false)
    expect(failedReason(undefined)).toEqual({ short: 'Processing failed', canRetry: true })
    const moov = failedReason("This file is incomplete or damaged: its video index (the 'moov atom') is missing, which usually means the recording or upload was cut off.")
    expect(moov).toEqual({ short: 'This file is incomplete or damaged', canRetry: true })
    expect(failedReason('Processing failed: something long '.padEnd(200, 'x')).short.length).toBeLessThanOrEqual(69)
  })
})
