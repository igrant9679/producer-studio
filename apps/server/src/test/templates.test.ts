// Templates (A-22): a built-in look's starter document for the viewer's live preview, in any aspect and brand kit;
// a team template made from a look and a brand kit; a project started from a look in another aspect and kit.
import { beforeAll, describe, expect, it } from 'vitest'
import type { BrandKitSummary, Project, ProjectDocResponse, TemplateSummary } from '@producer/core'
import { setup, signup, type TestEnv } from './helpers'

let t: TestEnv
beforeAll(async () => {
  t = await setup()
})

const RETAIL = { name: 'Retail', colors: ['#112233', '#ffcc00', '#fefefe'], fonts: { headline: 'Oswald', body: 'Inter' } }

async function space() {
  const A = await signup(t.app, 'Owner')
  const kit = (await A.client.json<BrandKitSummary>('POST', `/api/workspaces/${A.workspaceId}/brand-kits`, { doc: RETAIL })).body
  return { A, ws: A.workspaceId, kit }
}

describe('templates', () => {
  it('serves a built-in look as a document to preview, in the aspect and brand kit asked for', async () => {
    const { A, ws, kit } = await space()
    const plain = await A.client.json<Project>('GET', '/api/templates/tpl:studio-dark/doc')
    expect(plain.status).toBe(200)
    expect(plain.body).toMatchObject({ width: 1920, height: 1080 })
    const vertical = (await A.client.json<Project>('GET', `/api/templates/tpl:studio-dark/doc?aspect=9:16&workspaceId=${ws}&kitId=${kit.id}`)).body
    expect(vertical).toMatchObject({ width: 1080, height: 1920, background: '#112233' })
    expect(vertical.tracks.flatMap((tr) => tr.items).some((i) => i.type === 'text' && i.style.fontFamily === 'Oswald')).toBe(true)
    expect((await A.client.json('GET', '/api/templates/tpl:nope/doc')).status).toBe(404)
    expect((await A.client.json('GET', `/api/templates/tpl:studio-dark/doc?workspaceId=${ws}&kitId=bk_missing`)).status).toBe(404)
    // another space's kit: not readable
    const B = await signup(t.app, 'Stranger')
    expect((await B.client.json('GET', `/api/templates/tpl:studio-dark/doc?workspaceId=${ws}`)).status).toBe(404)
  })

  it('makes a team template from a look and a brand kit, listed with the space’s templates', async () => {
    const { A, ws, kit } = await space()
    const r = await A.client.json<TemplateSummary>('POST', '/api/templates/from-brand', { workspaceId: ws, lookId: 'social-vertical', kitId: kit.id })
    expect(r.status).toBe(200)
    expect(r.body).toMatchObject({ name: 'Retail · Social Vertical', builtIn: false, aspect: '9:16', category: 'My templates' })
    const list = (await A.client.json<{ items: TemplateSummary[] }>('GET', `/api/templates?workspaceId=${ws}`)).body.items
    expect(list.filter((x) => !x.builtIn).map((x) => x.id)).toEqual([r.body.id])
    // starting from it gives the kit's look
    const p = (await A.client.json<ProjectDocResponse>('POST', '/api/projects', { workspaceId: ws, templateId: r.body.id })).body.project
    expect(p.background).toBe('#112233')
    expect((await A.client.json('POST', '/api/templates/from-brand', { workspaceId: ws, lookId: 'nope' })).status).toBe(404)
  })

  it('starts a project from a look in another aspect, with the brand kit picked', async () => {
    const { A, ws, kit } = await space()
    const r = await A.client.json<ProjectDocResponse>('POST', '/api/projects', { workspaceId: ws, templateId: 'tpl:studio-dark', aspect: '1:1', brandKitId: kit.id })
    expect(r.status).toBe(200)
    expect(r.body.project).toMatchObject({ width: 1080, height: 1080, background: '#112233' })
    // no kit named: the space's default
    const d = (await A.client.json<ProjectDocResponse>('POST', '/api/projects', { workspaceId: ws, templateId: 'tpl:studio-dark' })).body.project
    expect(d.background).not.toBe('#112233')
  })
})
