// Music and sound effects, for real: a video made from an idea, narrated by Kokoro, assembled with composed music and
// earshot's effects, and exported, so a person can listen to it (SOUND_OUT=<file.mp4>; a spectrogram is written next
// to it). Runs only with REAL_SOUND=1, and needs the Kokoro model (KOKORO_CACHE).
import fs from 'node:fs'
import path from 'node:path'
import { projectDuration, type AudioItem, type ProjectDocResponse, type ScriptScene } from '@producer/core'
import { eq } from 'drizzle-orm'
import { beforeAll, describe, expect, it } from 'vitest'
import { produceAssemble } from '../ai/produce'
import { ctx } from '../context'
import { assets, exportsTable } from '../db/schema'
import { enqueue, getJob } from '../jobs/queue'
import { inlineContext } from '../jobs/worker'
import { ffmpeg } from '../media/proc'
import { exportRender } from '../render/export'
import { claimJob, type Client, setup, signup } from './helpers'

const REAL = process.env.REAL_SOUND === '1'
let client: Client
let workspaceId = ''

beforeAll(async () => {
  if (!REAL) return
  const t = await setup()
  const u = await signup(t.app, 'Sound')
  client = u.client
  workspaceId = u.workspaceId
}, 300_000)

/** Integrated loudness (LUFS) of a file, by ffmpeg's ebur128. */
async function lufs(file: string): Promise<number> {
  const r = await ffmpeg(['-i', file, '-af', 'ebur128', '-f', 'null', '-'])
  const m = /I:\s+(-?[\d.]+) LUFS/.exec(r.stderr.split('Summary:').pop() ?? '')
  return m ? Number(m[1]) : NaN
}

describe.skipIf(!REAL)('a video with music and sound effects', () => {
  it('is narrated, scored and exported, the voice well over the music', async () => {
    const scenes: ScriptScene[] = [
      { id: 's01', title: 'Hook', headline: 'Your scraps are worth more', narration: 'Your kitchen scraps are worth more than you think.', footage: [], visual: { kind: 'motion', points: ['Peels', 'Coffee grounds', 'Eggshells'] } },
      { id: 's02', title: 'Recipe', headline: 'Greens and browns', narration: 'Mix one part greens with two parts browns, and keep it damp like a sponge.', footage: [], visual: { kind: 'diagram', diagram: { type: 'steps', items: ['Greens', 'Browns', 'Water'] } } },
      { id: 's03', title: 'Time', headline: 'Three months', narration: 'In about three months, microbes turn it into rich, dark soil.', footage: [], visual: { kind: 'diagram', diagram: { type: 'stat', value: '3', label: 'months to soil' } } },
      { id: 's04', title: 'Close', headline: 'Start this weekend', narration: 'Start a bin this weekend, and your garden will thank you.', footage: [], visual: { kind: 'motion', points: ['This weekend'] } },
    ]
    const brief = { title: 'How compost works', audience: 'Home gardeners', goal: 'Start a compost bin', tone: process.env.SOUND_TONE || 'Friendly', template: 'studio-dark', voice: 'af_heart', aspect: '16:9' as const, source: 'idea' as const, idea: 'How compost works', music: process.env.SOUND_MUSIC || 'auto', soundEffects: true }
    const r = await client.json<ProjectDocResponse>('POST', '/api/projects', { workspaceId, name: 'Compost', kind: 'producer', width: 1920, height: 1080 })
    const id = r.body.project.id
    const a = await client.json('POST', '/api/ai/produce/assemble', { projectId: id, scenes, brief })
    expect(a.status).toBe(200)
    const job = (await getJob(a.body.id))!
    const jc = inlineContext({ id: job.id, kind: 'ai.produce.assemble', workspaceId, userId: job.userId, projectId: id, input: job.input })
    const t0 = Date.now()
    jc.progress = (f, m) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0)}s] ${Math.round(f * 100)}% ${m ?? ''}`)
    const res = await produceAssemble(jc)
    expect(res.notes).toBeUndefined()
    const p = (await client.json<ProjectDocResponse>('GET', `/api/projects/${id}`)).body.project
    const fx = p.tracks.find((t) => t.name === 'Sound effects')!
    console.log(JSON.stringify({ tracks: p.tracks.map((t) => `${t.name}(${t.items.length})`), effects: fx.items.map((i) => `${i.name}@${i.start.toFixed(2)}`) }))
    const song = p.assets[(p.tracks.find((t) => t.name === 'Music')!.items[0] as AudioItem).assetId]
    const j = await enqueue('export.render', { projectId: id, resolution: '720p', fps: 30, quality: 'standard', format: 'mp4' }, { workspaceId, userId: job.userId, projectId: id })
    const result = await exportRender(inlineContext(await claimJob(j.id)))
    const ex = (await ctx().db.select().from(exportsTable).where(eq(exportsTable.id, (result as { exportId: string }).exportId)))[0]
    const outRow = (await ctx().db.select().from(assets).where(eq(assets.id, ex.assetId)))[0]
    const file = ctx().storage.localPath!(outRow.sourceKey)
    const songRow = (await ctx().db.select().from(assets).where(eq(assets.id, song.id)))[0]
    const songFile = ctx().storage.localPath!(songRow.sourceKey)
    const target = process.env.SOUND_OUT
    if (target) {
      fs.copyFileSync(file, target)
      fs.copyFileSync(songFile, target.replace(/\.mp4$/, '-music.m4a'))
      await ffmpeg(['-i', file, '-lavfi', 'showspectrumpic=s=1600x500:legend=1:scale=log', '-frames:v', '1', target.replace(/\.mp4$/, '-spectrum.png')])
      await ffmpeg(['-i', file, '-filter_complex', 'showwavespic=s=1600x300:split_channels=1', '-frames:v', '1', target.replace(/\.mp4$/, '-wave.png')])
    }
    const mix = await lufs(file)
    const music = await lufs(songFile)
    console.log(JSON.stringify({ export: file, mixLufs: mix, musicLufs: music, music: songRow.name }))
    expect(mix).toBeGreaterThan(music + 6)
    expect(path.extname(file)).toBe('.mp4')
  }, 3_600_000)

  it('just the animation: no voice, no words, no cards, the music up front', async () => {
    ctx().config.freeMedia = true
    const obj = (name: string) => ({ name })
    const scenes: ScriptScene[] = [
      { id: 's01', title: 'Seed', headline: 'Seed', narration: 'A seed, a watering can and the sun arrive one after another along a row.', footage: [], visual: { kind: 'animation', style: 'row', objects: [obj('seedling'), obj('droplet'), obj('sun')] } },
      { id: 's02', title: 'Grow', headline: 'Grow', narration: 'The seedling grows into a tree, and then the tree bears a red apple for everyone.', footage: [], visual: { kind: 'animation', style: 'grow', objects: [obj('seedling'), obj('deciduous tree'), obj('red apple')] } },
      { id: 's03', title: 'World', headline: 'World', narration: 'Apples, baskets and trucks circle the globe, going everywhere at once and never stopping.', footage: [], visual: { kind: 'animation', style: 'orbit', objects: [obj('globe'), obj('red apple'), obj('basket'), obj('delivery truck')] } },
    ]
    const brief = { title: 'From a seed', audience: '', goal: '', tone: 'Calm', template: 'studio-dark', voice: 'af_heart', aspect: '16:9' as const, source: 'idea' as const, idea: 'From a seed', music: 'auto', soundEffects: true, narration: false, captions: false, onScreenText: false, cards: false }
    const r = await client.json<ProjectDocResponse>('POST', '/api/projects', { workspaceId, name: 'From a seed', kind: 'producer', width: 1920, height: 1080 })
    const id = r.body.project.id
    const a = await client.json('POST', '/api/ai/produce/assemble', { projectId: id, scenes, brief })
    expect(a.status).toBe(200)
    const job = (await getJob(a.body.id))!
    const res = await produceAssemble(inlineContext({ id: job.id, kind: 'ai.produce.assemble', workspaceId, userId: job.userId, projectId: id, input: job.input }))
    expect(res.notes).toBeUndefined()
    const p = (await client.json<ProjectDocResponse>('GET', `/api/projects/${id}`)).body.project
    console.log(JSON.stringify({ tracks: p.tracks.map((t) => `${t.name}(${t.items.length})`), duration: projectDuration(p) }))
    expect(p.tracks.flatMap((t) => t.items).filter((i) => i.type === 'text' || i.type === 'caption')).toEqual([])
    const j = await enqueue('export.render', { projectId: id, resolution: '720p', fps: 30, quality: 'standard', format: 'mp4' }, { workspaceId, userId: job.userId, projectId: id })
    const result = await exportRender(inlineContext(await claimJob(j.id)))
    const ex = (await ctx().db.select().from(exportsTable).where(eq(exportsTable.id, (result as { exportId: string }).exportId)))[0]
    const outRow = (await ctx().db.select().from(assets).where(eq(assets.id, ex.assetId)))[0]
    const file = ctx().storage.localPath!(outRow.sourceKey)
    const target = process.env.SOUND_SILENT_OUT
    if (target) {
      fs.copyFileSync(file, target)
      await ffmpeg(['-i', file, '-vf', `fps=1/${Math.max(1, Math.floor(projectDuration(p) / 12))},scale=400:-2,tile=4x3:padding=6:color=white`, '-frames:v', '1', target.replace(/\.mp4$/, '-sheet.png')])
    }
    const mix = await lufs(file)
    console.log(JSON.stringify({ export: file, mixLufs: mix }))
    expect(mix).toBeGreaterThan(-22)
  }, 1_500_000)
})
