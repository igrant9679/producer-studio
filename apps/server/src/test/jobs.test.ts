import { eq } from 'drizzle-orm'
import { beforeAll, describe, expect, it } from 'vitest'
import { ctx } from '../context'
import { jobs } from '../db/schema'
import { cancelJob, claimNext, enqueue, failJob, finishJob, getJob, recoverStale, updateProgress } from '../jobs/queue'
import { setup } from './helpers'

beforeAll(async () => {
  await setup()
  // isolate from other suites' jobs
  await ctx().db.delete(jobs)
})

const meta = { workspaceId: 'ws_test', userId: 'u_test' }

describe('job queue', () => {
  it('claims the oldest queued job exactly once and completes it', async () => {
    const a = await enqueue('asset.process', { n: 1 }, meta)
    await new Promise((r) => setTimeout(r, 5))
    const b = await enqueue('asset.process', { n: 2 }, meta)
    const events: string[] = []
    const off = ctx().bus.subscribe('ws_test', (e) => events.push(`${e.event}:${(e.data as { status: string }).status}`))

    const [c1, c2, c3] = await Promise.all([claimNext('w1'), claimNext('w2'), claimNext('w3')])
    const claimed = [c1, c2, c3].filter(Boolean)
    expect(claimed).toHaveLength(2)
    expect(new Set(claimed.map((j) => j!.id))).toEqual(new Set([a.id, b.id]))
    expect(claimed.every((j) => j!.status === 'running' && j!.attempts === 1)).toBe(true)

    const first = claimed.find((j) => j!.id === a.id)!
    await updateProgress(first.id, 0.5, 'Halfway')
    expect((await getJob(first.id))!.message).toBe('Halfway')
    await finishJob(first.id, { ok: 1 })
    const done = (await getJob(first.id))!
    expect(done).toMatchObject({ status: 'done', progress: 1, result: { ok: 1 } })
    // finishing again is a no-op (only running jobs transition)
    expect(await finishJob(first.id, { ok: 2 })).toBeNull()

    await failJob(b.id, 'boom')
    expect((await getJob(b.id))!).toMatchObject({ status: 'error', error: 'boom' })
    expect(await claimNext('w1')).toBeNull()
    off()
    expect(events).toContain('job:running')
    expect(events).toContain('job:done')
  })

  it('cancels queued and running jobs', async () => {
    const q = await enqueue('ai.tts', {}, meta)
    const c = await cancelJob(q.id)
    expect(c!.status).toBe('cancelled')
    expect(await claimNext('w1')).toBeNull()

    const r = await enqueue('ai.tts', {}, meta)
    const running = (await claimNext('w1'))!
    expect(running.id).toBe(r.id)
    let aborted = false
    const { onCancel } = await import('../jobs/queue')
    const off = onCancel((id) => {
      if (id === r.id) aborted = true
    })
    await cancelJob(r.id)
    expect(aborted).toBe(true)
    expect((await getJob(r.id))!).toMatchObject({ status: 'cancelled', cancelRequested: true })
    // a late finish from the worker doesn't resurrect it
    expect(await finishJob(r.id, {})).toBeNull()
    off()
  })

  it('requeues stale running jobs and gives up after 3 attempts', async () => {
    const j = await enqueue('export.render', {}, meta)
    const claimed = (await claimNext('dead-worker'))!
    await ctx().db.update(jobs).set({ lockedAt: Date.now() - 10 * 60_000 }).where(eq(jobs.id, claimed.id))
    expect(await recoverStale(60_000)).toBe(1)
    expect((await getJob(j.id))!.status).toBe('queued')
    await ctx().db.update(jobs).set({ status: 'running', attempts: 3, lockedAt: 0 }).where(eq(jobs.id, j.id))
    await recoverStale(60_000)
    expect((await getJob(j.id))!.status).toBe('error')
  })
})
