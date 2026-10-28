// Speaker labels (E-11): taken from whisper.cpp where it gives them, saved on the clip's transcript by editors
// (PATCH /api/assets/:id), and counted in the light record's transcriptRev so open editors fetch the new labels.
import { beforeAll, describe, expect, it } from 'vitest'
import { transcriptRev, type AssetRecord, type Transcript } from '@producer/core'
import { mapWhisperJson } from '../ai/whisper'
import { setup, signup, type TestEnv } from './helpers'

let t: TestEnv
beforeAll(async () => {
  t = await setup()
})

const seg = (text: string, from: number, to: number, extra: Record<string, unknown> = {}) => ({ text: ` ${text}`, offsets: { from, to }, tokens: [{ text: ` ${text}`, offsets: { from, to } }], ...extra })

describe('speakers from whisper.cpp', () => {
  it('a speaker per channel (-di): "0" and "1" are Speaker 1 and 2, "?" is nobody', () => {
    const tr = mapWhisperJson({ transcription: [seg('Hi', 0, 500, { speaker: '0' }), seg('Hello', 600, 900, { speaker: '1' }), seg('Both', 1000, 1200, { speaker: '?' })] }, 'en')
    expect(tr.segments.map((s) => s.speaker)).toEqual(['Speaker 1', 'Speaker 2', undefined])
  })

  it('speaker turns (-tdrz) alternate two speakers; nothing marked, no labels', () => {
    const tr = mapWhisperJson({ transcription: [seg('Question', 0, 500, { speaker_turn_next: true }), seg('Answer', 600, 900), seg('More', 1000, 1200, { speaker_turn_next: true }), seg('Next', 1300, 1500)] }, 'en')
    expect(tr.segments.map((s) => s.speaker)).toEqual(['Speaker 1', 'Speaker 2', 'Speaker 2', 'Speaker 1'])
    const plain = mapWhisperJson({ transcription: [seg('Hi', 0, 500), seg('There', 600, 900)] }, 'en')
    expect(plain.segments.every((s) => !('speaker' in s))).toBe(true)
  })

  it('a renamed speaker is a different transcript to a light record; no speakers keeps the old rev', () => {
    const base: Transcript = { language: 'en', engine: 'test', segments: [{ start: 0, end: 1, text: 'hi', words: [{ w: 'hi', start: 0, end: 0.5 }] }] }
    const a = { ...base, segments: [{ ...base.segments[0], speaker: 'Alex' }] }
    const b = { ...base, segments: [{ ...base.segments[0], speaker: 'Sam' }] }
    expect(transcriptRev(base)).toBe('en:test:1:1:1')
    expect(transcriptRev(a)).not.toBe(transcriptRev(b))
    expect(transcriptRev(a)).not.toBe(transcriptRev(base))
  })
})

describe('saving speaker labels', () => {
  it('an editor saves them on the clip; a viewer cannot', async () => {
    const A = await signup(t.app, 'Owner')
    const ws = (await A.client.json('POST', '/api/workspaces', { name: 'Team' })).body as { id: string }
    const ticket = await A.client.json('POST', '/api/uploads', { workspaceId: ws.id, filename: 'talk.mp4', mime: 'video/mp4', size: 16 })
    expect(ticket.status).toBe(200)
    const id = ticket.body.assetId as string
    const transcript: Transcript = {
      language: 'en',
      engine: 'whisper.cpp',
      segments: [
        { start: 0, end: 1, text: 'hello there', words: [{ w: 'hello', start: 0, end: 0.4 }, { w: 'there', start: 0.5, end: 1 }], speaker: 'Alex' },
        { start: 1, end: 2, text: 'hi', words: [{ w: 'hi', start: 1.1, end: 1.4 }], speaker: 'Sam' },
      ],
    }
    const saved = await A.client.json<AssetRecord>('PATCH', `/api/assets/${id}`, { transcript })
    expect(saved.status).toBe(200)
    expect((await A.client.json<AssetRecord>('GET', `/api/assets/${id}`)).body.asset.transcript?.segments.map((s) => s.speaker)).toEqual(['Alex', 'Sam'])

    const V = await signup(t.app, 'Viewer')
    const inv = await A.client.json('POST', `/api/workspaces/${ws.id}/invites`, { email: V.email, role: 'viewer' })
    await V.client.json('POST', `/api/invites/${inv.body.inviteUrl.split('/invite/')[1]}/accept`)
    const renamed = { ...transcript, segments: transcript.segments.map((s) => ({ ...s, speaker: 'Someone' })) }
    expect((await V.client.json('PATCH', `/api/assets/${id}`, { transcript: renamed })).status).toBe(403)
    expect((await V.client.json<AssetRecord>('GET', `/api/assets/${id}`)).body.asset.transcript?.segments[0].speaker).toBe('Alex')
  })
})
