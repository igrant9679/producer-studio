// The media library (21 Nov 2026, the owner: "remove the current music samples and create 20 additional music clip
// samples (a mix of genres) as well as 10 different animation video clips, and 10 different full motion video
// clips"): an operator has the items made with a space's keys, one job at a time; everyone can then hear, watch and
// add them. Quick stand-in makers (a few seconds of tone or test picture through ffmpeg) replace the real ones, which
// spend the space's AI credit. Also the brief's samples: a music style's sample composed by the server, and the sound
// effects.
import { and, eq, sql } from 'drizzle-orm'
import { CLIP_LIBRARY, DRAWING_STYLES, MUSIC_LIBRARY, MUSIC_STYLES, SFX_PREVIEW_ROLES, sfxKitFor, styleSampleCuts } from '@producer/core'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ctx } from '../context'
import { jobs } from '../db/schema'
import { failJob, finishJob } from '../jobs/queue'
import type { JobContext } from '../jobs/worker'
import { ffmpeg } from '../media/proc'
import { SAMPLES } from '../routes/music'
import { LIBRARY_MAKERS, forgetLibraryInfo, makeLibraryJob } from '../services/media-library'
import { claimJob, setup, signup, type TestEnv } from './helpers'

let t: TestEnv
const real = { compose: SAMPLES.compose, makers: { ...LIBRARY_MAKERS } }
const composed: string[] = []
const made: string[] = []
let failOnce: string | undefined

beforeAll(async () => {
  t = await setup()
  SAMPLES.compose = async (o) => {
    composed.push(o.seed)
    await new Promise((r) => setTimeout(r, 150))
    await ffmpeg(['-y', '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3', '-c:a', 'aac', '-b:a', '96k', o.out])
    return { about: `${o.style} test`, lufs: -18 }
  }
  const tone = async (prompt: string, outDir: string) => {
    if (failOnce && prompt.includes(failOnce)) {
      failOnce = undefined
      throw new Error('Google answered without a song')
    }
    const file = `${outDir}/song-${made.length}.m4a`
    await ffmpeg(['-y', '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=330:duration=6', '-c:a', 'aac', '-b:a', '96k', file])
    return file
  }
  const picture = async (outDir: string) => {
    const file = `${outDir}/clip-${made.length}.mp4`
    await ffmpeg(['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=24:duration=2', '-pix_fmt', 'yuv420p', '-c:v', 'libx264', file])
    return file
  }
  LIBRARY_MAKERS.music = async (o) => {
    const file = await tone(o.prompt, o.outDir)
    made.push(`music:${o.prompt.slice(0, 40)}`)
    return { file, mime: 'audio/mp4', seconds: 6, provider: 'gemini', model: 'lyria-3.5' }
  }
  LIBRARY_MAKERS.motion = async (o) => {
    const file = await picture(o.outDir)
    made.push('motion')
    return { file, mime: 'video/mp4', seconds: 2, provider: 'gemini', model: 'gemini-omni-1.2-flash' }
  }
  LIBRARY_MAKERS.animation = async (o) => {
    const file = await picture(o.outDir)
    made.push(`animation:${o.style}`)
    return { file, mime: 'video/mp4', seconds: 2, provider: 'claude', model: 'code', drawing: { code: `// ${o.style}`, env: { width: 1920, height: 1080, fps: 30, duration: o.seconds, palette: { canvas: '#fff', accent: '#f60', ink: '#111' }, fonts: { headline: 'Inter', body: 'Inter' } }, style: o.style } }
  }
}, 120_000)
afterAll(() => {
  SAMPLES.compose = real.compose
  Object.assign(LIBRARY_MAKERS, real.makers)
  ctx().config.operatorEmails = []
})

/** Runs the library's queued jobs the way the worker would, one after another, until none is left. */
async function runLibraryJobs(max = 60): Promise<number> {
  let n = 0
  for (; n < max; n++) {
    const next = (await ctx().db.select().from(jobs).where(and(eq(jobs.kind, 'library.make'), eq(jobs.status, 'queued'))).orderBy(jobs.createdAt).limit(2))
    expect(next.length).toBeLessThanOrEqual(1) // one at a time: each job queues the next
    if (!next[0]) return n
    const row = await claimJob(next[0].id)
    const jc: JobContext = { job: row, signal: new AbortController().signal, progress: () => undefined, check: () => undefined }
    try {
      await finishJob(row.id, await makeLibraryJob(jc), row.lockedBy ?? undefined)
    } catch (err) {
      await failJob(row.id, String((err as Error).message), 'error', row.lockedBy ?? undefined)
    }
  }
  return n
}

describe('the library’s catalogue', () => {
  it('has 20 songs of different genres, 10 animations in drawing styles and 10 full-motion clips', () => {
    expect(MUSIC_LIBRARY).toHaveLength(20)
    expect(new Set(MUSIC_LIBRARY.map((m) => m.genre)).size).toBe(20)
    for (const m of MUSIC_LIBRARY) expect(m.prompt).toMatch(/^Instrumental only, no vocals/)
    const ids = [...MUSIC_LIBRARY.map((m) => m.id), ...CLIP_LIBRARY.map((c) => c.id)]
    expect(new Set(ids).size).toBe(40)
    const anim = CLIP_LIBRARY.filter((c) => c.kind === 'animation')
    const motion = CLIP_LIBRARY.filter((c) => c.kind === 'motion')
    expect([anim.length, motion.length]).toEqual([10, 10])
    for (const a of anim) {
      expect(DRAWING_STYLES.map((s) => s.id)).toContain(a.style)
      expect(a.style).not.toBe('blender')
    }
    expect(new Set(anim.map((a) => a.style)).size).toBeGreaterThanOrEqual(8)
    for (const m of motion) expect(m.seconds).toBe(8)
  })
})

describe('the brief’s samples', () => {
  it('composes a music style’s sample once, however many ask, and keeps it', async () => {
    const { client } = await signup(t.app, 'Style listener')
    composed.length = 0
    const [a, b] = await Promise.all([client.req('GET', '/api/music/style/lofi/preview'), client.req('GET', '/api/music/style/lofi/preview')])
    expect([a.status, b.status]).toEqual([200, 200])
    expect(a.headers.get('content-type')).toBe('audio/mp4')
    expect(composed).toEqual(['sample lofi'])
    const whole = Buffer.from(await a.arrayBuffer())
    const part = await client.req('GET', '/api/music/style/lofi/preview', undefined, { range: 'bytes=10-29' })
    expect(part.status).toBe(206)
    expect(Buffer.from(await part.arrayBuffer())).toEqual(whole.subarray(10, 30))
    expect(composed).toHaveLength(1)
    expect((await client.req('GET', '/api/music/style/polka/preview')).status).toBe(404)
    expect(styleSampleCuts(45).map((c) => c.t)).toEqual([0, 8, 16, 24, 32, 40])
    for (const m of MUSIC_STYLES) expect(m.id).toBeTruthy()
  })

  it('lets the brief hear its sound effects, and nothing outside the kits', async () => {
    const { client } = await signup(t.app, 'Effects listener')
    for (const role of SFX_PREVIEW_ROLES) {
      const r = await client.req('GET', `/api/music/sfx/${sfxKitFor('mallet')}/${role}`)
      expect(r.status).toBe(200)
      expect(r.headers.get('content-type')).toMatch(/^audio\//)
    }
    expect((await client.req('GET', '/api/music/sfx/crisp/no-such-role')).status).toBe(404)
    expect((await client.req('GET', '/api/music/sfx/nokit/pop')).status).toBe(404)
  })
})

describe('the media library', () => {
  it('lists every item, none made yet: nothing to hear, watch or add', async () => {
    const { client, workspaceId } = await signup(t.app, 'Early visitor')
    forgetLibraryInfo()
    const music = await client.json('GET', '/api/music')
    expect(music.body).toHaveLength(20)
    expect(music.body[0]).toMatchObject({ id: MUSIC_LIBRARY[0].id, genre: MUSIC_LIBRARY[0].genre, ready: false })
    const clips = await client.json('GET', '/api/clips')
    expect(clips.body).toHaveLength(20)
    expect(clips.body.every((c: { ready: boolean }) => !c.ready)).toBe(true)
    expect((await client.req('GET', `/api/music/${MUSIC_LIBRARY[0].id}/preview`)).status).toBe(404)
    expect((await client.req('GET', `/api/clips/${CLIP_LIBRARY[0].id}/preview`)).status).toBe(404)
    expect((await client.json('POST', `/api/clips/${CLIP_LIBRARY[0].id}/add`, { workspaceId })).status).toBe(404)
    // a track id is no clip, and the other way round
    expect((await client.req('GET', `/api/clips/${MUSIC_LIBRARY[0].id}/preview`)).status).toBe(404)
    // the operator's routes don't exist for anyone else
    expect((await client.json('GET', '/api/operator/library')).status).toBe(404)
    expect((await client.json('POST', '/api/operator/library/make', { workspaceId })).status).toBe(404)
  })

  it('an operator has it made with a space’s keys: music, then full motion, then animations, one job at a time; a failed item doesn’t stop the rest and is made on the next go', async () => {
    const op = await signup(t.app, 'The operator')
    ctx().config.operatorEmails = [op.email]
    // only a space the operator owns pays
    const other = await signup(t.app, 'Someone else')
    expect((await op.client.json('POST', '/api/operator/library/make', { workspaceId: other.workspaceId })).status).toBe(404)
    made.length = 0
    failOnce = MUSIC_LIBRARY[1].prompt.slice(40, 90)
    const go = await op.client.json('POST', '/api/operator/library/make', { workspaceId: op.workspaceId })
    expect(go.status).toBe(200)
    expect(go.body.queued).toEqual([...MUSIC_LIBRARY.map((m) => m.id), ...CLIP_LIBRARY.filter((c) => c.kind === 'motion').map((c) => c.id), ...CLIP_LIBRARY.filter((c) => c.kind === 'animation').map((c) => c.id)])
    // pressed again while it is going: nothing more is queued
    expect((await op.client.json('POST', '/api/operator/library/make', { workspaceId: op.workspaceId })).body).toEqual({ queued: [], going: true })
    expect(await runLibraryJobs()).toBe(40)
    expect(made.filter((m) => m.startsWith('music'))).toHaveLength(19)
    expect(made.filter((m) => m === 'motion')).toHaveLength(10)
    expect(made.filter((m) => m.startsWith('animation:')).map((m) => m.slice(10))).toEqual(CLIP_LIBRARY.filter((c) => c.kind === 'animation').map((c) => c.style))
    const status = await op.client.json('GET', '/api/operator/library')
    const failed = status.body.find((s: { id: string }) => s.id === MUSIC_LIBRARY[1].id)
    expect(failed).toMatchObject({ ready: false, job: { status: 'error', error: expect.stringMatching(/without a song/) } })
    expect(status.body.filter((s: { ready: boolean }) => s.ready)).toHaveLength(39)
    expect(status.body.find((s: { id: string }) => s.id === MUSIC_LIBRARY[0].id)).toMatchObject({ ready: true, seconds: 6, model: 'lyria-3.5' })
    // an animation keeps its drawing code beside it, so it can be drawn again in other colours
    const anim = CLIP_LIBRARY.find((c) => c.kind === 'animation')!
    const code = await ctx().storage.stat(`library/clips/${anim.id}.v1.drawing.js`)
    expect(code?.size).toBeGreaterThan(0)
    // the next go makes only what is missing
    failOnce = MUSIC_LIBRARY[1].prompt.slice(40, 90)
    const again = await op.client.json('POST', '/api/operator/library/make', { workspaceId: op.workspaceId, kinds: ['music'] })
    expect(again.body.queued).toEqual([MUSIC_LIBRARY[1].id])
    expect(await runLibraryJobs()).toBe(1)
    // it failed again; run again by hand from Operator → Jobs, it is made, and no second chain starts
    const failedJob = (await op.client.json('GET', '/api/operator/library')).body.find((s: { id: string }) => s.id === MUSIC_LIBRARY[1].id).job
    expect(failedJob.status).toBe('error')
    expect((await op.client.json('POST', `/api/operator/jobs/${failedJob.id}/requeue`)).status).toBe(200)
    made.length = 0
    expect(await runLibraryJobs()).toBe(1)
    expect(made).toHaveLength(1)
    expect((await op.client.json('GET', '/api/music')).body.every((m: { ready: boolean }) => m.ready)).toBe(true)
    expect((await op.client.json('POST', '/api/operator/library/make', { workspaceId: op.workspaceId })).body).toEqual({ queued: [] })
    const audit = await op.client.json('GET', '/api/operator/audit?kind=operator.library.make')
    expect(audit.status).toBe(200)
  }, 300_000)

  it('everyone can then hear and watch the items and add them to a video; adding again reuses the space’s copy', async () => {
    const { client, workspaceId } = await signup(t.app, 'Video maker')
    const p = await client.json('POST', '/api/projects', { workspaceId, name: 'With library media' })
    const projectId = p.body.id ?? p.body.project?.id ?? p.body.summary?.id
    const song = await client.req('GET', `/api/music/${MUSIC_LIBRARY[3].id}/preview`)
    expect(song.status).toBe(200)
    expect(song.headers.get('content-type')).toBe('audio/mp4')
    const clip = CLIP_LIBRARY.find((c) => c.kind === 'motion')!
    const video = await client.req('GET', `/api/clips/${clip.id}/preview`, undefined, { range: 'bytes=0-99' })
    expect(video.status).toBe(206)
    expect(video.headers.get('content-type')).toBe('video/mp4')
    const poster = await client.req('GET', `/api/clips/${clip.id}/poster`)
    expect(poster.status).toBe(200)
    expect(poster.headers.get('content-type')).toBe('image/jpeg')
    const added = await client.json('POST', `/api/music/${MUSIC_LIBRARY[3].id}/add`, { workspaceId, projectId })
    expect(added.status).toBe(200)
    expect(added.body).toMatchObject({ status: 'ready', origin: 'ai', projectId, asset: { kind: 'audio', name: `Music · ${MUSIC_LIBRARY[3].title}` } })
    expect((await client.json('POST', `/api/music/${MUSIC_LIBRARY[3].id}/add`, { workspaceId, projectId })).body.asset.id).toBe(added.body.asset.id)
    const anim = CLIP_LIBRARY.find((c) => c.kind === 'animation')!
    const addedClip = await client.json('POST', `/api/clips/${anim.id}/add`, { workspaceId, projectId })
    expect(addedClip.status).toBe(200)
    expect(addedClip.body).toMatchObject({ status: 'ready', asset: { kind: 'video', name: `Animation · ${anim.title}` } })
    expect(addedClip.body.asset.duration).toBeGreaterThan(1)
    const outsider = await signup(t.app, 'Not in the space')
    expect((await outsider.client.json('POST', `/api/clips/${anim.id}/add`, { workspaceId, projectId })).status).toBe(404)
    const kept = await ctx().db.select().from(jobs).where(and(eq(jobs.kind, 'library.make'), sql`${jobs.status} = 'queued'`))
    expect(kept).toHaveLength(0)
  }, 120_000)
})
