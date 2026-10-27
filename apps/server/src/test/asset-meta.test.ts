// Clip metadata is merged in SQL: processing never writes back a snapshot over a transcript saved meanwhile, and two
// writers at once both keep their keys. (PIP-20)
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import type { Transcript } from '@producer/core'
import { inlineContext } from '../jobs/worker'
import { ffmpeg } from '../media/proc'
import { processAsset } from '../media/process'
import { createAssetFromFile, loadAsset, mergeAssetMeta } from '../services/assets'
import { setup, signup } from './helpers'

let workspaceId = ''
let userId = ''
let clip = ''
const transcript: Transcript = { language: 'en', engine: 'whisper', segments: [{ start: 0, end: 1.2, text: 'Hello there', words: [{ w: 'Hello', start: 0, end: 0.5 }, { w: 'there', start: 0.6, end: 1.1 }] }] }

beforeAll(async () => {
  const t = await setup()
  const u = await signup(t.app)
  workspaceId = u.workspaceId
  userId = (await u.client.json('GET', '/api/auth/me')).body.user.id
  clip = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ps-meta-')), 'talk.mp4')
  await ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=30', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '2', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', clip])
})

const upload = () => createAssetFromFile({ workspaceId, userId, filePath: clip, name: 'talk.mp4', mime: 'video/mp4', kind: 'video', origin: 'upload' })

describe('clip metadata', () => {
  it('a transcript saved while processing is mid-way survives, and so does everything processing found', async () => {
    const created = await upload()
    let saving: Promise<unknown> | undefined
    const jc = inlineContext({ id: 'meta-test', kind: 'asset.process', workspaceId, userId, projectId: null, input: {} })
    // transcription finishes while processing is still building the filmstrip
    await processAsset(created.id, { ...jc, progress: (_p, m) => void (m === 'Filmstrip' && !saving && (saving = mergeAssetMeta(created.id, { transcript }))) })
    expect(saving).toBeDefined()
    await saving
    const row = await loadAsset(created.id)
    expect(row.status).toBe('ready')
    expect(row.meta.transcript).toEqual(transcript)
    expect(row.meta.duration).toBeGreaterThan(1.5)
    expect(row.meta.filmstrip?.frames).toBe(10)
    expect(row.meta.waveform?.length).toBeGreaterThan(50)
  })

  it('two writers at once both keep their keys', async () => {
    const created = await upload()
    const silences = [{ start: 0.5, end: 0.9 }]
    await Promise.all([mergeAssetMeta(created.id, { transcript }), mergeAssetMeta(created.id, { silences }), mergeAssetMeta(created.id, { codec: 'h264' })])
    const row = await loadAsset(created.id)
    expect(row.meta).toMatchObject({ transcript, silences, codec: 'h264' })
  })
})
