// First-run onboarding (A-6): a new space starts with a sample project; the Home checklist ticks itself from what the
// space really holds (an upload, a saved brand kit, an assembled Producer video, a teammate or a pending invite) and
// each person can hide it in a space.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import type { OnboardingState, ProjectSummary } from '@producer/core'
import { ctx } from '../context'
import { projects } from '../db/schema'
import { ffmpeg } from '../media/proc'
import { createAssetFromFile } from '../services/assets'
import { setup, signup, type TestEnv } from './helpers'

let t: TestEnv
const was = process.env.SAMPLE_PROJECT
beforeAll(async () => {
  t = await setup()
  process.env.SAMPLE_PROJECT = '1'
})
afterAll(() => {
  process.env.SAMPLE_PROJECT = was ?? '0'
})

describe('onboarding', () => {
  it('a new space (the personal one at sign-up too) has a sample project, named in its checklist', async () => {
    const A = await signup(t.app, 'New Person')
    const list = (await A.client.json<ProjectSummary[]>('GET', `/api/projects?workspaceId=${A.workspaceId}`)).body as unknown as { items?: ProjectSummary[] } | ProjectSummary[]
    const items = Array.isArray(list) ? list : list.items ?? []
    expect(items.map((p) => p.name)).toEqual(['Sample project'])
    const s = (await A.client.json<OnboardingState>('GET', `/api/workspaces/${A.workspaceId}/onboarding`)).body
    expect(s).toMatchObject({ steps: { upload: false, brand: false, producer: false, invite: false }, dismissed: false, sampleProjectId: items[0].id })
    const team = (await A.client.json('POST', '/api/workspaces', { name: 'Team' })).body as { id: string }
    expect((await A.client.json<OnboardingState>('GET', `/api/workspaces/${team.id}/onboarding`)).body.sampleProjectId).toBeTruthy()
    // binned: no longer offered
    await ctx().db.update(projects).set({ trashedAt: Date.now() }).where(eq(projects.id, items[0].id))
    expect((await A.client.json<OnboardingState>('GET', `/api/workspaces/${A.workspaceId}/onboarding`)).body.sampleProjectId).toBeUndefined()
  })

  it('ticks each step from the space’s real state', async () => {
    const A = await signup(t.app, 'Owner')
    const team = (await A.client.json('POST', '/api/workspaces', { name: 'Studio' })).body as { id: string }
    const userId = (await A.client.json('GET', '/api/auth/me')).body.user.id as string
    const state = async () => (await A.client.json<OnboardingState>('GET', `/api/workspaces/${team.id}/onboarding`)).body.steps

    const clip = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ps-onb-')), 'rec.png')
    await ffmpeg(['-f', 'lavfi', '-i', 'color=c=red:s=16x16', '-frames:v', '1', clip])
    await createAssetFromFile({ workspaceId: team.id, userId, filePath: clip, name: 'rec.png', mime: 'image/png', kind: 'image', origin: 'upload' })
    expect(await state()).toMatchObject({ upload: true, brand: false })

    await A.client.json('PUT', `/api/workspaces/${team.id}/brand`, { name: 'Studio', colors: ['#111111'], fonts: { headline: 'Inter', body: 'Inter' } })
    expect((await state()).brand).toBe(true)

    // a Producer project counts once it is assembled
    const p = (await A.client.json('POST', '/api/projects', { workspaceId: team.id, name: 'Tour', kind: 'producer' })).body.project
    expect((await state()).producer).toBe(false)
    await ctx().db.update(projects).set({ doc: { ...p, ai: { status: 'assembled' } } }).where(eq(projects.id, p.id))
    expect((await state()).producer).toBe(true)

    // an invite out counts, before anyone accepts it
    await A.client.json('POST', `/api/workspaces/${team.id}/invites`, { email: 'kim@example.com', role: 'editor' })
    expect((await state()).invite).toBe(true)
  })

  it('each person hides their own checklist, per space; a viewer can too', async () => {
    const A = await signup(t.app, 'Owner')
    const B = await signup(t.app, 'Viewer')
    const team = (await A.client.json('POST', '/api/workspaces', { name: 'Shared' })).body as { id: string }
    const inv = await A.client.json('POST', `/api/workspaces/${team.id}/invites`, { email: B.email, role: 'viewer' })
    await B.client.json('POST', `/api/invites/${inv.body.inviteUrl.split('/invite/')[1]}/accept`)
    const hid = await B.client.json<OnboardingState>('PUT', `/api/workspaces/${team.id}/onboarding`, { dismissed: true })
    expect(hid.status).toBe(200)
    expect(hid.body.dismissed).toBe(true)
    expect((await A.client.json<OnboardingState>('GET', `/api/workspaces/${team.id}/onboarding`)).body).toMatchObject({ dismissed: false, steps: { invite: true } })
    expect((await B.client.json<OnboardingState>('GET', `/api/workspaces/${B.workspaceId}/onboarding`)).body.dismissed).toBe(false)
    expect((await B.client.json('PUT', `/api/workspaces/${team.id}/onboarding`, { dismissed: 'yes' })).status).toBe(400)
    const C = await signup(t.app, 'Stranger')
    expect((await C.client.json('GET', `/api/workspaces/${team.id}/onboarding`)).status).toBe(404)
  })
})
