// How the desktop sends a clip's file (D-7 with P-5): in parts when the cloud's ticket carries a plan (only the parts
// not yet in storage), else one PUT of the whole file.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import type { UploadTicket } from '@producer/core'
import type { CloudClient } from '../desktop/cloud'
import { sendResumable } from '../desktop/uploads'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-desk-up-'))
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }))

function fakeClient() {
  const puts: Array<{ url: string; bytes: number }> = []
  const asked: number[][] = []
  const client = {
    async request(_m: string, url: string, init: { body?: BodyInit | null }) {
      const bytes = (await new Response(init.body as BodyInit).arrayBuffer()).byteLength
      puts.push({ url, bytes })
      return new Response(null, { status: 200 })
    },
    async json(_m: string, p: string, body?: { parts: number[] }) {
      asked.push(body?.parts ?? [])
      return { parts: (body?.parts ?? []).map((n) => ({ partNumber: n, url: `${p}/${n}`, size: n === 3 ? 2 : 4, headers: {} })) }
    },
  }
  return { client: client as unknown as CloudClient, puts, asked }
}

describe('a desktop upload', () => {
  const file = path.join(dir, 'clip.bin')
  fs.writeFileSync(file, Buffer.alloc(10, 7))

  it('goes in parts when the cloud offers them, sending only the parts not yet in storage', async () => {
    const { client, puts, asked } = fakeClient()
    const ticket: UploadTicket = { assetId: 'as_1', url: '/api/uploads/as_1/parts', method: 'PUT', headers: {}, multipart: { size: 10, partSize: 4, partCount: 3, done: [1] } }
    const seen: number[] = []
    await sendResumable({ client, ticket, file, bytes: 10, name: 'clip', onProgress: (n) => seen.push(n), idleMs: 60_000 })
    // parts go up side by side, so a part's address may be asked for twice; part 1 never is
    expect([...new Set(asked.flat())].sort()).toEqual([2, 3])
    expect(puts.map((p) => [p.url, p.bytes]).sort()).toEqual([
      ['/api/uploads/as_1/parts/2', 4],
      ['/api/uploads/as_1/parts/3', 2],
    ])
    expect(seen.at(-1)).toBe(10)
  })

  it('is one PUT of the whole file when the ticket has no plan (a small file, or an older cloud)', async () => {
    const { client, puts, asked } = fakeClient()
    const ticket: UploadTicket = { assetId: 'as_2', url: 'https://bucket.example/put', method: 'PUT', headers: {} }
    await sendResumable({ client, ticket, file, bytes: 10, name: 'clip', onProgress: () => undefined, idleMs: 60_000 })
    expect(asked).toEqual([])
    expect(puts).toEqual([{ url: 'https://bucket.example/put', bytes: 10 }])
  })
})
