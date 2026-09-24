// Desktop ⇄ cloud sync engine. The cloud is the source of truth; this replica works fully offline.
//   link   — credentials → cloud device token (encrypted at rest); the local user adopts the cloud identity; cloud
//            workspaces are mirrored with the same ids; local-only workspaces are merged (personal → cloud personal,
//            others created in the cloud) so every local project has a cloud home.
//   pull   — GET /api/sync/changes?since=<cursor − lookback>, paged: workspaces, asset records (bytes on demand),
//            projects (never overwriting a dirty local copy; cloud advanced + local dirty ⇒ conflict), brand kits,
//            tombstones.
//   push   — local hard deletes; local-only assets (upload with the same id + sha256, 409 exists ⇒ done); dirty
//            projects (PUT with baseVersion = cloud_version; 409 ⇒ conflict) and new ones (POST with id); brand kits.
//   resolve— keep-local (force-push over the latest cloud version), keep-cloud, keep-both (local → "(conflicted copy)").
// Runs on start, every 60 s, and 3 s after local saves; backs off while offline; SSE `sync` carries SyncStatus.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { and, eq, inArray, sql } from 'drizzle-orm'
import { uid, type AssetRecord, type BrandKitDoc, type MeResponse, type Project, type ProjectDocResponse, type SyncChanges, type SyncProject, type SyncStatus, type UploadTicket, type Workspace } from '@producer/core'
import { ctx } from '../context'
import { type AssetMeta, assets, brandKits, memberships, projects, workspaces } from '../db/schema'
import { HttpError } from '../http'
import { log } from '../log'
import { assetPrefix, extFor, hashObject } from '../services/assets'
import { derived, hydrateAssets, insertProject } from '../services/projects'
import { CloudClient, CloudError, normalizeCloudUrl } from './cloud'
import { clearSync, deleteSync, kvGet, kvSet, putSync, rawQuery, syncRow, syncRows, type SyncRow } from './db'
import { adoptCloudIdentity, localUserId } from './identity'
import { clearLink, cloud, linkInfo, loadLink, saveLink } from './link'
import { prefetchAllMedia } from './media'
import { getSettings, onSettingsChange } from './settings'

const LOOKBACK = 25
const PAGE = 200
const INTERVAL_MS = 60_000
const AFTER_SAVE_MS = 3_000
const MAX_BACKOFF_MS = 5 * 60_000

type ProjectRow = typeof projects.$inferSelect

const mediaId = (url?: string) => url?.match(/^\/api\/media\/([^/]+)\//)?.[1] ?? null

function isDirty(p: Pick<ProjectRow, 'version' | 'trashedAt' | 'isTemplate'>, s: SyncRow | undefined): boolean {
  if (!s || s.cloudVersion == null) return true
  if (s.localVersion !== p.version) return true
  if (s.cloudTrashed != null && s.cloudTrashed !== (p.trashedAt != null)) return true
  if (s.cloudTemplate != null && s.cloudTemplate !== p.isTemplate) return true
  return false
}

export class SyncEngine {
  private state: SyncStatus['state'] = 'unlinked'
  private lastSyncAt?: number
  private error?: string
  private running?: Promise<void>
  private rerun = false
  private interval?: NodeJS.Timeout
  private debounce?: NodeJS.Timeout
  private backoffUntil = 0
  private backoffMs = 0
  private suppress = 0
  private unsubs: Array<() => void> = []
  private stopped = false

  async start() {
    const link = await loadLink()
    this.state = link ? (cloud() ? 'idle' : 'error') : 'unlinked'
    if (link && !cloud()) this.error = 'The saved cloud credentials could not be decrypted on this computer. Link your account again.'
    this.lastSyncAt = (await kvGet<number>('lastSyncAt')) ?? undefined
    this.unsubs.push(
      ctx().bus.onAny((e) => {
        if (this.suppress || (e.event !== 'project' && e.event !== 'asset')) return
        if (getSettings().autoSync) this.schedule(AFTER_SAVE_MS)
      }),
      onSettingsChange((s, prev) => {
        if (s.autoSync && !prev.autoSync) this.schedule(500)
        if (s.mediaSync === 'all' && prev.mediaSync !== 'all' && cloud()) void prefetchAllMedia()
      }),
    )
    this.interval = setInterval(() => {
      if (getSettings().autoSync && Date.now() >= this.backoffUntil) this.schedule(0)
    }, INTERVAL_MS)
    this.interval.unref()
    if (link && getSettings().autoSync) this.schedule(1000)
  }

  stop() {
    this.stopped = true
    if (this.interval) clearInterval(this.interval)
    if (this.debounce) clearTimeout(this.debounce)
    for (const u of this.unsubs) u()
    this.unsubs = []
  }

  /** Run a cycle after `ms` (debounced). */
  schedule(ms: number) {
    if (this.stopped || !linkInfo()) return
    if (this.debounce) clearTimeout(this.debounce)
    this.debounce = setTimeout(() => void this.syncNow().catch(() => undefined), ms)
    this.debounce.unref?.()
  }

  // ---------------- status ----------------

  async status(): Promise<SyncStatus> {
    const link = linkInfo()
    if (!link) return { linked: false, state: 'unlinked', pending: await this.pendingCount().catch(() => 0), conflicts: [], ...(this.error && this.state === 'error' ? { error: this.error } : {}) }
    const rows = await syncRows('project')
    const conflicted = [...rows.values()].filter((r) => r.conflictVersion != null)
    const names = conflicted.length ? await ctx().db.select({ id: projects.id, name: projects.name, version: projects.version }).from(projects).where(inArray(projects.id, conflicted.map((c) => c.id))) : []
    return {
      linked: true,
      cloudUrl: link.cloudUrl,
      account: link.account,
      state: this.state,
      lastSyncAt: this.lastSyncAt,
      pending: await this.pendingCount(rows),
      conflicts: names.map((n) => ({ projectId: n.id, name: n.name, localVersion: n.version, cloudVersion: conflicted.find((c) => c.id === n.id)!.conflictVersion! })),
      ...(this.error ? { error: this.error } : {}),
    }
  }

  private async pendingCount(rows?: Map<string, SyncRow>): Promise<number> {
    const pr = rows ?? (await syncRows('project'))
    const local = await ctx().db.select({ id: projects.id, version: projects.version, trashedAt: projects.trashedAt, isTemplate: projects.isTemplate }).from(projects)
    let n = local.filter((p) => pr.get(p.id)?.conflictVersion == null && isDirty(p, pr.get(p.id))).length
    const ar = await syncRows('asset')
    const la = await ctx().db.select({ id: assets.id, origin: assets.origin, status: assets.status }).from(assets)
    n += la.filter((a) => a.origin !== 'render' && a.status !== 'uploading' && !ar.get(a.id)?.uploaded && !ar.get(a.id)?.remote).length
    return n
  }

  private async emit() {
    const s = await this.status().catch(() => undefined)
    if (!s) return
    const ws = await ctx().db.select({ id: memberships.workspaceId }).from(memberships)
    this.suppress++
    try {
      for (const w of new Set(ws.map((x) => x.id))) ctx().bus.publish(w, 'sync', s)
    } finally {
      this.suppress--
    }
  }

  private setState(state: SyncStatus['state'], error?: string) {
    this.state = state
    this.error = error
    void this.emit()
  }

  // ---------------- link / unlink ----------------

  async link(cloudUrlIn: string, email: string, password: string): Promise<SyncStatus> {
    if (linkInfo()) throw new HttpError(409, 'conflict', `Already linked to ${linkInfo()!.account}. Unlink first.`)
    let cloudUrl: string
    try {
      cloudUrl = normalizeCloudUrl(cloudUrlIn)
    } catch (err) {
      throw new HttpError(400, 'invalid', (err as Error).message)
    }
    const anon = new CloudClient(cloudUrl)
    let dev: { deviceId: string; token: string }
    try {
      dev = await anon.json('POST', '/api/devices', { name: `Producer Studio desktop · ${os.hostname()}`.slice(0, 100), email, password })
    } catch (err) {
      if (err instanceof CloudError && err.status === 401) throw new HttpError(401, 'unauthorized', 'The cloud rejected that email or password.')
      if (err instanceof CloudError && err.status === 429) throw new HttpError(429, 'quota', err.message)
      if (err instanceof CloudError && err.offline) throw new HttpError(502, 'server', `Couldn’t reach ${cloudUrl}. Check the URL and your connection.`)
      if (err instanceof CloudError && err.status === 404) throw new HttpError(502, 'server', `${cloudUrl} doesn’t look like a Producer Studio cloud (no device API).`)
      throw err
    }
    const c = new CloudClient(cloudUrl, dev.token)
    const me = await c.json<MeResponse>('GET', '/api/auth/me')
    const last = await kvGet<{ cloudUrl: string; cloudUserId: string }>('lastLink')
    if (!last || last.cloudUrl !== cloudUrl || last.cloudUserId !== me.user.id) {
      // a different account/cloud: nothing we know about sync state applies
      await clearSync()
      await kvSet('cursor', 0)
    }
    await adoptCloudIdentity(me.user)
    await this.mirrorWorkspaces(me.workspaces)
    await this.mergeLocalWorkspaces(c, me.workspaces)
    const tomb = await rawQuery<{ m: string | null }>(sql`SELECT max(change_seq)::text AS m FROM tombstones`)
    await kvSet('tombCursor', Number(tomb[0]?.m ?? 0))
    await saveLink({ cloudUrl, account: me.user.email, cloudUserId: me.user.id, deviceId: dev.deviceId, linkedAt: Date.now() }, dev.token)
    this.backoffMs = 0
    this.backoffUntil = 0
    this.state = 'idle'
    this.error = undefined
    log.info('desktop: linked', { cloudUrl, account: me.user.email })
    this.schedule(0)
    return { ...(await this.status()), state: 'syncing' }
  }

  async unlink(): Promise<SyncStatus> {
    const link = linkInfo()
    const c = cloud()
    if (link && c) await c.json('DELETE', `/api/devices/${encodeURIComponent(link.deviceId)}`, undefined, 10_000).catch(() => undefined)
    await clearLink()
    this.state = 'unlinked'
    this.error = undefined
    void this.emit()
    return this.status()
  }

  // ---------------- cycle ----------------

  /** Run one full cycle (coalesced with a running one) and return the resulting status. */
  async syncNow(): Promise<SyncStatus> {
    if (!linkInfo()) return this.status()
    if (!cloud()) {
      this.setState('error', 'The saved cloud credentials could not be decrypted on this computer. Link your account again.')
      return this.status()
    }
    if (this.running) {
      this.rerun = true
      await this.running
      return this.status()
    }
    this.running = (async () => {
      do {
        this.rerun = false
        await this.cycle()
      } while (this.rerun && !this.stopped)
    })().finally(() => {
      this.running = undefined
    })
    await this.running
    return this.status()
  }

  private async cycle() {
    const c = cloud()
    if (!c) return
    this.setState('syncing', undefined)
    try {
      await this.pushDeletes(c)
      await this.pull(c)
      await this.pushAssets(c)
      await this.pushProjects(c)
      await this.pushBrandKits(c)
      this.lastSyncAt = Date.now()
      await kvSet('lastSyncAt', this.lastSyncAt)
      this.backoffMs = 0
      this.backoffUntil = 0
      this.setState('idle')
      if (getSettings().mediaSync === 'all') void prefetchAllMedia()
    } catch (err) {
      if (err instanceof CloudError && err.offline) {
        this.backoffMs = Math.min(MAX_BACKOFF_MS, Math.max(5000, this.backoffMs * 2))
        this.backoffUntil = Date.now() + this.backoffMs
        this.setState('offline', undefined)
        log.info('desktop: cloud offline, backing off', { ms: this.backoffMs })
        this.schedule(this.backoffMs)
      } else if (err instanceof CloudError && err.status === 401) {
        this.setState('error', 'The cloud no longer accepts this computer’s device token (it may have been revoked). Unlink and link again.')
      } else {
        log.warn('desktop: sync failed', { err })
        this.setState('error', err instanceof Error ? err.message : String(err))
      }
    }
  }

  // ---------------- workspaces ----------------

  private async mirrorWorkspaces(list: Workspace[]) {
    const db = ctx().db
    const me = await localUserId()
    const now = Date.now()
    for (const w of list) {
      await db
        .insert(workspaces)
        .values({ id: w.id, name: w.name, personal: w.personal, createdBy: me, createdAt: now })
        .onConflictDoUpdate({ target: workspaces.id, set: { name: w.name, personal: w.personal } })
      const has = await db.select({ role: memberships.role }).from(memberships).where(and(eq(memberships.workspaceId, w.id), eq(memberships.userId, me))).limit(1)
      if (!has.length) await db.insert(memberships).values({ workspaceId: w.id, userId: me, role: w.role, createdAt: now })
      else if (has[0].role !== w.role) await db.update(memberships).set({ role: w.role }).where(and(eq(memberships.workspaceId, w.id), eq(memberships.userId, me)))
    }
    await kvSet('cloudWorkspaces', [...new Set([...((await kvGet<string[]>('cloudWorkspaces')) ?? []), ...list.map((w) => w.id)])])
  }

  /** Move everything in a local workspace into another (same ids for projects/assets; storage keys unchanged). */
  private async rehomeWorkspace(from: string, to: string) {
    await ctx().db.transaction(async (tx) => {
      for (const t of ['projects', 'assets', 'jobs', 'exports']) await tx.execute(sql.raw(`UPDATE ${t} SET workspace_id = '${to.replace(/'/g, "''")}' WHERE workspace_id = '${from.replace(/'/g, "''")}'`))
      await tx.execute(sql`DELETE FROM brand_kits WHERE workspace_id = ${from}`)
      await tx.execute(sql`DELETE FROM memberships WHERE workspace_id = ${from}`)
      await tx.execute(sql`DELETE FROM workspaces WHERE id = ${from}`)
    })
    log.info('desktop: merged local workspace', { from, to })
  }

  private async mergeLocalWorkspaces(c: CloudClient, cloudList: Workspace[]) {
    const me = await localUserId()
    const cloudIds = new Set(cloudList.map((w) => w.id))
    const personal = cloudList.find((w) => w.personal) ?? cloudList[0]
    const local = await ctx()
      .db.select({ id: workspaces.id, name: workspaces.name, personal: workspaces.personal })
      .from(workspaces)
      .innerJoin(memberships, eq(memberships.workspaceId, workspaces.id))
      .where(eq(memberships.userId, me))
    for (const w of local) {
      if (cloudIds.has(w.id)) continue
      if (w.personal && personal) await this.rehomeWorkspace(w.id, personal.id)
      else {
        const created = await c.json<Workspace>('POST', '/api/workspaces', { name: w.name })
        await this.mirrorWorkspaces([created])
        await this.rehomeWorkspace(w.id, created.id)
      }
    }
  }

  /** Create a workspace while linked: in the cloud first (the cloud assigns the id), then mirrored locally. */
  async createWorkspace(name: string): Promise<Workspace | null> {
    const c = cloud()
    if (!c) return null
    const w = await c.json<Workspace>('POST', '/api/workspaces', { name })
    await this.mirrorWorkspaces([w])
    return w
  }

  // ---------------- pull ----------------

  private async pull(c: CloudClient) {
    let cursor = (await kvGet<number>('cursor')) ?? 0
    let since = Math.max(0, cursor - LOOKBACK)
    for (let page = 0; page < 1000; page++) {
      const ch = await c.json<SyncChanges>('GET', `/api/sync/changes?since=${since}&limit=${PAGE}`)
      if (ch.workspaces.length) await this.mirrorWorkspaces(ch.workspaces)
      const known = new Set((await ctx().db.select({ id: workspaces.id }).from(workspaces)).map((w) => w.id))
      const missingWs = [...ch.projects.map((p) => p.summary.workspaceId), ...ch.assets.map((a) => a.workspaceId)].filter((w) => !known.has(w))
      if (missingWs.length) await this.mirrorWorkspaces(await c.json<Workspace[]>('GET', '/api/workspaces'))
      for (const a of ch.assets) await this.applyAsset(a)
      for (const p of ch.projects) await this.applyProject(p)
      for (const b of ch.brandKits) await this.applyBrand(b.workspaceId, b.doc)
      for (const id of ch.deleted.assets) await this.applyAssetDelete(id)
      for (const id of ch.deleted.projects) await this.applyProjectDelete(id)
      cursor = Math.max(cursor, ch.cursor)
      await kvSet('cursor', cursor)
      if (!ch.more) break
      since = ch.cursor
    }
  }

  private async applyAsset(rec: AssetRecord & { sha256?: string; changeSeq: number }) {
    const db = ctx().db
    const a = rec.asset
    const row = (await db.select().from(assets).where(eq(assets.id, a.id)).limit(1))[0]
    const s = await syncRow('asset', a.id)
    if (row && !s?.remote) {
      // our own upload echoed back (or an id we already hold locally): local bytes and derived files win
      if (!s?.uploaded) await putSync('asset', a.id, { uploaded: true, remote: false })
      return
    }
    const prefix = assetPrefix(rec.workspaceId, a.id)
    const meta: AssetMeta = {
      duration: a.duration,
      width: a.width,
      height: a.height,
      fps: a.fps,
      hasAudio: a.hasAudio,
      filmstrip: a.filmstrip ? { frames: a.filmstrip.frames, frameWidth: a.filmstrip.frameWidth, frameHeight: a.filmstrip.frameHeight } : undefined,
      waveform: a.waveform,
      transcript: a.transcript,
      silences: a.silences,
    }
    const values = {
      workspaceId: rec.workspaceId,
      kind: a.kind,
      name: a.name,
      mime: a.mime ?? 'application/octet-stream',
      size: a.sizeBytes ?? 0,
      status: rec.status,
      origin: rec.origin,
      error: rec.error ?? null,
      sourceKey: row?.sourceKey ?? `${prefix}/source${extFor(a.name, a.mime ?? '')}`,
      proxyKey: a.proxySrc ? (row?.proxyKey ?? `${prefix}/proxy.mp4`) : null,
      thumbKey: a.thumbnail ? (row?.thumbKey ?? `${prefix}/thumb.jpg`) : null,
      filmstripKey: a.filmstrip ? (row?.filmstripKey ?? `${prefix}/filmstrip.jpg`) : null,
      audioKey: null,
      meta,
      sha256: rec.sha256 ?? null,
      updatedAt: Date.now(),
    }
    this.suppress++
    try {
      const [saved] = row
        ? await db.update(assets).set(values).where(eq(assets.id, a.id)).returning()
        : await db
            .insert(assets)
            .values({ id: a.id, ...values, createdBy: await localUserId(), createdAt: a.createdAt ?? rec.createdAt ?? Date.now() })
            .returning()
      await putSync('asset', a.id, { remote: true, uploaded: true })
      const { emitAsset } = await import('../services/assets')
      emitAsset(saved)
    } finally {
      this.suppress--
    }
  }

  /** Write a cloud document over the local copy (or insert it). Returns false if a local save raced us. */
  private async writeCloudProject(sp: { summary: SyncProject['summary']; project: Project; version: number }, local: ProjectRow | undefined): Promise<boolean> {
    const db = ctx().db
    const doc = sp.project
    const base = {
      workspaceId: sp.summary.workspaceId,
      kind: sp.summary.kind,
      doc,
      ...derived(doc),
      thumbnail: mediaId(sp.summary.thumbnailUrl),
      isTemplate: sp.summary.isTemplate,
      trashedAt: sp.summary.trashed ? (local?.trashedAt ?? Date.now()) : null,
      updatedAt: sp.summary.updatedAt,
    }
    let saved: ProjectRow | undefined
    this.suppress++
    try {
      if (!local) {
        ;[saved] = await db
          .insert(projects)
          .values({ id: doc.id, ...base, version: sp.version, createdBy: sp.summary.createdBy, createdAt: sp.summary.createdAt })
          .onConflictDoNothing()
          .returning()
      } else {
        ;[saved] = await db
          .update(projects)
          .set({ ...base, version: local.version + 1 })
          .where(and(eq(projects.id, local.id), eq(projects.version, local.version)))
          .returning()
      }
      if (!saved) return false
      await putSync('project', saved.id, { cloudVersion: sp.version, localVersion: saved.version, conflictVersion: null, cloudTrashed: sp.summary.trashed, cloudTemplate: sp.summary.isTemplate })
      // the open editor reloads silently on `project` events when it has no unsaved edits
      ctx().bus.publish(saved.workspaceId, 'project', { id: saved.id, version: saved.version })
      return true
    } finally {
      this.suppress--
    }
  }

  private async applyProject(sp: SyncProject) {
    const id = sp.project.id
    const s = await syncRow('project', id)
    if (s?.cloudVersion != null && sp.version <= s.cloudVersion) return // already applied (or our own push)
    if (s?.conflictVersion != null && sp.version <= s.conflictVersion) return
    const local = (await ctx().db.select().from(projects).where(eq(projects.id, id)).limit(1))[0]
    if (local && isDirty(local, s)) {
      await putSync('project', id, { conflictVersion: sp.version })
      log.info('desktop: sync conflict', { projectId: id, localVersion: local.version, cloudVersion: sp.version })
      return
    }
    if (!(await this.writeCloudProject(sp, local))) await putSync('project', id, { conflictVersion: sp.version })
  }

  private async applyBrand(workspaceId: string, doc: BrandKitDoc) {
    const s = await syncRow('brand', workspaceId)
    const cur = (await ctx().db.select().from(brandKits).where(eq(brandKits.workspaceId, workspaceId)).limit(1))[0]
    // local edits since the last sync win until pushed
    if (cur && s?.localVersion != null && cur.updatedAt !== s.localVersion) return
    const now = Date.now()
    await ctx()
      .db.insert(brandKits)
      .values({ workspaceId, doc, updatedAt: now })
      .onConflictDoUpdate({ target: brandKits.workspaceId, set: { doc, updatedAt: now } })
    await putSync('brand', workspaceId, { localVersion: now })
  }

  private async applyAssetDelete(id: string) {
    const row = (await ctx().db.select().from(assets).where(eq(assets.id, id)).limit(1))[0]
    await deleteSync('asset', id)
    if (!row) return
    this.suppress++
    try {
      await ctx().db.delete(assets).where(eq(assets.id, id))
      await ctx().storage.deletePrefix(assetPrefix(row.workspaceId, id) + '/').catch(() => undefined)
    } finally {
      this.suppress--
    }
  }

  private async applyProjectDelete(id: string) {
    const local = (await ctx().db.select().from(projects).where(eq(projects.id, id)).limit(1))[0]
    const s = await syncRow('project', id)
    await deleteSync('project', id)
    if (!local) return
    // edited here since: keep it; with no sync row it is pushed again as a new cloud project
    if (isDirty(local, s)) return
    this.suppress++
    try {
      await ctx().db.delete(projects).where(eq(projects.id, id))
    } finally {
      this.suppress--
    }
  }

  // ---------------- push ----------------

  private async pushDeletes(c: CloudClient) {
    let cursor = (await kvGet<number>('tombCursor')) ?? 0
    const rows = await rawQuery<{ kind: string; id: string; seq: string }>(sql`SELECT kind, id, change_seq::text AS seq FROM tombstones WHERE change_seq > ${cursor} ORDER BY change_seq`)
    for (const t of rows) {
      const kind = t.kind === 'project' ? 'project' : 'asset'
      const s = await syncRow(kind, t.id)
      if (s && (kind === 'project' ? s.cloudVersion != null : s.uploaded)) {
        try {
          if (kind === 'project') {
            await c.json('PATCH', `/api/projects/${encodeURIComponent(t.id)}`, { trashed: true }).catch((e) => {
              if (!(e instanceof CloudError && e.status === 404)) throw e
            })
            await c.json('DELETE', `/api/projects/${encodeURIComponent(t.id)}`)
          } else await c.json('DELETE', `/api/assets/${encodeURIComponent(t.id)}`)
        } catch (err) {
          if (!(err instanceof CloudError && (err.status === 404 || err.status === 403))) throw err
        }
      }
      if (s) await deleteSync(kind, t.id)
      cursor = Number(t.seq)
      await kvSet('tombCursor', cursor)
    }
  }

  private async pushAssets(c: CloudClient) {
    const cloudWs = new Set((await kvGet<string[]>('cloudWorkspaces')) ?? [])
    const rows = await syncRows('asset')
    const local = await ctx().db.select().from(assets)
    for (const a of local) {
      const s = rows.get(a.id)
      if (s?.uploaded || s?.remote || a.origin === 'render' || a.status === 'uploading' || !cloudWs.has(a.workspaceId)) continue
      if (!(await ctx().storage.stat(a.sourceKey))) continue
      let sha = a.sha256
      if (!sha) {
        sha = await hashObject(a.sourceKey)
        await ctx().db.update(assets).set({ sha256: sha }).where(eq(assets.id, a.id))
      }
      const ext = path.extname(a.sourceKey)
      const filename = path.extname(a.name) ? a.name : `${a.name}${ext}`
      let ticket: UploadTicket
      try {
        ticket = await c.json<UploadTicket>('POST', '/api/uploads', { workspaceId: a.workspaceId, filename, mime: a.mime, size: a.size, assetId: a.id, sha256: sha, ...(a.projectId ? { projectId: a.projectId } : {}) })
      } catch (err) {
        if (err instanceof CloudError && err.status === 409 && (err.body?.details as { exists?: boolean } | undefined)?.exists) {
          await putSync('asset', a.id, { uploaded: true, remote: false })
          continue
        }
        throw err
      }
      const file = ctx().storage.localPath?.(a.sourceKey)
      if (!file) continue
      const bytes = fs.statSync(file).size
      const body = Readable.toWeb(fs.createReadStream(file)) as unknown as ReadableStream
      const put = await c.request('PUT', ticket.url, { body, headers: { ...ticket.headers, 'content-length': String(bytes) } })
      if (!put.ok) {
        const text = await put.text().catch(() => '')
        let parsed: { error?: string } | undefined
        try {
          parsed = JSON.parse(text)
        } catch {
          /* not json */
        }
        throw new CloudError(put.status, { error: `Upload of ${a.name} failed: ${parsed?.error ?? (text.slice(0, 200) || put.statusText)}` })
      }
      await put.body?.cancel().catch(() => undefined)
      await c.json('POST', `/api/assets/${encodeURIComponent(a.id)}/complete`)
      await putSync('asset', a.id, { uploaded: true, remote: false })
      log.info('desktop: uploaded asset', { assetId: a.id, bytes })
    }
  }

  private async pushProject(c: CloudClient, p: ProjectRow, s: SyncRow | undefined): Promise<void> {
    const doc = await hydrateAssets(p.doc, p.workspaceId)
    const trashed = p.trashedAt != null
    let cloudVersion: number
    let cloudTrashed = s?.cloudTrashed ?? false
    let cloudTemplate = s?.cloudTemplate ?? false
    const create = async () => {
      const r = await c.json<ProjectDocResponse>('POST', '/api/projects', { id: p.id, workspaceId: p.workspaceId, project: doc, kind: p.kind === 'producer' ? 'producer' : 'edit', name: p.name })
      cloudTrashed = r.summary.trashed
      cloudTemplate = r.summary.isTemplate
      // an idempotent retry can return an existing cloud copy: bring it up to date with ours
      if (r.version !== 1 || JSON.stringify(r.project.tracks) !== JSON.stringify(doc.tracks)) {
        return (await c.json<{ version: number }>('PUT', `/api/projects/${encodeURIComponent(p.id)}`, { project: doc, baseVersion: r.version })).version
      }
      return r.version
    }
    if (s?.cloudVersion == null) {
      try {
        cloudVersion = await create()
      } catch (err) {
        if (err instanceof CloudError && err.status === 409) throw new CloudError(409, { error: `“${p.name}” has an id that already exists in another cloud workspace; duplicate it to sync a copy.` })
        throw err
      }
    } else if (s.localVersion !== p.version) {
      try {
        cloudVersion = (await c.json<{ version: number }>('PUT', `/api/projects/${encodeURIComponent(p.id)}`, { project: doc, baseVersion: s.cloudVersion })).version
      } catch (err) {
        if (err instanceof CloudError && err.status === 409) {
          const v = (err.body?.details as { version?: number } | undefined)?.version ?? s.cloudVersion + 1
          await putSync('project', p.id, { conflictVersion: v })
          log.info('desktop: push conflict', { projectId: p.id, cloudVersion: v })
          return
        }
        if (err instanceof CloudError && err.status === 404) cloudVersion = await create()
        else throw err
      }
    } else cloudVersion = s.cloudVersion
    if (trashed !== cloudTrashed || p.isTemplate !== cloudTemplate) {
      const sum = await c.json<{ trashed: boolean; isTemplate: boolean }>('PATCH', `/api/projects/${encodeURIComponent(p.id)}`, { trashed, isTemplate: p.isTemplate })
      cloudTrashed = sum.trashed
      cloudTemplate = sum.isTemplate
    }
    await putSync('project', p.id, { cloudVersion, localVersion: p.version, conflictVersion: null, cloudTrashed, cloudTemplate })
  }

  private async pushProjects(c: CloudClient) {
    const cloudWs = new Set((await kvGet<string[]>('cloudWorkspaces')) ?? [])
    const rows = await syncRows('project')
    const local = await ctx().db.select().from(projects)
    const errors: string[] = []
    for (const p of local) {
      const s = rows.get(p.id)
      if (s?.conflictVersion != null || !isDirty(p, s) || !cloudWs.has(p.workspaceId)) continue
      try {
        await this.pushProject(c, p, s)
      } catch (err) {
        if (err instanceof CloudError && (err.offline || err.status === 401)) throw err
        errors.push(err instanceof Error ? err.message : String(err))
        log.warn('desktop: project push failed', { projectId: p.id, err })
      }
    }
    if (errors.length) throw new Error(errors[0])
  }

  private async pushBrandKits(c: CloudClient) {
    const cloudWs = new Set((await kvGet<string[]>('cloudWorkspaces')) ?? [])
    const rows = await syncRows('brand')
    for (const b of await ctx().db.select().from(brandKits)) {
      if (!cloudWs.has(b.workspaceId)) continue
      const s = rows.get(b.workspaceId)
      if (s?.localVersion === b.updatedAt) continue
      try {
        await c.json('PUT', `/api/workspaces/${encodeURIComponent(b.workspaceId)}/brand`, b.doc)
      } catch (err) {
        if (err instanceof CloudError && err.status === 403) {
          // viewers can't edit the brand kit; drop the local change on the next pull
          await putSync('brand', b.workspaceId, { localVersion: b.updatedAt })
          continue
        }
        throw err
      }
      await putSync('brand', b.workspaceId, { localVersion: b.updatedAt })
    }
  }

  // ---------------- conflicts ----------------

  async resolve(projectId: string, mode: 'keep-local' | 'keep-cloud' | 'keep-both'): Promise<SyncStatus> {
    const c = cloud()
    if (!c) throw new HttpError(409, 'conflict', 'This computer is not linked to a cloud account')
    const local = (await ctx().db.select().from(projects).where(eq(projects.id, projectId)).limit(1))[0]
    if (!local) throw new HttpError(404, 'not_found', 'Project not found')
    const fetchCloud = async () => {
      try {
        return await c.json<ProjectDocResponse>('GET', `/api/projects/${encodeURIComponent(projectId)}`)
      } catch (err) {
        if (err instanceof CloudError && err.status === 404) return null
        throw err
      }
    }
    const takeCloud = async () => {
      const remote = await fetchCloud()
      const cur = (await ctx().db.select().from(projects).where(eq(projects.id, projectId)).limit(1))[0]
      if (!remote) {
        // deleted in the cloud: the local copy becomes a new cloud project on the next push
        await deleteSync('project', projectId)
        return
      }
      if (!(await this.writeCloudProject(remote, cur))) throw new HttpError(409, 'conflict', 'The project changed while resolving; try again')
    }
    if (mode === 'keep-local') {
      const remote = await fetchCloud()
      await putSync('project', projectId, { cloudVersion: remote?.version ?? null, localVersion: -1, conflictVersion: null, cloudTrashed: remote?.summary.trashed ?? null, cloudTemplate: remote?.summary.isTemplate ?? null })
      const fresh = (await ctx().db.select().from(projects).where(eq(projects.id, projectId)).limit(1))[0]
      await this.pushProject(c, fresh, await syncRow('project', projectId))
    } else if (mode === 'keep-cloud') {
      await takeCloud()
    } else {
      const copyId = uid('p')
      const doc: Project = { ...structuredClone(local.doc), id: copyId, name: `${local.name} (conflicted copy)`.slice(0, 200) }
      const row = await insertProject({ workspaceId: local.workspaceId, userId: await localUserId(), doc, kind: local.kind, isTemplate: local.isTemplate })
      await this.pushProject(c, row, undefined)
      await takeCloud()
    }
    void this.emit()
    return this.status()
  }
}

export const syncEngine = new SyncEngine()
