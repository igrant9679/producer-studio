import { createProject, updateProject } from '@producer/core'
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
