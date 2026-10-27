// The worker makes every job end (phase 3, "jobs finish"): a hung job is stopped with a reason and its clip leaves
// "Processing"; a worker that lost its job to stale recovery drops its copy.
import { eq } from 'drizzle-orm'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { ctx } from '../context'
import { type AssetMeta, assets, jobs } from '../db/schema'
import { enqueue, getJob, type JobRow, recoverJob } from '../jobs/queue'
import { CancelledError, type Handler, registerHandler, runningJobIds, startWorker, stopWorker } from '../jobs/worker'
import { setMissingMediaFetcher } from '../services/assets'
import { type Client, setup, signup } from './helpers'

let WS = ''
let USER = ''
let client: Client
let n = 0
const defaults = { ...(await import('../config')).loadConfig().jobLimits }
const meta = () => ({ workspaceId: WS, userId: USER })

async function waitFor<T>(fn: () => Promise<T | undefined | null | false>, ms = 15_000): Promise<T> {
  const end = Date.now() + ms
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() > end) throw new Error('timed out waiting')
    await new Promise((r) => setTimeout(r, 50))
  }
}
const ended = (id: string) => waitFor(async () => ((j) => (j && j.status !== 'queued' && j.status !== 'running' ? j : undefined))(await getJob(id)))
const runningHere = (id: string) => waitFor(async () => ((j) => (j?.status === 'running' && j.lockedBy === ctx().instanceId ? j : undefined))(await getJob(id)))

/** Never settles and ignores cancellation: a storage call that hangs. */
const hang: Handler = () => new Promise(() => undefined)
/** Runs until stopped, and notes that it was. */
const untilStopped =
  (seen: { aborted?: boolean }): Handler =>
  (jc) =>
    new Promise((_r, reject) =>
      jc.signal.addEventListener('abort', () => {
        seen.aborted = true
        reject(new CancelledError())
      }),
    )

async function clip(status: 'processing' | 'ready', m: AssetMeta = {}) {
  const id = `as_rt_${++n}`
  const now = Date.now()
  await ctx().db.insert(assets).values({ id, workspaceId: WS, kind: 'audio', name: `${id}.wav`, mime: 'audio/wav', status, origin: 'tts', meta: m, sourceKey: `ws/${WS}/assets/${id}/source.wav`, createdBy: USER, createdAt: now, updatedAt: now })
  return id
}
const assetRow = async (id: string) => (await ctx().db.select().from(assets).where(eq(assets.id, id)))[0]

beforeAll(async () => {
  const { app } = await setup()
  await ctx().db.delete(jobs)
  const s = await signup(app, 'Runtime Tester')
  client = s.client
  WS = s.workspaceId
  USER = (await s.client.json('GET', '/api/auth/me')).body.user.id
  startWorker({ concurrency: 2, heartbeatMs: 100, graceMs: 300 })
})

afterEach(() => {
  Object.assign(ctx().config.jobLimits, defaults)
  setMissingMediaFetcher(undefined)
})

afterAll(() => stopWorker())

describe('time limits (PIP-2)', () => {
  it('a job past its time limit ends as an error with a reason, frees its slot, and its clip leaves Processing', async () => {
    ctx().config.jobLimits.voiceMs = 400
    registerHandler('ai.tts', hang)
    const job = await enqueue('ai.tts', { text: 'hello' }, meta())
    const voice = await clip('processing', { jobId: job.id })
    const done = await ended(job.id)
    expect(done.status).toBe('error')
    expect(done.error).toMatch(/The voiceover ran longer than its \d+ seconds limit and was stopped/)
    expect(runningJobIds()).not.toContain(job.id)
    expect(await assetRow(voice)).toMatchObject({ status: 'error', error: done.error })
  })

  it('a job that reports no progress for too long is stopped', async () => {
    ctx().config.jobLimits.stallMs = 400
    const seen: { aborted?: boolean } = {}
    registerHandler('ai.transcribe', (jc) => {
      jc.progress(0.1, 'Transcribing')
      return untilStopped(seen)(jc)
    })
    const job = await enqueue('ai.transcribe', { assetId: 'as_none' }, meta())
    const done = await ended(job.id)
    expect(done).toMatchObject({ status: 'error', error: expect.stringMatching(/The transcription made no progress for \d+ seconds and was stopped/) })
    expect(seen.aborted).toBe(true)
  })

  it('a clip whose processing hung, or ended after it was stopped, says why instead of "cancelled"', async () => {
    ctx().config.jobLimits.processingMs = 400
    // the source fetch never returns: processing hangs before its first step
    setMissingMediaFetcher(() => new Promise(() => undefined))
    const hung = await clip('processing')
    const a = await enqueue('asset.process', { assetId: hung }, meta())
    expect((await ended(a.id)).status).toBe('error')
    expect((await assetRow(hung))!.error).toMatch(/Processing this clip ran longer than its/)
    // the fetch fails a while after the stop: processing's own error path runs late
    setMissingMediaFetcher(() => new Promise((_r, reject) => setTimeout(() => reject(new Error('fetch failed')), 150)))
    ctx().config.jobLimits.processingMs = 50
    const late = await clip('processing')
    const b = await enqueue('asset.process', { assetId: late }, meta())
    await ended(b.id)
    await waitFor(async () => (await assetRow(late))!.error?.includes('ran longer than'))
    expect(await assetRow(late)).toMatchObject({ status: 'error' })
  })
})

describe('quick jobs have their own lane (PIP-18)', () => {
  it('counts slots: long jobs only take shared ones, quick jobs take theirs first', async () => {
    const { claimable } = await import('../jobs/worker')
    const exp = { kind: 'export.render' }
    const proc = { kind: 'asset.process' }
    expect(claimable([], 2, 1)).toBe('any')
    expect(claimable([exp, exp], 2, 1)).toBe('quick')
    expect(claimable([exp, exp, proc], 2, 1)).toBe('none')
    expect(claimable([proc], 2, 1)).toBe('any')
    expect(claimable([proc, proc], 2, 1)).toBe('any')
    expect(claimable([proc, proc, proc], 2, 1)).toBe('none')
    expect(claimable([proc, proc, exp], 2, 1)).toBe('none')
    expect(claimable([exp], 1, 0)).toBe('none')
  })

  it('an upload is processed while long exports fill every shared slot', async () => {
    stopWorker()
    startWorker({ concurrency: 1, quickConcurrency: 1, heartbeatMs: 100, graceMs: 300 })
    const seen: { aborted?: boolean } = {}
    registerHandler('export.render', untilStopped(seen))
    registerHandler('ai.transcribe', async () => ({ transcript: 'ok' }))
    const e1 = await enqueue('export.render', {}, meta())
    const e2 = await enqueue('export.render', {}, meta())
    await runningHere(e1.id)
    const quick = await enqueue('ai.transcribe', { assetId: 'as_x' }, meta())
    expect((await ended(quick.id)).status).toBe('done')
    expect((await getJob(e2.id))!.status).toBe('queued')
    const { cancelJob } = await import('../jobs/queue')
    await cancelJob(e2.id)
    await cancelJob(e1.id)
    await waitFor(async () => !runningJobIds().length)
    stopWorker()
    startWorker({ concurrency: 2, heartbeatMs: 100, graceMs: 300 })
  })
})

describe('job errors people see (PIP-33 / QA-13)', () => {
  it('carry no server file paths', async () => {
    const raw = [
      'ffprobe failed (exit 1): /data/tmp/stt-as_1-mk2/as_1.mov: Invalid data found when processing input',
      'whisper failed: C:\\Users\\Admin\\AppData\\Local\\Temp\\ps\\audio.wav: could not open | [aac @ 0x55d0c1a2b3c4] error',
    ]
    for (const message of raw) {
      registerHandler('ai.transcribe', async () => {
        throw new Error(message)
      })
      const j = await enqueue('ai.transcribe', { assetId: 'as_x' }, meta())
      await ended(j.id)
      const shown = (await client.json('GET', `/api/jobs/${j.id}`)).body
      expect(shown.status).toBe('error')
      expect(shown.error).not.toMatch(/\/data\/|C:\\|Users|AppData|0x55/)
      expect(shown.error).toMatch(/Invalid data found|could not open/)
    }
    // processing errors read like the clip's
    const { publicJobError } = await import('../jobs/errors')
    expect(publicJobError('asset.process', new Error(raw[0]))).toMatch(/isn't a video, audio or image format/)
  })
})

describe('restarts (PIP-30)', () => {
  it('a deploy puts running jobs back in the queue without counting an attempt, and their clips stay processing', async () => {
    const seen: { aborted?: boolean } = {}
    registerHandler('export.render', untilStopped(seen))
    const exp = await enqueue('export.render', {}, meta())
    expect((await runningHere(exp.id)).attempts).toBe(1)
    // an upload mid-processing: its source fetch fails once the job is stopped (processing's own error path runs)
    const upload = await clip('processing')
    let procJob = ''
    setMissingMediaFetcher(async () => {
      await waitFor(async () => (await getJob(procJob))?.status === 'queued')
      await new Promise((r) => setTimeout(r, 50))
      throw new Error('fetch aborted')
    })
    procJob = (await enqueue('asset.process', { assetId: upload }, meta())).id
    await runningHere(procJob)
    await stopWorker()
    expect(seen.aborted).toBe(true)
    expect(await getJob(exp.id)).toMatchObject({ status: 'queued', attempts: 0, lockedBy: null, error: null })
    expect(await getJob(procJob)).toMatchObject({ status: 'queued', attempts: 0 })
    expect(await assetRow(upload)).toMatchObject({ status: 'processing', error: null })
    const { cancelJob } = await import('../jobs/queue')
    await cancelJob(exp.id)
    await cancelJob(procJob)
    startWorker({ concurrency: 2, heartbeatMs: 100, graceMs: 300 })
  })
})

describe('stale recovery and lost locks (PIP-8)', () => {
  it('recovery leaves a job alone if its worker heartbeat after it was seen as stale', async () => {
    // running on another worker (this one never claims it)
    const now = Date.now()
    const [j] = await ctx()
      .db.insert(jobs)
      .values({ id: `j_rt_${++n}`, kind: 'export.render', status: 'running', input: {}, ...meta(), attempts: 1, lockedBy: 'w_busy', lockedAt: now - 10 * 60_000, createdAt: now, updatedAt: now })
      .returning()
    const seenStale = (await getJob(j.id)) as JobRow
    // the worker heartbeats before recovery gets to its update
    await ctx().db.update(jobs).set({ lockedAt: Date.now() }).where(eq(jobs.id, j.id))
    expect(await recoverJob(seenStale)).toBe(false)
    expect(await getJob(j.id)).toMatchObject({ status: 'running', lockedBy: 'w_busy' })
    // seen as it really is, it's requeued once, not twice
    const stale = (await getJob(j.id)) as JobRow
    expect(await recoverJob(stale)).toBe(true)
    expect(await recoverJob(stale)).toBe(false)
    await ctx().db.delete(jobs).where(eq(jobs.id, j.id))
  })

  it('a worker whose job was taken over stops its copy and writes nothing', async () => {
    const seen: { aborted?: boolean } = {}
    registerHandler('export.render', untilStopped(seen))
    const j = await enqueue('export.render', {}, meta())
    await runningHere(j.id)
    // stale recovery elsewhere requeued it and another worker claimed it
    await ctx().db.update(jobs).set({ lockedBy: 'w_other', lockedAt: Date.now() }).where(eq(jobs.id, j.id))
    await waitFor(async () => seen.aborted)
    await waitFor(async () => !runningJobIds().includes(j.id))
    expect(await getJob(j.id)).toMatchObject({ status: 'running', lockedBy: 'w_other', error: null })
    await ctx().db.delete(jobs).where(eq(jobs.id, j.id))
  })
})
