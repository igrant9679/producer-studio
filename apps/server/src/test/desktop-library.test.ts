// The media library in the desktop app (24 Nov 2026): a desktop makes no library of its own; linked to the cloud it
// lists the cloud's, and fetches each file the first time into its own storage, so listening, adding an item and
// Producer's library songs and clips work as on the web. A real cloud (child process) with library files placed in
// its storage, and this process as the desktop.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { CLIP_LIBRARY_VERSION, MUSIC_LIBRARY_VERSION } from '@producer/core'
import { type Cloud, type Desktop, PASSWORD, deskSession, startCloud, startDesktop } from './desktop-harness'

let cloud: Cloud
let d: Desktop
let cloudData = ''
let email = ''
let workspaceId = ''
const song = Buffer.alloc(0)
let songBytes = song
let clipBytes = song

/** Runs ffmpeg (the desktop's, from its config) to make a small file. */
async function make(args: string[]) {
  const { ffmpeg } = await import('../media/proc')
  await ffmpeg(['-y', '-v', 'error', ...args])
}

beforeAll(async () => {
  cloudData = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-cloud-lib-'))
  d = await startDesktop()
  // the cloud's library, as an operator's jobs leave it: each file with its info beside it
  const lib = path.join(cloudData, 'storage', 'library')
  fs.mkdirSync(path.join(lib, 'music'), { recursive: true })
  fs.mkdirSync(path.join(lib, 'clips'), { recursive: true })
  const songFile = path.join(lib, 'music', `bright-ideas.v${MUSIC_LIBRARY_VERSION}.m4a`)
  await make(['-f', 'lavfi', '-i', 'sine=frequency=440:duration=6', '-c:a', 'aac', '-b:a', '96k', songFile])
  fs.writeFileSync(songFile.replace(/\.m4a$/, '.json'), JSON.stringify({ key: `library/music/bright-ideas.v${MUSIC_LIBRARY_VERSION}.m4a`, mime: 'audio/mp4', seconds: 6, madeAt: 1, provider: 'gemini', model: 'lyria-3.5', workspaceId: 'ws_op' }))
  const clipStem = path.join(lib, 'clips', `coffee-pour.v${CLIP_LIBRARY_VERSION}`)
  await make(['-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=24:duration=2', '-f', 'lavfi', '-i', 'sine=frequency=330:duration=2', '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-c:a', 'aac', '-shortest', `${clipStem}.s1.mp4`])
  await make(['-f', 'lavfi', '-i', 'color=c=brown:size=320x180', '-frames:v', '1', `${clipStem}.jpg`])
  fs.writeFileSync(`${clipStem}.json`, JSON.stringify({ key: `library/clips/coffee-pour.v${CLIP_LIBRARY_VERSION}.s1.mp4`, mime: 'video/mp4', seconds: 2, madeAt: 1, provider: 'gemini', model: 'omni', workspaceId: 'ws_op', poster: `library/clips/coffee-pour.v${CLIP_LIBRARY_VERSION}.jpg`, sound: { song: 'morning-espresso', rev: 1, original: `library/clips/coffee-pour.v${CLIP_LIBRARY_VERSION}.mp4` } }))
  songBytes = fs.readFileSync(songFile)
  clipBytes = fs.readFileSync(`${clipStem}.s1.mp4`)
  cloud = await startCloud({ DATA_DIR: cloudData })
  email = (await cloud.signup('Library user')).email
  await deskSession(d.desk)
  workspaceId = (await d.desk.json<Array<{ id: string }>>('GET', '/api/workspaces')).body[0].id
}, 300_000)
afterAll(() => {
  d?.stop()
  cloud?.proc.kill()
})

describe('the media library in the desktop app', () => {
  it('lists nothing while the computer isn’t linked, and says how to get it', async () => {
    const music = await d.desk.json<Array<{ id: string; ready: boolean }>>('GET', '/api/music')
    expect(music.status).toBe(200)
    expect(music.body.some((t) => t.ready)).toBe(false)
    const preview = await d.desk.json('GET', '/api/music/bright-ideas/preview')
    expect(preview.status).toBe(404)
    expect(preview.body.error).toMatch(/Link this computer to producerstudio\.app/)
  })

  it('once linked, lists the cloud’s songs and clips, plays them from its own copy, and adds them', async () => {
    const linked = await d.desk.json('POST', '/api/sync/link', { cloudUrl: cloud.url, email, password: PASSWORD })
    expect(linked.status, JSON.stringify(linked.body)).toBe(200)
    const music = await d.desk.json<Array<{ id: string; ready: boolean; seconds?: number }>>('GET', '/api/music')
    expect(music.body.filter((t) => t.ready)).toEqual([expect.objectContaining({ id: 'bright-ideas', ready: true, seconds: 6 })])
    const clips = await d.desk.json<Array<{ id: string; ready: boolean; song?: string }>>('GET', '/api/clips')
    expect(clips.body.filter((c) => c.ready)).toEqual([expect.objectContaining({ id: 'coffee-pour', ready: true, song: 'morning-espresso' })])
    // heard and watched: the cloud's file, kept in the desktop's own storage after the first time
    const heard = await d.desk.req('GET', '/api/music/bright-ideas/preview')
    expect(heard.status).toBe(200)
    expect(heard.headers.get('content-type')).toMatch(/^audio\//)
    expect(Buffer.from(await heard.arrayBuffer())).toEqual(songBytes)
    const { ctx } = await import('../context')
    expect(await ctx().storage.stat(`library-cache/music/bright-ideas.v${MUSIC_LIBRARY_VERSION}.m4a`)).toBeTruthy()
    const watched = await d.desk.req('GET', '/api/clips/coffee-pour/preview')
    expect(watched.headers.get('content-type')).toBe('video/mp4')
    expect(Buffer.from(await watched.arrayBuffer())).toEqual(clipBytes)
    const poster = await d.desk.req('GET', '/api/clips/coffee-pour/poster')
    expect(poster.headers.get('content-type')).toBe('image/jpeg')
    // added to a space as its own clip, with the cloud's song on it (linking put the cloud's space in place of the local one)
    workspaceId = (await d.desk.json<Array<{ id: string }>>('GET', '/api/workspaces')).body[0].id
    const added = await d.desk.json<{ asset: { id: string; name: string; kind: string } }>('POST', '/api/music/bright-ideas/add', { workspaceId })
    expect(added.status, JSON.stringify(added.body)).toBe(200)
    expect(added.body.asset).toMatchObject({ name: 'Music · Bright Ideas', kind: 'audio' })
    const clip = await d.desk.json<{ asset: { name: string; kind: string } }>('POST', '/api/clips/coffee-pour/add', { workspaceId })
    expect(clip.body.asset).toMatchObject({ name: 'Clip · Coffee Pour', kind: 'video' })
    // Producer offers the clips here too
    const { readyLibraryClips } = await import('../ai/produce')
    expect((await readyLibraryClips()).map((c) => c.id)).toEqual(['coffee-pour'])
    // remaking an item for a topic stays on the web
    const remake = await d.desk.json('POST', '/api/music/bright-ideas/customize', { workspaceId, mode: 'topic', topic: 'a bakery' })
    expect(remake.status).toBe(400)
    expect(remake.body.error).toMatch(/on producerstudio\.app/)
  }, 180_000)

  it('lets a device token read the library and nothing else of it', async () => {
    const { deviceMayUse } = await import('../auth')
    expect(deviceMayUse('GET', '/api/music')).toBe(true)
    expect(deviceMayUse('GET', '/api/clips/coffee-pour/poster')).toBe(true)
    expect(deviceMayUse('GET', '/api/music/bright-ideas/preview')).toBe(true)
    expect(deviceMayUse('POST', '/api/music/bright-ideas/use')).toBe(false)
    expect(deviceMayUse('POST', '/api/clips/coffee-pour/add')).toBe(false)
    expect(deviceMayUse('GET', '/api/music/style/lofi/preview')).toBe(false)
  })

  it('lists nothing again after unlinking', async () => {
    expect((await d.desk.json('POST', '/api/sync/unlink')).status).toBe(200)
    const music = await d.desk.json<Array<{ ready: boolean }>>('GET', '/api/music')
    expect(music.body.some((t) => t.ready)).toBe(false)
  })
})
