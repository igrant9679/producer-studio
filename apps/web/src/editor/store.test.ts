import { addAsset, addItem, createProject, createVideoItem, updateItem, updateProject, type Asset } from '@producer/core'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { COALESCE_MS, HISTORY_CAP, useEditor } from './store'

const S = () => useEditor.getState()

function named(name: string) {
  return updateProject(S().project, { name })
}

beforeEach(() => {
  vi.useRealTimers()
  S().load({ project: createProject({ id: 'p1', name: 'start' }), version: 1, projectId: 'p1', demo: true })
})

describe('editor store history', () => {
  it('commit pushes an undo entry and marks dirty', () => {
    S().commit(named('a'), 'Rename')
    expect(S().project.name).toBe('a')
    expect(S().history.past).toHaveLength(1)
    expect(S().saveState).toBe('dirty')
  })

  it('undo / redo restore snapshots', () => {
    S().commit(named('a'), 'A')
    S().commit(named('b'), 'B')
    S().undo()
    expect(S().project.name).toBe('a')
    S().undo()
    expect(S().project.name).toBe('start')
    S().undo() // nothing left
    expect(S().project.name).toBe('start')
    S().redo()
    S().redo()
    expect(S().project.name).toBe('b')
    expect(S().history.future).toHaveLength(0)
  })

  it('a new commit clears the redo stack', () => {
    S().commit(named('a'), 'A')
    S().undo()
    expect(S().history.future).toHaveLength(1)
    S().commit(named('c'), 'C')
    expect(S().history.future).toHaveLength(0)
  })

  it('coalesces rapid commits with the same key into one undo entry', () => {
    for (let i = 0; i < 20; i++) S().commit(named(`drag ${i}`), 'Slider', { coalesce: 'opacity:x' })
    expect(S().history.past).toHaveLength(1)
    expect(S().project.name).toBe('drag 19')
    S().undo()
    expect(S().project.name).toBe('start')
  })

  it('different keys or endCoalesce start a new entry', () => {
    S().commit(named('a1'), 'A', { coalesce: 'a' })
    S().commit(named('a2'), 'A', { coalesce: 'a' })
    S().commit(named('b1'), 'B', { coalesce: 'b' })
    expect(S().history.past).toHaveLength(2)
    S().endCoalesce()
    S().commit(named('b2'), 'B', { coalesce: 'b' })
    expect(S().history.past).toHaveLength(3)
  })

  it('stops coalescing after the time window', () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000_000)
    S().commit(named('x1'), 'X', { coalesce: 'x' })
    vi.setSystemTime(1_000_000 + COALESCE_MS + 10)
    S().commit(named('x2'), 'X', { coalesce: 'x' })
    expect(S().history.past).toHaveLength(2)
  })

  it('caps the history', () => {
    for (let i = 0; i < HISTORY_CAP + 25; i++) S().commit(named(`n${i}`), 'N')
    expect(S().history.past).toHaveLength(HISTORY_CAP)
    expect(S().history.past[0].project.name).toBe('n24')
  })

  it('drops selected ids that no longer exist and restores selection on undo', () => {
    const p = structuredClone(S().project)
    p.tracks[0].items.push({ id: 'x1', type: 'caption', start: 0, duration: 1, text: 'hi' })
    S().commit(p, 'Add', { selection: ['x1'] })
    expect(S().selection).toEqual(['x1'])
    const q = structuredClone(S().project)
    q.tracks[0].items = []
    S().commit(q, 'Delete')
    expect(S().selection).toEqual([])
    S().undo()
    expect(S().selection).toEqual(['x1'])
  })

  it('identical project is a no-op', () => {
    S().commit(S().project, 'Nothing')
    expect(S().history.past).toHaveLength(0)
  })
})

describe('media records and undo', () => {
  const uploading: Asset = { id: 'as1', kind: 'video', name: 'clip.mp4', src: '/api/media/as1/source' }
  const processed: Partial<Asset> = { duration: 12, proxySrc: '/api/media/as1/proxy', waveform: [0.1, 0.5], transcript: { language: 'en', engine: 'test', segments: [] } }

  beforeEach(() => {
    S().load({ project: addAsset(createProject({ id: 'p1', name: 'start' }), uploading), version: 1, projectId: 'p1', demo: false, workspaceId: 'w1' })
  })

  it('undo after processing finishes keeps the processed record', () => {
    S().commit(addItem(S().project, createVideoItem(uploading, 0, { duration: 5 })), 'Add clip')
    S().commit(named('renamed'), 'Rename')
    S().updateMedia({ id: 'as1', ...processed })
    expect(S().history.past).toHaveLength(2)
    expect(S().saveState).toBe('dirty')
    S().undo()
    expect(S().project.name).toBe('start')
    expect(S().project.assets.as1).toMatchObject(processed)
    S().undo()
    expect(S().project.assets.as1).toMatchObject(processed)
    S().redo()
    S().redo()
    expect(S().project.name).toBe('renamed')
    expect(S().project.assets.as1).toMatchObject(processed)
  })

  it('a record that arrives while its clip is undone away comes back fresh on redo', () => {
    S().load({ project: createProject({ id: 'p1', name: 'start' }), version: 1, projectId: 'p1', demo: false, workspaceId: 'w1' })
    S().commit(addItem(addAsset(S().project, uploading), createVideoItem(uploading, 0, { duration: 5 })), 'Add clip')
    S().undo()
    expect(S().project.assets.as1).toBeUndefined()
    S().updateMedia({ id: 'as1', ...processed })
    expect(S().project.assets.as1).toBeUndefined()
    S().redo()
    expect(S().project.assets.as1).toMatchObject(processed)
  })

  it('edits and undo steps share what they did not change (EDT-26)', () => {
    const heavy: Asset = { ...uploading, ...processed, waveform: Array.from({ length: 4000 }, (_, i) => (i % 50) / 50) } as Asset
    S().load({ project: addAsset(createProject({ id: 'p1', name: 'start' }), heavy), version: 1, projectId: 'p1', demo: false, workspaceId: 'w1' })
    S().commit(addItem(S().project, createVideoItem(heavy, 0, { duration: 5 })), 'Add clip')
    S().commit(addItem(S().project, createVideoItem(heavy, 5, { duration: 5 })), 'Add clip')
    const [first, second] = S().project.tracks.find((t) => t.main)!.items
    for (let i = 0; i < 50; i++) S().commit(updateItem(S().project, second.id, { opacity: i / 50 }), 'Opacity')
    const now = S().project
    // the first clip, untouched, is the very same object in the document and every undo step
    expect(now.tracks.find((t) => t.main)!.items[0]).toBe(first)
    for (const step of S().history.past.slice(2)) expect(step.project.tracks.find((t) => t.main)!.items[0]).toBe(first)
    // the clip's record (waveform, transcript) is one copy, not one per step
    for (const step of S().history.past) {
      expect(step.project.assets.as1.waveform).toBe(now.assets.as1.waveform)
      expect(step.project.assets.as1.transcript).toBe(now.assets.as1.transcript)
    }
    S().undo()
    expect(S().project.tracks.find((t) => t.main)!.items[0]).toBe(first)
  })

  it('ignores records for clips this project never had', () => {
    const before = S().project
    S().updateMedia({ id: 'elsewhere', duration: 3 })
    expect(S().project).toBe(before)
    expect(S().media.elsewhere).toBeUndefined()
  })
})
