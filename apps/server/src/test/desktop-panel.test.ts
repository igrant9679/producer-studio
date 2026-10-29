// What the desktop's sync panel says (D-1): why sync is held up, most pressing first, and how two copies differ.
import { describe, expect, it } from 'vitest'
import type { Project } from '@producer/core'
import { LOW_DISK_BYTES, blockedBy, compareSides, sideSummary } from '../desktop/panel'

const base = { signedOut: false, credentials: false, autoSync: true }
const linked = { linked: true, state: 'idle' as const, conflicts: [] }
const conflict = [{ projectId: 'p', name: 'P', localVersion: 2, cloudVersion: 3 }]

describe('why sync is held up', () => {
  it('names the most pressing reason', () => {
    expect(blockedBy(linked, base)).toBeUndefined()
    expect(blockedBy({ ...linked, linked: false }, { ...base, signedOut: true })).toBeUndefined()
    expect(blockedBy({ ...linked, state: 'offline', conflicts: conflict }, base)?.reason).toBe('offline')
    expect(blockedBy({ ...linked, state: 'error', conflicts: conflict }, { ...base, signedOut: true })?.reason).toBe('signed-out')
    expect(blockedBy(linked, { ...base, credentials: true })?.reason).toBe('credentials')
    expect(blockedBy({ ...linked, conflicts: conflict }, { ...base, cloudStorage: 'S3 refused the write' })?.message).toContain('S3 refused the write')
    expect(blockedBy(linked, { ...base, diskFree: LOW_DISK_BYTES / 4 })).toMatchObject({ reason: 'storage', message: expect.stringContaining('256 MB free') })
    expect(blockedBy(linked, { ...base, diskFree: LOW_DISK_BYTES * 4 })).toBeUndefined()
    expect(blockedBy({ ...linked, conflicts: conflict }, base)).toMatchObject({ reason: 'conflict', message: expect.stringContaining('1 project was edited') })
    expect(blockedBy(linked, { ...base, autoSync: false })?.reason).toBe('paused')
  })
})

const doc = (over: Partial<Project> = {}): Project =>
  ({
    id: 'p1',
    name: 'Cut',
    width: 1920,
    height: 1080,
    fps: 30,
    tracks: [{ id: 't1', kind: 'video', name: 'Video', main: true, items: [{ id: 'i1', type: 'video', assetId: 'a1', start: 0, duration: 10, in: 0, out: 10 }] }],
    assets: { a1: { id: 'a1' } },
    ...over,
  }) as unknown as Project

describe('two copies of a project', () => {
  it('say what differs in plain words', () => {
    const here = doc({ name: 'For the client', assets: { a1: { id: 'a1' }, a2: { id: 'a2' } } as unknown as Project['assets'] })
    const there = doc({ name: 'For the web' })
    const l = sideSummary(here, { version: 4, updatedAt: 1, trashed: false })
    const c = sideSummary(there, { version: 6, updatedAt: 2, trashed: true })
    expect(l).toMatchObject({ version: 4, name: 'For the client', tracks: 1, items: 1, clips: 2, trashed: false })
    expect(compareSides(here, there, l, c)).toEqual(['Named “For the client” here and “For the web” in the cloud', '1 clip only in this computer’s copy', 'In the trash in the cloud, not here'])
    expect(compareSides(here, null, l, null)).toEqual(['Deleted in the cloud since this computer last synced it'])
    expect(compareSides(there, there, c, c)[0]).toMatch(/differ in detail/)
  })
})
