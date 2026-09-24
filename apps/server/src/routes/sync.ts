// System info (public), device tokens, and the cloud change feed used by desktop replicas.
import fs from 'node:fs'
import { createRequire } from 'node:module'
import { Hono } from 'hono'
import { and, asc, desc, eq, gt, inArray } from 'drizzle-orm'
import * as z from 'zod/v4'
import type { Device, SyncChanges, SystemInfo } from '@producer/core'
import { type AppEnv, requireUser } from '../auth'
import { ctx } from '../context'
import { assets, brandKits, devices, memberships, projects, tombstones, workspaces } from '../db/schema'
import { assetRecord, projectSummary } from '../dto'
import { HttpError, body, memberRole, notFound, unauthorized } from '../http'
import { newId, randomToken, sha256 } from '../ids'
import { getProvider } from '../ai/provider'
import { builtinProvider, invalidateBuiltin } from '../ai/resolve'
import { whisperAvailable } from '../ai/whisper'
import { hydrateAssets } from '../services/projects'
import { checkCredentials } from './auth'
import { listWorkspaces } from './workspaces'

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

const deviceDto = (d: typeof devices.$inferSelect): Device => ({ id: d.id, name: d.name, createdAt: d.createdAt, lastSeenAt: d.lastSeenAt ?? undefined })

/**
 * Create a device token. Authenticated with the session cookie / an existing device token, or directly with
 * {email, password} so a desktop app can link without handling cookies. The token is returned once.
 */
deviceRoutes.post('/', async (c) => {
  const b = await body(c, z.object({ name: z.string().trim().min(1).max(100), email: z.string().max(254).optional(), password: z.string().max(200).optional() }))
  let user = c.get('user')
  if (!user && b.email && b.password) user = await checkCredentials(c, b.email, b.password)
  if (!user) throw unauthorized()
  const token = `psd_${randomToken(32)}`
  const id = newId('dev')
  await ctx().db.insert(devices).values({ id, userId: user.id, name: b.name, tokenHash: sha256(token), createdAt: Date.now() })
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

/** Changes after `since` across the user's workspaces, merged by change_seq and paged. */
export async function changesSince(userId: string, since: number, limit: number): Promise<SyncChanges> {
  const db = ctx().db
  const mine = await db.select({ ws: memberships.workspaceId, seq: memberships.changeSeq }).from(memberships).where(eq(memberships.userId, userId))
  const wsIds = mine.map((m) => m.ws)
  if (!wsIds.length) return { cursor: since, workspaces: [], projects: [], assets: [], brandKits: [], deleted: { projects: [], assets: [] }, more: false }
  const n = limit + 1
  const [p, a, b, t, w] = await Promise.all([
    db.select().from(projects).where(and(inArray(projects.workspaceId, wsIds), gt(projects.changeSeq, since))).orderBy(asc(projects.changeSeq)).limit(n),
    db.select().from(assets).where(and(inArray(assets.workspaceId, wsIds), gt(assets.changeSeq, since))).orderBy(asc(assets.changeSeq)).limit(n),
    db.select().from(brandKits).where(and(inArray(brandKits.workspaceId, wsIds), gt(brandKits.changeSeq, since))).orderBy(asc(brandKits.changeSeq)).limit(n),
    db.select().from(tombstones).where(and(inArray(tombstones.workspaceId, wsIds), gt(tombstones.changeSeq, since))).orderBy(asc(tombstones.changeSeq)).limit(n),
    db.select({ id: workspaces.id, seq: workspaces.changeSeq }).from(workspaces).where(and(inArray(workspaces.id, wsIds), gt(workspaces.changeSeq, since))),
  ])
  const all: Change[] = [
    ...p.map((row) => ({ seq: row.changeSeq ?? 0, kind: 'project' as const, row })),
    ...a.map((row) => ({ seq: row.changeSeq ?? 0, kind: 'asset' as const, row })),
    ...b.map((row) => ({ seq: row.changeSeq ?? 0, kind: 'brand' as const, row })),
    ...t.map((row) => ({ seq: row.changeSeq, kind: 'tombstone' as const, row })),
    ...w.map((row) => ({ seq: row.seq ?? 0, kind: 'workspace' as const, id: row.id })),
    ...mine.filter((m) => (m.seq ?? 0) > since).map((m) => ({ seq: m.seq ?? 0, kind: 'workspace' as const, id: m.ws })),
  ].sort((x, y) => x.seq - y.seq)
  const page = all.slice(0, limit)
  const more = all.length > limit
  const cursor = page.length ? page[page.length - 1].seq : since
  const out: SyncChanges = { cursor, workspaces: [], projects: [], assets: [], brandKits: [], deleted: { projects: [], assets: [] }, more }
  const wsChanged = new Set<string>()
  for (const ch of page) {
    if (ch.kind === 'project') {
      out.projects.push({ summary: projectSummary(ch.row), project: await hydrateAssets(ch.row.doc, ch.row.workspaceId), version: ch.row.version, changeSeq: ch.seq })
    } else if (ch.kind === 'asset') {
      out.assets.push({ ...assetRecord(ch.row), sha256: ch.row.sha256 ?? undefined, changeSeq: ch.seq })
    } else if (ch.kind === 'brand') {
      out.brandKits.push({ workspaceId: ch.row.workspaceId, doc: ch.row.doc, changeSeq: ch.seq })
    } else if (ch.kind === 'tombstone') {
      if (ch.row.kind === 'project') out.deleted.projects.push(ch.row.id)
      else if (ch.row.kind === 'asset') out.deleted.assets.push(ch.row.id)
    } else wsChanged.add(ch.id)
  }
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
  if (!Number.isFinite(since)) throw new HttpError(400, 'invalid', 'since must be a number')
  return c.json(await changesSince(u.id, since, limit))
})
