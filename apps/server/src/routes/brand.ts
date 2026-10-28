// Brand kit routes (A-21), mounted at /api/workspaces: several kits per space, colours from a logo, font files.
// GET/PUT /:id/brand (the default kit, in workspaces.ts) stay as they were for desktops and older clients.
import { Readable } from 'node:stream'
import { Hono } from 'hono'
import { and, count, eq } from 'drizzle-orm'
import * as z from 'zod/v4'
import { BRAND_FONT_MAX_BYTES, DEFAULT_KIT_ID, FONT_MIME, MAX_EXTRA_KITS, cleanFamily, sniffFontFormat, type BrandKitDoc, type BrandKitList } from '@producer/core'
import { type AppEnv, requireUser } from '../auth'
import { ctx } from '../context'
import { brandFonts, brandKits, extraBrandKits } from '../db/schema'
import { checkIfMatch, setEtag } from '../etag'
import { HttpError, body, notFound, requireRole } from '../http'
import { newId } from '../ids'
import { loadAsset } from '../services/assets'
import { checkKitDoc, defaultKitSummary, extraSummary, fontDto, listBrandFonts, listKits, loadExtraKit } from '../services/brand'
import { logoPalette } from '../services/palette'
import { BrandSchema, saveDefaultKit } from './workspaces'

export const brandRoutes = new Hono<AppEnv>()

/** Open Brand kit pages and editors reload the space's kits. */
function announce(workspaceId: string) {
  const ev = { id: workspaceId, deleted: false, brand: true }
  ctx().bus.publish(workspaceId, 'workspace', ev, { id: workspaceId, inline: ev })
}

brandRoutes.get('/:id/brand-kits', async (c) => {
  const u = requireUser(c)
  const id = c.req.param('id')
  await requireRole(u.id, id, 'viewer')
  return c.json({ items: await listKits(id) } satisfies BrandKitList)
})

brandRoutes.post('/:id/brand-kits', async (c) => {
  const u = requireUser(c)
  const id = c.req.param('id')
  await requireRole(u.id, id, 'editor')
  const b = await body(c, z.object({ doc: BrandSchema.optional(), from: z.string().max(80).optional(), name: z.string().trim().min(1).max(80).optional() }))
  const n = (await ctx().db.select({ n: count() }).from(extraBrandKits).where(eq(extraBrandKits.workspaceId, id)))[0]?.n ?? 0
  if (Number(n) >= MAX_EXTRA_KITS) throw new HttpError(409, 'quota', `A space keeps at most ${MAX_EXTRA_KITS + 1} brand kits. Delete one first.`)
  // a copy of another kit (the default by default), or the kit sent
  let doc: BrandKitDoc
  if (b.doc) doc = b.doc as BrandKitDoc
  else doc = structuredClone(b.from && b.from !== DEFAULT_KIT_ID ? (await loadExtraKit(id, b.from)).doc : (await defaultKitSummary(id)).doc)
  if (b.name) doc.name = b.name
  else if (!b.doc) doc.name = `${doc.name} copy`.slice(0, 80)
  doc = await checkKitDoc(id, doc)
  const now = Date.now()
  const [row] = await ctx().db.insert(extraBrandKits).values({ id: newId('bk'), workspaceId: id, doc, createdBy: u.id, createdAt: now, updatedAt: now }).returning()
  announce(id)
  const out = extraSummary(row)
  setEtag(c, out.doc)
  return c.json(out)
})

brandRoutes.get('/:id/brand-kits/:kitId', async (c) => {
  const u = requireUser(c)
  const id = c.req.param('id')
  await requireRole(u.id, id, 'viewer')
  const kitId = c.req.param('kitId')
  const out = kitId === DEFAULT_KIT_ID ? await defaultKitSummary(id) : extraSummary(await loadExtraKit(id, kitId))
  setEtag(c, out.doc)
  return c.json(out)
})

brandRoutes.put('/:id/brand-kits/:kitId', async (c) => {
  const u = requireUser(c)
  const id = c.req.param('id')
  await requireRole(u.id, id, 'editor')
  const kitId = c.req.param('kitId')
  const raw = (await body(c, BrandSchema)) as BrandKitDoc
  if (kitId === DEFAULT_KIT_ID) {
    checkIfMatch(c, (await defaultKitSummary(id)).doc, 'The brand kit')
    await saveDefaultKit(id, raw)
    const out = await defaultKitSummary(id)
    setEtag(c, out.doc)
    return c.json(out)
  }
  const cur = await loadExtraKit(id, kitId)
  checkIfMatch(c, cur.doc, 'The brand kit')
  const doc = await checkKitDoc(id, raw)
  const [row] = await ctx().db.update(extraBrandKits).set({ doc, updatedAt: Date.now() }).where(eq(extraBrandKits.id, cur.id)).returning()
  announce(id)
  const out = extraSummary(row)
  setEtag(c, out.doc)
  return c.json(out)
})

brandRoutes.delete('/:id/brand-kits/:kitId', async (c) => {
  const u = requireUser(c)
  const id = c.req.param('id')
  await requireRole(u.id, id, 'editor')
  const kitId = c.req.param('kitId')
  if (kitId === DEFAULT_KIT_ID) throw new HttpError(409, 'conflict', 'The default brand kit can’t be deleted. Make another kit the default first.')
  const cur = await loadExtraKit(id, kitId)
  await ctx().db.delete(extraBrandKits).where(eq(extraBrandKits.id, cur.id))
  announce(id)
  return c.json({ ok: true })
})

/**
 * Make a kit the space's default: its settings become the default kit's (the one desktops sync, and what Producer
 * AI, templates and new projects use), and what the default held stays on as another kit.
 */
brandRoutes.post('/:id/brand-kits/:kitId/default', async (c) => {
  const u = requireUser(c)
  const id = c.req.param('id')
  await requireRole(u.id, id, 'editor')
  const kit = await loadExtraKit(id, c.req.param('kitId'))
  const old = await defaultKitSummary(id)
  const now = Date.now()
  await ctx().db.transaction(async (tx) => {
    await tx.delete(extraBrandKits).where(and(eq(extraBrandKits.id, kit.id), eq(extraBrandKits.workspaceId, id)))
    await tx.insert(extraBrandKits).values({ id: newId('bk'), workspaceId: id, doc: old.doc, createdBy: u.id, createdAt: now, updatedAt: now })
    await tx.insert(brandKits).values({ workspaceId: id, doc: kit.doc, updatedAt: now }).onConflictDoUpdate({ target: brandKits.workspaceId, set: { doc: kit.doc, updatedAt: now } })
  })
  announce(id)
  return c.json({ items: await listKits(id) } satisfies BrandKitList)
})

/** The main colours of a logo image already in the space (uploaded through the usual upload flow). */
brandRoutes.post('/:id/brand/palette', async (c) => {
  const u = requireUser(c)
  const id = c.req.param('id')
  await requireRole(u.id, id, 'viewer')
  const b = await body(c, z.object({ assetId: z.string().min(1).max(80), max: z.number().int().min(2).max(10).optional() }))
  const row = await loadAsset(b.assetId).catch(() => null)
  if (!row || row.workspaceId !== id) throw notFound('Logo not found in this space')
  if (row.kind !== 'image') throw new HttpError(400, 'invalid', 'Colours come from an image: upload the logo as a PNG, JPEG, WebP or SVG')
  if (row.status !== 'ready') throw new HttpError(409, 'conflict', 'The logo is still being processed. Try again in a moment.')
  const colors = await logoPalette(row, b.max ?? 6)
  if (!colors.length) throw new HttpError(422, 'invalid', 'No colours found in that image (is it fully transparent?)')
  return c.json({ colors })
})

// ---- font files ----

brandRoutes.get('/:id/brand/fonts', async (c) => {
  const u = requireUser(c)
  const id = c.req.param('id')
  await requireRole(u.id, id, 'viewer')
  return c.json((await listBrandFonts(id)).map(fontDto))
})

brandRoutes.post('/:id/brand/fonts', async (c) => {
  const u = requireUser(c)
  const id = c.req.param('id')
  await requireRole(u.id, id, 'editor')
  const family = cleanFamily(c.req.query('family') ?? '')
  if (!family) throw new HttpError(400, 'invalid', 'Name the font family (letters, digits and spaces)')
  const weight = Math.round(Number(c.req.query('weight') ?? 400) / 100) * 100
  if (!(weight >= 100 && weight <= 900)) throw new HttpError(400, 'invalid', 'weight: a number from 100 to 900')
  const italic = c.req.query('italic') === '1' || c.req.query('italic') === 'true'
  const declared = Number(c.req.header('content-length') ?? 0)
  if (declared > BRAND_FONT_MAX_BYTES) throw new HttpError(413, 'quota', 'A font file can be at most 5 MB')
  const buf = Buffer.from(await c.req.arrayBuffer())
  if (!buf.length) throw new HttpError(400, 'invalid', 'Send the font file as the request body')
  if (buf.length > BRAND_FONT_MAX_BYTES) throw new HttpError(413, 'quota', 'A font file can be at most 5 MB')
  const format = sniffFontFormat(buf)
  if (!format) throw new HttpError(415, 'invalid', 'That isn’t a font file: upload a WOFF2, WOFF, TTF or OTF')
  const fontId = newId('bf')
  const key = `ws/${id}/brand-fonts/${fontId}.${format}`
  await ctx().storage.put(key, buf, { contentType: FONT_MIME[format] })
  const [row] = await ctx()
    .db.insert(brandFonts)
    .values({ id: fontId, workspaceId: id, family, format, weight, italic, storageKey: key, sizeBytes: buf.length, createdBy: u.id, createdAt: Date.now() })
    .returning()
  announce(id)
  return c.json(fontDto(row))
})

async function loadFont(workspaceId: string, fontId: string) {
  const row = (await ctx().db.select().from(brandFonts).where(and(eq(brandFonts.id, fontId), eq(brandFonts.workspaceId, workspaceId))).limit(1))[0]
  if (!row) throw notFound('Font not found')
  return row
}

brandRoutes.delete('/:id/brand/fonts/:fontId', async (c) => {
  const u = requireUser(c)
  const id = c.req.param('id')
  await requireRole(u.id, id, 'editor')
  const row = await loadFont(id, c.req.param('fontId'))
  // a kit still using the family keeps it only while another file of that family is left
  const others = (await listBrandFonts(id)).filter((f) => f.family === row.family && f.id !== row.id)
  if (!others.length) {
    const users = (await listKits(id)).filter((k) => k.doc.fonts.headline === row.family || k.doc.fonts.body === row.family)
    if (users.length) throw new HttpError(409, 'conflict', `“${row.family}” is used by ${users.map((k) => `“${k.doc.name}”`).join(', ')}. Pick another font there first.`)
  }
  await ctx().db.delete(brandFonts).where(eq(brandFonts.id, row.id))
  await ctx().storage.delete(row.storageKey).catch(() => undefined)
  announce(id)
  return c.json({ ok: true })
})

brandRoutes.get('/:id/brand/fonts/:fontId/file', async (c) => {
  const u = requireUser(c)
  const id = c.req.param('id')
  await requireRole(u.id, id, 'viewer')
  const row = await loadFont(id, c.req.param('fontId'))
  const stream = await ctx().storage.getStream(row.storageKey)
  return new Response(Readable.toWeb(stream) as unknown as ReadableStream, {
    headers: { 'Content-Type': FONT_MIME[row.format as keyof typeof FONT_MIME] ?? 'application/octet-stream', 'Content-Length': String(row.sizeBytes), 'Cache-Control': 'private, max-age=86400' },
  })
})
