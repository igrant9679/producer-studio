// The music library (19 Nov 2026): MUSIC_LIBRARY's tracks, composed once and kept, heard before they are used, added to
// a space as an audio clip once; and the sound effects the brief lets people hear. A quick stand-in composer (a few
// seconds of tone through ffmpeg) replaces the real one, which takes tens of seconds a track.
import fs from 'node:fs'
import { MUSIC_LIBRARY, MUSIC_STYLES, libraryCuts, libraryTrackFor, sfxKitFor, SFX_PREVIEW_ROLES } from '@producer/core'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ffmpeg } from '../media/proc'
import { LIBRARY, libraryFile } from '../routes/music'
import { setup, signup, type TestEnv } from './helpers'

let t: TestEnv
const real = LIBRARY.compose
const composed: string[] = []
beforeAll(async () => {
  t = await setup()
  LIBRARY.compose = async (o) => {
    composed.push(o.seed)
    await new Promise((r) => setTimeout(r, 150))
    await ffmpeg(['-y', '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3', '-c:a', 'aac', '-b:a', '96k', o.out])
    return { about: `${o.style} test`, lufs: -18 }
  }
}, 120_000)
afterAll(() => {
  LIBRARY.compose = real
})

describe('the music library', () => {
  it('has 20 tracks, every style among them, each in sections the composer develops', () => {
    expect(MUSIC_LIBRARY.length).toBe(20)
    expect(new Set(MUSIC_LIBRARY.map((x) => x.id)).size).toBe(20)
    for (const m of MUSIC_STYLES) expect(libraryTrackFor(m.id)?.style).toBe(m.id)
    expect(libraryCuts(60).map((c) => c.t)).toEqual([0, 8, 16, 24, 32, 40, 48])
    expect(sfxKitFor('lofi')).toBe('calm')
    expect(sfxKitFor(undefined)).toBe('crisp')
    expect(sfxKitFor('trap')).toBe('launch')
  })

  it('lists the tracks; a track is composed the first time it is heard, once however many ask, and kept', async () => {
    const { client } = await signup(t.app, 'Music listener')
    const track = MUSIC_LIBRARY[0]
    fs.rmSync(libraryFile(track), { force: true })
    const list = await client.json('GET', '/api/music')
    expect(list.status).toBe(200)
    expect(list.body).toHaveLength(20)
    expect(list.body[0]).toMatchObject({ id: track.id, title: track.title, ready: false })
    composed.length = 0
    const [a, b] = await Promise.all([client.req('GET', `/api/music/${track.id}/preview`), client.req('GET', `/api/music/${track.id}/preview`)])
    expect([a.status, b.status]).toEqual([200, 200])
    expect(a.headers.get('content-type')).toBe('audio/mp4')
    const whole = Buffer.from(await a.arrayBuffer())
    expect(whole.length).toBeGreaterThan(1000)
    expect(composed).toEqual([`library ${track.id}`])
    // kept: heard again without composing, in parts for seeking
    const part = await client.req('GET', `/api/music/${track.id}/preview`, undefined, { range: 'bytes=10-29' })
    expect(part.status).toBe(206)
    expect(part.headers.get('content-range')).toBe(`bytes 10-29/${whole.length}`)
    expect(Buffer.from(await part.arrayBuffer())).toEqual(whole.subarray(10, 30))
    expect(composed).toHaveLength(1)
    expect((await client.json('GET', '/api/music')).body[0].ready).toBe(true)
    expect((await client.req('GET', '/api/music/no-such-track/preview')).status).toBe(404)
  })

  it('adds a track to a space as one audio clip, listed under the project it was added in; adding it again reuses it', async () => {
    const { client, workspaceId } = await signup(t.app, 'Music editor')
    const p = await client.json('POST', '/api/projects', { workspaceId, name: 'With music' })
    const projectId = p.body.id ?? p.body.project?.id ?? p.body.summary?.id
    const track = MUSIC_LIBRARY[3]
    const first = await client.json('POST', `/api/music/${track.id}/add`, { workspaceId, projectId })
    expect(first.status).toBe(200)
    expect(first.body).toMatchObject({ status: 'ready', origin: 'ai', projectId, asset: { kind: 'audio', name: `Music · ${track.title}` } })
    expect(first.body.asset.duration).toBeGreaterThan(2)
    const again = await client.json('POST', `/api/music/${track.id}/add`, { workspaceId, projectId })
    expect(again.body.asset.id).toBe(first.body.asset.id)
    // someone outside the space is told it isn't there (requireRole says nothing about spaces one isn't in), and an
    // unknown track is no track
    const other = await signup(t.app, 'Someone else')
    expect((await other.client.json('POST', `/api/music/${track.id}/add`, { workspaceId, projectId })).status).toBe(404)
    expect((await client.json('POST', '/api/music/nope/add', { workspaceId })).status).toBe(404)
  })

  it('lets the brief hear its sound effects, and nothing outside the kits', async () => {
    const { client } = await signup(t.app, 'Effects listener')
    for (const role of SFX_PREVIEW_ROLES) {
      const r = await client.req('GET', `/api/music/sfx/${sfxKitFor('mallet')}/${role}`)
      expect(r.status).toBe(200)
      expect(r.headers.get('content-type')).toMatch(/^audio\//)
      expect((await r.arrayBuffer()).byteLength).toBeGreaterThan(100)
    }
    expect((await client.req('GET', '/api/music/sfx/crisp/no-such-role')).status).toBe(404)
    expect((await client.req('GET', '/api/music/sfx/nokit/pop')).status).toBe(404)
  })
})
