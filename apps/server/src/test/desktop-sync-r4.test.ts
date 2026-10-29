// Desktop sync, release 4 (R4-C): a full resync after the cloud compacted its deletes (D-6), a space's other brand
// kits and fonts (carried from R3). Same harness as desktop-sync.test.ts (a real cloud in a child process, this process
// as the desktop), with a proxy in between that can drop the network or rewrite the cloud's answers.
import crypto from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Project, SyncStatus } from '@producer/core'
import { type Cloud, type Desktop, type Http, PASSWORD, deskSession, startCloud, startDesktop } from './desktop-harness'
import { type CloudProxy, startProxy } from './cloud-proxy'
import { bootWaitMs } from './boot-wait'

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')
const png = (extra: number) => Buffer.concat([PNG, crypto.randomBytes(extra)])

async function deskUpload(bytes: Buffer, filename = 'clip.png'): Promise<string> {
  const t = await desk.json('POST', '/api/uploads', { workspaceId: A.workspaceId, filename, mime: 'image/png', size: bytes.length })
  expect(t.status).toBe(200)
  expect((await desk.json('PUT', t.body.url, bytes, { 'content-type': 'image/png' })).status).toBe(200)
  expect((await desk.json('POST', `/api/assets/${t.body.assetId}/complete`)).status).toBe(200)
  return t.body.assetId
}

const FONT = Buffer.from([0x77, 0x4f, 0x46, 0x32, ...new Array(80).fill(9)]) // 'wOF2' and some bytes

let cloud: Cloud
let proxy: CloudProxy
let d: Desktop
let desk: Http
let A: Awaited<ReturnType<Cloud['signup']>>

async function sync(): Promise<SyncStatus> {
  const r = await desk.json<SyncStatus>('POST', '/api/sync/now')
  expect(r.status).toBe(200)
  return r.body
}

async function cloudProject(name: string) {
  const r = await A.http.json('POST', '/api/projects', { workspaceId: A.workspaceId, name })
  expect(r.status).toBe(200)
  return r.body.project.id as string
}

async function cloudDelete(id: string) {
  await A.http.json('PATCH', `/api/projects/${id}`, { trashed: true })
  expect((await A.http.json('DELETE', `/api/projects/${id}`)).status).toBe(200)
}

async function until(ok: () => boolean | Promise<boolean>, ms = 20_000) {
  const end = Date.now() + ms
  while (!(await ok())) {
    if (Date.now() > end) throw new Error('timed out waiting')
    await new Promise((r) => setTimeout(r, 50))
  }
}

/** Hold the next pulls at the proxy until the returned function is called. */
function holdPulls(): () => void {
  let release!: () => void
  const held = new Promise<void>((r) => (release = r))
  proxy.hold = (_m, path) => (path.startsWith('/api/sync/changes') ? held : undefined)
  return () => {
    proxy.hold = undefined
    release()
  }
}

async function editName(h: Http, id: string, name: string) {
  const cur = (await h.json('GET', `/api/projects/${id}`)).body
  expect((await h.json('PUT', `/api/projects/${id}`, { project: { ...cur.project, name }, baseVersion: cur.version })).status).toBe(200)
}

const localIds = async () => ((await desk.json('GET', `/api/projects?workspaceId=${A.workspaceId}`)).body.items as Array<{ id: string }>).map((p) => p.id)

// two servers boot here (the cloud and the desktop), then a sign-up, a link and a first sync
beforeAll(async () => {
  cloud = await startCloud()
  proxy = await startProxy(cloud.url)
  d = await startDesktop()
  desk = d.desk
  await deskSession(desk)
  A = await cloud.signup('Rae')
  expect((await desk.json('POST', '/api/sync/link', { cloudUrl: proxy.url, email: A.email, password: PASSWORD })).status).toBe(200)
  await sync()
}, 2 * bootWaitMs() + 60_000)

afterAll(async () => {
  d?.stop()
  await proxy?.close()
  cloud?.proc.kill()
})

describe('a full resync after the cloud compacted its deletes (D-6)', () => {
  it('drops what the cloud no longer has, keeps what was edited here, and then syncs as usual', async () => {
    const gone = await cloudProject('Deleted in the cloud')
    const stays = await cloudProject('Still there')
    const edited = await cloudProject('Edited here, deleted there')
    const kit = (await A.http.json('POST', `/api/workspaces/${A.workspaceId}/brand-kits`, { name: 'Old kit' })).body.id as string
    await sync()
    expect(await localIds()).toEqual(expect.arrayContaining([gone, stays, edited]))
    expect((await desk.json('GET', `/api/workspaces/${A.workspaceId}/brand-kits`)).body.items.map((k: { id: string }) => k.id)).toContain(kit)

    // edited here while it goes in the cloud
    const cur = (await desk.json('GET', `/api/projects/${edited}`)).body
    expect((await desk.json('PUT', `/api/projects/${edited}`, { project: { ...cur.project, name: 'Edited here' }, baseVersion: cur.version })).status).toBe(200)
    await cloudDelete(gone)
    await cloudDelete(edited)
    expect((await A.http.json('DELETE', `/api/workspaces/${A.workspaceId}/brand-kits/${kit}`)).status).toBe(200)

    // the cloud has compacted those tombstones away: its feed no longer carries the deletes and says so
    proxy.rewrite = (path, body) => {
      if (!path.startsWith('/api/sync/changes')) return undefined
      const since = Number(new URL(path, 'http://x').searchParams.get('since'))
      return { ...body, deleted: { ...body.deleted, projects: [], assets: [], brandKits: [], brandFonts: [] }, ...(since > 0 ? { resync: true } : {}) }
    }
    const pulls = proxy.log.length
    await sync()
    proxy.rewrite = undefined
    // it started over from 0
    expect(proxy.log.slice(pulls).some((l) => l.startsWith('GET /api/sync/changes?since=0&'))).toBe(true)
    const ids = await localIds()
    expect(ids).not.toContain(gone)
    expect(ids).toContain(stays)
    // kept, and pushed again as a new cloud project
    expect(ids).toContain(edited)
    expect((await A.http.json('GET', `/api/projects/${edited}`)).body.summary.name).toBe('Edited here')
    expect((await desk.json('GET', `/api/workspaces/${A.workspaceId}/brand-kits`)).body.items.map((k: { id: string }) => k.id)).not.toContain(kit)

    // done: the next sync carries on from its cursor
    const next = proxy.log.length
    await sync()
    expect(proxy.log.slice(next).some((l) => l.startsWith('GET /api/sync/changes?since=0&'))).toBe(false)
  }, 120_000)
})

describe('a space’s other brand kits and fonts (carried from R3)', () => {
  it('made here go up with their ids; made or changed in the cloud come down, font files too; deletes both ways', async () => {
    const ws = A.workspaceId
    const font = await desk.req('POST', `/api/workspaces/${ws}/brand/fonts?family=Desk%20Serif&weight=400`, FONT)
    expect(font.status).toBe(200)
    const fontId = (await font.json()).id as string
    const base = (await desk.json('GET', `/api/workspaces/${ws}/brand-kits`)).body.items[0].doc
    const made = await desk.json('POST', `/api/workspaces/${ws}/brand-kits`, { doc: { ...base, name: 'Made offline', fonts: { headline: 'Desk Serif', body: base.fonts.body } } })
    expect(made.status).toBe(200)
    const kitId = made.body.id as string
    const s = await sync()
    expect(s.failures ?? []).toEqual([])

    const cloudKits = (await A.http.json('GET', `/api/workspaces/${ws}/brand-kits`)).body.items
    expect(cloudKits.find((k: { id: string }) => k.id === kitId)?.doc.name).toBe('Made offline')
    const cloudFonts = (await A.http.json('GET', `/api/workspaces/${ws}/brand/fonts`)).body
    expect(cloudFonts.map((f: { id: string; family: string }) => [f.id, f.family])).toContainEqual([fontId, 'Desk Serif'])

    // changed in the cloud, and a new font and kit there
    const cloudKit = cloudKits.find((k: { id: string }) => k.id === kitId)
    expect((await A.http.json('PUT', `/api/workspaces/${ws}/brand-kits/${kitId}`, { ...cloudKit.doc, name: 'Renamed in the cloud' })).status).toBe(200)
    const f2 = await A.http.req('POST', `/api/workspaces/${ws}/brand/fonts?family=Cloud%20Mono&weight=700`, Buffer.from([0x77, 0x4f, 0x46, 0x32, 1, 2, 3, 4, 5, 6]))
    const f2Id = (await f2.json()).id as string
    const k2 = (await A.http.json('POST', `/api/workspaces/${ws}/brand-kits`, { doc: { ...base, name: 'Cloud kit', fonts: { headline: 'Cloud Mono', body: base.fonts.body } } })).body.id as string
    await sync()
    const here = (await desk.json('GET', `/api/workspaces/${ws}/brand-kits`)).body.items
    expect(here.find((k: { id: string }) => k.id === kitId)?.doc.name).toBe('Renamed in the cloud')
    expect(here.find((k: { id: string }) => k.id === k2)?.doc.name).toBe('Cloud kit')
    const file = await desk.req('GET', `/api/workspaces/${ws}/brand/fonts/${f2Id}/file`)
    expect(file.status).toBe(200)
    expect(Buffer.from(await file.arrayBuffer())).toEqual(Buffer.from([0x77, 0x4f, 0x46, 0x32, 1, 2, 3, 4, 5, 6]))

    // deleted here: gone in the cloud
    expect((await desk.json('DELETE', `/api/workspaces/${ws}/brand-kits/${k2}`)).status).toBe(200)
    await sync()
    expect((await A.http.json('GET', `/api/workspaces/${ws}/brand-kits`)).body.items.map((k: { id: string }) => k.id)).not.toContain(k2)
    // deleted in the cloud: gone here
    expect((await A.http.json('DELETE', `/api/workspaces/${ws}/brand-kits/${kitId}`)).status).toBe(200)
    await sync()
    expect((await desk.json('GET', `/api/workspaces/${ws}/brand-kits`)).body.items.map((k: { id: string }) => k.id)).not.toContain(kitId)
    expect(((await desk.json<SyncStatus>('GET', '/api/sync/status')).body.failures ?? []).length).toBe(0)
  }, 120_000)
})

describe('one lock for link, unlink, conflicts and cycles (D-11)', () => {
  it('a conflict choice made while a cycle runs waits for that cycle', async () => {
    const id = await cloudProject('Both sides')
    await sync()
    await editName(desk, id, 'Named here')
    await editName(A.http, id, 'Named there')
    expect((await sync()).conflicts.map((c) => c.projectId)).toContain(id)

    const release = holdPulls()
    const cycle = desk.json('POST', '/api/sync/now')
    await until(() => d.engine.lock.holder === 'sync')
    let chosen = false
    const choice = desk.json('POST', `/api/projects/${id}/sync`, { mode: 'keep-cloud' }).then((r) => ((chosen = true), r))
    await until(() => d.engine.lock.waiting().includes('resolve'))
    await new Promise((r) => setTimeout(r, 400))
    expect(chosen).toBe(false)
    release()
    expect((await cycle).status).toBe(200)
    expect((await choice).status).toBe(200)
    expect((await desk.json('GET', `/api/projects/${id}`)).body.summary.name).toBe('Named there')
    expect((await desk.json<SyncStatus>('GET', '/api/sync/status')).body.conflicts.map((c) => c.projectId)).not.toContain(id)
  }, 60_000)

  it('unlinking stops the cycle under way instead of waiting for it, and records no failures', async () => {
    const release = holdPulls()
    const cycle = desk.json('POST', '/api/sync/now')
    await until(() => d.engine.lock.holder === 'sync')
    const t0 = Date.now()
    const un = await desk.json<SyncStatus>('POST', '/api/sync/unlink')
    expect(un.status).toBe(200)
    expect(un.body.linked).toBe(false)
    expect(Date.now() - t0).toBeLessThan(15_000)
    expect((await cycle).status).toBe(200)
    release()
    const st = (await desk.json<SyncStatus>('GET', '/api/sync/status')).body
    expect(st.state).toBe('unlinked')
    expect(st.failures ?? []).toEqual([])
    // linked again for what follows
    expect((await desk.json('POST', '/api/sync/link', { cloudUrl: proxy.url, email: A.email, password: PASSWORD })).status).toBe(200)
    expect((await sync()).state).toBe('idle')
  }, 60_000)
})

describe('sync again as soon as the network comes back (D-8)', () => {
  it('a cheap check while offline starts the sync when the cloud answers, not at the end of a long backoff', async () => {
    const engine = d.engine as unknown as { backoffMs: number; probeMs: number }
    engine.probeMs = 300
    // already backed off a long way: the next wait would be 5 minutes
    engine.backoffMs = 4 * 60_000
    proxy.down = true
    expect((await sync()).state).toBe('offline')
    const before = (await desk.json<SyncStatus>('GET', '/api/sync/status')).body.lastSyncAt ?? 0
    // a captive portal-ish wait: still down, the check keeps failing and nothing syncs
    await new Promise((r) => setTimeout(r, 900))
    expect((await desk.json<SyncStatus>('GET', '/api/sync/status')).body.state).toBe('offline')
    const id = await cloudProject('Made while this computer was offline')
    proxy.down = false
    const t0 = Date.now()
    await until(async () => (await desk.json<SyncStatus>('GET', '/api/sync/status')).body.state === 'idle' && (await localIds()).includes(id), 20_000)
    expect(Date.now() - t0).toBeLessThan(20_000)
    expect((await desk.json<SyncStatus>('GET', '/api/sync/status')).body.lastSyncAt).toBeGreaterThan(before)
    engine.probeMs = 5_000
  }, 60_000)

  it('the app telling it the connection is back does the same', async () => {
    proxy.down = true
    expect((await sync()).state).toBe('offline')
    proxy.down = false
    const r = await desk.json<SyncStatus>('POST', '/api/sync/online')
    expect(r.status).toBe(200)
    await until(async () => (await desk.json<SyncStatus>('GET', '/api/sync/status')).body.state === 'idle', 20_000)
  }, 60_000)
})

describe('uploads: projects before big media, a few at a time, in the background (D-7)', () => {
  const puts = (ids: string[]) => proxy.log.filter((l) => l.startsWith('PUT /api/uploads/') && ids.some((id) => l.includes(id)))
  const status = async () => (await desk.json<SyncStatus>('GET', '/api/sync/status')).body

  it('small clips, then projects, then big files three at a time; a sync meanwhile doesn’t wait for them', async () => {
    const engine = d.engine as unknown as { smallUploadBytes: number }
    engine.smallUploadBytes = 100_000
    const small = await deskUpload(png(100), 'small.png')
    const bigs: string[] = []
    for (let i = 0; i < 4; i++) bigs.push(await deskUpload(png(300_000), `big-${i}.png`))
    const proj = (await desk.json('POST', '/api/projects', { workspaceId: A.workspaceId, name: 'Uses big media' })).body.project.id as string
    let release!: () => void
    const held = new Promise<void>((r) => (release = r))
    proxy.hold = (m, path) => (m === 'PUT' && bigs.some((b) => path.includes(b)) ? held : undefined)
    const from = proxy.log.length
    // the cycle itself ends without waiting for the big files
    expect((await sync()).state).toBe('idle')
    await until(() => puts(bigs).length === 3)
    await new Promise((r) => setTimeout(r, 500))
    expect(puts(bigs)).toHaveLength(3)
    const log = proxy.log.slice(from)
    const at = (pred: (l: string) => boolean) => log.findIndex(pred)
    const smallPut = at((l) => l.startsWith(`PUT /api/uploads/${small}/data`))
    const projectPost = at((l) => l.startsWith('POST /api/projects') && !l.includes('/delete'))
    const firstBig = at((l) => l.startsWith('PUT /api/uploads/') && bigs.some((b) => l.includes(b)))
    expect(smallPut).toBeGreaterThanOrEqual(0)
    expect(projectPost).toBeGreaterThan(smallPut)
    expect(firstBig).toBeGreaterThan(projectPost)
    // the cloud already has the project, and lists the big clips as on their way
    expect((await A.http.json('GET', `/api/projects/${proj}`)).status).toBe(200)
    expect((await A.http.json('GET', `/api/assets/${bigs[3]}`)).body.status).toBe('uploading')
    // what's going up, with bytes
    const ups = (await status()).uploads ?? []
    expect(ups.map((u) => u.id).sort()).toEqual([...bigs].sort())
    expect(ups.filter((u) => u.startedAt > 0)).toHaveLength(3)
    for (const u of ups.filter((x) => x.startedAt > 0)) expect(u.sent).toBe(u.bytes)
    expect((await status()).pending).toBeGreaterThanOrEqual(4)
    // another sync while they go: it doesn't wait for them, nor send them twice
    expect((await sync()).state).toBe('idle')
    expect(puts(bigs)).toHaveLength(3)
    proxy.hold = undefined
    release()
    await until(async () => ((await status()).uploads ?? []).length === 0 && (await status()).pending === 0, 30_000)
    for (const b of bigs) expect(['processing', 'ready']).toContain((await A.http.json('GET', `/api/assets/${b}`)).body.status)
    expect(puts(bigs)).toHaveLength(4)
  }, 90_000)

  it('a drop during a big upload: offline, then that file goes up again once the cloud answers', async () => {
    const engine = d.engine as unknown as { probeMs: number }
    engine.probeMs = 300
    const big = await deskUpload(png(300_000), 'dropped.png')
    let release!: () => void
    const held = new Promise<void>((r) => (release = r))
    proxy.hold = (m, path) => (m === 'PUT' && path.includes(big) ? held : undefined)
    expect((await sync()).state).toBe('idle')
    await until(() => puts([big]).length === 1)
    // the network goes while its bytes are in flight
    proxy.down = true
    proxy.hold = undefined
    release()
    await until(async () => (await status()).state === 'offline')
    expect(((await status()).failures ?? []).map((f) => f.id)).not.toContain(big)
    proxy.down = false
    await until(async () => ['processing', 'ready'].includes((await A.http.json('GET', `/api/assets/${big}`)).body.status), 30_000)
    expect(puts([big]).length).toBeGreaterThanOrEqual(2)
    engine.probeMs = 5_000
  }, 90_000)
})

describe('the sync panel (D-1)', () => {
  const status = async () => (await desk.json<SyncStatus>('GET', '/api/sync/status')).body
  const items = async () => (await desk.json('GET', '/api/sync/items')).body as import('@producer/core').SyncItems

  it('lists what waits, what failed and why, with sizes; Skip keeps it here, Retry sends it', async () => {
    const engine = d.engine as unknown as { smallUploadBytes: number }
    engine.smallUploadBytes = 16 * 1024 * 1024
    const proj = (await desk.json('POST', '/api/projects', { workspaceId: A.workspaceId, name: 'Refused by the cloud' })).body.project.id as string
    proxy.fail = (m, path) => (m === 'POST' && path === '/api/projects' ? { status: 413, body: { error: 'This project is too large for the cloud', code: 'quota' } } : undefined)
    await sync()
    const listed = (await items()).items.find((i) => i.id === proj)
    expect(listed).toMatchObject({ kind: 'project', name: 'Refused by the cloud', state: 'failed', reason: 'This project is too large for the cloud' })
    // and a clip waiting, with its size
    const clip = await deskUpload(png(2_000), 'waiting.png')
    const waiting = (await items()).items.find((i) => i.id === clip)
    expect(waiting).toMatchObject({ kind: 'asset', state: 'waiting' })
    expect(waiting!.bytes).toBeGreaterThan(2_000)
    expect((await items()).uploadBytes).toBeGreaterThanOrEqual(waiting!.bytes!)

    expect((await desk.json('POST', `/api/sync/failures/project/${proj}`, { action: 'skip' })).status).toBe(200)
    expect((await items()).items.find((i) => i.id === proj)?.state).toBe('skipped')
    proxy.fail = undefined
    expect((await desk.json('POST', `/api/sync/failures/project/${proj}`, { action: 'retry' })).status).toBe(200)
    expect((await items()).items.find((i) => i.id === proj)).toBeUndefined()
    expect((await A.http.json('GET', `/api/projects/${proj}`)).status).toBe(200)
  }, 60_000)

  it('previews a conflict side by side, and says why sync is held up', async () => {
    const id = await cloudProject('Two versions')
    await sync()
    await editName(desk, id, 'Cut for the client')
    await editName(A.http, id, 'Cut for the web')
    const s = await sync()
    expect(s.conflicts.map((c) => c.projectId)).toContain(id)
    expect(s.blocked?.reason).toBe('conflict')
    const p = (await desk.json('GET', `/api/sync/conflicts/${id}`)).body as import('@producer/core').SyncConflictPreview
    expect(p.local.name).toBe('Cut for the client')
    expect(p.cloud?.name).toBe('Cut for the web')
    expect(p.changes).toContain('Named “Cut for the client” here and “Cut for the web” in the cloud')
    expect((await desk.json('GET', '/api/sync/conflicts/p_nope')).status).toBe(404)
    // offline says so, ahead of the conflict
    proxy.down = true
    expect((await sync()).blocked?.reason).toBe('offline')
    proxy.down = false
    await sync()
    expect((await desk.json('POST', `/api/projects/${id}/sync`, { mode: 'keep-cloud' })).status).toBe(200)
    // nothing holds it up now but the harness's own setting (automatic sync is off here)
    expect((await status()).blocked?.reason).toBe('paused')
  }, 60_000)
})

describe('comments and activity on a linked desktop (carried from R2)', () => {
  it('are the cloud’s: read and written there, live while open, and say so when offline', async () => {
    const { ctx } = await import('../context')
    const heard: Array<{ projectId: string; comment?: { body: string } }> = []
    const off = ctx().bus.onAny((e) => {
      if (e.event === 'comment' && e.workspaceId === A.workspaceId) heard.push(e.data as (typeof heard)[number])
    })
    const id = await cloudProject('Reviewed in the cloud')
    expect((await A.http.json('POST', `/api/projects/${id}/comments`, { body: 'From the web', at: 1 })).status).toBe(200)
    await sync()
    const list = await desk.json('GET', `/api/projects/${id}/comments`)
    expect(list.status).toBe(200)
    expect(list.body.map((c: { body: string }) => c.body)).toEqual(['From the web'])
    // made here: it's in the cloud
    const mine = await desk.json('POST', `/api/projects/${id}/comments`, { body: 'From the desktop', at: 2 })
    expect(mine.status).toBe(200)
    expect((await A.http.json('GET', `/api/projects/${id}/comments`)).body.map((c: { body: string }) => c.body)).toEqual(['From the web', 'From the desktop'])
    // resolved here: resolved there
    expect((await desk.json('PATCH', `/api/comments/${list.body[0].id}`, { resolved: true })).status).toBe(200)
    expect((await A.http.json('GET', `/api/projects/${id}/comments`)).body.find((c: { id: string }) => c.id === list.body[0].id).resolved?.at).toBeTruthy()
    // someone comments on the web while it's open here: this computer's screens hear of it
    await new Promise((r) => setTimeout(r, 1500))
    expect((await A.http.json('POST', `/api/projects/${id}/comments`, { body: 'Live from the web', at: 3 })).status).toBe(200)
    await until(() => heard.some((h) => h.comment?.body === 'Live from the web'), 20_000)
    // removed here: gone there, and screens here hear of it
    expect((await desk.json('DELETE', `/api/comments/${mine.body.id}`)).status).toBe(200)
    expect((await A.http.json('GET', `/api/projects/${id}/comments`)).body.map((c: { body: string }) => c.body)).not.toContain('From the desktop')
    // the space's activity is the cloud's
    const act = await desk.json('GET', `/api/workspaces/${A.workspaceId}/activity`)
    expect(act.status).toBe(200)
    expect(Array.isArray(act.body.items)).toBe(true)
    // offline: they say they need the connection
    proxy.down = true
    const gone = await desk.json('GET', `/api/projects/${id}/comments`)
    expect(gone.status).toBe(503)
    expect(gone.body.error).toMatch(/kept in the cloud/)
    proxy.down = false
    off()
  }, 90_000)
})

describe('available offline (D-9)', () => {
  async function cloudClip(name: string): Promise<string> {
    const bytes = png(1_000)
    const t = await A.http.json('POST', '/api/uploads', { workspaceId: A.workspaceId, filename: name, mime: 'image/png', size: bytes.length })
    expect((await A.http.req('PUT', t.body.url, bytes, { 'content-type': 'image/png' })).status).toBe(200)
    expect((await A.http.json('POST', `/api/assets/${t.body.assetId}/complete`)).status).toBe(200)
    await until(async () => (await A.http.json('GET', `/api/assets/${t.body.assetId}`)).body.status === 'ready', 30_000)
    return t.body.assetId
  }
  const off = async () => (await desk.json('GET', `/api/sync/offline?workspaceId=${A.workspaceId}`)).body as import('@producer/core').OfflineInfo

  it('a project kept offline gets every clip it uses, which then open with no connection; other clips stay in the cloud', async () => {
    const clip = await cloudClip('used.png')
    const other = await cloudClip('not-used.png')
    const proj = await cloudProject('Edit on the plane')
    const cur = (await A.http.json('GET', `/api/projects/${proj}`)).body
    const asset = (await A.http.json('GET', `/api/assets/${clip}`)).body.asset
    expect((await A.http.json('PUT', `/api/projects/${proj}`, { project: { ...cur.project, assets: { [clip]: asset } }, baseVersion: cur.version })).status).toBe(200)
    await sync()
    expect((await off()).cloudOnly).toEqual(expect.arrayContaining([clip, other]))
    expect((await off()).projects[proj]).toBeUndefined()

    const pin = await desk.json('PUT', `/api/sync/offline/${proj}`, { pinned: true })
    expect(pin.status).toBe(200)
    expect(pin.body.projects[proj].pinned).toBe(true)
    await until(async () => (await off()).projects[proj]?.missing === 0, 30_000)
    const now = await off()
    expect(now.cloudOnly).not.toContain(clip)
    expect(now.cloudOnly).toContain(other)
    // no connection: its file is on this computer
    proxy.down = true
    expect((await desk.req('GET', `/api/media/${clip}/source`)).status).toBe(200)
    proxy.down = false
    // stopped: no longer listed, what was downloaded stays
    expect((await desk.json('PUT', `/api/sync/offline/${proj}`, { pinned: false })).body.projects[proj]).toBeUndefined()
    expect((await off()).cloudOnly).not.toContain(clip)
    expect((await desk.json('PUT', '/api/sync/offline/p_nope', { pinned: true })).status).toBe(404)
  }, 120_000)
})

describe('the first-link preview (D-5)', () => {
  it('shows what would be merged and uploaded, changes nothing until confirmed, and links as chosen', async () => {
    expect((await desk.json('POST', '/api/sync/unlink')).status).toBe(200)
    // made while unlinked: a space of its own, with a project and a clip
    const ws = (await desk.json('POST', '/api/workspaces', { name: 'Offline work' })).body.id as string
    const proj = (await desk.json('POST', '/api/projects', { workspaceId: ws, name: 'Made offline' })).body.project.id as string
    const t = await desk.json('POST', '/api/uploads', { workspaceId: ws, filename: 'offline.png', mime: 'image/png', size: PNG.length + 5_000 })
    const bytes = png(5_000)
    expect((await desk.json('PUT', t.body.url, bytes, { 'content-type': 'image/png' })).status).toBe(200)
    expect((await desk.json('POST', `/api/assets/${t.body.assetId}/complete`)).status).toBe(200)

    const B = await cloud.signup('Bo')
    const ask = () => desk.json<import('@producer/core').LinkPreview>('POST', '/api/sync/link/preview', { cloudUrl: proxy.url, email: B.email, password: PASSWORD })
    const first = await ask()
    expect(first.status).toBe(200)
    const p = first.body
    expect(p.account).toBe(B.email)
    expect(p.cloudSpaces.map((w) => w.id)).toEqual([B.workspaceId])
    // the account linked before keeps its spaces here, set aside
    expect(p.setAside?.account).toBe(A.email)
    const mine = p.spaces.find((s) => s.id === ws)!
    expect(mine).toMatchObject({ name: 'Offline work', projects: 1, clips: 1, suggested: { action: 'new' } })
    expect(mine.uploadBytes).toBe(bytes.length)
    expect(p.spaces.map((s) => s.id)).toEqual([ws])
    // nothing changed: still unlinked, nothing new in the cloud
    expect((await desk.json<SyncStatus>('GET', '/api/sync/status')).body.linked).toBe(false)
    expect((await B.http.json('GET', '/api/workspaces')).body).toHaveLength(1)
    expect((await B.http.json('GET', '/api/devices')).body).toHaveLength(1)

    // cancelled: its device link goes
    expect((await desk.json('POST', '/api/sync/link/cancel', { previewId: p.previewId })).body).toEqual({ ok: true })
    expect((await B.http.json('GET', '/api/devices')).body).toHaveLength(0)
    expect((await desk.json('POST', '/api/sync/link', { previewId: p.previewId, choices: {} })).status).toBe(410)

    // again, merging the space into Bo's own instead of creating one
    const again = (await ask()).body
    expect((await desk.json('POST', '/api/sync/link', { previewId: again.previewId, choices: { [ws]: { action: 'merge', into: 'w_not_mine' } } })).status).toBe(400)
    const linked = await desk.json<SyncStatus>('POST', '/api/sync/link', { previewId: again.previewId, choices: { [ws]: { action: 'merge', into: B.workspaceId } } })
    expect(linked.status).toBe(200)
    expect(linked.body.account).toBe(B.email)
    await sync()
    await until(async () => (await B.http.json('GET', `/api/projects/${proj}`)).status === 200)
    expect((await B.http.json('GET', `/api/projects/${proj}`)).body.summary.workspaceId).toBe(B.workspaceId)
    expect((await B.http.json('GET', '/api/workspaces')).body).toHaveLength(1)
    await until(async () => ['processing', 'ready'].includes((await B.http.json('GET', `/api/assets/${t.body.assetId}`)).body.status))
  }, 120_000)
})

export type { Project }
