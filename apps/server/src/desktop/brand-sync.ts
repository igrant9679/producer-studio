// A space's other brand kits and its font files on the desktop (R3's extra kits and fonts, synced since R4): they come
// down with the change feed and edits made here go up under their own ids, so a project made with any kit or font can
// be edited offline. Font files (at most 5 MB each) are fetched as soon as they arrive. Local edits win until pushed,
// as for the default kit. The space's own settings (pronunciations, sample project) and each member's settings
// (favourite voices, Voice Studio draft, onboarding) are read and written in the cloud (settings-proxy.ts).
import { buffer } from 'node:stream/consumers'
import { eq } from 'drizzle-orm'
import type { SyncFont, SyncKit } from '@producer/core'
import { ctx } from '../context'
import { brandFonts, extraBrandKits, workspaces } from '../db/schema'
import { localUserId } from './identity'
import { type CloudClient, CloudError } from './cloud'
import { deleteSync, putSync, syncRow, syncRows } from './db'

export type ItemRunner = (kind: 'kit' | 'font', id: string, name: string, fn: () => Promise<void>) => Promise<void>

const fontKey = (workspaceId: string, id: string, format: string) => `ws/${workspaceId}/brand-fonts/${id}.${format}`

/** Open Brand kit pages and editors reload the space's kits. */
function announce(workspaceId: string, quietly: (fn: () => void) => void) {
  const ev = { id: workspaceId, deleted: false, brand: true }
  quietly(() => ctx().bus.publish(workspaceId, 'workspace', ev))
}

async function spaceHere(id: string): Promise<boolean> {
  return (await ctx().db.select({ id: workspaces.id }).from(workspaces).where(eq(workspaces.id, id)).limit(1)).length > 0
}

export async function applyKit(k: SyncKit, quietly: (fn: () => void) => void) {
  const db = ctx().db
  if (!(await spaceHere(k.workspaceId))) return
  const cur = (await db.select().from(extraBrandKits).where(eq(extraBrandKits.id, k.id)).limit(1))[0]
  const s = await syncRow('kit', k.id)
  // edited here since the last sync: ours wins until pushed
  if (cur && s?.localVersion != null && cur.updatedAt !== s.localVersion) return
  if (cur) await db.update(extraBrandKits).set({ doc: k.doc, workspaceId: k.workspaceId, updatedAt: k.updatedAt }).where(eq(extraBrandKits.id, k.id))
  else await db.insert(extraBrandKits).values({ id: k.id, workspaceId: k.workspaceId, doc: k.doc, createdBy: await localUserId(), createdAt: k.updatedAt, updatedAt: k.updatedAt })
  await putSync('kit', k.id, { localVersion: k.updatedAt, uploaded: true })
  announce(k.workspaceId, quietly)
}

export async function applyKitDelete(id: string, quietly: (fn: () => void) => void) {
  const row = (await ctx().db.select().from(extraBrandKits).where(eq(extraBrandKits.id, id)).limit(1))[0]
  // the sync record first: the delete here then isn't pushed back
  await deleteSync('kit', id)
  if (!row) return
  await ctx().db.delete(extraBrandKits).where(eq(extraBrandKits.id, id))
  announce(row.workspaceId, quietly)
}

export async function applyFont(c: CloudClient, f: SyncFont, quietly: (fn: () => void) => void) {
  const db = ctx().db
  if (!(await spaceHere(f.workspaceId))) return
  const cur = (await db.select().from(brandFonts).where(eq(brandFonts.id, f.id)).limit(1))[0]
  const key = cur?.storageKey ?? fontKey(f.workspaceId, f.id, f.format)
  if (!(await ctx().storage.stat(key))) {
    const res = await c.request('GET', `/api/sync/brand-fonts/${encodeURIComponent(f.id)}/file`, { idleTimeoutMs: 60_000 })
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined)
      // gone in the cloud since: its delete comes with the feed
      if (res.status === 404) return
      throw new CloudError(res.status, { error: `The cloud has no file for the font “${f.family}” (HTTP ${res.status})` }, res.status >= 502)
    }
    await ctx().storage.put(key, Buffer.from(await res.arrayBuffer()), { contentType: res.headers.get('content-type') ?? undefined })
  }
  const values = { workspaceId: f.workspaceId, family: f.family, format: f.format, weight: f.weight, italic: f.italic, storageKey: key, sizeBytes: f.sizeBytes }
  if (cur) await db.update(brandFonts).set(values).where(eq(brandFonts.id, f.id))
  else await db.insert(brandFonts).values({ id: f.id, ...values, createdBy: await localUserId(), createdAt: Date.now() })
  await putSync('font', f.id, { uploaded: true })
  announce(f.workspaceId, quietly)
}

export async function applyFontDelete(id: string, quietly: (fn: () => void) => void) {
  const row = (await ctx().db.select().from(brandFonts).where(eq(brandFonts.id, id)).limit(1))[0]
  await deleteSync('font', id)
  if (!row) return
  await ctx().db.delete(brandFonts).where(eq(brandFonts.id, id))
  await ctx().storage.delete(row.storageKey).catch(() => undefined)
  announce(row.workspaceId, quietly)
}

/** Fonts first (a kit naming a font family the cloud doesn't have is refused), then kits. */
export async function pushBrandExtras(c: CloudClient, cloudWs: Set<string>, item: ItemRunner, resolved: (kind: 'kit' | 'font', id: string) => Promise<void>) {
  const db = ctx().db
  const fr = await syncRows('font')
  for (const f of await db.select().from(brandFonts)) {
    if (!cloudWs.has(f.workspaceId)) continue
    if (fr.get(f.id)?.uploaded) {
      await resolved('font', f.id)
      continue
    }
    await item('font', f.id, `Font “${f.family}”`, async () => {
      const file = await buffer(await ctx().storage.getStream(f.storageKey))
      const q = new URLSearchParams({ workspaceId: f.workspaceId, family: f.family, weight: String(f.weight), italic: f.italic ? '1' : '0' })
      const res = await c.request('PUT', `/api/sync/brand-fonts/${encodeURIComponent(f.id)}?${q}`, { body: new Uint8Array(file), headers: { 'content-type': 'application/octet-stream' }, idleTimeoutMs: 60_000 })
      const text = await res.text().catch(() => '')
      // a viewer can't add fonts: it stays on this computer
      if (res.status === 403) return putSync('font', f.id, { uploaded: true })
      if (!res.ok) throw new CloudError(res.status, safeJson(text) ?? { error: text.slice(0, 200) || res.statusText }, res.status >= 502)
      await putSync('font', f.id, { uploaded: true })
    })
  }
  const kr = await syncRows('kit')
  for (const k of await db.select().from(extraBrandKits)) {
    if (!cloudWs.has(k.workspaceId)) continue
    if (kr.get(k.id)?.localVersion === k.updatedAt) {
      await resolved('kit', k.id)
      continue
    }
    await item('kit', k.id, `Brand kit “${k.doc.name}”`, async () => {
      try {
        await c.json('PUT', `/api/sync/brand-kits/${encodeURIComponent(k.id)}`, { workspaceId: k.workspaceId, doc: k.doc })
      } catch (err) {
        // viewers can't edit kits: the cloud's copy comes back with the next change
        if (!(err instanceof CloudError && err.status === 403)) throw err
      }
      await putSync('kit', k.id, { localVersion: k.updatedAt, uploaded: true })
    })
  }
}

/** A kit or font deleted here: gone in the cloud too (already gone there is fine). */
export async function pushBrandDelete(c: CloudClient, kind: 'kit' | 'font', id: string) {
  const s = await syncRow(kind, id)
  if (!s) return
  await c.json('POST', `/api/sync/${kind === 'kit' ? 'brand-kits' : 'brand-fonts'}/${encodeURIComponent(id)}/delete`).catch((err) => {
    if (!(err instanceof CloudError && (err.status === 404 || err.status === 403))) throw err
  })
  await deleteSync(kind, id)
}

/** After a full resync: kits and fonts this computer had from the cloud that the cloud no longer has. */
export async function dropUnseenBrand(live: Set<string>, seen: { kits: Set<string>; fonts: Set<string> }, quietly: (fn: () => void) => void) {
  const db = ctx().db
  const [kr, fr] = await Promise.all([syncRows('kit'), syncRows('font')])
  for (const k of await db.select({ id: extraBrandKits.id, ws: extraBrandKits.workspaceId }).from(extraBrandKits)) if (live.has(k.ws) && kr.get(k.id)?.uploaded && !seen.kits.has(k.id)) await applyKitDelete(k.id, quietly)
  for (const f of await db.select({ id: brandFonts.id, ws: brandFonts.workspaceId }).from(brandFonts)) if (live.has(f.ws) && fr.get(f.id)?.uploaded && !seen.fonts.has(f.id)) await applyFontDelete(f.id, quietly)
}

function safeJson(text: string): { error: string } | undefined {
  try {
    return JSON.parse(text) as { error: string }
  } catch {
    return undefined
  }
}
