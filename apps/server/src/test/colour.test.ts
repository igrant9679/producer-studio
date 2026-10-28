// A graded project with an adjustment layer saves, and its export composition carries the grade and the LUT (E-20).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { addAdjustmentLayer, addItem, addLut, createShapeItem, parseCube, updateItem, type AdjustmentItem, type Project } from '@producer/core'
import { prepareRenderDir } from '../render/export'
import { type Client, setup, signup } from './helpers'

let client: Client
let workspaceId: string

beforeAll(async () => {
  const t = await setup()
  const u = await signup(t.app)
  client = u.client
  workspaceId = u.workspaceId
})

describe('colour grading (E-20)', () => {
  it('saves a project with a LUT and an adjustment layer, and the export page carries both', async () => {
    const r = await client.json('POST', '/api/projects', { workspaceId, name: 'Graded', width: 640, height: 360 })
    expect(r.status).toBe(200)
    let p = r.body.project as Project
    p = addItem(p, createShapeItem(0, { duration: 3 }))
    const { lut } = parseCube(['LUT_3D_SIZE 2', '0 0 0', '1 0 0', '0 1 0', '1 1 0', '0 0 1', '1 0 1', '0 1 1', '1 1 1'].join('\n'))
    const l = addLut(p, 'Identity', lut)
    const a = addAdjustmentLayer(l.project, 0, 3)
    p = updateItem<AdjustmentItem>(a.project, a.id, { grade: { lut: { id: l.id, intensity: 80 }, curves: { master: [[0, 0.1], [1, 0.9]] } } })
    const saved = await client.json('PUT', `/api/projects/${p.id}`, { project: p, baseVersion: r.body.version })
    expect(saved.status).toBe(200)
    const back = (await client.json('GET', `/api/projects/${p.id}`)).body.project as Project
    expect(back.luts![l.id].data).toBe(p.luts![l.id].data)
    expect(back.tracks.flatMap((t) => t.items).find((i) => i.id === a.id)?.type).toBe('adjustment')

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-grade-'))
    const prep = await prepareRenderDir(back, workspaceId, dir)
    const html = fs.readFileSync(prep.index, 'utf8')
    expect(html).toContain(`data-ps-layer="${a.id}"`)
    expect(html).toContain(p.luts![l.id].data)
    // the bundled renderer has the grade shader and the HyperFrames frame hook
    const runtime = fs.readFileSync(path.join(dir, 'runtime.js'), 'utf8')
    expect(runtime).toContain('u_lutN')
    expect(runtime).toContain('__render_frame__')
  })
})
