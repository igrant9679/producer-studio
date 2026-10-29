// The same file uploaded again into a space (P-21): same sha256 as a clip already processed there by this version of
// processing. Its proxy, thumbnail, filmstrip, audio and waveform are copied (inside storage) to the new clip instead
// of being made again; the new clip is still a clip of its own (its own row and files, so either can be removed).
import { and, desc, eq, ne } from 'drizzle-orm'
import type { AssetMeta } from '../db/schema'
import { ctx } from '../context'
import { assets } from '../db/schema'
import { log } from '../log'
import { type AssetRow, assetPrefix, updateAsset } from '../services/assets'

/** What processing found or made: copied with the files. (Not a transcript, voice text, captions: they're the clip's.) */
const PROCESSED_META: Array<keyof AssetMeta> = ['duration', 'width', 'height', 'fps', 'hasAudio', 'codec', 'filmstrip', 'waveform', 'waveformRate', 'waveformFull', 'silences', 'alpha', 'colorMatrix', 'processing', 'proxyEncoder']

/** A ready clip of the same space with the same bytes, processed by this version (null when there is none). */
export async function processedTwin(row: Pick<AssetRow, 'id' | 'workspaceId' | 'sha256' | 'kind'>): Promise<AssetRow | null> {
  if (!row.sha256) return null
  const { PROCESSING_VERSION } = await import('./process')
  const rows = await ctx()
    .db.select()
    .from(assets)
    .where(and(eq(assets.workspaceId, row.workspaceId), eq(assets.sha256, row.sha256), eq(assets.status, 'ready'), ne(assets.id, row.id)))
    .orderBy(desc(assets.createdAt))
    .limit(5)
  // made by today's processing, with the files and the findings that kind of clip has
  const complete = (r: AssetRow) => {
    const m = r.meta ?? {}
    if (m.processing !== PROCESSING_VERSION || m.hasAudio === undefined) return false
    if (r.kind === 'image') return !!r.thumbKey && !!m.width
    if (r.kind === 'video') return !!(r.proxyKey && r.thumbKey && m.duration && m.width)
    return !!(m.duration && m.waveform?.length)
  }
  return rows.find(complete) ?? null
}

/** Give `row` copies of `twin`'s processed files and what processing found, and make it ready. */
export async function reuseProcessing(row: AssetRow, twin: AssetRow): Promise<AssetRow> {
  const storage = ctx().storage
  const prefix = assetPrefix(row.workspaceId, row.id)
  const keys: Partial<Pick<AssetRow, 'proxyKey' | 'thumbKey' | 'filmstripKey' | 'audioKey'>> = {}
  for (const k of ['proxyKey', 'thumbKey', 'filmstripKey', 'audioKey'] as const) {
    const from = twin[k]
    if (!from) continue
    const to = `${prefix}/${from.split('/').pop()}`
    await storage.copy(from, to)
    keys[k] = to
  }
  if (twin.meta?.waveformFull) await storage.copy(`${assetPrefix(twin.workspaceId, twin.id)}/waveform.bin`, `${prefix}/waveform.bin`)
  const meta: Partial<AssetMeta> = {}
  for (const k of PROCESSED_META) if (twin.meta?.[k] !== undefined) (meta as Record<string, unknown>)[k] = twin.meta[k]
  meta.reusedFrom = twin.id
  log.info('identical upload: reused processing', { assetId: row.id, from: twin.id })
  return updateAsset(row.id, { ...keys, meta, kind: twin.kind, status: 'ready', error: null })
}
