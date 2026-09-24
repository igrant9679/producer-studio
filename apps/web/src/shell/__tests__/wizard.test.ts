import type { ProjectDocResponse, ScriptScene } from '@producer/core'
import { createProject } from '@producer/core'
import { describe, expect, it } from 'vitest'
import {
  briefTitleFromPrompt,
  canAdvance,
  initialState,
  insertScene,
  maxReachableStep,
  moveScene,
  newScene,
  removeScene,
  sanitizeForResume,
  stateFromProject,
  storageKey,
  validateScenes,
  type WizardState,
} from '../producer/wizardLogic'

const scene = (id: string, over: Partial<ScriptScene> = {}): ScriptScene => ({ id, title: id, headline: '', narration: `Narration for ${id}`, footage: [{ assetId: 'a1', start: 0, end: 5 }], ...over })

function withAssets(s: WizardState, statuses: Array<WizardState['assets'][number]['status']>): WizardState {
  return { ...s, assets: statuses.map((status, i) => ({ localId: `l${i}`, assetId: status === 'uploading' ? undefined : `a${i}`, name: `f${i}.mp4`, size: 1, status, progress: 1 })) }
}

describe('step gating', () => {
  it('needs at least one ready recording and nothing still processing', () => {
    const s = initialState()
    expect(canAdvance(s).ok).toBe(false)
    expect(canAdvance(withAssets(s, ['ready', 'processing'])).ok).toBe(false)
    expect(canAdvance(withAssets(s, ['ready', 'error'])).ok).toBe(true)
  })

  it('requires a title on the brief', () => {
    const s = { ...withAssets(initialState(), ['ready']), step: 'brief' as const }
    expect(canAdvance(s)).toEqual({ ok: false, reason: 'Give the video a title' })
    expect(canAdvance({ ...s, brief: { ...s.brief, title: 'Tour' } }).ok).toBe(true)
  })

  it('validates scenes before assembling', () => {
    expect(validateScenes([])).toMatch(/at least one/)
    expect(validateScenes([scene('a'), scene('b', { narration: ' ' })])).toBe('Scene 2 has no narration')
    expect(validateScenes([scene('a', { footage: [{ assetId: 'x', start: 5, end: 2 }] })])).toMatch(/Scene 1/)
    expect(validateScenes([scene('a')])).toBeUndefined()
  })

  it('computes how far the stepper can jump', () => {
    const base = { ...withAssets(initialState(), ['ready']), brief: { ...initialState().brief, title: 'T' } }
    expect(maxReachableStep(initialState())).toBe(0)
    expect(maxReachableStep(base)).toBe(2) // upload + brief done → generate
    expect(maxReachableStep({ ...base, scenes: [scene('a')] })).toBe(4)
  })
})

describe('scene editing', () => {
  const list = [scene('a'), scene('b'), scene('c')]
  it('reorders, inserts and removes immutably', () => {
    expect(moveScene(list, 0, 2).map((s) => s.id)).toEqual(['b', 'c', 'a'])
    expect(moveScene(list, 1, 5)).toBe(list)
    const n = newScene('a1', list[0])
    expect(n.footage[0]).toEqual({ assetId: 'a1', start: 5, end: 10 })
    expect(insertScene(list, 1, n).map((s) => s.id)).toEqual(['a', n.id, 'b', 'c'])
    expect(removeScene(list, 'b').map((s) => s.id)).toEqual(['a', 'c'])
    expect(list.map((s) => s.id)).toEqual(['a', 'b', 'c'])
  })
})

describe('persistence & resume', () => {
  it('turns interrupted uploads and runs into recoverable states', () => {
    const s: WizardState = { ...withAssets(initialState(), ['uploading', 'processing', 'ready']), run: { status: 'running', phase: 'script', jobId: 'j1' } }
    const r = sanitizeForResume(s)
    expect(r.assets[0].status).toBe('error')
    expect(r.assets[1].status).toBe('processing')
    expect(r.run).toMatchObject({ status: 'idle', interrupted: true, jobId: 'j1', phase: 'script' })
  })

  it('keys drafts and projects separately', () => {
    expect(storageKey()).toBe('ps.producer.draft')
    expect(storageKey('p1')).toBe('ps.producer.p1')
  })

  it('rebuilds state from a saved producer project', () => {
    const project = createProject({ id: 'p1', name: 'Tour' })
    project.assets = { a1: { id: 'a1', kind: 'video', name: 'rec.mp4', src: 'k', duration: 60 } }
    project.ai = { brief: { title: 'Tour', audience: '', goal: '', tone: 'Calm', template: 'tpl:studio', voice: 'am_eric', aspect: '16:9' }, script: { scenes: [scene('s1')] }, status: 'scripted' }
    const res = { summary: { id: 'p1', workspaceId: 'w', name: 'Tour', width: 1920, height: 1080, duration: 0, isTemplate: false, trashed: false, kind: 'producer', updatedAt: 0, createdAt: 0, createdBy: 'u' }, project, version: 3 } satisfies ProjectDocResponse
    const s = stateFromProject(res)
    expect(s.step).toBe('review')
    expect(s.projectId).toBe('p1')
    expect(s.assets).toEqual([expect.objectContaining({ assetId: 'a1', name: 'rec.mp4', status: 'ready' })])
    expect(s.transcribed).toEqual(['a1'])
    expect(s.brief.voice).toBe('am_eric')
    expect(stateFromProject({ ...res, project: { ...project, ai: { ...project.ai, status: 'assembled' } } }).step).toBe('assemble')
  })

  it('derives a short title from the Home prompt', () => {
    expect(briefTitleFromPrompt('turn my recording into a tour.')).toBe('Turn my recording into a tour')
    expect(briefTitleFromPrompt('one two three four five six seven eight nine ten')).toBe('One two three four five six seven eight…')
    expect(briefTitleFromPrompt('  ')).toBe('')
  })
})
