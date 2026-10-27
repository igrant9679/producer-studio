// Saving and live updates around a project: renames racing autosaves, and the events other screens rely on.
import { beforeAll, describe, expect, it } from 'vitest'
import { ctx } from '../context'
import { setup, signup, type TestEnv } from './helpers'

let t: TestEnv
beforeAll(async () => {
  t = await setup()
})

/** Let `n` microtasks run, so a second request starts part-way through the first. */
async function ticks(n: number) {
  for (let i = 0; i < n; i++) await Promise.resolve()
}

/** Versions announced in `project` live updates for one project. */
function projectVersions(workspaceId: string, id: string): { versions: number[]; off: () => void } {
  const versions: number[] = []
  const off = ctx().bus.subscribe(workspaceId, (e) => {
    const d = e.data as { id: string; version: number }
    if (e.event === 'project' && d.id === id) versions.push(d.version)
  })
  return { versions, off }
}

describe('rename and autosave at the same moment', () => {
  it('keeps both the saved edit and the new name, with distinct versions, at every interleaving', async () => {
    const { client, workspaceId } = await signup(t.app)
    // 0-300 microtasks covers the rename landing before, inside and after the save (the window is ~40-120)
    for (let offset = 0; offset <= 300; offset += 5) {
      const created = await client.json('POST', '/api/projects', { workspaceId, name: 'Race' })
      const { project, version } = created.body
      const seen = projectVersions(workspaceId, project.id)
      const save = client.json('PUT', `/api/projects/${project.id}`, { project: { ...project, background: '#123456' }, baseVersion: version })
      await ticks(offset)
      const rename = client.json('PATCH', `/api/projects/${project.id}`, { name: `Renamed ${offset}` })
      const [s, r] = await Promise.all([save, rename])
      seen.off()
      expect(r.status).toBe(200)
      const got = (await client.json('GET', `/api/projects/${project.id}`)).body
      // the rename always lands, in the document and the summary
      expect(got.project.name).toBe(`Renamed ${offset}`)
      expect(got.summary.name).toBe(`Renamed ${offset}`)
      // every change announces its own version: two writes never claim the same one
      expect(new Set(seen.versions).size).toBe(seen.versions.length)
      expect(got.version).toBe(Math.max(...seen.versions))
      if (s.status === 200) {
        // a save that was told it succeeded is never wiped
        expect(got.project.background).toBe('#123456')
        expect(seen.versions).toHaveLength(2)
      } else {
        // the rename won the race: the save is refused as a conflict, never applied over it
        expect(s.status).toBe(409)
        expect(seen.versions).toHaveLength(1)
      }
    }
  })

  it('a rename bumps the version once and leaves the rest of the document alone', async () => {
    const { client, workspaceId } = await signup(t.app)
    const { body } = await client.json('POST', '/api/projects', { workspaceId, name: 'Before' })
    const saved = await client.json('PUT', `/api/projects/${body.project.id}`, { project: { ...body.project, background: '#abcdef' }, baseVersion: 1 })
    expect(saved.body.version).toBe(2)
    const r = await client.json('PATCH', `/api/projects/${body.project.id}`, { name: '  After  ' })
    expect(r.body).toMatchObject({ name: 'After', version: 3 })
    const got = (await client.json('GET', `/api/projects/${body.project.id}`)).body
    expect(got.version).toBe(3)
    expect(got.project).toMatchObject({ name: 'After', background: '#abcdef' })
  })
})

describe('live updates for every change other screens show', () => {
  it('trash, restore, template, copy and delete each announce the project', async () => {
    const { client, workspaceId } = await signup(t.app)
    const { body } = await client.json('POST', '/api/projects', { workspaceId, name: 'Live' })
    const id = body.project.id
    const seen: unknown[] = []
    const off = ctx().bus.subscribe(workspaceId, (e) => e.event === 'project' && seen.push(e.data))
    await client.json('PATCH', `/api/projects/${id}`, { isTemplate: true })
    await client.json('PATCH', `/api/projects/${id}`, { trashed: true })
    await client.json('PATCH', `/api/projects/${id}`, { trashed: false })
    const copy = await client.json('POST', `/api/projects/${id}/duplicate`)
    await client.json('PATCH', `/api/projects/${id}`, { trashed: true })
    expect((await client.json('DELETE', `/api/projects/${id}`)).status).toBe(200)
    off()
    expect(seen).toEqual([
      { id, version: 1 },
      { id, version: 1 },
      { id, version: 1 },
      { id: copy.body.id, version: 1 },
      { id, version: 1 },
      { id, version: 1, deleted: true },
    ])
  })

  it('a brand kit save announces itself to the space', async () => {
    const { client, workspaceId } = await signup(t.app)
    const seen: Array<{ event: string; data: unknown }> = []
    const off = ctx().bus.subscribe(workspaceId, (e) => seen.push({ event: e.event, data: e.data }))
    const kit = { name: 'Acme', colors: ['#112233'], fonts: { headline: 'Inter', body: 'Inter' } }
    expect((await client.json('PUT', `/api/workspaces/${workspaceId}/brand`, kit)).status).toBe(200)
    off()
    expect(seen).toEqual([{ event: 'workspace', data: { id: workspaceId, deleted: false, brand: true } }])
  })
})
