// Brand kits (A-21): several kits per space, one of them the default; colours pulled from a logo image (raster and
// SVG, no web fetch); font files uploaded for a kit, usable as its headline / body font, embedded in the export.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import type { BrandFont, BrandKitDoc, BrandKitList, BrandKitSummary } from '@producer/core'
import { paletteFromPixels, paletteFromSvg } from '../services/palette'
import { ffmpeg } from '../media/proc'
import { createAssetFromFile, updateAsset } from '../services/assets'
import { brandFontFaces } from '../render/brandFonts'
import { getBrandKit } from '../services/brand'
import { getLook, starterProject } from '../services/looks'
import { setup, signup, type TestEnv } from './helpers'

let t: TestEnv
beforeAll(async () => {
  t = await setup()
})

const KIT: BrandKitDoc = { name: 'Northwind', colors: ['#0b1830', '#ff5a5f', '#f3f5fa'], fonts: { headline: 'Montserrat', body: 'Inter' } }

/** A team space owned by A, with a viewer V. */
async function team() {
  const A = await signup(t.app, 'Owner')
  const ws = (await A.client.json('POST', '/api/workspaces', { name: 'Agency' })).body as { id: string }
  const V = await signup(t.app, 'Viewer')
  const inv = await A.client.json('POST', `/api/workspaces/${ws.id}/invites`, { email: V.email, role: 'viewer' })
  await V.client.json('POST', `/api/invites/${inv.body.inviteUrl.split('/invite/')[1]}/accept`)
  const userId = (await A.client.json('GET', '/api/auth/me')).body.user.id as string
  return { A, V, wsId: ws.id, userId }
}

/** A minimal TrueType header: the bytes a font file starts with (the server sniffs, never trusts the name). */
const ttf = () => Buffer.concat([Buffer.from([0, 1, 0, 0]), Buffer.alloc(60, 7)])

describe('brand kits', () => {
  it('a space has its default kit and can keep others: copy, rename, edit with If-Match, delete', async () => {
    const { A, V, wsId } = await team()
    const list = (await A.client.json<BrandKitList>('GET', `/api/workspaces/${wsId}/brand-kits`)).body
    expect(list.items).toHaveLength(1)
    expect(list.items[0]).toMatchObject({ id: 'default', default: true })

    const made = await A.client.json<BrandKitSummary>('POST', `/api/workspaces/${wsId}/brand-kits`, { doc: KIT })
    expect(made.status).toBe(200)
    expect(made.body).toMatchObject({ default: false, doc: { name: 'Northwind' } })
    const copy = await A.client.json<BrandKitSummary>('POST', `/api/workspaces/${wsId}/brand-kits`, { from: made.body.id })
    expect(copy.body.doc.name).toBe('Northwind copy')
    expect((await A.client.json<BrandKitList>('GET', `/api/workspaces/${wsId}/brand-kits`)).body.items.map((k) => k.doc.name)).toEqual([expect.any(String), 'Northwind', 'Northwind copy'])

    // a save over a kit someone changed since it was read is refused, not lost
    const url = `/api/workspaces/${wsId}/brand-kits/${made.body.id}`
    const ok = await A.client.req('PUT', url, { ...KIT, name: 'Northwind Retail' }, { 'if-match': made.body.etag! })
    expect(ok.status).toBe(200)
    const stale = await A.client.req('PUT', url, { ...KIT, name: 'Older edit' }, { 'if-match': made.body.etag! })
    expect(stale.status).toBe(412)
    expect((await A.client.json<BrandKitSummary>('GET', url)).body.doc.name).toBe('Northwind Retail')

    // viewers read, never write
    expect((await V.client.json('GET', `/api/workspaces/${wsId}/brand-kits`)).status).toBe(200)
    expect((await V.client.json('POST', `/api/workspaces/${wsId}/brand-kits`, { doc: KIT })).status).toBe(403)
    expect((await V.client.json('DELETE', url)).status).toBe(403)

    expect((await A.client.json('DELETE', `/api/workspaces/${wsId}/brand-kits/default`)).status).toBe(409)
    expect((await A.client.json('DELETE', `/api/workspaces/${wsId}/brand-kits/${copy.body.id}`)).status).toBe(200)
    expect((await A.client.json('GET', `/api/workspaces/${wsId}/brand-kits/${copy.body.id}`)).status).toBe(404)
    // another space's kit is not found here
    const other = await signup(t.app, 'Stranger')
    expect((await other.client.json('GET', url)).status).toBe(404)
  })

  it('making a kit the default moves its settings to the default (what Producer and templates use) and keeps the old one', async () => {
    const { A, wsId } = await team()
    const before = (await A.client.json<BrandKitSummary>('GET', `/api/workspaces/${wsId}/brand-kits/default`)).body.doc
    const made = (await A.client.json<BrandKitSummary>('POST', `/api/workspaces/${wsId}/brand-kits`, { doc: KIT })).body
    const r = await A.client.json<BrandKitList>('POST', `/api/workspaces/${wsId}/brand-kits/${made.id}/default`)
    expect(r.status).toBe(200)
    expect(r.body.items[0]).toMatchObject({ default: true, doc: { name: 'Northwind' } })
    expect(r.body.items.slice(1).map((k) => k.doc.name)).toEqual([before.name])
    // the legacy route (desktops) reads the same default
    expect((await A.client.json('GET', `/api/workspaces/${wsId}/brand`)).body.name).toBe('Northwind')
    expect((await getBrandKit(wsId, 'default')).name).toBe('Northwind')
  })

  it('pulls colours from a logo: a PNG through ffmpeg, an SVG from its markup', async () => {
    const { A, V, wsId, userId } = await team()
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-logo-'))
    const png = path.join(dir, 'logo.png')
    // three quarters coral, a quarter navy
    await ffmpeg(['-f', 'lavfi', '-i', 'color=c=0xff5a5f:s=120x80', '-f', 'lavfi', '-i', 'color=c=0x0b1830:s=40x80', '-filter_complex', '[0][1]hstack', '-frames:v', '1', png])
    const row = await createAssetFromFile({ workspaceId: wsId, userId, filePath: png, name: 'logo.png', mime: 'image/png', kind: 'image', origin: 'upload' })
    await updateAsset(row.id, { status: 'ready' })
    const r = await V.client.json<{ colors: string[] }>('POST', `/api/workspaces/${wsId}/brand/palette`, { assetId: row.id })
    expect(r.status).toBe(200)
    expect(r.body.colors).toHaveLength(2)
    const near = (hex: string, want: string) => {
      const n = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16))
      return n(hex).every((v, i) => Math.abs(v - n(want)[i]) <= 6)
    }
    expect(near(r.body.colors[0], '#ff5a5f')).toBe(true)
    expect(near(r.body.colors[1], '#0b1830')).toBe(true)

    const svg = path.join(dir, 'logo.svg')
    fs.writeFileSync(svg, '<svg xmlns="http://www.w3.org/2000/svg"><rect fill="#1F6FEB"/><circle fill="#1f6feb"/><path stroke="rgb(255, 138, 61)"/></svg>')
    const srow = await createAssetFromFile({ workspaceId: wsId, userId, filePath: svg, name: 'logo.svg', mime: 'image/svg+xml', kind: 'image', origin: 'upload' })
    await updateAsset(srow.id, { status: 'ready' })
    expect((await A.client.json('POST', `/api/workspaces/${wsId}/brand/palette`, { assetId: srow.id })).body.colors).toEqual(['#1f6feb', '#ff8a3d'])

    // only images in this space
    const other = await signup(t.app, 'Stranger')
    expect((await other.client.json('POST', `/api/workspaces/${other.workspaceId}/brand/palette`, { assetId: row.id })).status).toBe(404)
  })

  it('quantises pixels: transparent ones are ignored, near colours merge, the most used comes first', () => {
    const px: number[] = []
    for (let i = 0; i < 100; i++) px.push(250, 90, 95, 255)
    for (let i = 0; i < 100; i++) px.push(255, 92, 96, 255) // the same coral, near enough
    for (let i = 0; i < 60; i++) px.push(10, 24, 48, 255)
    for (let i = 0; i < 300; i++) px.push(0, 255, 0, 0) // transparent: not part of the logo
    const out = paletteFromPixels(new Uint8Array(px))
    expect(out).toHaveLength(2)
    // the two corals averaged, then the navy
    expect(out).toEqual(['#fd5b60', '#0a1830'])
    expect(paletteFromSvg('<svg><g fill="none"/></svg>')).toEqual([])
  })

  it('uploads a font file for a kit: sniffed by content, usable as the kit’s font, kept by looks, embedded in the export', async () => {
    const { A, V, wsId } = await team()
    const base = `/api/workspaces/${wsId}/brand/fonts`
    // not a font: refused whatever it's called
    expect((await A.client.req('POST', `${base}?family=Acme`, Buffer.from('<html>not a font</html>'))).status).toBe(415)
    expect((await V.client.req('POST', `${base}?family=Acme`, ttf())).status).toBe(403)
    const up = await A.client.req('POST', `${base}?family=${encodeURIComponent('Acme Sans')}&weight=700`, ttf())
    expect(up.status).toBe(200)
    const font = (await up.json()) as BrandFont
    expect(font).toMatchObject({ family: 'Acme Sans', format: 'ttf', weight: 700, italic: false })
    expect((await V.client.json<BrandFont[]>('GET', base)).body.map((f) => f.family)).toEqual(['Acme Sans'])
    const file = await V.client.req('GET', font.url)
    expect(file.status).toBe(200)
    expect(file.headers.get('content-type')).toBe('font/ttf')
    expect(Buffer.from(await file.arrayBuffer()).equals(ttf())).toBe(true)

    // a kit may use it; an unknown family is refused
    expect((await A.client.json('PUT', `/api/workspaces/${wsId}/brand`, { ...KIT, fonts: { headline: 'Nope Grotesk', body: 'Inter' } })).status).toBe(400)
    const saved = await A.client.json<BrandKitDoc>('PUT', `/api/workspaces/${wsId}/brand`, { ...KIT, fonts: { headline: 'Acme Sans', body: 'Inter' } })
    expect(saved.status).toBe(200)
    expect(saved.body.customFonts).toEqual(['Acme Sans'])
    // the looks keep it (instead of mapping it to a bundled fallback)
    const p = starterProject(getLook('studio-dark'), { brand: saved.body })
    expect(p.tracks.flatMap((tr) => tr.items).some((i) => i.type === 'text' && i.style.fontFamily === 'Acme Sans')).toBe(true)
    // and the export copies its file and declares it
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-bfont-'))
    fs.mkdirSync(path.join(out, 'fonts'))
    const faces = await brandFontFaces(wsId, [{ family: 'Acme Sans', weight: 700, italic: false }, { family: 'Inter', weight: 400, italic: false }], out)
    expect(faces.files).toEqual([`fonts/brand-${font.id}.ttf`])
    expect(faces.css).toContain("font-family:'Acme Sans'")
    expect(faces.css).toContain("format('truetype')")
    expect(fs.existsSync(path.join(out, faces.files[0]))).toBe(true)

    // the last file of a family a kit uses can't be deleted out from under it
    expect((await A.client.json('DELETE', `${base}/${font.id}`)).status).toBe(409)
    await A.client.json('PUT', `/api/workspaces/${wsId}/brand`, KIT)
    expect((await A.client.json('DELETE', `${base}/${font.id}`)).status).toBe(200)
    expect((await A.client.json<BrandFont[]>('GET', base)).body).toEqual([])
  })
})
