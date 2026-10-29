// System info (public), device tokens, and the cloud change feed used by desktop replicas.
import fs from 'node:fs'
import { Readable } from 'node:stream'
import { createRequire } from 'node:module'
import { Hono } from 'hono'
import { and, asc, count, desc, eq, gt, inArray, isNotNull, sql } from 'drizzle-orm'
import * as z from 'zod/v4'
import { BRAND_FONT_MAX_BYTES, FONT_MIME, MAX_EXTRA_KITS, cleanFamily, sniffFontFormat, type BrandKitDoc, type Device, type SyncChanges, type SystemInfo } from '@producer/core'
import { type AppEnv, DEVICE_IDLE_MS, requireUser } from '../auth'
import { ctx } from '../context'
import { CHANGE_LOCK_NS } from '../db/migrate'
import { assets, brandFonts, brandKits, comments, devices, extraBrandKits, memberships, projects, tombstones, voiceProfiles, workspaces } from '../db/schema'
import { assetRecord, projectSummary } from '../dto'
import { HttpError, body, memberRole, notFound, requireRole, unauthorized } from '../http'
import { newId, randomToken, sha256 } from '../ids'
import { limitDevices } from '../limits'
import { getProvider } from '../ai/provider'
import { builtinProvider, invalidateBuiltin } from '../ai/resolve'
import { whisperAvailable } from '../ai/whisper'
import { hydrateAssets, loadProjectRow } from '../services/projects'
import { checkCredentials } from './auth'
import { audit } from '../services/audit'
import { BrandSchema, listWorkspaces } from './workspaces'
import { voiceProfileDto } from './voice'
import { storageHealth } from '../services/storage-health'
import { mailEnabled } from '../mail'
import { checkKitDoc, fontDto, listKits } from '../services/brand'
import { syncHorizon } from '../services/tombstones'

const require = createRequire(import.meta.url)

function resolvable(mod: string): boolean {
  try {
    require.resolve(mod)
    return true
  } catch {
    return false
  }
}

let capsCache: { at: number; caps: SystemInfo['capabilities'] } | undefined

export function capabilities(): SystemInfo['capabilities'] {
  if (capsCache && Date.now() - capsCache.at < 60_000) return capsCache.caps
  const cfg = ctx().config
  const ffmpegOk = cfg.ffmpegPath === 'ffmpeg' || fs.existsSync(cfg.ffmpegPath)
  const caps = {
    transcribe: whisperAvailable(),
    tts: resolvable('kokoro-js') && resolvable('@huggingface/transformers'),
    render: ffmpegOk && resolvable('hyperframes/package.json'),
  }
  capsCache = { at: Date.now(), caps }
  return caps
}

export const systemRoutes = new Hono<AppEnv>()

systemRoutes.get('/', async (c) => {
  const cfg = ctx().config
  // ?workspaceId= (cloud, members only) reports that workspace's effective default provider; else the built-in one
  let scope: string | undefined
  const ws = c.req.query('workspaceId')
  const user = c.get('user')
  if (cfg.mode === 'cloud' && ws && user && (await memberRole(user.id, ws))) scope = ws
  // ?refresh=1 re-probes the provider now (e.g. right after "Sign in to Claude"); otherwise cached ~30 s
  if (c.req.query('refresh') === '1') await invalidateBuiltin()
  const provider = cfg.mode === 'desktop' && !user ? await builtinProvider() : await getProvider(scope)
  const s = await provider.status()
  const info: SystemInfo = {
    mode: cfg.mode,
    version: cfg.version,
    ai: { provider: provider.id, available: s.available, detail: s.detail, model: s.model },
    capabilities: capabilities(),
    ...(cfg.mode === 'cloud' ? { storage: storageHealth() } : {}),
    limits: { uploadBytes: cfg.maxUploadBytes },
    retention: { mediaTrashDays: cfg.mediaTrashDays, exportDays: cfg.exportRetentionDays },
    mail: mailEnabled(),
  }
  // desktop: sync state (account, cloud URL) only for the signed-in local session
  if (cfg.mode === 'desktop' && c.get('user')) {
    const { syncEngine } = await import('../desktop/sync')
    info.sync = await syncEngine.status()
  }
  return c.json(info)
})

// ---- devices ----
export const deviceRoutes = new Hono<AppEnv>()

const deviceDto = (d: typeof devices.$inferSelect): Device => ({ id: d.id, name: d.name, createdAt: d.createdAt, lastSeenAt: d.lastSeenAt ?? undefined, expiresAt: (d.lastSeenAt ?? d.createdAt) + DEVICE_IDLE_MS })

/**
 * Create a device token. Authenticated with the session cookie / an existing device token, or directly with
 * {email, password} so a desktop app can link without handling cookies. The token is returned once.
 */
deviceRoutes.post('/', async (c) => {
  const b = await body(c, z.object({ name: z.string().trim().min(1).max(100), email: z.string().max(254).optional(), password: z.string().max(200).optional() }))
  // A device token can't mint more device tokens: revoking a leaked one must end that access, not leave a copy behind.
  // Linking takes a password, or a browser session.
  let user = c.get('deviceId') ? null : c.get('user')
  if (!user && b.email && b.password) user = await checkCredentials(c, b.email, b.password)
  if (!user) throw c.get('deviceId') ? new HttpError(403, 'forbidden', 'Link a new app with your email and password') : unauthorized()
  await limitDevices(user.id)
  const token = `psd_${randomToken(32)}`
  const id = newId('dev')
  await ctx().db.insert(devices).values({ id, userId: user.id, name: b.name, tokenHash: sha256(token), createdAt: Date.now() })
  await audit(c, { kind: 'device.created', actor: user, targetId: id, target: b.name, data: { name: b.name, via: c.get('user') ? 'session' : 'password' } })
  return c.json({ deviceId: id, token })
})

deviceRoutes.get('/', async (c) => {
  const u = requireUser(c)
  const rows = await ctx().db.select().from(devices).where(eq(devices.userId, u.id)).orderBy(desc(devices.createdAt))
  return c.json(rows.map(deviceDto))
})

deviceRoutes.delete('/:id', async (c) => {
  const u = requireUser(c)
  const rows = await ctx().db.delete(devices).where(and(eq(devices.id, c.req.param('id')), eq(devices.userId, u.id))).returning()
  if (!rows.length) throw notFound('Device not found')
  ctx().bus.accessChanged(u.id)
  await audit(c, { kind: 'device.revoked', targetId: rows[0].id, target: rows[0].name, data: { name: rows[0].name } })
  return c.json({ ok: true })
})

// ---- change feed ----
export const syncRoutes = new Hono<AppEnv>()

type Change =
  | { seq: number; kind: 'project'; row: typeof projects.$inferSelect }
  | { seq: number; kind: 'asset'; row: typeof assets.$inferSelect }
  | { seq: number; kind: 'brand'; row: typeof brandKits.$inferSelect }
  | { seq: number; kind: 'workspace'; id: string }
  | { seq: number; kind: 'tombstone'; row: typeof tombstones.$inferSelect }
  | { seq: number; kind: 'left'; id: string }
  | { seq: number; kind: 'voice'; row: typeof voiceProfiles.$inferSelect }
  | { seq: number; kind: 'kit'; row: typeof extraBrandKits.$inferSelect }
  | { seq: number; kind: 'font'; row: typeof brandFonts.$inferSelect }

async function rows<T>(q: ReturnType<typeof sql>): Promise<T[]> {
  const r = (await ctx().db.execute(q)) as unknown
  return (Array.isArray(r) ? r : ((r as { rows?: T[] }).rows ?? [])) as T[]
}

/**
 * The highest change number a reader may resume after without skipping a change that is still being written: no
 * further than the sequence had reached, and below where every transaction still in flight registered its changes
 * start (migration v8). Read before the rows, in this order, so a transaction either shows here or is already visible.
 */
async function changeHorizon(): Promise<number> {
  const [s] = await rows<{ v: string; called: boolean }>(sql`SELECT last_value::text AS v, is_called AS called FROM change_seq`)
  const reached = s ? Number(s.v) - (s.called ? 0 : 1) : 0
  const [l] = await rows<{ low: string | null }>(
    sql`SELECT min(((classid::bigint & 65535) << 32) | objid::bigint)::text AS low FROM pg_locks WHERE locktype = 'advisory' AND objsubid = 1 AND (classid::bigint >> 16) = ${CHANGE_LOCK_NS}`,
  )
  return l?.low != null ? Math.min(reached, Number(l.low)) : reached
}

/** A page of changes ends at about this much JSON unless the reader asks for another size. */
export const PAGE_BYTES = 4 * 1024 * 1024

/** Changes after `since` across the user's workspaces, merged by change_seq and paged (by count and by size). */
export async function changesSince(userId: string, since: number, limit: number, maxBytes = PAGE_BYTES): Promise<SyncChanges> {
  const db = ctx().db
  const horizon = await changeHorizon()
  // deletes up to the compaction horizon may be gone: a reader that stopped below it pulls everything again
  const resync = since > 0 && since < (await syncHorizon())
  const safeFrom = (cursor: number) => Math.max(since, Math.min(cursor, horizon))
  const mine = await db.select({ ws: memberships.workspaceId, seq: memberships.changeSeq }).from(memberships).where(eq(memberships.userId, userId))
  const wsIds = mine.map((m) => m.ws)
  const n = limit + 1
  // spaces this user left (deleted, or removed from); ignore any they've since rejoined
  const left = (
    await db
      .select({ ws: tombstones.workspaceId, seq: tombstones.changeSeq })
      .from(tombstones)
      .where(and(eq(tombstones.kind, 'membership'), eq(tombstones.id, userId), gt(tombstones.changeSeq, since)))
      .orderBy(asc(tombstones.changeSeq))
      .limit(n)
  ).filter((l) => !wsIds.includes(l.ws))
  if (!wsIds.length) {
    const page = left.slice(0, limit)
    const cursor = page.length ? page[page.length - 1].seq : since
    return { cursor, safe: safeFrom(cursor), workspaces: [], projects: [], assets: [], brandKits: [], voiceProfiles: [], extraBrandKits: [], brandFonts: [], deleted: { projects: [], assets: [], workspaces: page.map((l) => l.ws), voiceProfiles: [], brandKits: [], brandFonts: [] }, more: left.length > limit, ...(resync ? { resync } : {}) }
  }
  const [p, a, b, t, w, v, k, f] = await Promise.all([
    db.select().from(projects).where(and(inArray(projects.workspaceId, wsIds), gt(projects.changeSeq, since))).orderBy(asc(projects.changeSeq)).limit(n),
    db.select().from(assets).where(and(inArray(assets.workspaceId, wsIds), gt(assets.changeSeq, since))).orderBy(asc(assets.changeSeq)).limit(n),
    db.select().from(brandKits).where(and(inArray(brandKits.workspaceId, wsIds), gt(brandKits.changeSeq, since))).orderBy(asc(brandKits.changeSeq)).limit(n),
    db.select().from(tombstones).where(and(inArray(tombstones.workspaceId, wsIds), inArray(tombstones.kind, ['project', 'asset', 'voice_profile', 'brand_kit', 'brand_font']), gt(tombstones.changeSeq, since))).orderBy(asc(tombstones.changeSeq)).limit(n),
    db.select({ id: workspaces.id, seq: workspaces.changeSeq }).from(workspaces).where(and(inArray(workspaces.id, wsIds), gt(workspaces.changeSeq, since))),
    db.select().from(voiceProfiles).where(and(inArray(voiceProfiles.workspaceId, wsIds), gt(voiceProfiles.changeSeq, since))).orderBy(asc(voiceProfiles.changeSeq)).limit(n),
    db.select().from(extraBrandKits).where(and(inArray(extraBrandKits.workspaceId, wsIds), gt(extraBrandKits.changeSeq, since))).orderBy(asc(extraBrandKits.changeSeq)).limit(n),
    db.select().from(brandFonts).where(and(inArray(brandFonts.workspaceId, wsIds), gt(brandFonts.changeSeq, since))).orderBy(asc(brandFonts.changeSeq)).limit(n),
  ])
  // a deleted id that exists again (a replica kept its edited copy and created it anew): its old tombstone is void,
  // or delivering it again would delete the copy that came back
  const back = new Set<string>()
  const ofKind = (k: string) => [...new Set(t.filter((r) => r.kind === k).map((r) => r.id))]
  const [bp, ba, bv, bk, bf] = await Promise.all([
    ofKind('project').length ? db.select({ id: projects.id }).from(projects).where(and(inArray(projects.id, ofKind('project')), inArray(projects.workspaceId, wsIds))) : [],
    ofKind('asset').length ? db.select({ id: assets.id }).from(assets).where(and(inArray(assets.id, ofKind('asset')), inArray(assets.workspaceId, wsIds))) : [],
    ofKind('voice_profile').length ? db.select({ id: voiceProfiles.id }).from(voiceProfiles).where(and(inArray(voiceProfiles.id, ofKind('voice_profile')), inArray(voiceProfiles.workspaceId, wsIds))) : [],
    ofKind('brand_kit').length ? db.select({ id: extraBrandKits.id }).from(extraBrandKits).where(and(inArray(extraBrandKits.id, ofKind('brand_kit')), inArray(extraBrandKits.workspaceId, wsIds))) : [],
    ofKind('brand_font').length ? db.select({ id: brandFonts.id }).from(brandFonts).where(and(inArray(brandFonts.id, ofKind('brand_font')), inArray(brandFonts.workspaceId, wsIds))) : [],
  ])
  for (const [kind, rows] of [['project', bp], ['asset', ba], ['voice_profile', bv], ['brand_kit', bk], ['brand_font', bf]] as const) for (const r of rows) back.add(`${kind}:${r.id}`)
  const all: Change[] = [
    ...p.map((row) => ({ seq: row.changeSeq ?? 0, kind: 'project' as const, row })),
    ...a.map((row) => ({ seq: row.changeSeq ?? 0, kind: 'asset' as const, row })),
    ...b.map((row) => ({ seq: row.changeSeq ?? 0, kind: 'brand' as const, row })),
    ...t.map((row) => ({ seq: row.changeSeq, kind: 'tombstone' as const, row })),
    ...w.map((row) => ({ seq: row.seq ?? 0, kind: 'workspace' as const, id: row.id })),
    ...mine.filter((m) => (m.seq ?? 0) > since).map((m) => ({ seq: m.seq ?? 0, kind: 'workspace' as const, id: m.ws })),
    ...left.map((l) => ({ seq: l.seq, kind: 'left' as const, id: l.ws })),
    ...v.map((row) => ({ seq: row.changeSeq ?? 0, kind: 'voice' as const, row })),
    ...k.map((row) => ({ seq: row.changeSeq ?? 0, kind: 'kit' as const, row })),
    ...f.map((row) => ({ seq: row.changeSeq ?? 0, kind: 'font' as const, row })),
  ].sort((x, y) => x.seq - y.seq)
  const out: SyncChanges = { cursor: since, workspaces: [], projects: [], assets: [], brandKits: [], voiceProfiles: [], extraBrandKits: [], brandFonts: [], deleted: { projects: [], assets: [], workspaces: [], voiceProfiles: [], brandKits: [], brandFonts: [] }, more: false, ...(resync ? { resync } : {}) }
  const wsChanged = new Set<string>()
  // a page ends at `limit` changes or about `maxBytes` of JSON (at least one change), so big documents come a few at
  // a time on a slow link instead of one page that never finishes
  let bytes = 0
  let taken = 0
  const size = (x: unknown) => (bytes += JSON.stringify(x).length)
  for (const ch of all.slice(0, limit)) {
    if (taken && bytes >= maxBytes) break
    taken++
    if (ch.kind === 'project') {
      const item = { summary: projectSummary(ch.row), project: await hydrateAssets(ch.row.doc, ch.row.workspaceId), version: ch.row.version, changeSeq: ch.seq }
      out.projects.push(item)
      size(item)
    } else if (ch.kind === 'asset') {
      out.assets.push({ ...assetRecord(ch.row), sha256: ch.row.sha256 ?? undefined, changeSeq: ch.seq })
      size(out.assets[out.assets.length - 1])
    } else if (ch.kind === 'brand') {
      out.brandKits.push({ workspaceId: ch.row.workspaceId, doc: ch.row.doc, changeSeq: ch.seq })
      size(ch.row.doc)
    } else if (ch.kind === 'tombstone') {
      if (back.has(`${ch.row.kind}:${ch.row.id}`)) continue
      if (ch.row.kind === 'project') out.deleted.projects.push(ch.row.id)
      else if (ch.row.kind === 'asset') out.deleted.assets.push(ch.row.id)
      else if (ch.row.kind === 'voice_profile') out.deleted.voiceProfiles!.push(ch.row.id)
      else if (ch.row.kind === 'brand_kit') out.deleted.brandKits!.push(ch.row.id)
      else if (ch.row.kind === 'brand_font') out.deleted.brandFonts!.push(ch.row.id)
    } else if (ch.kind === 'voice') {
      out.voiceProfiles!.push({ ...voiceProfileDto(ch.row), vsProfileId: undefined, changeSeq: ch.seq })
      size(out.voiceProfiles![out.voiceProfiles!.length - 1])
    } else if (ch.kind === 'kit') {
      out.extraBrandKits!.push({ id: ch.row.id, workspaceId: ch.row.workspaceId, doc: ch.row.doc, updatedAt: ch.row.updatedAt, changeSeq: ch.seq })
      size(ch.row.doc)
    } else if (ch.kind === 'font') {
      out.brandFonts!.push({ ...fontDto(ch.row), workspaceId: ch.row.workspaceId, changeSeq: ch.seq })
    } else if (ch.kind === 'left') out.deleted.workspaces!.push(ch.id)
    else wsChanged.add(ch.id)
  }
  out.cursor = taken ? all[taken - 1].seq : since
  out.more = all.length > taken
  out.safe = safeFrom(out.cursor)
  if (wsChanged.size || since === 0) {
    const list = await listWorkspaces(userId)
    out.workspaces = since === 0 ? list : list.filter((x) => wsChanged.has(x.id))
  }
  return out
}

syncRoutes.get('/changes', async (c) => {
  const u = requireUser(c)
  const since = Math.max(0, Number(c.req.query('since') ?? 0) || 0)
  const limit = Math.min(500, Math.max(1, Number(c.req.query('limit') ?? 100) || 100))
  const maxBytes = Math.min(64 * 1024 * 1024, Math.max(64 * 1024, Number(c.req.query('maxBytes') ?? PAGE_BYTES) || PAGE_BYTES))
  if (!Number.isFinite(since)) throw new HttpError(400, 'invalid', 'since must be a number')
  return c.json(await changesSince(u.id, since, limit, maxBytes))
})

/**
 * A replica pushes a delete made on it. It goes through only while the cloud copy is still the version that replica
 * last saw (and still in the trash, if it saw it there), in one statement, so an edit or a restore made since is never
 * destroyed: 409 with details {reason: 'edited' | 'restored', version, trashed}. 404 when it's already gone.
 */
syncRoutes.post('/projects/:id/delete', async (c) => {
  const u = requireUser(c)
  const id = c.req.param('id')
  const b = await body(c, z.object({ baseVersion: z.number().int(), trashed: z.boolean().optional() }))
  const row = await loadProjectRow(id)
  await requireRole(u.id, row.workspaceId, 'editor')
  const conds = [eq(projects.id, id), eq(projects.version, b.baseVersion)]
  if (b.trashed) conds.push(isNotNull(projects.trashedAt))
  // review comments have no FK: they go with the project, as for a delete on the web
  const gone = await ctx().db.transaction(async (tx) => {
    const g = await tx.delete(projects).where(and(...conds)).returning({ id: projects.id })
    if (g.length) await tx.delete(comments).where(eq(comments.projectId, id))
    return g
  })
  if (gone.length) {
    // open screens drop it, as for a delete on the web
    const ev = { id, version: row.version, deleted: true }
    ctx().bus.publish(row.workspaceId, 'project', ev, { id, inline: ev })
    return c.json({ ok: true })
  }
  const cur = await loadProjectRow(id)
  const edited = cur.version !== b.baseVersion
  throw new HttpError(409, 'conflict', edited ? 'The project was edited in the cloud since this computer last saw it' : 'The project was taken out of the trash in the cloud', {
    reason: edited ? 'edited' : 'restored',
    version: cur.version,
    trashed: cur.trashedAt != null,
  })
})

// ---- a space's other brand kits and font files, pushed by desktops with their own ids ----

/** Open Brand kit pages and editors reload the space's kits. */
function announceBrand(workspaceId: string) {
  const ev = { id: workspaceId, deleted: false, brand: true }
  ctx().bus.publish(workspaceId, 'workspace', ev, { id: workspaceId, inline: ev })
}

syncRoutes.put('/brand-kits/:kitId', async (c) => {
  const u = requireUser(c)
  const kitId = c.req.param('kitId')
  const b = await body(c, z.object({ workspaceId: z.string().min(1).max(80), doc: BrandSchema }))
  await requireRole(u.id, b.workspaceId, 'editor')
  const db = ctx().db
  const cur = (await db.select().from(extraBrandKits).where(eq(extraBrandKits.id, kitId)).limit(1))[0]
  if (cur && cur.workspaceId !== b.workspaceId) throw new HttpError(409, 'conflict', 'A brand kit with this id belongs to another space')
  const doc = await checkKitDoc(b.workspaceId, b.doc as BrandKitDoc)
  const now = Date.now()
  if (cur) await db.update(extraBrandKits).set({ doc, updatedAt: now }).where(eq(extraBrandKits.id, kitId))
  else {
    const n = (await db.select({ n: count() }).from(extraBrandKits).where(eq(extraBrandKits.workspaceId, b.workspaceId)))[0]?.n ?? 0
    if (Number(n) >= MAX_EXTRA_KITS) throw new HttpError(409, 'quota', `A space keeps at most ${MAX_EXTRA_KITS + 1} brand kits. Delete one first.`)
    await db.insert(extraBrandKits).values({ id: kitId, workspaceId: b.workspaceId, doc, createdBy: u.id, createdAt: now, updatedAt: now })
  }
  announceBrand(b.workspaceId)
  return c.json({ ok: true, updatedAt: now })
})

syncRoutes.post('/brand-kits/:kitId/delete', async (c) => {
  const u = requireUser(c)
  const row = (await ctx().db.select().from(extraBrandKits).where(eq(extraBrandKits.id, c.req.param('kitId'))).limit(1))[0]
  if (!row) throw notFound('Brand kit not found')
  await requireRole(u.id, row.workspaceId, 'editor')
  await ctx().db.delete(extraBrandKits).where(eq(extraBrandKits.id, row.id))
  announceBrand(row.workspaceId)
  return c.json({ ok: true })
})

async function loadFontRow(fontId: string) {
  const row = (await ctx().db.select().from(brandFonts).where(eq(brandFonts.id, fontId)).limit(1))[0]
  if (!row) throw notFound('Font not found')
  return row
}

syncRoutes.put('/brand-fonts/:fontId', async (c) => {
  const u = requireUser(c)
  const fontId = c.req.param('fontId')
  if (!/^[\w-]{1,80}$/.test(fontId)) throw new HttpError(400, 'invalid', 'Invalid font id')
  const ws = c.req.query('workspaceId') ?? ''
  await requireRole(u.id, ws, 'editor')
  const cur = (await ctx().db.select().from(brandFonts).where(eq(brandFonts.id, fontId)).limit(1))[0]
  if (cur) {
    if (cur.workspaceId !== ws) throw new HttpError(409, 'conflict', 'A font with this id belongs to another space')
    return c.json(fontDto(cur))
  }
  const family = cleanFamily(c.req.query('family') ?? '')
  if (!family) throw new HttpError(400, 'invalid', 'Name the font family (letters, digits and spaces)')
  const weight = Math.round(Number(c.req.query('weight') ?? 400) / 100) * 100
  if (!(weight >= 100 && weight <= 900)) throw new HttpError(400, 'invalid', 'weight: a number from 100 to 900')
  const italic = c.req.query('italic') === '1' || c.req.query('italic') === 'true'
  if (Number(c.req.header('content-length') ?? 0) > BRAND_FONT_MAX_BYTES) throw new HttpError(413, 'quota', 'A font file can be at most 5 MB')
  const buf = Buffer.from(await c.req.arrayBuffer())
  if (!buf.length) throw new HttpError(400, 'invalid', 'Send the font file as the request body')
  if (buf.length > BRAND_FONT_MAX_BYTES) throw new HttpError(413, 'quota', 'A font file can be at most 5 MB')
  const format = sniffFontFormat(buf)
  if (!format) throw new HttpError(415, 'invalid', 'That isn’t a font file: upload a WOFF2, WOFF, TTF or OTF')
  const key = `ws/${ws}/brand-fonts/${fontId}.${format}`
  await ctx().storage.put(key, buf, { contentType: FONT_MIME[format] })
  const [row] = await ctx()
    .db.insert(brandFonts)
    .values({ id: fontId, workspaceId: ws, family, format, weight, italic, storageKey: key, sizeBytes: buf.length, createdBy: u.id, createdAt: Date.now() })
    .returning()
  announceBrand(ws)
  return c.json(fontDto(row))
})

syncRoutes.post('/brand-fonts/:fontId/delete', async (c) => {
  const u = requireUser(c)
  const row = await loadFontRow(c.req.param('fontId'))
  await requireRole(u.id, row.workspaceId, 'editor')
  // a kit still using the family keeps it only while another file of that family is left
  const others = (await ctx().db.select({ id: brandFonts.id, family: brandFonts.family }).from(brandFonts).where(eq(brandFonts.workspaceId, row.workspaceId))).filter((f) => f.family === row.family && f.id !== row.id)
  if (!others.length) {
    const users = (await listKits(row.workspaceId)).filter((k) => k.doc.fonts.headline === row.family || k.doc.fonts.body === row.family)
    if (users.length) throw new HttpError(409, 'conflict', `“${row.family}” is used by ${users.map((k) => `“${k.doc.name}”`).join(', ')}. Pick another font there first.`)
  }
  await ctx().db.delete(brandFonts).where(eq(brandFonts.id, row.id))
  await ctx().storage.delete(row.storageKey).catch(() => undefined)
  announceBrand(row.workspaceId)
  return c.json({ ok: true })
})

syncRoutes.get('/brand-fonts/:fontId/file', async (c) => {
  const u = requireUser(c)
  const row = await loadFontRow(c.req.param('fontId'))
  await requireRole(u.id, row.workspaceId, 'viewer')
  const stream = await ctx().storage.getStream(row.storageKey)
  return new Response(Readable.toWeb(stream) as unknown as ReadableStream, {
    headers: { 'Content-Type': FONT_MIME[row.format as keyof typeof FONT_MIME] ?? 'application/octet-stream', 'Content-Length': String(row.sizeBytes) },
  })
})
