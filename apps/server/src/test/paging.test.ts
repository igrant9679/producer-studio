// Lists page with a cursor instead of stopping quietly at a cap, and clip lists and live updates carry light records:
// no transcripts, the waveform at its inline size; GET /api/assets/:id still has everything. (SEC-18)
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import type { AssetRecord, Page, ProjectSummary, TemplateSummary, Transcript } from '@producer/core'
import { type Client, setup, signup } from './helpers'

let client: Client
let workspaceId = ''
let userId = ''
const transcript: Transcript = { language: 'en', engine: 'whisper', segments: [{ start: 0, end: 1.2, text: 'Hello there', words: [{ w: 'Hello', start: 0, end: 0.5 }, { w: 'there', start: 0.6, end: 1.1 }] }] }
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')

/** Follow `nextCursor` to the end. `extra`: what the first page may carry beyond `limit` (the built-in templates). */
async function all<T>(url: string, limit: number, extra = 0): Promise<{ items: T[]; pages: number }> {
  const items: T[] = []
  let cursor: string | undefined
  let pages = 0
  do {
    const r = await client.json<Page<T>>('GET', `${url}&limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`)
    expect(r.status).toBe(200)
    expect(r.body.items.length).toBeLessThanOrEqual(limit + (pages ? 0 : extra))
    items.push(...r.body.items)
    cursor = r.body.nextCursor
    pages++
  } while (cursor)
  return { items, pages }
}

async function clip(name: string): Promise<string> {
  const { createAssetFromFile } = await import('../services/assets')
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ps-page-')), name)
  fs.writeFileSync(f, PNG)
  return (await createAssetFromFile({ workspaceId, userId, filePath: f, name, mime: 'image/png', kind: 'image', origin: 'upload' })).id
}

beforeAll(async () => {
  const t = await setup()
  const u = await signup(t.app)
  client = u.client
  workspaceId = u.workspaceId
  userId = (await client.json('GET', '/api/auth/me')).body.user.id
})

describe('cursor paging', () => {
  it('projects: every one, page by page, newest first, none twice', async () => {
    const made: string[] = []
    for (let i = 0; i < 7; i++) made.push((await client.json('POST', '/api/projects', { workspaceId, name: `P${i}` })).body.project.id)
    const { items, pages } = await all<ProjectSummary>(`/api/projects?workspaceId=${workspaceId}`, 3)
    expect(pages).toBe(3)
    expect(new Set(items.map((p) => p.id)).size).toBe(items.length)
    expect(items.map((p) => p.id).sort()).toEqual([...made].sort())
    const times = items.map((p) => p.updatedAt)
    expect(times).toEqual([...times].sort((a, b) => b - a))
    // one page when it all fits, with no cursor
    const one = await client.json<Page<ProjectSummary>>('GET', `/api/projects?workspaceId=${workspaceId}`)
    expect(one.body.items).toHaveLength(7)
    expect(one.body.nextCursor).toBeUndefined()
  })

  it('clips, jobs and templates page the same way; a made-up cursor is refused', async () => {
    for (let i = 0; i < 5; i++) await clip(`c${i}.png`)
    const clips = await all<AssetRecord>(`/api/assets?workspaceId=${workspaceId}`, 2)
    expect(clips.items).toHaveLength(5)
    expect(clips.pages).toBe(3)
    const { enqueue } = await import('../jobs/queue')
    for (let i = 0; i < 4; i++) await enqueue('asset.process', { assetId: `as_none${i}` }, { workspaceId, userId })
    const jobs = await all<{ id: string }>(`/api/jobs?workspaceId=${workspaceId}`, 3)
    expect(new Set(jobs.items.map((j) => j.id)).size).toBe(jobs.items.length)
    expect(jobs.items.length).toBeGreaterThanOrEqual(4)
    // two of the projects become templates: the built-in looks come on the first page, then the space's
    const mine = (await client.json<Page<ProjectSummary>>('GET', `/api/projects?workspaceId=${workspaceId}`)).body.items.slice(0, 2)
    for (const p of mine) await client.json('PATCH', `/api/projects/${p.id}`, { isTemplate: true })
    const { loadLooks } = await import('../services/looks')
    const tpls = await all<TemplateSummary>(`/api/templates?workspaceId=${workspaceId}`, 1, loadLooks().length)
    expect(tpls.pages).toBe(2)
    expect(tpls.items.filter((t) => !t.builtIn).map((t) => t.id).sort()).toEqual(mine.map((p) => p.id).sort())
    expect(tpls.items.some((t) => t.builtIn)).toBe(true)
    expect((await client.json('GET', `/api/projects?workspaceId=${workspaceId}&cursor=bm9wZQ`)).status).toBe(400)
  })
})

describe('light clip records', () => {
  it('lists and live updates leave the transcript out and cap the waveform; the clip itself has both', async () => {
    const { ctx } = await import('../context')
    const { mergeAssetMeta } = await import('../services/assets')
    const id = await clip('talk.png')
    // an hour of peaks, as a clip processed before the full waveform became a file still holds
    await mergeAssetMeta(id, { transcript, waveform: Array.from({ length: 180_000 }, (_, i) => (i % 100) / 100) })
    const events: AssetRecord[] = []
    const off = ctx().bus.subscribe(workspaceId, (e) => e.event === 'asset' && events.push(e.data as AssetRecord))
    try {
      expect((await client.json('PATCH', `/api/assets/${id}`, { name: 'talk renamed.png' })).status).toBe(200)
    } finally {
      off()
    }
    const listed = (await client.json<Page<AssetRecord>>('GET', `/api/assets?workspaceId=${workspaceId}`)).body.items.find((r) => r.asset.id === id)!
    for (const r of [listed, events.at(-1)!]) {
      expect(r.light).toBe(true)
      expect(r.asset.transcript).toBeUndefined()
      expect(r.transcriptRev).toEqual(expect.any(String))
      expect(r.asset.waveform!.length).toBeLessThanOrEqual(4000)
      expect(r.asset.waveformSrc).toBe(`/api/media/${id}/waveform`)
      // well under the size of the full record
      expect(JSON.stringify(r).length).toBeLessThan(60_000)
    }
    const full = (await client.json<AssetRecord>('GET', `/api/assets/${id}`)).body
    expect(full.light).toBeUndefined()
    expect(full.asset.transcript).toEqual(transcript)
    // a different transcript is told apart without being sent
    await mergeAssetMeta(id, { transcript: { ...transcript, language: 'fr' } })
    const again = (await client.json<Page<AssetRecord>>('GET', `/api/assets?workspaceId=${workspaceId}`)).body.items.find((r) => r.asset.id === id)!
    expect(again.transcriptRev).not.toBe(listed.transcriptRev)
  })
})
