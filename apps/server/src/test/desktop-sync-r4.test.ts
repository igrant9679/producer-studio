// Desktop sync, release 4 (R4-C): a full resync after the cloud compacted its deletes (D-6), a space's other brand
// kits and fonts (carried from R3). Same harness as desktop-sync.test.ts (a real cloud in a child process, this process
// as the desktop), with a proxy in between that can drop the network or rewrite the cloud's answers.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Project, SyncStatus } from '@producer/core'
import { type Cloud, type Desktop, type Http, PASSWORD, deskSession, startCloud, startDesktop } from './desktop-harness'
import { type CloudProxy, startProxy } from './cloud-proxy'

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

const localIds = async () => ((await desk.json('GET', `/api/projects?workspaceId=${A.workspaceId}`)).body.items as Array<{ id: string }>).map((p) => p.id)

beforeAll(async () => {
  cloud = await startCloud()
  proxy = await startProxy(cloud.url)
  d = await startDesktop()
  desk = d.desk
  await deskSession(desk)
  A = await cloud.signup('Rae')
  expect((await desk.json('POST', '/api/sync/link', { cloudUrl: proxy.url, email: A.email, password: PASSWORD })).status).toBe(200)
  await sync()
}, 180_000)

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

export type { Project }
