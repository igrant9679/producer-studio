// The editor's Media panel shows This project and the Library (tracker #17/#18): an upload made in a project says so,
// and a clip can be taken out of its project (the library keeps it) — only into a project of its own space.
import { beforeAll, describe, expect, it } from 'vitest'
import type { ProjectDocResponse } from '@producer/core'
import { type Client, setup, signup } from './helpers'

let A: { client: Client; workspaceId: string }
let B: { client: Client; workspaceId: string }

beforeAll(async () => {
  const t = await setup()
  A = await signup(t.app, 'Scope A')
  B = await signup(t.app, 'Scope B')
}, 120_000)

const project = async (c: Client, workspaceId: string) => (await c.json<ProjectDocResponse>('POST', '/api/projects', { workspaceId, name: 'Cut', width: 1920, height: 1080 })).body.project.id

describe('which project a clip belongs to', () => {
  it('an upload made in a project says so; the record carries it; it can be taken out and put back', async () => {
    const p = await project(A.client, A.workspaceId)
    const ticket = (await A.client.json('POST', '/api/uploads', { workspaceId: A.workspaceId, projectId: p, filename: 'cut.mp4', mime: 'video/mp4', size: 4 })).body
    const rec = (await A.client.json('GET', `/api/assets/${ticket.assetId}`)).body
    expect(rec.projectId).toBe(p)
    const out = await A.client.json('PATCH', `/api/assets/${ticket.assetId}`, { projectId: null })
    expect(out.status).toBe(200)
    expect(out.body.projectId).toBeUndefined()
    const back = await A.client.json('PATCH', `/api/assets/${ticket.assetId}`, { projectId: p })
    expect(back.body.projectId).toBe(p)
    // a library upload has none
    const lib = (await A.client.json('POST', '/api/uploads', { workspaceId: A.workspaceId, filename: 'b-roll.mp4', mime: 'video/mp4', size: 4 })).body
    expect((await A.client.json('GET', `/api/assets/${lib.assetId}`)).body.projectId).toBeUndefined()
  })

  it('never into another space’s project, and only by its own space’s editors', async () => {
    const theirs = await project(B.client, B.workspaceId)
    const ticket = (await A.client.json('POST', '/api/uploads', { workspaceId: A.workspaceId, filename: 'x.mp4', mime: 'video/mp4', size: 4 })).body
    expect((await A.client.json('PATCH', `/api/assets/${ticket.assetId}`, { projectId: theirs })).status).toBeGreaterThanOrEqual(400)
    expect((await B.client.json('PATCH', `/api/assets/${ticket.assetId}`, { projectId: null })).status).toBeGreaterThanOrEqual(400)
  })
})
