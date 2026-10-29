// The desktop sync engine's one lock (D-11): link, unlink, conflict resolution and cycles never interleave.
import { describe, expect, it } from 'vitest'
import { SyncLock } from '../desktop/lock'

const tick = () => new Promise((r) => setTimeout(r, 5))

describe('SyncLock', () => {
  it('runs one thing at a time, in the order asked', async () => {
    const lock = new SyncLock()
    const trace: string[] = []
    const job = (name: string, ms: number) =>
      lock.run(name, async () => {
        trace.push(`${name}:start`)
        expect(lock.holder).toBe(name)
        await new Promise((r) => setTimeout(r, ms))
        trace.push(`${name}:end`)
        return name
      })
    const all = Promise.all([job('sync', 30), job('resolve', 1), job('unlink', 10)])
    await tick()
    expect(lock.holder).toBe('sync')
    expect(lock.waiting()).toEqual(['resolve', 'unlink'])
    expect(await all).toEqual(['sync', 'resolve', 'unlink'])
    expect(trace).toEqual(['sync:start', 'sync:end', 'resolve:start', 'resolve:end', 'unlink:start', 'unlink:end'])
    expect(lock.holder).toBeUndefined()
  })

  it('a failure is the caller’s, and the next one still runs', async () => {
    const lock = new SyncLock()
    const failed = lock.run('link', async () => {
      throw new Error('cloud refused')
    })
    const next = lock.run('sync', async () => 'ran')
    await expect(failed).rejects.toThrow('cloud refused')
    expect(await next).toBe('ran')
  })
})
