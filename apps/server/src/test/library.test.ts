// The Library (phase 5, release 3): the media trash with Empty trash and retention, "used in N projects" and
// replacing a clip's file in place (A-14, P-23), the space-wide exports list and export deletes (A-19, P-23), search
// (A-11), copying and moving projects and clips between spaces (A-13) and project tags (A-12).
import { beforeAll, describe, expect, it } from 'vitest'
import { createProject, type Project } from '@producer/core'
import { Client, setup, signup, type TestEnv } from './helpers'

let t: TestEnv
beforeAll(async () => {
  t = await setup()
})

const ctx = async () => (await import('../context')).ctx()
const schema = () => import('../db/schema')
let n = 0

/** A ready clip with a real file (and the derived files a processed clip has). */
async function readyClip(workspaceId: string, opts: { name?: string; kind?: 'video' | 'audio'; meta?: Record<string, unknown>; origin?: string } = {}) {
  const c = await ctx()
  const { assets } = await schema()
  const id = `as_lib_${Date.now().toString(36)}${++n}`
  const dir = `ws/${workspaceId}/assets/${id}`
  const kind = opts.kind ?? 'video'
  await c.storage.put(`${dir}/source.mp4`, Buffer.from(`clip ${id}`))
  await c.storage.put(`${dir}/thumb.jpg`, Buffer.from('thumb'))
  const now = Date.now()
  await c.db.insert(assets).values({ id, workspaceId, kind, name: opts.name ?? `${id}.mp4`, mime: kind === 'video' ? 'video/mp4' : 'audio/wav', size: 10, status: 'ready', origin: opts.origin ?? 'upload', sourceKey: `${dir}/source.mp4`, thumbKey: `${dir}/thumb.jpg`, meta: (opts.meta ?? { duration: 30 }) as never, createdBy: 'u', createdAt: now, updatedAt: now })
  return id
}

/** A project whose document uses the given clips. */
async function projectUsing(client: Client, workspaceId: string, name: string, clipIds: string[], extra: Partial<Project> = {}) {
  const doc = createProject({ name })
  for (const id of clipIds) doc.assets[id] = { id, kind: 'video', name: `${id}.mp4`, src: `/api/media/${id}/source`, duration: 30 } as Project['assets'][string]
  if (clipIds[0]) doc.tracks[0].items.push({ id: 'v_1', type: 'video', assetId: clipIds[0], start: 0, duration: 5, in: 0 } as never)
  Object.assign(doc, extra)
  const r = await client.json('POST', '/api/projects', { workspaceId, project: doc })
  expect(r.status).toBe(200)
  return r.body.summary.id as string
}

async function exists(key: string) {
  return !!(await (await ctx()).storage.stat(key))
}

async function teamWith(role: 'editor' | 'viewer') {
  const A = await signup(t.app, 'Ada Owner')
  const ws = (await A.client.json('POST', '/api/workspaces', { name: 'Team' })).body as { id: string }
  const M = await signup(t.app, 'Member')
  const inv = await A.client.json('POST', `/api/workspaces/${ws.id}/invites`, { email: M.email, role })
  await M.client.json('POST', `/api/invites/${inv.body.inviteUrl.split('/invite/')[1]}/accept`)
  return { A, wsId: ws.id, M }
}

describe('the media trash (A-14, P-23)', () => {
  it('Delete puts a clip in the trash: it leaves the library, keeps its files, says which projects use it, and can be restored', async () => {
    const A = await signup(t.app)
    const clip = await readyClip(A.workspaceId)
    const p = await projectUsing(A.client, A.workspaceId, 'Launch', [clip])
    expect((await A.client.json('GET', `/api/assets/${clip}/usage`)).body).toEqual({ assetId: clip, projects: [{ id: p, name: 'Launch', trashed: false }] })

    const del = await A.client.json('DELETE', `/api/assets/${clip}`)
    expect(del.status).toBe(200)
    expect(del.body).toMatchObject({ ok: true, usedIn: 1 })
    const lib = (await A.client.json('GET', `/api/assets?workspaceId=${A.workspaceId}`)).body.items.map((a: any) => a.asset.id)
    expect(lib).not.toContain(clip)
    const trash = (await A.client.json('GET', `/api/assets?workspaceId=${A.workspaceId}&trashed=1`)).body.items
    expect(trash.map((a: any) => a.asset.id)).toEqual([clip])
    expect(trash[0].trashedAt).toBeGreaterThan(0)
    // nothing removed: the project still plays it
    expect(await exists(`ws/${A.workspaceId}/assets/${clip}/source.mp4`)).toBe(true)
    expect((await A.client.json('GET', `/api/projects/${p}`)).body.project.assets[clip].src).toBe(`/api/media/${clip}/source`)
    expect((await A.client.req('GET', `/api/media/${clip}/source`)).status).toBeLessThan(400)

    const back = await A.client.json('POST', `/api/assets/${clip}/restore`)
    expect(back.status).toBe(200)
    expect(back.body.trashedAt).toBeUndefined()
    expect((await A.client.json('GET', `/api/assets?workspaceId=${A.workspaceId}`)).body.items.map((a: any) => a.asset.id)).toContain(clip)
  })

  it('only Empty trash removes clips for good: rows, files and the exports made of them', async () => {
    const A = await signup(t.app)
    const keep = await readyClip(A.workspaceId)
    const gone = await readyClip(A.workspaceId)
    const other = await readyClip(A.workspaceId)
    // an export whose file is one of them, with a share link
    const p = await projectUsing(A.client, A.workspaceId, 'Cut', [])
    const { exportsTable, assets, tombstones } = await schema()
    const c = await ctx()
    await c.db.insert(exportsTable).values({ id: `ex_lib_${gone}`, projectId: p, workspaceId: A.workspaceId, assetId: gone, name: 'Cut', resolution: '1080p', fps: 30, format: 'mp4', sizeBytes: 4, duration: 5, createdBy: 'u', createdAt: Date.now() })
    expect((await A.client.json('POST', `/api/projects/${p}/share`, {})).status).toBe(200)

    await A.client.json('DELETE', `/api/assets/${gone}`)
    await A.client.json('DELETE', `/api/assets/${other}`)
    // a clip that isn't in the trash can't be removed from it
    const refused = await A.client.json('POST', '/api/assets/trash/empty', { workspaceId: A.workspaceId, ids: [keep] })
    expect(refused.status).toBe(409)
    // only the ones asked for
    const one = await A.client.json('POST', '/api/assets/trash/empty', { workspaceId: A.workspaceId, ids: [gone] })
    expect(one.body).toEqual({ removed: 1, exports: 1 })
    expect(await exists(`ws/${A.workspaceId}/assets/${gone}/source.mp4`)).toBe(false)
    expect((await A.client.json('GET', `/api/projects/${p}/shares`)).body).toEqual([])
    const { eq } = await import('drizzle-orm')
    expect((await c.db.select().from(tombstones).where(eq(tombstones.id, gone))).length).toBe(1)
    // everything left in the trash
    expect((await A.client.json('POST', '/api/assets/trash/empty', { workspaceId: A.workspaceId })).body).toEqual({ removed: 1, exports: 0 })
    const left = (await c.db.select({ id: assets.id }).from(assets).where(eq(assets.workspaceId, A.workspaceId))).map((r) => r.id)
    expect(left).toEqual([keep])
  })

  it('viewers can look at the trash and usage but not delete, restore or empty it', async () => {
    const { A, wsId, M } = await teamWith('viewer')
    const clip = await readyClip(wsId)
    expect((await M.client.json('GET', `/api/assets/${clip}/usage`)).status).toBe(200)
    expect((await M.client.json('DELETE', `/api/assets/${clip}`)).status).toBe(403)
    await A.client.json('DELETE', `/api/assets/${clip}`)
    expect((await M.client.json('GET', `/api/assets?workspaceId=${wsId}&trashed=1`)).body.items).toHaveLength(1)
    expect((await M.client.json('POST', `/api/assets/${clip}/restore`)).status).toBe(403)
    expect((await M.client.json('POST', '/api/assets/trash/empty', { workspaceId: wsId })).status).toBe(403)
  })

  it('media in the trash longer than MEDIA_TRASH_DAYS is removed by the housekeeping sweep (0 keeps it)', async () => {
    const A = await signup(t.app)
    const old = await readyClip(A.workspaceId)
    const recent = await readyClip(A.workspaceId)
    const c = await ctx()
    const { assets } = await schema()
    const { eq } = await import('drizzle-orm')
    await c.db.update(assets).set({ trashedAt: Date.now() - 40 * 86400_000 }).where(eq(assets.id, old))
    await c.db.update(assets).set({ trashedAt: Date.now() - 86400_000 }).where(eq(assets.id, recent))
    const { sweepLibrary } = await import('../services/library')
    const saved = c.config.mediaTrashDays
    try {
      c.config.mediaTrashDays = 0
      expect((await sweepLibrary()).media).toBe(0)
      c.config.mediaTrashDays = 30
      expect((await sweepLibrary()).media).toBeGreaterThanOrEqual(1)
    } finally {
      c.config.mediaTrashDays = saved
    }
    const ids = (await c.db.select({ id: assets.id }).from(assets).where(eq(assets.workspaceId, A.workspaceId))).map((r) => r.id)
    expect(ids).toEqual([recent])
    // the system info states it, for the trash's notice
    expect((await A.client.json('GET', '/api/system')).body.retention).toEqual({ mediaTrashDays: saved, exportDays: c.config.exportRetentionDays })
  })
})

describe('replacing a clip’s file in place (A-14)', () => {
  it('keeps the id, so every project follows; the old files go and the new one is processed', async () => {
    const A = await signup(t.app)
    const clip = await readyClip(A.workspaceId, { meta: { duration: 30, transcript: { language: 'en', engine: 't', segments: [] } } })
    const p = await projectUsing(A.client, A.workspaceId, 'Uses it', [clip])
    const ticket = await A.client.json('POST', `/api/assets/${clip}/replace`, { filename: 'take2.mov', mime: 'video/quicktime', size: 8 })
    expect(ticket.status).toBe(200)
    expect(ticket.body).toMatchObject({ assetId: clip, url: `/api/assets/${clip}/replace/data`, method: 'PUT' })
    // nothing has changed yet
    expect((await A.client.json('GET', `/api/assets/${clip}`)).body.status).toBe('ready')
    expect((await A.client.req('PUT', ticket.body.url, new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]), ticket.body.headers)).status).toBe(200)
    const done = await A.client.json('POST', `/api/assets/${clip}/replace/complete`)
    expect(done.status).toBe(200)
    expect(done.body).toMatchObject({ status: 'processing', asset: { id: clip, mime: 'video/quicktime', sizeBytes: 8 } })
    expect(done.body.asset.transcript).toBeUndefined()
    expect(await exists(`ws/${A.workspaceId}/assets/${clip}/source.mp4`)).toBe(false)
    expect(await exists(`ws/${A.workspaceId}/assets/${clip}/thumb.jpg`)).toBe(false)
    const c = await ctx()
    const { assets, jobs } = await schema()
    const { eq, and, sql } = await import('drizzle-orm')
    const row = (await c.db.select().from(assets).where(eq(assets.id, clip)))[0]
    expect(row.sourceKey).toMatch(new RegExp(`^ws/${A.workspaceId}/assets/${clip}/source-[a-z0-9]+\\.mov$`))
    expect(await exists(row.sourceKey)).toBe(true)
    expect(row.sha256).toMatch(/^[a-f0-9]{64}$/)
    const queued = await c.db.select().from(jobs).where(and(eq(jobs.kind, 'asset.process'), sql`${jobs.input}->>'assetId' = ${clip}`))
    expect(queued).toHaveLength(1)
    // the project still points at the same clip
    expect(Object.keys((await A.client.json('GET', `/api/projects/${p}`)).body.project.assets)).toEqual([clip])
  })

  it('refuses another kind of media, and a clip that is still processing', async () => {
    const A = await signup(t.app)
    const clip = await readyClip(A.workspaceId)
    const r = await A.client.json('POST', `/api/assets/${clip}/replace`, { filename: 'song.mp3', mime: 'audio/mpeg', size: 8 })
    expect(r.status).toBe(400)
    expect(r.body.error).toMatch(/Replace a video with another video/)
    expect((await A.client.json('POST', `/api/assets/${clip}/replace/complete`)).status).toBe(409)
  })
})

describe('the space’s exports (A-19, P-23)', () => {
  async function addExport(workspaceId: string, projectId: string, name: string, format = 'mp4', createdAt = Date.now()) {
    const assetId = await readyClip(workspaceId, { origin: 'render' })
    const { exportsTable } = await schema()
    const id = `ex_lib_${++n}`
    await (await ctx()).db.insert(exportsTable).values({ id, projectId, workspaceId, assetId, name, resolution: format === 'mp3' ? 'audio' : '1080p', fps: 30, format, sizeBytes: 10, duration: 5, createdBy: 'u', createdAt })
    return { id, assetId }
  }

  it('lists every project’s exports, newest first, paged, with search and a format filter', async () => {
    const A = await signup(t.app)
    const ps = []
    for (let i = 0; i < 30; i++) ps.push(await projectUsing(A.client, A.workspaceId, `Project ${i}`, []))
    let at = Date.now() - 1000
    for (const p of ps) await addExport(A.workspaceId, p, 'Cut', 'mp4', at++)
    const podcast = await addExport(A.workspaceId, ps[0], 'Podcast episode', 'mp3', at++)
    const page1 = (await A.client.json('GET', `/api/exports?workspaceId=${A.workspaceId}&limit=20`)).body
    expect(page1.items).toHaveLength(20)
    expect(page1.items[0]).toMatchObject({ exportId: podcast.id, projectName: 'Project 0', format: 'mp3', shares: 0, assetId: podcast.assetId })
    const page2 = (await A.client.json('GET', `/api/exports?workspaceId=${A.workspaceId}&limit=20&cursor=${page1.nextCursor}`)).body
    expect(page2.items).toHaveLength(11)
    expect(page2.nextCursor).toBeUndefined()
    expect((await A.client.json('GET', `/api/exports?workspaceId=${A.workspaceId}&format=mp3`)).body.items.map((e: any) => e.exportId)).toEqual([podcast.id])
    expect((await A.client.json('GET', `/api/exports?workspaceId=${A.workspaceId}&q=project%2029`)).body.items.map((e: any) => e.projectName)).toEqual(['Project 29'])
    // a pattern character is only itself
    expect((await A.client.json('GET', `/api/exports?workspaceId=${A.workspaceId}&q=%25`)).body.items).toEqual([])
    // the per-project list is unchanged
    expect((await A.client.json('GET', `/api/exports?projectId=${ps[0]}`)).body).toHaveLength(2)
  })

  it('Delete removes an export, its share links and its file; a file a project uses stays in the library', async () => {
    const { A, wsId, M } = await teamWith('viewer')
    const p = await projectUsing(A.client, wsId, 'Launch', [])
    const plain = await addExport(wsId, p, 'Plain')
    expect((await A.client.json('POST', `/api/projects/${p}/share`, { exportId: plain.id })).status).toBe(200)
    expect((await M.client.json('DELETE', `/api/exports/${plain.id}`)).status).toBe(403)
    const r = await A.client.json('DELETE', `/api/exports/${plain.id}`)
    expect(r.body).toEqual({ ok: true, links: 1, keptFile: false })
    expect(await exists(`ws/${wsId}/assets/${plain.assetId}/source.mp4`)).toBe(false)
    expect((await A.client.json('GET', `/api/exports?projectId=${p}`)).body).toEqual([])

    const used = await addExport(wsId, p, 'On a timeline')
    await projectUsing(A.client, wsId, 'Reuses the render', [used.assetId])
    expect((await A.client.json('DELETE', `/api/exports/${used.id}`)).body).toEqual({ ok: true, links: 0, keptFile: true })
    expect((await A.client.json('GET', `/api/assets/${used.assetId}`)).status).toBe(200)
    expect((await A.client.json('DELETE', `/api/exports/${used.id}`)).status).toBe(404)
  })

  it('EXPORT_RETENTION_DAYS removes old exports, except one a working share link shows', async () => {
    const A = await signup(t.app)
    const p = await projectUsing(A.client, A.workspaceId, 'Old', [])
    const old = Date.now() - 100 * 86400_000
    const stale = await addExport(A.workspaceId, p, 'Stale', 'mp4', old)
    const linked = await addExport(A.workspaceId, p, 'Linked', 'mp4', old)
    const fresh = await addExport(A.workspaceId, p, 'Fresh')
    await A.client.json('POST', `/api/projects/${p}/share`, { exportId: linked.id })
    const c = await ctx()
    const { sweepLibrary } = await import('../services/library')
    const saved = c.config.exportRetentionDays
    try {
      c.config.exportRetentionDays = 0
      await sweepLibrary()
      expect((await A.client.json('GET', `/api/exports?projectId=${p}`)).body).toHaveLength(3)
      c.config.exportRetentionDays = 30
      await sweepLibrary()
    } finally {
      c.config.exportRetentionDays = saved
    }
    expect((await A.client.json('GET', `/api/exports?projectId=${p}`)).body.map((e: any) => e.exportId).sort()).toEqual([fresh.id, linked.id].sort())
    expect(await exists(`ws/${A.workspaceId}/assets/${stale.assetId}/source.mp4`)).toBe(false)
  })
})

describe('search everything (A-11)', () => {
  it('finds projects, templates, clips by their words, voiceovers, voices, exports and members; never the trash', async () => {
    const A = await signup(t.app, 'Grace Hopper')
    const said = await readyClip(A.workspaceId, {
      name: 'Interview.mov',
      meta: { duration: 60, transcript: { language: 'en', engine: 't', segments: [{ start: 3, end: 5, text: 'Hello there', words: [] }, { start: 12.5, end: 15, text: 'We ship the blue widget on Friday', words: [] }] } },
    })
    await readyClip(A.workspaceId, { name: 'Voiceover 1.wav', kind: 'audio', origin: 'tts', meta: { duration: 4, tts: { text: 'Our widget saves an hour a day', voice: 'af_heart', speed: 1 } } })
    const trashed = await readyClip(A.workspaceId, { name: 'Widget b-roll.mp4' })
    await A.client.json('DELETE', `/api/assets/${trashed}`)
    const launch = await projectUsing(A.client, A.workspaceId, 'Widget launch', [])
    await A.client.json('PATCH', `/api/projects/${launch}`, { tags: ['Q3 campaign'] })
    const tpl = await projectUsing(A.client, A.workspaceId, 'Widget template', [])
    await A.client.json('PATCH', `/api/projects/${tpl}`, { isTemplate: true })
    await projectUsing(A.client, A.workspaceId, 'Explainer', [], { ai: { brief: {} as never, script: { scenes: [{ id: 's1', title: 'Hook', headline: 'h', narration: 'Meet the widget everyone talks about', footage: [] }] } } as Project['ai'] })

    const get = async (q: string) => (await A.client.json('GET', `/api/search?workspaceId=${A.workspaceId}&q=${encodeURIComponent(q)}`)).body
    const r = await get('WIDGET')
    const titles = r.hits.map((h: any) => `${h.kind}:${h.title}`)
    expect(titles).toEqual(expect.arrayContaining(['project:Widget launch', 'template:Widget template', 'project:Explainer', 'media:Interview.mov', 'media:Voiceover 1.wav']))
    expect(titles).not.toContain('media:Widget b-roll.mp4')
    const words = r.hits.find((h: any) => h.title === 'Interview.mov')
    expect(words).toMatchObject({ detail: 'Said in the clip', at: 12.5, snippet: 'We ship the blue widget on Friday', assetId: said })
    expect(r.hits.find((h: any) => h.title === 'Explainer')).toMatchObject({ detail: 'Said in its narration', snippet: 'Meet the widget everyone talks about' })
    // every word, in any order, in one sentence
    expect((await get('friday blue')).hits.map((h: any) => h.title)).toEqual(['Interview.mov'])
    expect((await get('friday hello')).hits).toEqual([])
    // tags, members, built-in voices
    expect((await get('q3')).hits.map((h: any) => h.title)).toEqual(['Widget launch'])
    expect((await get('grace')).hits).toEqual([expect.objectContaining({ kind: 'member', title: 'Grace Hopper' })])
    expect((await get('heart')).hits.some((h: any) => h.kind === 'voice' && h.id === 'af_heart')).toBe(true)
    // pattern characters are literal
    expect((await get('%')).hits).toEqual([])
    expect((await get('_')).hits).toEqual([])
    expect((await get('   ')).hits).toEqual([])
  })

  it('is only for the space’s members', async () => {
    const A = await signup(t.app)
    const B = await signup(t.app)
    expect((await B.client.json('GET', `/api/search?workspaceId=${A.workspaceId}&q=x`)).status).toBe(404)
  })
})

describe('copying and moving between spaces (A-13)', () => {
  it('a project copied to another space brings copies of its clips, with their files, under new ids', async () => {
    const A = await signup(t.app)
    const team = (await A.client.json('POST', '/api/workspaces', { name: 'Team' })).body.id as string
    const clip = await readyClip(A.workspaceId, { name: 'Shot.mp4' })
    const p = await projectUsing(A.client, A.workspaceId, 'Promo', [clip])
    const r = await A.client.json('POST', `/api/projects/${p}/copy`, { workspaceId: team })
    expect(r.status).toBe(200)
    expect(r.body).toMatchObject({ workspaceId: team, name: 'Promo', missingMedia: 0 })
    const copy = (await A.client.json('GET', `/api/projects/${r.body.id}`)).body.project as Project
    const [newClip] = Object.keys(copy.assets)
    expect(newClip).not.toBe(clip)
    expect((copy.tracks[0].items[0] as { assetId: string }).assetId).toBe(newClip)
    expect(copy.assets[newClip]).toMatchObject({ name: 'Shot.mp4', src: `/api/media/${newClip}/source` })
    expect(await exists(`ws/${team}/assets/${newClip}/source.mp4`)).toBe(true)
    expect(await exists(`ws/${team}/assets/${newClip}/thumb.jpg`)).toBe(true)
    // the original is untouched
    expect((await A.client.json('GET', `/api/projects/${p}`)).body.summary.trashed).toBe(false)
  })

  it('move also puts the original in the trash; a space the person only views is refused', async () => {
    const { A, wsId, M } = await teamWith('viewer')
    const p = await projectUsing(M.client, (await M.client.json('GET', '/api/workspaces')).body.find((w: any) => w.personal).id, 'Mine', [])
    expect((await M.client.json('POST', `/api/projects/${p}/copy`, { workspaceId: wsId })).status).toBe(403)
    const own = await projectUsing(A.client, A.workspaceId, 'Moving', [])
    const moved = await A.client.json('POST', `/api/projects/${own}/copy`, { workspaceId: wsId, move: true })
    expect(moved.status).toBe(200)
    expect((await A.client.json('GET', `/api/projects/${own}`)).body.summary.trashed).toBe(true)
    expect((await A.client.json('POST', `/api/projects/${own}/copy`, { workspaceId: A.workspaceId })).status).toBe(400)
  })

  it('a clip can be copied or moved to another space on its own', async () => {
    const A = await signup(t.app)
    const team = (await A.client.json('POST', '/api/workspaces', { name: 'Team' })).body.id as string
    const clip = await readyClip(A.workspaceId)
    const r = await A.client.json('POST', `/api/assets/${clip}/copy`, { workspaceId: team, move: true })
    expect(r.status).toBe(200)
    expect(r.body.workspaceId).toBe(team)
    expect((await A.client.json('GET', `/api/assets?workspaceId=${team}`)).body.items.map((a: any) => a.asset.id)).toEqual([r.body.asset.id])
    expect((await A.client.json('GET', `/api/assets?workspaceId=${A.workspaceId}&trashed=1`)).body.items.map((a: any) => a.asset.id)).toEqual([clip])
  })
})

describe('project tags (A-12)', () => {
  it('are tidied, listed with the project, and saved as a new version', async () => {
    const A = await signup(t.app)
    const p = await projectUsing(A.client, A.workspaceId, 'Tagged', [])
    const r = await A.client.json('PATCH', `/api/projects/${p}`, { tags: [' Launch ', 'launch', 'Q3  campaign', ''], baseVersion: 1 })
    expect(r.status).toBe(200)
    expect(r.body).toMatchObject({ tags: ['Launch', 'Q3 campaign'], version: 2 })
    const listed = (await A.client.json('GET', `/api/projects?workspaceId=${A.workspaceId}`)).body.items.find((x: any) => x.id === p)
    expect(listed.tags).toEqual(['Launch', 'Q3 campaign'])
    expect((await A.client.json('GET', `/api/projects/${p}`)).body.project.tags).toEqual(['Launch', 'Q3 campaign'])
    expect((await A.client.json('PATCH', `/api/projects/${p}`, { tags: [] })).body.tags).toBeUndefined()
  })
})
