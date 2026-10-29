// "Available offline" per project (D-9): a project kept offline has every clip it uses downloaded (original, proxy,
// thumbnail, filmstrip, full waveform) and kept current after each sync, so it can be edited and exported with no
// connection. Other cloud clips still come when first opened. Clips whose original is only in the cloud are listed
// for the library's badge. Stopping keeps what was downloaded.
import { and, eq, inArray } from 'drizzle-orm'
import type { OfflineInfo, OfflineProject } from '@producer/core'
import { ctx } from '../context'
import { assets, projects } from '../db/schema'
import { log } from '../log'
import { waveformKey } from '../media/process'
import type { AssetRow } from '../services/assets'
import { kvGet, kvSet, syncRows } from './db'
import { ensureLocal } from './media'

const pinnedIds = async () => (await kvGet<string[]>('offlineProjects')) ?? []

/** Every file of a clip this computer needs to edit and export it without the cloud. */
function keysOf(a: AssetRow): string[] {
  return [a.sourceKey, a.proxyKey, a.thumbKey, a.filmstripKey, a.meta?.waveformFull ? waveformKey(a) : null].filter((k): k is string => !!k)
}

async function missingKeys(a: AssetRow): Promise<string[]> {
  const out: string[] = []
  for (const k of keysOf(a)) if (!(await ctx().storage.stat(k))) out.push(k)
  return out
}

async function projectClips(projectIds: string[]): Promise<Map<string, AssetRow[]>> {
  const out = new Map<string, AssetRow[]>()
  if (!projectIds.length) return out
  const rows = await ctx().db.select({ id: projects.id, ws: projects.workspaceId, doc: projects.doc }).from(projects).where(inArray(projects.id, projectIds))
  const remote = new Set([...(await syncRows('asset')).values()].filter((s) => s.remote).map((s) => s.id))
  for (const p of rows) {
    const ids = Object.keys(p.doc.assets ?? {}).filter((id) => remote.has(id))
    out.set(p.id, ids.length ? await ctx().db.select().from(assets).where(and(eq(assets.workspaceId, p.ws), inArray(assets.id, ids))) : [])
  }
  return out
}

export async function offlineInfo(workspaceId: string): Promise<OfflineInfo> {
  const db = ctx().db
  const inSpace = new Set((await db.select({ id: projects.id }).from(projects).where(eq(projects.workspaceId, workspaceId))).map((p) => p.id))
  const pinned = (await pinnedIds()).filter((id) => inSpace.has(id))
  const clips = await projectClips(pinned)
  const out: Record<string, OfflineProject> = {}
  for (const id of pinned) {
    let missing = 0
    let missingBytes = 0
    for (const a of clips.get(id) ?? []) {
      if (!(await missingKeys(a)).length) continue
      missing++
      if (!(await ctx().storage.stat(a.sourceKey))) missingBytes += a.size
    }
    out[id] = { pinned: true, missing, missingBytes }
  }
  const remote = new Set([...(await syncRows('asset')).values()].filter((s) => s.remote).map((s) => s.id))
  const cloudOnly: string[] = []
  for (const a of await db.select({ id: assets.id, sourceKey: assets.sourceKey }).from(assets).where(eq(assets.workspaceId, workspaceId))) {
    if (remote.has(a.id) && !(await ctx().storage.stat(a.sourceKey))) cloudOnly.push(a.id)
  }
  return { projects: out, cloudOnly }
}

/** Keep a project available offline (its clips download now and after each sync), or stop. */
export async function setOffline(projectId: string, pinned: boolean): Promise<string> {
  const row = (await ctx().db.select({ ws: projects.workspaceId }).from(projects).where(eq(projects.id, projectId)).limit(1))[0]
  if (!row) throw Object.assign(new Error('Project not found'), { notFound: true })
  const cur = await pinnedIds()
  await kvSet('offlineProjects', pinned ? [...new Set([...cur, projectId])] : cur.filter((id) => id !== projectId))
  if (pinned) void keepOffline()
  return row.ws
}

let running: Promise<void> | undefined
let again = false

/** Download what projects kept offline are missing (one run at a time; a call during a run runs once more after). */
export function keepOffline(): Promise<void> {
  if (running) {
    again = true
    return running
  }
  running = (async () => {
    do {
      again = false
      const ids = await pinnedIds()
      const live = new Set((ids.length ? await ctx().db.select({ id: projects.id }).from(projects).where(inArray(projects.id, ids)) : []).map((p) => p.id))
      // projects deleted since are forgotten
      if (live.size !== ids.length) await kvSet('offlineProjects', ids.filter((id) => live.has(id)))
      const clips = await projectClips([...live])
      const seen = new Set<string>()
      for (const list of clips.values())
        for (const a of list) {
          if (seen.has(a.id)) continue
          seen.add(a.id)
          if (a.status !== 'ready' && a.status !== 'processing') continue
          for (const k of await missingKeys(a)) {
            await ensureLocal(a, k).catch((err) => log.warn('desktop: offline download failed', { assetId: a.id, err: (err as Error).message }))
          }
        }
    } while (again)
  })().finally(() => {
    running = undefined
  })
  return running
}
