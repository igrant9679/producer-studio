// Clips that can no longer finish are marked failed (abandoned uploads, dead or cancelled processing), and the
// storage self-check reports what is wrong. (23 Oct 2026: clips sat on "Processing" for good on producerstudio.app.)
import { eq } from 'drizzle-orm'
import { beforeAll, describe, expect, it } from 'vitest'
import { ctx } from '../context'
import { type AssetMeta, assets, jobs } from '../db/schema'
import { cancelJob, claimNext, enqueue, recoverStale } from '../jobs/queue'
import { ASSET_ERRORS, UPLOAD_ABANDONED_MS, reconcileAssets } from '../services/asset-recovery'
import { checkStorage, describeStorageError, storageHealth } from '../services/storage-health'
import { friendlyProcessingError } from '../media/process'
import { setup, signup } from './helpers'

// a real workspace and user: assets and jobs reference both
let WS = ''
let USER = ''
let n = 0
// unique per run: a real Postgres (TEST_DATABASE_URL) keeps rows between runs
const RUN = Date.now().toString(36)

async function asset(status: 'uploading' | 'processing' | 'ready', updatedAt: number, origin = 'upload', meta: AssetMeta = {}) {
  const id = `as_rec_${RUN}${++n}`
  await ctx().db.insert(assets).values({
    id,
    workspaceId: WS,
    kind: 'video',
    name: `${id}.mov`,
    mime: 'video/quicktime',
    status,
    origin,
    meta,
    sourceKey: `ws/${WS}/assets/${id}/source.mov`,
    createdBy: USER,
    createdAt: updatedAt,
    updatedAt,
  })
  return id
}

const statusOf = async (id: string) => (await ctx().db.select().from(assets).where(eq(assets.id, id)))[0]!

/** An asset.process job for `assetId` that ended at `endedAt` with `status`. */
async function endedJob(assetId: string, status: 'done' | 'error' | 'cancelled', endedAt: number, error?: string) {
  const j = await enqueue('asset.process', { assetId }, { workspaceId: WS, userId: USER })
  await ctx().db.update(jobs).set({ status, error: error ?? null, createdAt: endedAt - 1000, updatedAt: endedAt }).where(eq(jobs.id, j.id))
  return j.id
}

beforeAll(async () => {
  const { app } = await setup()
  await ctx().db.delete(jobs)
  const { client, workspaceId } = await signup(app, 'Recovery Tester')
  WS = workspaceId
  USER = (await client.json('GET', '/api/auth/me')).body.user.id
})

describe('stuck clips', () => {
  it('fails uploads whose ticket expired long ago, and leaves recent ones alone', async () => {
    const now = Date.now()
    const old = await asset('uploading', now - UPLOAD_ABANDONED_MS - 60_000)
    const recent = await asset('uploading', now - 10 * 60_000)
    await reconcileAssets(now)
    expect(await statusOf(old)).toMatchObject({ status: 'error', error: ASSET_ERRORS.uploadAbandoned })
    expect((await statusOf(recent)).status).toBe('uploading')
  })

  it('fails a processing clip whose latest job ended after the clip last changed, with the job error', async () => {
    const now = Date.now()
    const id = await asset('processing', now - 10 * 60_000)
    await endedJob(id, 'error', now - 5 * 60_000, 'ffmpeg exited with code 1: moov atom not found')
    await reconcileAssets(now)
    expect(await statusOf(id)).toMatchObject({ status: 'error' })
    expect((await statusOf(id)).error).toMatch(/incomplete or damaged/)
  })

  it('leaves a clip alone while its job is queued or running, and while a retry is on its way', async () => {
    const now = Date.now()
    const running = await asset('processing', now - 10 * 60_000)
    await enqueue('asset.process', { assetId: running }, { workspaceId: WS, userId: USER })
    // retry: the old job failed, then the clip was set back to processing (its new job not yet visible)
    const retried = await asset('processing', now - 2 * 60_000)
    await endedJob(retried, 'error', now - 5 * 60_000, 'old failure')
    await reconcileAssets(now)
    expect((await statusOf(running)).status).toBe('processing')
    expect((await statusOf(retried)).status).toBe('processing')
    await ctx().db.delete(jobs).where(eq(jobs.workspaceId, WS))
  })

  it('fails an upload whose processing never started, but not a voiceover processed inside its own job', async () => {
    const now = Date.now()
    const upload = await asset('processing', now - 40 * 60_000)
    const voiceover = await asset('processing', now - 40 * 60_000, 'tts')
    await reconcileAssets(now)
    expect(await statusOf(upload)).toMatchObject({ status: 'error', error: ASSET_ERRORS.neverStarted })
    expect((await statusOf(voiceover)).status).toBe('processing')
  })

  it('fails a clip made inside another job (a Producer AI voice) once that job has ended without finishing it', async () => {
    const now = Date.now()
    const parent = await enqueue('ai.produce.assemble', { projectId: 'p_rec' }, { workspaceId: WS, userId: USER })
    const voice = await asset('processing', now - 10 * 60_000, 'tts', { jobId: parent.id })
    // its job is still queued or running: left alone
    await reconcileAssets(now)
    expect((await statusOf(voice)).status).toBe('processing')
    // the worker died mid-voice and the job ended: the clip says so instead of "processing" for good
    await ctx().db.update(jobs).set({ status: 'error', error: 'TTS worker exited (code 1)', updatedAt: now - 5 * 60_000 }).where(eq(jobs.id, parent.id))
    await reconcileAssets(now)
    expect(await statusOf(voice)).toMatchObject({ status: 'error', error: ASSET_ERRORS.endedWithoutResult })
    // a parent job that no longer exists (pruned) can't finish it either
    const orphan = await asset('processing', now - 10 * 60_000, 'tts', { jobId: 'j_pruned_long_ago' })
    await reconcileAssets(now)
    expect((await statusOf(orphan)).status).toBe('error')
  })

  it('cancelling a job fails the clips it was still making, and only those', async () => {
    const parent = await enqueue('ai.produce.assemble', { projectId: 'p_rec' }, { workspaceId: WS, userId: USER })
    const voice = await asset('processing', Date.now(), 'tts', { jobId: parent.id })
    const finished = await asset('ready', Date.now(), 'tts', { jobId: parent.id })
    await cancelJob(parent.id)
    expect(await statusOf(voice)).toMatchObject({ status: 'error', error: ASSET_ERRORS.cancelled })
    expect((await statusOf(finished)).status).toBe('ready')
  })

  it('cancelling a queued processing job fails its clip at once', async () => {
    const id = await asset('processing', Date.now())
    const j = await enqueue('asset.process', { assetId: id }, { workspaceId: WS, userId: USER })
    await cancelJob(j.id)
    expect(await statusOf(id)).toMatchObject({ status: 'error', error: ASSET_ERRORS.cancelled })
  })

  it('giving up on a job whose worker kept dying fails its clip too', async () => {
    await ctx().db.delete(jobs)
    const id = await asset('processing', Date.now())
    const j = await enqueue('asset.process', { assetId: id }, { workspaceId: WS, userId: USER })
    // three claims by workers that never heartbeat again
    for (let i = 0; i < 3; i++) {
      expect((await claimNext(`dead-${i}`))?.id).toBe(j.id)
      await ctx().db.update(jobs).set({ lockedAt: Date.now() - 10 * 60_000 }).where(eq(jobs.id, j.id))
      await recoverStale(90_000)
    }
    const job = (await ctx().db.select().from(jobs).where(eq(jobs.id, j.id)))[0]!
    expect(job).toMatchObject({ status: 'error', error: expect.stringMatching(/stopped responding three times/) })
    expect(await statusOf(id)).toMatchObject({ status: 'error', error: ASSET_ERRORS.workerGaveUp })
  })

  it('never touches a clip that finished', async () => {
    const now = Date.now()
    const id = await asset('ready', now - 60 * 60_000)
    await endedJob(id, 'error', now - 5 * 60_000, 'late failure')
    await reconcileAssets(now)
    expect((await statusOf(id)).status).toBe('ready')
  })

  it('POST /api/assets/:id/abort records why an upload failed', async () => {
    const { app } = await setup()
    const { client, workspaceId } = await signup(app, 'Abort Tester')
    const t = await client.json('POST', '/api/uploads', { workspaceId, filename: 'Video Tutorial.mov', mime: 'video/quicktime', size: 1234 })
    expect(t.status).toBe(200)
    const r = await client.json('POST', `/api/assets/${t.body.assetId}/abort`, { reason: 'storage refused the upload (403 InvalidAccessKeyId)' })
    expect(r.status).toBe(200)
    expect(r.body).toMatchObject({ status: 'error', error: 'Upload failed: storage refused the upload (403 InvalidAccessKeyId). Upload the file again.' })
    // a finished upload can't be aborted into an error
    const again = await client.json('POST', `/api/assets/${t.body.assetId}/abort`, { reason: 'second time' })
    expect(again.body.error).toContain('403 InvalidAccessKeyId')
  })
})

describe('processing errors a person can act on', () => {
  it('names the cause and drops server paths', () => {
    const raw = String.raw`ffprobe failed (exit 1): [mov,mp4,m4a,3gp,3g2,mj2 @ 0000027f4312d380] moov atom not found | C:\data\storage\ws\x\source.mov: Invalid data found when processing input`
    expect(friendlyProcessingError(new Error(raw))).toMatch(/^This file is incomplete or damaged/)
    expect(friendlyProcessingError(new Error('ffmpeg exited 1: Invalid data found when processing input'))).toMatch(/Convert it to MP4/)
    const other = friendlyProcessingError(new Error('ffmpeg exited 234: something odd at /app/.data/tmp/proc-x/proxy.mp4'))
    expect(other).toMatch(/^Processing failed: /)
    expect(other).not.toMatch(/\/app\/\.data/)
    expect(friendlyProcessingError({ name: 'InvalidAccessKeyId', $metadata: { httpStatusCode: 403 } })).toMatch(/rotated or revoked/)
  })
})

describe('storage self-check', () => {
  it('writes, reads back and deletes a test object on working storage', async () => {
    const h = await checkStorage()
    expect(h.status).toBe('ok')
    expect(storageHealth().status).toBe('ok')
    expect(await ctx().storage.stat(`_health/${ctx().instanceId}.txt`)).toBeNull()
  })

  it('turns bucket errors into what to do about them', () => {
    expect(describeStorageError({ name: 'InvalidAccessKeyId', $metadata: { httpStatusCode: 403 } })).toMatch(/rotated or revoked.*Redeploy/)
    expect(describeStorageError({ Code: 'SignatureDoesNotMatch' })).toMatch(/S3_SECRET_ACCESS_KEY/)
    expect(describeStorageError({ name: 'NoSuchBucket' })).toMatch(/does not exist/)
    expect(describeStorageError({ name: 'Whatever', $metadata: { httpStatusCode: 403 } })).toMatch(/refused.*\(403\)/)
    expect(describeStorageError({ code: 'ENOTFOUND' })).toMatch(/can't be reached/)
  })

  it('/api/health reports storage without gating on it', async () => {
    const { app } = await setup()
    const r = await app.request('/api/health')
    expect(r.status).toBe(200)
    expect(await r.json()).toMatchObject({ ok: true, storageStatus: 'ok' })
  })
})
