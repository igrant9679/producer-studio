// Desktop ⇄ cloud sync engine. The cloud is the source of truth; this replica works fully offline.
//   link   — credentials → cloud device token (encrypted at rest); the local user adopts the cloud identity; cloud
//            workspaces are mirrored with the same ids; local-only workspaces are merged (personal → cloud personal,
//            others created in the cloud) so every local project has a cloud home.
//   pull   — GET /api/sync/changes?since=<cursor>, paged; the stored cursor is the cloud's `safe` point (never past a
//            change still being written; older clouds: cursor − lookback): workspaces, asset records (bytes on demand),
//            projects (never overwriting a dirty local copy; cloud advanced + local dirty ⇒ conflict), brand kits,
//            tombstones, and spaces the user left (deleted in the cloud) are removed locally.
//   push   — local hard deletes (projects only while the cloud copy is the version we saw); local-only assets (upload
//            with the same id + sha256; done once the cloud holds that file); dirty projects (PUT with baseVersion =
//            cloud_version; 409 ⇒ conflict) and new ones (POST with id); brand kits.
//   safety — a different account's spaces are set aside, never merged; a lost space's local-only work is recovered.
//   voices — VoiceStudio voice profiles sync as metadata (the reference audio and VoiceStudio-side profile stay on the
//            desktop that made them); the relay poller generates speech for the web app with this desktop's voices.
//   resolve— keep-local (force-push over the latest cloud version), keep-cloud, keep-both (local → "(conflicted copy)").
//   failures — an item whose push fails for any reason but "offline" or "signed out" is recorded (desktop_sync_failures)
//            and retried on its own backoff; the rest of the cycle carries on. The person can Retry or Skip it.
// Runs on start, every 60 s, and 3 s after local saves; backs off while offline; SSE `sync` carries SyncStatus.
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { and, eq, inArray, sql } from 'drizzle-orm'
import { uid, type AssetRecord, type BrandKitDoc, type MeResponse, type Project, type ProjectDocResponse, type SyncChanges, type SyncFailure, type SyncProject, type SyncStatus, type Transcript, type UploadTicket, type VoiceProfile, type Workspace } from '@producer/core'
import { ctx } from '../context'
import { type AssetMeta, assets, brandKits, exportsTable, jobs, memberships, projects, voiceProfiles, workspaces } from '../db/schema'
import { HttpError } from '../http'
import { log } from '../log'
import { type AssetRow, assetDirs, assetPrefix, emitAsset, extFor, hashObject, uploadMime } from '../services/assets'
import { derived, hydrateAssets, insertProject } from '../services/projects'
import { CloudClient, CloudError, normalizeCloudUrl } from './cloud'
import { type FailureKind, addNotice, clearFailure, clearFailures, clearSync, deleteSync, failureKey, failureMap, kvGet, kvSet, listNotices, putSync, rawQuery, recordFailure, removeNotice, setFailure, syncRow, syncRows, type SyncRow } from './db'
import { adoptCloudIdentity, localUserId } from './identity'
import { clearLink, cloud, linkInfo, loadLink, saveLink } from './link'
import { prefetchAllMedia } from './media'
import { getSettings, onSettingsChange } from './settings'

const LOOKBACK = 25
const PAGE = 200
/** A page of changes ends at about this much JSON (the cloud sizes it); halved after a page that didn't arrive. */
const PAGE_BYTES = 4 * 1024 * 1024
const MIN_PAGE_BYTES = 256 * 1024
/** A transfer that moves nothing for this long counts as offline (however long the whole transfer takes). */
const IDLE_MS = 60_000
const INTERVAL_MS = 60_000
const AFTER_SAVE_MS = 3_000
const MAX_BACKOFF_MS = 5 * 60_000
const RELAY_POLL_MS = 5_000
const RELAY_BEAT_MS = 15_000

type ProjectRow = typeof projects.$inferSelect

/** The account linked last (kept after unlink, so relinking it keeps sync state). */
interface LastLink {
  cloudUrl: string
  cloudUserId: string
  account?: string
}

/** Another account's spaces set aside on this computer, and where its pull stopped. */
interface ParkedAccount {
  account?: string
  workspaces: string[]
  cursor: number
  /** Where pushing this computer's deletes had got to (deletes in its spaces made since are pushed when it's back). */
  tombCursor?: number
}

const accountKey = (cloudUrl: string, cloudUserId: string) => `${cloudUrl}|${cloudUserId}`

const mediaId = (url?: string) => url?.match(/^\/api\/media\/([^/]+)\//)?.[1] ?? null

/** The cloud copy of a clip holds its file (and the same file, when both sides know the hash). */
function cloudHasFile(rec: { status: AssetRecord['status']; sha256?: string }, localSha: string | null): boolean {
  if (rec.status !== 'ready' && rec.status !== 'processing') return false
  return !rec.sha256 || !localSha || rec.sha256 === localSha
}

const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

const hashJson = (v: unknown) => crypto.createHash('sha256').update(JSON.stringify(v)).digest('hex').slice(0, 32)

/** What of a clip either side may change once it's synced, in a form to compare: its name and its transcript's hash. */
interface ClipFields {
  name: string
  transcript: string | null
}

const clipFields = (name: string, transcript: unknown): ClipFields => ({ name, transcript: transcript ? hashJson(transcript) : null })

/**
 * A clip here meets the cloud's copy: its name and its transcript are each the cloud's, unless changed here since the
 * two last agreed (`base`; before anything was agreed, `oursWithoutBase` decides). A transcript only the copy here has
 * is kept (it's pushed).
 */
function mergeClipFields(row: AssetRow, base: Record<string, unknown> | null | undefined, cloud: ClipFields, cloudTranscript: Transcript | undefined, oursWithoutBase: boolean): { name: string; transcript: Transcript | undefined } {
  const here = clipFields(row.name, row.meta?.transcript)
  const changedHere = (k: keyof ClipFields) => (base ? here[k] !== base[k] : oursWithoutBase)
  return {
    name: changedHere('name') ? row.name : cloud.name,
    transcript: changedHere('transcript') || !cloudTranscript ? row.meta?.transcript : cloudTranscript,
  }
}

/** A document's own content, to compare two copies: not when it was saved, nor the clip records the server refreshes. */
function contentKey(p: Project): string {
  const { updatedAt: _u, assets: a, ...rest } = p
  return stableJson({ ...rest, assets: Object.keys(a ?? {}).sort() })
}

function stableJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableJson).join(',')}]`
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>
    return `{${Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableJson(o[k])}`)
      .join(',')}}`
  }
  return JSON.stringify(v) ?? 'null'
}

const sameContent = (a: Project, b: Project) => contentKey(a) === contentKey(b)

/** What of a voice either side may edit. */
interface VoiceFields {
  name: string
  language: string | null
  gender: string | null
  description: string | null
}

const voiceFields = (v: { name: string; language?: string | null; gender?: string | null; description?: string | null }): VoiceFields => ({ name: v.name, language: v.language ?? null, gender: v.gender ?? null, description: v.description ?? null })

/** What a failed delete is called in the sync menu (the item itself is gone from this computer). */
const DELETED_NAME = { project: 'A project deleted here', asset: 'A clip deleted here', voice: 'A voice deleted here' } as const

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
  /**
   * True only while this engine publishes an event about its own write (that's synchronous), so the listener never
   * takes it for a local save; a save made while a long sync write is under way is still seen.
   */
  private quiet = false
  private unsubs: Array<() => void> = []
  private stopped = false
  private relayTimer?: NodeJS.Timeout
  private relayBusy = false
  private relayCheckAt = 0
  private relayHasVoices = false
  /** After a failed claim, the relay waits until this time (doubling up to 5 minutes; a success starts it over). */
  private relayRetryAt = 0
  private relayBackoffMs = 0
  /** How often a relayed voice in progress tells the cloud it's still alive (well inside the cloud's 2-minute lease). */
  private relayBeatMs = RELAY_BEAT_MS
  /** Items that failed before (loaded at the start of each cycle). */
  private failures = new Map<string, SyncFailure>()
  private pageBytes = PAGE_BYTES
  /** The pending cycle is a retry after going offline (not one asked for by a save or a person). */
  private retrying = false

  async start() {
    const link = await loadLink()
    this.state = link ? (cloud() ? 'idle' : 'error') : 'unlinked'
    if (link && !cloud()) this.error = 'The saved cloud credentials could not be decrypted on this computer. Link your account again.'
    this.lastSyncAt = (await kvGet<number>('lastSyncAt')) ?? undefined
    this.unsubs.push(
      ctx().bus.onAny((e) => {
        if (this.quiet || (e.event !== 'project' && e.event !== 'asset')) return
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
    this.relayTimer = setInterval(() => void this.relayTick(), RELAY_POLL_MS)
    this.relayTimer.unref()
  }

  stop() {
    this.stopped = true
    if (this.interval) clearInterval(this.interval)
    if (this.relayTimer) clearInterval(this.relayTimer)
    if (this.debounce) clearTimeout(this.debounce)
    for (const u of this.unsubs) u()
    this.unsubs = []
  }

  /** Run a cycle after `ms` (debounced). */
  schedule(ms: number) {
    if (this.stopped || !linkInfo()) return
    this.retrying = false
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
    const failures = await failureMap()
    return {
      linked: true,
      cloudUrl: link.cloudUrl,
      account: link.account,
      state: this.state,
      lastSyncAt: this.lastSyncAt,
      pending: await this.pendingCount(rows, failures),
      conflicts: names.map((n) => ({ projectId: n.id, name: n.name, localVersion: n.version, cloudVersion: conflicted.find((c) => c.id === n.id)!.conflictVersion! })),
      failures: [...failures.values()],
      notices: (await listNotices()).map(({ data: _data, ...n }) => n),
      ...(this.error ? { error: this.error } : {}),
    }
  }

  async dismissNotice(id: string): Promise<SyncStatus> {
    if (!(await removeNotice(id))) throw new HttpError(404, 'not_found', 'That notice is gone')
    void this.emit()
    return this.status()
  }

  /** Take the one thing a notice offers (bring back a brand kit set aside at link time), then drop the notice. */
  async applyNotice(id: string): Promise<SyncStatus> {
    const n = (await listNotices()).find((x) => x.id === id)
    if (!n) throw new HttpError(404, 'not_found', 'That notice is gone')
    if (n.data?.kind !== 'brand') throw new HttpError(400, 'invalid', 'This notice has nothing to apply')
    const { workspaceId, doc } = n.data
    if (!(await ctx().db.select({ id: workspaces.id }).from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1)).length) throw new HttpError(404, 'not_found', 'That space is no longer on this computer')
    const now = Date.now()
    // a local edit like any other: pushed on the next cycle
    await ctx()
      .db.insert(brandKits)
      .values({ workspaceId, doc, updatedAt: now })
      .onConflictDoUpdate({ target: brandKits.workspaceId, set: { doc, updatedAt: now } })
    await removeNotice(id)
    if (getSettings().autoSync) this.schedule(500)
    void this.emit()
    return this.status()
  }

  private async pendingCount(rows?: Map<string, SyncRow>, failures?: Map<string, SyncFailure>): Promise<number> {
    const pr = rows ?? (await syncRows('project'))
    // skipped items stay on this computer: not pending
    const skipped = new Set([...(failures ?? new Map<string, SyncFailure>()).values()].filter((f) => f.skipped).map((f) => failureKey(f.kind, f.id)))
    // while linked, only spaces that sync count (not a Recovered space, nor another account's set aside here)
    const cloudWs = linkInfo() ? new Set((await kvGet<string[]>('cloudWorkspaces')) ?? []) : undefined
    const syncs = (ws: string) => !cloudWs || cloudWs.has(ws)
    const local = await ctx().db.select({ id: projects.id, workspaceId: projects.workspaceId, version: projects.version, trashedAt: projects.trashedAt, isTemplate: projects.isTemplate }).from(projects)
    let n = local.filter((p) => syncs(p.workspaceId) && pr.get(p.id)?.conflictVersion == null && isDirty(p, pr.get(p.id)) && !skipped.has(failureKey('project', p.id))).length
    const ar = await syncRows('asset')
    const la = await ctx().db.select({ id: assets.id, workspaceId: assets.workspaceId, origin: assets.origin, status: assets.status }).from(assets)
    n += la.filter((a) => syncs(a.workspaceId) && a.origin !== 'render' && a.status !== 'uploading' && !ar.get(a.id)?.uploaded && !ar.get(a.id)?.remote && !skipped.has(failureKey('asset', a.id))).length
    return n
  }

  // ---------------- items that keep failing ----------------

  private due(f: SyncFailure | undefined): boolean {
    return !f || (!f.skipped && (f.nextAt == null || f.nextAt <= Date.now()))
  }

  /**
   * Push one item. Any failure but "offline" or "signed out" is recorded against that item (tried again on its own
   * backoff, or skipped by the person) and the rest of the cycle carries on.
   */
  private async item(kind: FailureKind, id: string, name: string, fn: () => Promise<void>): Promise<void> {
    const key = failureKey(kind, id)
    const f = this.failures.get(key)
    if (!this.due(f)) return
    try {
      await fn()
      if (f) await this.resolved(kind, id)
    } catch (err) {
      if (err instanceof CloudError && (err.offline || err.status === 401)) throw err
      const message = err instanceof Error ? err.message : String(err)
      this.failures.set(key, await recordFailure(kind, id, name, message))
      log.warn('desktop: item failed to sync', { kind, id, err: message })
    }
  }

  /** The item synced, or no longer needs to: drop it from the failure list. */
  private async resolved(kind: FailureKind, id: string) {
    if (!this.failures.delete(failureKey(kind, id))) return
    await clearFailure(kind, id)
  }

  /** Failures whose item is gone from this computer (deleted, or its delete already reached the cloud). */
  private async pruneFailures() {
    await ctx().db.execute(sql`
      DELETE FROM desktop_sync_failures f WHERE
        (f.kind = 'project' AND NOT EXISTS (SELECT 1 FROM projects p WHERE p.id = f.id)) OR
        (f.kind = 'asset' AND NOT EXISTS (SELECT 1 FROM assets a WHERE a.id = f.id)) OR
        (f.kind = 'voice' AND NOT EXISTS (SELECT 1 FROM voice_profiles v WHERE v.id = f.id)) OR
        (f.kind = 'brand' AND NOT EXISTS (SELECT 1 FROM brand_kits b WHERE b.workspace_id = f.id)) OR
        (f.kind LIKE '%-delete' AND NOT EXISTS (SELECT 1 FROM desktop_sync s WHERE s.id = f.id AND s.kind = split_part(f.kind, '-', 1)))`)
  }

  /** Retry a failed item now (also un-skips it). */
  async retryFailure(kind: FailureKind, id: string): Promise<SyncStatus> {
    if (!(await setFailure(kind, id, { skipped: false }))) throw new HttpError(404, 'not_found', 'That item is no longer waiting to sync')
    return this.syncNow()
  }

  /** Stop trying: the item stays on this computer only, until Retry. */
  async skipFailure(kind: FailureKind, id: string): Promise<SyncStatus> {
    if (!(await setFailure(kind, id, { skipped: true }))) throw new HttpError(404, 'not_found', 'That item is no longer waiting to sync')
    void this.emit()
    return this.status()
  }

  /** Publish an event about the engine's own write: not a local save, so it schedules no push. */
  private quietly(fn: () => void) {
    const was = this.quiet
    this.quiet = true
    try {
      fn()
    } finally {
      this.quiet = was
    }
  }

  private async emit() {
    const s = await this.status().catch(() => undefined)
    if (!s) return
    const ws = await ctx().db.select({ id: memberships.workspaceId }).from(memberships)
    this.quietly(() => {
      for (const w of new Set(ws.map((x) => x.id))) ctx().bus.publish(w, 'sync', s)
    })
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
    const last = await kvGet<LastLink>('lastLink')
    if (!last) {
      // the first link: nothing we know about sync state applies
      await clearSync()
      await kvSet('cursor', 0)
    } else if (last.cloudUrl !== cloudUrl || last.cloudUserId !== me.user.id) {
      // another account (or cloud): the previous account's spaces are set aside here, never merged into this one
      await this.setAsideAccount(last, me.user.email)
    }
    if (!last || last.cloudUrl !== cloudUrl) await kvSet('safeCursor', false)
    // what failed for another account means nothing here (it shows up again if it still fails)
    if (!last || last.cloudUrl !== cloudUrl || last.cloudUserId !== me.user.id) await clearFailures()
    const resumed = await this.resumeAccount(cloudUrl, me.user.id)
    await adoptCloudIdentity(me.user)
    await this.mirrorWorkspaces(me.workspaces)
    await this.mergeLocalWorkspaces(c, me.workspaces)
    // the same account again: deletes made here while unlinked are pushed. A first link has nothing in the cloud to
    // delete; an account linked again after another carries on from where its deletes stopped.
    if (!last || last.cloudUrl !== cloudUrl || last.cloudUserId !== me.user.id) {
      const tomb = await rawQuery<{ m: string | null }>(sql`SELECT max(change_seq)::text AS m FROM tombstones`)
      await kvSet('tombCursor', resumed?.tombCursor ?? Number(tomb[0]?.m ?? 0))
    }
    await saveLink({ cloudUrl, account: me.user.email, cloudUserId: me.user.id, deviceId: dev.deviceId, linkedAt: Date.now() }, dev.token)
    this.backoffMs = 0
    this.backoffUntil = 0
    this.relayRetryAt = 0
    this.relayBackoffMs = 0
    this.state = 'idle'
    this.error = undefined
    log.info('desktop: linked', { cloudUrl, account: me.user.email })
    this.schedule(0)
    return { ...(await this.status()), state: 'syncing' }
  }

  /**
   * Linking another account: the spaces mirrored from the previous one stay on this computer, untouched, but don't
   * sync with the new account and are never merged into it (they may hold colleagues' work). Their sync state is kept,
   * so linking that account again carries on where it left off (resumeAccount).
   */
  private async setAsideAccount(last: LastLink, next: string) {
    const db = ctx().db
    const ids = (await kvGet<string[]>('cloudWorkspaces')) ?? []
    const here = ids.length ? await db.select({ id: workspaces.id, name: workspaces.name }).from(workspaces).where(inArray(workspaces.id, ids)) : []
    const parked = (await kvGet<Record<string, ParkedAccount>>('parkedAccounts')) ?? {}
    parked[accountKey(last.cloudUrl, last.cloudUserId)] = { account: last.account, workspaces: here.map((w) => w.id), cursor: (await kvGet<number>('cursor')) ?? 0, tombCursor: (await kvGet<number>('tombCursor')) ?? 0 }
    await kvSet('parkedAccounts', parked)
    await kvSet('cloudWorkspaces', [])
    await kvSet('cursor', 0)
    if (!here.length) return
    // the new account brings its own personal space
    await db.update(workspaces).set({ personal: false }).where(inArray(workspaces.id, here.map((w) => w.id)))
    const before = last.account ?? 'the account linked before'
    await addNotice(`Linked to ${next}. The spaces from ${before} (${here.map((w) => `“${w.name}”`).join(', ')}) stay on this computer but don’t sync with ${next}. Link ${last.account ?? 'that account'} again to sync them.`)
    log.info('desktop: set aside the previous account’s spaces', { spaces: here.length })
  }

  /** Spaces set aside for this account by an earlier switch sync again, from where they stopped. */
  private async resumeAccount(cloudUrl: string, cloudUserId: string): Promise<ParkedAccount | undefined> {
    const parked = (await kvGet<Record<string, ParkedAccount>>('parkedAccounts')) ?? {}
    const key = accountKey(cloudUrl, cloudUserId)
    const mine = parked[key]
    if (!mine) return undefined
    delete parked[key]
    await kvSet('parkedAccounts', parked)
    const here = mine.workspaces.length ? await ctx().db.select({ id: workspaces.id }).from(workspaces).where(inArray(workspaces.id, mine.workspaces)) : []
    await kvSet('cloudWorkspaces', here.map((w) => w.id))
    await kvSet('cursor', mine.cursor)
    return mine
  }

  /** Spaces that belong to another account, set aside here. */
  private async parkedSpaces(): Promise<string[]> {
    return Object.values((await kvGet<Record<string, ParkedAccount>>('parkedAccounts')) ?? {}).flatMap((p) => p.workspaces)
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
      this.failures = await failureMap()
      await this.pushDeletes(c)
      await this.pull(c)
      await this.pushAssets(c)
      await this.pushProjects(c)
      await this.pushBrandKits(c)
      await this.pushVoiceProfiles(c)
      await this.pruneFailures()
      this.lastSyncAt = Date.now()
      await kvSet('lastSyncAt', this.lastSyncAt)
      this.backoffMs = 0
      this.backoffUntil = 0
      // a retry scheduled while offline has nothing left to do: it would otherwise run later, unasked (sync is off)
      if (this.retrying && this.debounce) clearTimeout(this.debounce)
      this.retrying = false
      this.setState('idle')
      if (getSettings().mediaSync === 'all') void prefetchAllMedia()
    } catch (err) {
      if (err instanceof CloudError && err.offline) {
        this.backoffMs = Math.min(MAX_BACKOFF_MS, Math.max(5000, this.backoffMs * 2))
        this.backoffUntil = Date.now() + this.backoffMs
        this.setState('offline', undefined)
        log.info('desktop: cloud offline, backing off', { ms: this.backoffMs })
        this.schedule(this.backoffMs)
        this.retrying = true
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

  /**
   * Move everything in a local workspace into another (same ids for projects/assets/voices; storage keys unchanged).
   * Its brand kit moves too when the target has none here; the first pull then decides against the cloud's (prelinkBrand).
   */
  private async rehomeWorkspace(from: string, to: string) {
    const db = ctx().db
    const kit = (await db.select().from(brandKits).where(eq(brandKits.workspaceId, from)).limit(1))[0]
    const target = (await db.select().from(brandKits).where(eq(brandKits.workspaceId, to)).limit(1))[0]
    await db.transaction(async (tx) => {
      for (const t of ['projects', 'assets', 'jobs', 'exports', 'voice_profiles']) await tx.execute(sql.raw(`UPDATE ${t} SET workspace_id = '${to.replace(/'/g, "''")}' WHERE workspace_id = '${from.replace(/'/g, "''")}'`))
      if (kit && !target) await tx.execute(sql`UPDATE brand_kits SET workspace_id = ${to} WHERE workspace_id = ${from}`)
      await tx.execute(sql`DELETE FROM brand_kits WHERE workspace_id = ${from}`)
      await tx.execute(sql`DELETE FROM memberships WHERE workspace_id = ${from}`)
      await tx.execute(sql`DELETE FROM workspaces WHERE id = ${from}`)
    })
    if (kit && !target) await kvSet('prelinkBrand', [...((await kvGet<string[]>('prelinkBrand')) ?? []), to])
    else if (kit && !sameJson(kit.doc, target!.doc)) await this.setAsideBrand(to, kit.doc)
    log.info('desktop: merged local workspace', { from, to })
  }

  /** Two brand kits for one space: the cloud's stays, ours is kept in a notice that can bring it back. */
  private async setAsideBrand(workspaceId: string, doc: BrandKitDoc) {
    const ws = (await ctx().db.select({ name: workspaces.name }).from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1))[0]
    await addNotice(`The brand kit “${doc.name}” made on this computer before linking wasn’t used, because “${ws?.name ?? 'this space'}” already has one in the cloud. It was kept aside.`, {
      action: 'Use this computer’s kit',
      data: { kind: 'brand', workspaceId, doc },
    })
  }

  private async mergeLocalWorkspaces(c: CloudClient, cloudList: Workspace[]) {
    const me = await localUserId()
    // the account's own spaces, and spaces that stay on this computer: recovered ones and another account's
    const skip = new Set([...cloudList.map((w) => w.id), ...((await kvGet<string[]>('localOnlySpaces')) ?? []), ...(await this.parkedSpaces())])
    const personal = cloudList.find((w) => w.personal) ?? cloudList[0]
    const local = await ctx()
      .db.select({ id: workspaces.id, name: workspaces.name, personal: workspaces.personal })
      .from(workspaces)
      .innerJoin(memberships, eq(memberships.workspaceId, workspaces.id))
      .where(eq(memberships.userId, me))
    for (const w of local) {
      if (skip.has(w.id)) continue
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

  /** Is this workspace mirrored from the cloud (vs local-only, not yet merged)? */
  private async isCloudWorkspace(id: string): Promise<boolean> {
    return ((await kvGet<string[]>('cloudWorkspaces')) ?? []).includes(id)
  }

  /** Rename while linked: in the cloud first, then mirrored. Null when unlinked or local-only (caller renames locally). */
  async renameWorkspace(id: string, name: string): Promise<Workspace | null> {
    const c = cloud()
    if (!c || !(await this.isCloudWorkspace(id))) return null
    const w = await c.json<Workspace>('PATCH', `/api/workspaces/${encodeURIComponent(id)}`, { name })
    await this.mirrorWorkspaces([w])
    ctx().bus.publish(id, 'workspace', { id, name: w.name, deleted: false })
    return w
  }

  /** Delete while linked: in the cloud first, then here. False when unlinked or local-only (caller deletes locally). */
  async deleteWorkspace(id: string): Promise<boolean> {
    const c = cloud()
    if (!c || !(await this.isCloudWorkspace(id))) return false
    await c.json('DELETE', `/api/workspaces/${encodeURIComponent(id)}`).catch((e) => {
      if (!(e instanceof CloudError && e.status === 404)) throw e
    })
    // the person deleted it on purpose: nothing to recover
    await this.applyWorkspaceDelete(id, false)
    return true
  }

  /**
   * The cloud says this user no longer belongs to a space (removed, or the space was deleted): drop it from this
   * replica. Work that exists only here is moved to a "Recovered from …" space first (see recoverWork).
   */
  private async applyWorkspaceDelete(id: string, recover = true) {
    const db = ctx().db
    const ws = (await db.select().from(workspaces).where(eq(workspaces.id, id)).limit(1))[0]
    if (!ws) return
    const kept = recover ? await this.recoverWork(ws) : new Set<string>()
    const dropped = await db.select({ id: assets.id, workspaceId: assets.workspaceId, sourceKey: assets.sourceKey }).from(assets).where(eq(assets.workspaceId, id))
    for (const p of await db.select({ id: projects.id }).from(projects).where(eq(projects.workspaceId, id))) await deleteSync('project', p.id)
    for (const a of dropped) await deleteSync('asset', a.id)
    for (const v of await db.select({ id: voiceProfiles.id }).from(voiceProfiles).where(eq(voiceProfiles.workspaceId, id))) await deleteSync('voice', v.id)
    await deleteSync('brand', id)
    await db.transaction(async (tx) => {
      await tx.delete(exportsTable).where(eq(exportsTable.workspaceId, id))
      await tx.delete(jobs).where(eq(jobs.workspaceId, id))
      await tx.delete(workspaces).where(eq(workspaces.id, id)) // projects, assets, memberships, brand kit cascade
    })
    // recovered clips keep their files where they are (storage keys don't move); a clip made here before linking keeps
    // its files under its first space's prefix
    if (!kept.size) await ctx().storage.deletePrefix(`ws/${id}/`).catch(() => undefined)
    for (const a of dropped) for (const dir of assetDirs(a)) if (kept.size || !dir.startsWith(`ws/${id}/`)) await ctx().storage.deletePrefix(dir).catch(() => undefined)
    await kvSet('cloudWorkspaces', ((await kvGet<string[]>('cloudWorkspaces')) ?? []).filter((w) => w !== id))
    ctx().bus.publish(id, 'workspace', { id, deleted: true })
    log.info('desktop: removed workspace deleted in the cloud', { id })
  }

  /**
   * Before a lost space goes: what exists only on this computer — projects with changes that never synced (or in
   * conflict), clips never uploaded, the clips those projects use when their files are here, renders of them, and
   * voices made here — moves to a new local-only "Recovered from …" space (never synced, never merged), with a notice.
   * Returns the ids of the clips kept.
   */
  private async recoverWork(ws: typeof workspaces.$inferSelect): Promise<Set<string>> {
    const db = ctx().db
    const storage = ctx().storage
    const [prows, arows, vrows] = await Promise.all([syncRows('project'), syncRows('asset'), syncRows('voice')])
    const projs = (await db.select().from(projects).where(eq(projects.workspaceId, ws.id))).filter((p) => prows.get(p.id)?.conflictVersion != null || isDirty(p, prows.get(p.id)))
    const keptProjects = new Set(projs.map((p) => p.id))
    const clips = await db.select().from(assets).where(eq(assets.workspaceId, ws.id))
    const used = new Set(projs.flatMap((p) => Object.keys(p.doc.assets ?? {})))
    const keptClips = new Set<string>()
    for (const a of clips) {
      const s = arows.get(a.id)
      const onlyHere = !s?.uploaded && !s?.remote
      const mine = onlyHere || used.has(a.id) || (a.origin === 'render' && !!a.projectId && keptProjects.has(a.projectId))
      if (mine && (await storage.stat(a.sourceKey))) keptClips.add(a.id)
    }
    const voices = (await db.select().from(voiceProfiles).where(eq(voiceProfiles.workspaceId, ws.id))).filter((v) => {
      const s = vrows.get(v.id)
      return !!v.vsProfileId || s?.cloudVersion == null || s.localVersion !== v.updatedAt
    })
    if (!projs.length && !keptClips.size && !voices.length) return keptClips

    const name = `Recovered from ${ws.name}`.slice(0, 80)
    const { createWorkspace } = await import('../routes/workspaces')
    const rec = await createWorkspace(await localUserId(), name)
    await db.transaction(async (tx) => {
      if (projs.length) await tx.update(projects).set({ workspaceId: rec.id }).where(inArray(projects.id, [...keptProjects]))
      if (keptClips.size) await tx.update(assets).set({ workspaceId: rec.id }).where(inArray(assets.id, [...keptClips]))
      if (voices.length) await tx.update(voiceProfiles).set({ workspaceId: rec.id }).where(inArray(voiceProfiles.id, voices.map((v) => v.id)))
      if (projs.length) await tx.update(exportsTable).set({ workspaceId: rec.id }).where(inArray(exportsTable.projectId, [...keptProjects]))
    })
    // no longer tied to anything in the cloud
    for (const id of keptProjects) await deleteSync('project', id)
    for (const id of keptClips) await deleteSync('asset', id)
    for (const v of voices) await deleteSync('voice', v.id)
    await kvSet('localOnlySpaces', [...((await kvGet<string[]>('localOnlySpaces')) ?? []), rec.id])
    const parts = [
      projs.length && `${projs.length} project${projs.length === 1 ? '' : 's'} with changes that hadn’t synced`,
      keptClips.size && `${keptClips.size} clip${keptClips.size === 1 ? '' : 's'}`,
      voices.length && `${voices.length} voice${voices.length === 1 ? '' : 's'} made here`,
    ].filter(Boolean)
    await addNotice(`You no longer have access to “${ws.name}” in the cloud. What existed only on this computer (${parts.join(', ')}) was moved to “${name}”, which stays on this computer and isn’t synced.`)
    log.info('desktop: recovered local work from a lost space', { from: ws.id, to: rec.id, projects: projs.length, clips: keptClips.size, voices: voices.length })
    return keptClips
  }

  // ---------------- pull ----------------

  private async pull(c: CloudClient) {
    let cursor = (await kvGet<number>('cursor')) ?? 0
    // a cloud that reports `safe` never lets the cursor pass a change still being written; older ones get a lookback
    let since = Math.max(0, cursor - ((await kvGet<boolean>('safeCursor')) ? 0 : LOOKBACK))
    // where the next pull starts: below the first change the cloud said may still be committing
    let hold: number | undefined
    for (;;) {
      let ch: SyncChanges
      try {
        ch = await c.json<SyncChanges>('GET', `/api/sync/changes?since=${since}&limit=${PAGE}&maxBytes=${this.pageBytes}`, undefined, IDLE_MS)
      } catch (err) {
        // it didn't arrive: ask for smaller pages (a slow link), growing back as pages arrive
        if (err instanceof CloudError && err.offline) this.pageBytes = Math.max(MIN_PAGE_BYTES, this.pageBytes / 2)
        throw err
      }
      this.pageBytes = Math.min(PAGE_BYTES, this.pageBytes * 2)
      if (ch.workspaces.length) await this.mirrorWorkspaces(ch.workspaces)
      const known = new Set((await ctx().db.select({ id: workspaces.id }).from(workspaces)).map((w) => w.id))
      const missingWs = [...ch.projects.map((p) => p.summary.workspaceId), ...ch.assets.map((a) => a.workspaceId)].filter((w) => !known.has(w))
      if (missingWs.length) await this.mirrorWorkspaces(await c.json<Workspace[]>('GET', '/api/workspaces'))
      for (const a of ch.assets) await this.applyAsset(a)
      for (const p of ch.projects) await this.applyProject(p)
      for (const b of ch.brandKits) await this.applyBrand(b.workspaceId, b.doc)
      for (const id of ch.deleted.assets) await this.applyAssetDelete(id)
      for (const id of ch.deleted.projects) await this.applyProjectDelete(id)
      for (const v of ch.voiceProfiles ?? []) await this.applyVoiceProfile(v)
      for (const id of ch.deleted.voiceProfiles ?? []) await this.applyVoiceProfileDelete(id)
      for (const id of ch.deleted.workspaces ?? []) await this.applyWorkspaceDelete(id)
      cursor = Math.max(cursor, ch.cursor)
      if (ch.safe != null) {
        if (ch.safe < ch.cursor) hold ??= ch.safe
        if (!(await kvGet<boolean>('safeCursor'))) await kvSet('safeCursor', true)
      }
      // what was applied above `hold` is delivered again next time (applying twice is harmless)
      await kvSet('cursor', hold ?? cursor)
      // every page there is (a cloud that says "more" without moving on is a broken one: stop there)
      if (!ch.more || ch.cursor <= since) break
      since = ch.cursor
    }
  }

  private async applyAsset(rec: AssetRecord & { sha256?: string; changeSeq: number }) {
    const db = ctx().db
    const a = rec.asset
    const row = (await db.select().from(assets).where(eq(assets.id, a.id)).limit(1))[0]
    const s = await syncRow('asset', a.id)
    const cloudFields = clipFields(a.name, a.transcript)
    // a clip whose sync record never got written (cut short between two writes) has no file here while the cloud has
    // one: it's a cloud clip, fetched on demand, not one of ours
    const ours = row && !s?.remote && ((await ctx().storage.stat(row.sourceKey)) || !cloudHasFile(rec, null))
    if (row && ours) {
      // our own upload echoed back (or an id we already hold locally): local bytes and derived files win. It only
      // counts as uploaded once the cloud has the same file; an upload cut short is sent again by the push.
      const uploaded = s?.uploaded || cloudHasFile(rec, row.sha256)
      if (!uploaded) return
      // a rename or transcript made in the cloud since comes here, unless this computer changed it too (then ours is
      // pushed); before anything was agreed, ours counts as changed
      const take = mergeClipFields(row, s?.base, cloudFields, a.transcript, true)
      if (take.name !== row.name || take.transcript !== row.meta?.transcript) {
        const [saved] = await db.update(assets).set({ name: take.name, meta: { ...(row.meta ?? {}), transcript: take.transcript }, updatedAt: Date.now() }).where(eq(assets.id, a.id)).returning()
        this.quietly(() => emitAsset(saved))
      }
      await putSync('asset', a.id, { uploaded: true, remote: false, base: { ...cloudFields } })
      return
    }
    // ours to keep: a name or transcript changed here and not pushed yet
    const take = row ? mergeClipFields(row, s?.base, cloudFields, a.transcript, false) : undefined
    const prefix = assetPrefix(rec.workspaceId, a.id)
    const meta: AssetMeta = {
      duration: a.duration,
      width: a.width,
      height: a.height,
      fps: a.fps,
      hasAudio: a.hasAudio,
      filmstrip: a.filmstrip ? { frames: a.filmstrip.frames, frameWidth: a.filmstrip.frameWidth, frameHeight: a.filmstrip.frameHeight } : undefined,
      waveform: a.waveform,
      // a long clip's record carries a shortened waveform; the full one is fetched from the cloud when zoomed into
      waveformRate: a.waveformRate,
      waveformFull: a.waveformSrc ? true : undefined,
      transcript: take ? take.transcript : a.transcript,
      silences: a.silences,
    }
    const values = {
      workspaceId: rec.workspaceId,
      kind: a.kind,
      name: take ? take.name : a.name,
      // served from this computer's origin: a type that isn't media is never served as what the cloud called it
      mime: uploadMime(a.mime ?? '', a.name) ?? 'application/octet-stream',
      size: a.sizeBytes ?? 0,
      status: rec.status,
      origin: rec.origin,
      error: rec.error ?? null,
      sourceKey: row?.sourceKey ?? `${prefix}/source${extFor(a.name, a.mime ?? '')}`,
      // a picture's proxy is a PNG (a TIFF's copy): the export names its file by this key's extension
      proxyKey: a.proxySrc ? (row?.proxyKey ?? `${prefix}/${a.kind === 'image' ? 'display.png' : 'proxy.mp4'}`) : null,
      thumbKey: a.thumbnail ? (row?.thumbKey ?? `${prefix}/thumb.jpg`) : null,
      filmstripKey: a.filmstrip ? (row?.filmstripKey ?? `${prefix}/filmstrip.jpg`) : null,
      audioKey: null,
      meta,
      sha256: rec.sha256 ?? null,
      updatedAt: Date.now(),
    }
    // the sync record first: a crash before the row is written leaves nothing that looks like a clip made here
    await putSync('asset', a.id, { remote: true, uploaded: true, base: { ...cloudFields } })
    const [saved] = row
      ? await db.update(assets).set(values).where(eq(assets.id, a.id)).returning()
      : await db
          .insert(assets)
          .values({ id: a.id, ...values, createdBy: await localUserId(), createdAt: a.createdAt ?? rec.createdAt ?? Date.now() })
          .returning()
    this.quietly(() => emitAsset(saved))
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
    const row = saved
    this.quietly(() => ctx().bus.publish(row.workspaceId, 'project', { id: row.id, version: row.version }))
    return true
  }

  private async applyProject(sp: SyncProject) {
    const id = sp.project.id
    const s = await syncRow('project', id)
    if (s?.cloudVersion != null && sp.version <= s.cloudVersion) {
      // already applied (or our own push); trash, restore and template changes don't bump the version
      if (sp.version === s.cloudVersion) await this.applyProjectFlags(sp, s)
      return
    }
    if (s?.conflictVersion != null && sp.version <= s.conflictVersion) return
    const local = (await ctx().db.select().from(projects).where(eq(projects.id, id)).limit(1))[0]
    if (local && isDirty(local, s)) {
      if (sameContent(local.doc, sp.project)) {
        // the cloud already holds what we have (our own save whose answer was lost): not a conflict; a trash or
        // template change made here is still pushed
        await putSync('project', id, { cloudVersion: sp.version, localVersion: local.version, conflictVersion: null, cloudTrashed: sp.summary.trashed, cloudTemplate: sp.summary.isTemplate })
        return
      }
      await putSync('project', id, { conflictVersion: sp.version })
      log.info('desktop: sync conflict', { projectId: id, localVersion: local.version, cloudVersion: sp.version })
      return
    }
    if (!(await this.writeCloudProject(sp, local))) await putSync('project', id, { conflictVersion: sp.version })
  }

  /** Same document, new trash/template flags in the cloud: take each one unless it was toggled here since the last sync. */
  private async applyProjectFlags(sp: SyncProject, s: SyncRow) {
    const { trashed, isTemplate } = sp.summary
    if (s.cloudTrashed === trashed && s.cloudTemplate === isTemplate) return
    const local = (await ctx().db.select().from(projects).where(eq(projects.id, sp.project.id)).limit(1))[0]
    if (!local) return // deleted here: the delete push decides
    const set: Partial<ProjectRow> = {}
    const localTrashed = local.trashedAt != null
    if (localTrashed === (s.cloudTrashed ?? localTrashed) && localTrashed !== trashed) set.trashedAt = trashed ? Date.now() : null
    if (local.isTemplate === (s.cloudTemplate ?? local.isTemplate) && local.isTemplate !== isTemplate) set.isTemplate = isTemplate
    if (Object.keys(set).length) {
      await ctx().db.update(projects).set(set).where(eq(projects.id, local.id))
      this.quietly(() => ctx().bus.publish(local.workspaceId, 'project', { id: local.id, version: local.version }))
    }
    await putSync('project', local.id, { cloudTrashed: trashed, cloudTemplate: isTemplate })
  }

  private async applyBrand(workspaceId: string, doc: BrandKitDoc) {
    const s = await syncRow('brand', workspaceId)
    const cur = (await ctx().db.select().from(brandKits).where(eq(brandKits.workspaceId, workspaceId)).limit(1))[0]
    // local edits since the last sync win until pushed
    if (cur && s?.localVersion != null && cur.updatedAt !== s.localVersion) return
    const prelink = (await kvGet<string[]>('prelinkBrand')) ?? []
    if (prelink.includes(workspaceId)) {
      // a kit made here before linking meets the cloud's: the cloud's stays, ours is set aside
      await kvSet('prelinkBrand', prelink.filter((w) => w !== workspaceId))
      if (cur && !sameJson(cur.doc, doc)) await this.setAsideBrand(workspaceId, cur.doc)
    }
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
    await ctx().db.delete(assets).where(eq(assets.id, id))
    for (const dir of assetDirs(row)) await ctx().storage.deletePrefix(dir).catch(() => undefined)
  }

  private async applyProjectDelete(id: string) {
    const local = (await ctx().db.select().from(projects).where(eq(projects.id, id)).limit(1))[0]
    const s = await syncRow('project', id)
    await deleteSync('project', id)
    if (!local) return
    // edited here since: keep it; with no sync row it is pushed again as a new cloud project
    if (isDirty(local, s)) return
    await ctx().db.delete(projects).where(eq(projects.id, id))
  }

  // ---------------- push ----------------

  private async pushDeletes(c: CloudClient) {
    let cursor = (await kvGet<number>('tombCursor')) ?? 0
    const cloudWs = new Set((await kvGet<string[]>('cloudWorkspaces')) ?? [])
    const rows = await rawQuery<{ kind: string; id: string; ws: string; seq: string }>(sql`SELECT kind, id, workspace_id AS ws, change_seq::text AS seq FROM tombstones WHERE change_seq > ${cursor} ORDER BY change_seq`)
    for (const t of rows) {
      // membership tombstones (local workspace merges/deletes) aren't pushed, nor deletes in spaces this account
      // doesn't sync (another account's, set aside here: the cloud copy simply stays)
      const kind = t.kind === 'voice_profile' ? 'voice' : t.kind
      if ((kind === 'project' || kind === 'asset' || kind === 'voice') && cloudWs.has(t.ws)) await this.item(`${kind}-delete`, t.id, DELETED_NAME[kind], () => this.pushDelete(c, kind, t.id))
      cursor = Number(t.seq)
      await kvSet('tombCursor', cursor)
    }
    // deletes that failed before and are due again
    for (const f of [...this.failures.values()]) {
      if (!f.kind.endsWith('-delete') || !this.due(f)) continue
      const kind = f.kind.slice(0, -'-delete'.length) as keyof typeof DELETED_NAME
      await this.item(f.kind, f.id, f.name, () => this.pushDelete(c, kind, f.id))
    }
  }

  private async pushDelete(c: CloudClient, kind: 'project' | 'asset' | 'voice', id: string) {
    const s = await syncRow(kind, id)
    if (kind === 'project' && s?.cloudVersion != null) return this.pushProjectDelete(c, id, s)
    if (kind === 'voice') {
      if (s?.cloudVersion != null) {
        await c.json('DELETE', `/api/voice/profiles/${encodeURIComponent(id)}`).catch((err) => {
          if (!(err instanceof CloudError && (err.status === 404 || err.status === 403))) throw err
        })
      }
    } else if (s?.uploaded) {
      await c.json('DELETE', `/api/assets/${encodeURIComponent(id)}`).catch((err) => {
        if (!(err instanceof CloudError && (err.status === 404 || err.status === 403))) throw err
      })
    }
    if (s) await deleteSync(kind, id)
  }

  /**
   * A project deleted here goes in the cloud only while the cloud copy is the one this computer last saw. Edited or
   * taken out of the trash since (or no longer ours to delete): the cloud copy is kept, comes back here, and we say so.
   */
  private async pushProjectDelete(c: CloudClient, id: string, s: SyncRow) {
    try {
      await c.json('POST', `/api/sync/projects/${encodeURIComponent(id)}/delete`, { baseVersion: s.cloudVersion, trashed: s.cloudTrashed ?? undefined })
      await deleteSync('project', id)
    } catch (err) {
      // gone already
      if (err instanceof CloudError && err.status === 404) return deleteSync('project', id)
      if (!(err instanceof CloudError && (err.status === 409 || err.status === 403))) throw err
      const reason = err.status === 403 ? 'forbidden' : (err.body?.details as { reason?: string } | undefined)?.reason
      const remote = await c.json<ProjectDocResponse>('GET', `/api/projects/${encodeURIComponent(id)}`).catch((e) => {
        if (e instanceof CloudError && e.status === 404) return null
        throw e
      })
      await deleteSync('project', id)
      if (!remote || !(await this.writeCloudProject(remote, undefined))) return
      const name = remote.summary.name
      await addNotice(
        reason === 'restored'
          ? `“${name}” was taken out of the trash in the cloud after it was deleted here, so it wasn’t deleted. It’s back in your projects.`
          : reason === 'forbidden'
            ? `“${name}” couldn’t be deleted: you can no longer delete projects in that space. It’s back in your projects.`
            : `“${name}” was deleted here, but edited in the cloud since. The cloud version was kept and is back in your projects; delete it again if you still want it gone.`,
      )
      log.info('desktop: kept a project deleted here', { projectId: id, reason })
    }
  }

  private async pushAssets(c: CloudClient) {
    const cloudWs = new Set((await kvGet<string[]>('cloudWorkspaces')) ?? [])
    const rows = await syncRows('asset')
    const local = await ctx().db.select().from(assets)
    for (const a of local) {
      const s = rows.get(a.id)
      if (!cloudWs.has(a.workspaceId)) continue
      if (s?.uploaded || s?.remote) {
        // in the cloud already: a rename or a transcript made here since goes up (synced before this was tracked: what
        // is here now counts as agreed)
        const here = clipFields(a.name, a.meta?.transcript)
        if (!s.base) await putSync('asset', a.id, { base: { ...here } })
        if (!s.base || (s.base.name === here.name && s.base.transcript === here.transcript)) await this.resolved('asset', a.id)
        else await this.item('asset', a.id, a.name, () => this.pushClipFields(c, a, s))
        continue
      }
      if (a.origin === 'render' || a.status === 'uploading') continue
      await this.item('asset', a.id, a.name, () => this.pushAsset(c, a))
    }
  }

  /** A clip's name or transcript changed here since it last matched the cloud's: send what changed. */
  private async pushClipFields(c: CloudClient, a: AssetRow, s: SyncRow) {
    const here = clipFields(a.name, a.meta?.transcript)
    const patch = { ...(here.name !== s.base?.name ? { name: a.name } : {}), ...(here.transcript !== s.base?.transcript && a.meta?.transcript ? { transcript: a.meta.transcript } : {}) }
    if (Object.keys(patch).length) {
      await c.json('PATCH', `/api/assets/${encodeURIComponent(a.id)}`, patch).catch((err) => {
        // gone in the cloud (its delete comes with the next pull), or no longer ours to change: stays as it is here
        if (!(err instanceof CloudError && (err.status === 404 || err.status === 403))) throw err
      })
    }
    await putSync('asset', a.id, { base: { ...here } })
  }

  private async pushAsset(c: CloudClient, a: typeof assets.$inferSelect) {
    if (!(await ctx().storage.stat(a.sourceKey))) return
    let sha = a.sha256
    if (!sha) {
      sha = await hashObject(a.sourceKey)
      await ctx().db.update(assets).set({ sha256: sha }).where(eq(assets.id, a.id))
    }
    const ext = path.extname(a.sourceKey)
    const filename = path.extname(a.name) ? a.name : `${a.name}${ext}`
    const file = ctx().storage.localPath?.(a.sourceKey)
    if (!file) return
    // declare the file's real size: the cloud signs it into the upload URL and the bucket refuses any other length
    const bytes = fs.statSync(file).size
    let ticket: UploadTicket
    try {
      ticket = await c.json<UploadTicket>('POST', '/api/uploads', { workspaceId: a.workspaceId, filename, mime: a.mime, size: bytes, assetId: a.id, sha256: sha, origin: a.origin, ...(a.meta?.tts ? { tts: a.meta.tts } : {}), ...(a.projectId ? { projectId: a.projectId } : {}) })
    } catch (err) {
      const exists = err instanceof CloudError && err.status === 409 ? (err.body?.details as { exists?: boolean; asset?: AssetRecord; sha256?: string } | undefined) : undefined
      if (exists?.exists) {
        // a different file under this id, or (older clouds) an upload that never arrived: never count that as done
        if (exists.sha256 && exists.sha256 !== sha) throw new Error('The cloud already has a different file under this clip’s id')
        if (exists.asset?.status === 'uploading') throw new Error('The cloud has an unfinished upload of this clip and won’t take it again (the cloud server needs updating)')
        await putSync('asset', a.id, { uploaded: true, remote: false, base: { ...clipFields(exists.asset?.asset.name ?? a.name, exists.asset?.asset.transcript) } })
        return
      }
      throw err
    }
    const body = Readable.toWeb(fs.createReadStream(file)) as unknown as ReadableStream
    const put = await c.request('PUT', ticket.url, { body, headers: { ...ticket.headers, 'content-length': String(bytes) }, idleTimeoutMs: IDLE_MS })
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
    const done = await c.json<AssetRecord | undefined>('POST', `/api/assets/${encodeURIComponent(a.id)}/complete`)
    // what the cloud has now: a name it shortened, no transcript yet (one made here goes up next)
    await putSync('asset', a.id, { uploaded: true, remote: false, base: { ...clipFields(done?.asset?.name ?? a.name, done?.asset?.transcript) } })
    log.info('desktop: uploaded asset', { assetId: a.id, bytes })
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
        const details = err instanceof CloudError && err.status === 409 ? (err.body?.details as { version?: number; project?: Project } | undefined) : undefined
        if (details?.version != null && details.project && sameContent(details.project, doc)) {
          // the cloud already has this content (an earlier save whose answer was lost)
          cloudVersion = details.version
        } else if (err instanceof CloudError && err.status === 409) {
          const v = details?.version ?? s.cloudVersion + 1
          await putSync('project', p.id, { conflictVersion: v })
          log.info('desktop: push conflict', { projectId: p.id, cloudVersion: v })
          return
        } else if (err instanceof CloudError && err.status === 404) cloudVersion = await create()
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
    for (const p of local) {
      const s = rows.get(p.id)
      if (!isDirty(p, s)) await this.resolved('project', p.id)
      if (s?.conflictVersion != null || !isDirty(p, s) || !cloudWs.has(p.workspaceId)) continue
      await this.item('project', p.id, p.name, () => this.pushProject(c, p, s))
    }
  }

  private async pushBrandKits(c: CloudClient) {
    const cloudWs = new Set((await kvGet<string[]>('cloudWorkspaces')) ?? [])
    const rows = await syncRows('brand')
    for (const b of await ctx().db.select().from(brandKits)) {
      if (!cloudWs.has(b.workspaceId)) continue
      const s = rows.get(b.workspaceId)
      if (s?.localVersion === b.updatedAt) {
        await this.resolved('brand', b.workspaceId)
        continue
      }
      await this.item('brand', b.workspaceId, `Brand kit “${b.doc.name}”`, async () => {
        try {
          await c.json('PUT', `/api/workspaces/${encodeURIComponent(b.workspaceId)}/brand`, b.doc)
        } catch (err) {
          if (err instanceof CloudError && err.status === 403) {
            // viewers can't edit the brand kit; drop the local change on the next pull
            await putSync('brand', b.workspaceId, { localVersion: b.updatedAt })
            return
          }
          throw err
        }
        await putSync('brand', b.workspaceId, { localVersion: b.updatedAt })
      })
    }
    // kits made before linking whose space had none in the cloud (nothing came in the full first pull) are pushed now
    const prelink = (await kvGet<string[]>('prelinkBrand')) ?? []
    if (prelink.length) {
      const pushed = new Set([...(await syncRows('brand')).keys()])
      await kvSet('prelinkBrand', prelink.filter((w) => !pushed.has(w)))
    }
  }

  // ---------------- voice profiles ----------------

  /**
   * Cloud → here: upsert the metadata, keeping this replica's VoiceStudio link (vs_profile_id) untouched. Copies are
   * ordered by the cloud's version, never by clocks: a voice edited here and not pushed yet keeps the fields changed
   * here and takes the cloud's others (and is then pushed on top of that version).
   */
  private async applyVoiceProfile(v: VoiceProfile) {
    const db = ctx().db
    const cur = (await db.select().from(voiceProfiles).where(eq(voiceProfiles.id, v.id)).limit(1))[0]
    const s = await syncRow('voice', v.id)
    const editedHere = !!cur && s?.localVersion !== cur.updatedAt
    // a cloud too old to stamp versions: the newer timestamp wins, as before
    if (v.version == null && editedHere && cur.updatedAt > v.updatedAt) return
    if (v.version != null && s?.cloudVersion != null && v.version <= s.cloudVersion) return // already here
    if (!(await db.select({ id: workspaces.id }).from(workspaces).where(eq(workspaces.id, v.workspaceId)).limit(1)).length) return
    const cloudFields = voiceFields(v)
    const base = s?.base as Partial<VoiceFields> | null | undefined
    const mine = cur ? voiceFields(cur) : undefined
    // before anything was agreed, everything edited here counts as changed here
    const keep = (k: keyof VoiceFields) => editedHere && !!mine && (!base || mine[k] !== base[k])
    const fields = Object.fromEntries((Object.keys(cloudFields) as Array<keyof VoiceFields>).map((k) => [k, keep(k) ? mine![k] : cloudFields[k]])) as unknown as VoiceFields
    const values = {
      workspaceId: v.workspaceId,
      ...fields,
      kind: v.kind,
      engine: v.engine,
      consent: v.consent,
      deviceId: v.deviceId ?? null,
      sampleAssetId: v.sampleAssetId ?? null,
      // still edited here: the local time stays, so it's still pushed
      updatedAt: editedHere ? cur.updatedAt : v.updatedAt,
    }
    if (cur) await db.update(voiceProfiles).set(values).where(eq(voiceProfiles.id, v.id))
    else await db.insert(voiceProfiles).values({ id: v.id, ...values, createdBy: v.createdBy, createdAt: v.createdAt })
    await putSync('voice', v.id, { ...(editedHere ? {} : { localVersion: v.updatedAt }), cloudVersion: v.version ?? 1, base: { ...cloudFields } })
  }

  private async applyVoiceProfileDelete(id: string) {
    const db = ctx().db
    const cur = (await db.select().from(voiceProfiles).where(eq(voiceProfiles.id, id)).limit(1))[0]
    await deleteSync('voice', id)
    if (!cur) return
    if (cur.vsProfileId) {
      const { deleteVsProfile } = await import('./voicestudio/profiles')
      await deleteVsProfile(cur.vsProfileId).catch(() => undefined)
    }
    await db.delete(voiceProfiles).where(eq(voiceProfiles.id, id))
  }

  /** Here → cloud: new or edited profiles (metadata only). Profiles made before linking adopt this device. */
  private async pushVoiceProfiles(c: CloudClient) {
    const cloudWs = new Set((await kvGet<string[]>('cloudWorkspaces')) ?? [])
    const rows = await syncRows('voice')
    const deviceId = linkInfo()?.deviceId
    for (const v of await ctx().db.select().from(voiceProfiles)) {
      if (!cloudWs.has(v.workspaceId)) continue
      let row = v
      if (!row.deviceId && row.vsProfileId && deviceId) {
        ;[row] = await ctx().db.update(voiceProfiles).set({ deviceId }).where(eq(voiceProfiles.id, v.id)).returning()
      }
      const s = rows.get(row.id)
      if (s?.localVersion === row.updatedAt && s.cloudVersion != null) {
        await this.resolved('voice', row.id)
        continue
      }
      await this.item('voice', row.id, row.name, () => this.pushVoiceProfile(c, row, s))
    }
  }

  /** Push one voice on top of the cloud version this copy is based on. Changed in the cloud since: merge, push again. */
  private async pushVoiceProfile(c: CloudClient, row: typeof voiceProfiles.$inferSelect, s: SyncRow | undefined, again = true): Promise<void> {
    let saved: VoiceProfile
    try {
      saved = await c.json<VoiceProfile>('PUT', `/api/voice/profiles/${encodeURIComponent(row.id)}`, {
        workspaceId: row.workspaceId,
        name: row.name,
        kind: row.kind,
        engine: row.engine,
        language: row.language ?? undefined,
        gender: row.gender ?? undefined,
        description: row.description ?? undefined,
        consent: row.consent,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        baseVersion: s?.cloudVersion ?? 0,
      })
    } catch (err) {
      const newer = err instanceof CloudError && err.status === 409 ? (err.body?.details as { profile?: VoiceProfile } | undefined)?.profile : undefined
      if (newer && again) {
        await this.applyVoiceProfile(newer)
        const merged = (await ctx().db.select().from(voiceProfiles).where(eq(voiceProfiles.id, row.id)).limit(1))[0]
        if (merged) await this.pushVoiceProfile(c, merged, await syncRow('voice', row.id), false)
        return
      }
      if (err instanceof CloudError && (err.status === 403 || err.status === 409)) {
        // viewers can't add voices / id clash: leave it local-only
        await putSync('voice', row.id, { localVersion: row.updatedAt })
        return
      }
      throw err
    }
    await putSync('voice', row.id, { localVersion: row.updatedAt, cloudVersion: saved.version ?? 1, base: { ...voiceFields(row) } })
  }

  // ---------------- relay: generate for the web app ----------------

  /** Poll the cloud for speech requests that need one of this desktop's voices; generate, upload, report. */
  private async relayTick() {
    if (this.relayBusy || this.stopped) return
    const c = cloud()
    if (!c) return
    const { voiceStudio } = await import('./voicestudio/runtime')
    if (voiceStudio.status().state === 'not-installed') return
    if (Date.now() - this.relayCheckAt > 60_000) {
      this.relayCheckAt = Date.now()
      const n = await rawQuery<{ n: string }>(sql`SELECT count(*)::text AS n FROM voice_profiles WHERE vs_profile_id IS NOT NULL`).catch(() => [{ n: '0' }])
      this.relayHasVoices = Number(n[0]?.n ?? 0) > 0
    }
    if (!this.relayHasVoices || Date.now() < this.relayRetryAt) return
    this.relayBusy = true
    try {
      const r = await c.json<{ job: RelayClaim | null }>('GET', '/api/voice/relay/claim')
      this.relayBackoffMs = 0
      if (r.job) await this.runRelay(c, r.job)
    } catch (err) {
      // offline, refused (a revoked device) or failing: ask again less and less often (at most every 5 minutes), and
      // say so once per wait rather than every 5 s
      this.relayBackoffMs = Math.min(MAX_BACKOFF_MS, Math.max(RELAY_POLL_MS * 2, this.relayBackoffMs * 2))
      this.relayRetryAt = Date.now() + this.relayBackoffMs
      if (!(err instanceof CloudError && err.offline)) log.warn('desktop: voice relay failed', { err: String(err), retryInMs: this.relayBackoffMs })
    } finally {
      this.relayBusy = false
    }
  }

  /** Re-check for local voices right away (after creating one). */
  voicesChanged() {
    this.relayCheckAt = 0
  }

  private async runRelay(c: CloudClient, job: RelayClaim) {
    const ac = new AbortController()
    let lastBeat = 0
    let last: { f: number; m?: string } = { f: -1 }
    const send = (f: number, m?: string) => {
      lastBeat = Date.now()
      void c
        .json<{ cancelled: boolean }>('POST', `/api/voice/relay/${job.id}/progress`, { progress: f, message: m })
        .then((x) => x.cancelled && ac.abort())
        .catch(() => undefined)
    }
    const progress = (f: number, m?: string) => {
      last = { f, m: m ?? last.m }
      if (Date.now() - lastBeat < 2000 && f < 1) return
      send(f, m)
    }
    // the cloud holds this job on a lease (RELAY_LEASE_MS): beat on a timer, also while a long generation reports nothing
    const beat = setInterval(() => Date.now() - lastBeat >= this.relayBeatMs && send(last.f, last.m), Math.min(this.relayBeatMs, 5_000))
    beat.unref()
    try {
      const { synthesizeProfileToAsset } = await import('../services/voice')
      // the project may not be on this desktop; the asset still lands in the space's library
      const projectId = job.projectId && (await ctx().db.select({ id: projects.id }).from(projects).where(eq(projects.id, job.projectId)).limit(1)).length ? job.projectId : undefined
      const r = await synthesizeProfileToAsset(
        { workspaceId: job.workspaceId, userId: job.userId, projectId, text: job.input.text, voice: `vs:${job.input.profileId}`, speed: job.input.speed, name: job.input.name },
        { signal: ac.signal, progress: (f, m) => progress(f < 0 ? -1 : Math.min(0.9, f * 0.9), m), check: () => ac.signal.throwIfAborted() },
      )
      progress(0.92, 'Uploading')
      await this.syncNow()
      if (!(await syncRow('asset', r.row.id))?.uploaded) throw new Error('The audio could not be uploaded to the cloud')
      await c.json('POST', `/api/voice/relay/${job.id}/done`, { assetId: r.row.id })
    } catch (err) {
      await c.json('POST', `/api/voice/relay/${job.id}/fail`, { error: err instanceof Error ? err.message : String(err) }).catch(() => undefined)
    } finally {
      clearInterval(beat)
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
    // the cloud copy first: offline, nothing here has changed yet (and a retry can't make a second copy)
    const remote = await fetchCloud()
    const takeCloud = async () => {
      const cur = (await ctx().db.select().from(projects).where(eq(projects.id, projectId)).limit(1))[0]
      if (!remote) {
        // deleted in the cloud: the local copy becomes a new cloud project on the next push
        await deleteSync('project', projectId)
        return true
      }
      return this.writeCloudProject(remote, cur)
    }
    const changed = () => new HttpError(409, 'conflict', 'The project changed while resolving; try again')
    if (mode === 'keep-local') {
      await putSync('project', projectId, { cloudVersion: remote?.version ?? null, localVersion: -1, conflictVersion: null, cloudTrashed: remote?.summary.trashed ?? null, cloudTemplate: remote?.summary.isTemplate ?? null })
      const fresh = (await ctx().db.select().from(projects).where(eq(projects.id, projectId)).limit(1))[0]
      await this.pushProject(c, fresh, await syncRow('project', projectId))
    } else if (mode === 'keep-cloud') {
      if (!(await takeCloud())) throw changed()
    } else {
      const copyId = uid('p')
      const doc: Project = { ...structuredClone(local.doc), id: copyId, name: `${local.name} (conflicted copy)`.slice(0, 200) }
      const row = await insertProject({ workspaceId: local.workspaceId, userId: await localUserId(), doc, kind: local.kind, isTemplate: local.isTemplate })
      if (!(await takeCloud())) {
        await ctx().db.delete(projects).where(eq(projects.id, copyId))
        throw changed()
      }
      // the copy is a new project here: if the connection drops now, the next sync pushes it
      await this.pushProject(c, row, undefined).catch((err) => {
        if (!(err instanceof CloudError && err.offline)) throw err
      })
    }
    void this.emit()
    return this.status()
  }
}

export const syncEngine = new SyncEngine()

interface RelayClaim {
  id: string
  userId: string
  workspaceId: string
  projectId?: string
  input: { profileId: string; text: string; speed?: number; name?: string }
}
