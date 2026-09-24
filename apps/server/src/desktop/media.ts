// Cloud media on the desktop: asset records arrive with the change feed, bytes are fetched on demand (first request
// of a variant) or eagerly (Settings → Download all), cached in local storage under the same keys, sha256-verified
// for the source, and then served like any local file (Range support). While a download runs, the media route
// answers 202 + Retry-After and the editor retries.
import crypto from 'node:crypto'
import { Readable, Transform } from 'node:stream'
import type { Context } from 'hono'
import { ctx } from '../context'
import type { AssetRow } from '../services/assets'
import { log } from '../log'
import type { Variant } from '../media/serve'
import { CloudError } from './cloud'
import { syncRow, syncRows } from './db'
import { cloud } from './link'

const GRACE_MS = 4000
const inflight = new Map<string, Promise<void>>()

export function variantForKey(row: AssetRow, key: string): Variant | null {
  if (key === row.sourceKey) return 'source'
  if (key === row.proxyKey) return 'proxy'
  if (key === row.thumbKey) return 'thumb'
  if (key === row.filmstripKey) return 'filmstrip'
  if (key === row.audioKey) return 'audio'
  return null
}

async function download(row: AssetRow, key: string, variant: Variant): Promise<void> {
  const c = cloud()
  if (!c) throw new CloudError(0, { error: 'This computer is not linked to the cloud' }, true)
  const res = await c.request('GET', `/api/media/${encodeURIComponent(row.id)}/${variant}`)
  if (!res.ok || !res.body) {
    await res.body?.cancel().catch(() => undefined)
    throw new CloudError(res.status, { error: `The cloud has no ${variant} for this asset (HTTP ${res.status})` }, res.status >= 502)
  }
  const hash = crypto.createHash('sha256')
  const tap = new Transform({
    transform(chunk: Buffer, _e, cb) {
      hash.update(chunk)
      cb(null, chunk)
    },
  })
  const src = Readable.fromWeb(res.body as import('node:stream/web').ReadableStream).pipe(tap)
  await ctx().storage.put(key, src, { contentType: res.headers.get('content-type') ?? undefined })
  if (variant === 'source' && row.sha256) {
    const got = hash.digest('hex')
    if (got !== row.sha256) {
      await ctx().storage.delete(key)
      throw new Error(`Downloaded media for ${row.name} failed its integrity check (sha256 mismatch)`)
    }
  }
  log.info('desktop: cached cloud media', { assetId: row.id, variant })
}

/** Download a variant once (concurrent callers share the promise). */
export function ensureLocal(row: AssetRow, key: string): Promise<void> {
  const variant = variantForKey(row, key)
  if (!variant) return Promise.reject(new Error('Unknown media key'))
  let p = inflight.get(key)
  if (!p) {
    p = (async () => {
      if (await ctx().storage.stat(key)) return
      await download(row, key, variant)
    })().finally(() => inflight.delete(key))
    inflight.set(key, p)
  }
  return p
}

export async function isRemoteAsset(assetId: string): Promise<boolean> {
  return Boolean((await syncRow('asset', assetId))?.remote)
}

/**
 * Media route hook: null = serve normally (file present, or not a cloud asset); otherwise a 202 (downloading) or an
 * error response.
 */
export async function desktopMediaResponse(c: Context, row: AssetRow, key: string): Promise<Response | null> {
  if (await ctx().storage.stat(key)) return null
  if (!(await isRemoteAsset(row.id))) return null
  const p = ensureLocal(row, key)
  p.catch(() => undefined)
  const outcome = await Promise.race([p.then(() => 'done' as const, (e: unknown) => e), new Promise<'wait'>((r) => setTimeout(() => r('wait'), GRACE_MS))])
  if (outcome === 'done') return null
  if (outcome === 'wait') return c.json({ status: 'downloading', assetId: row.id }, 202, { 'Retry-After': '2', 'Cache-Control': 'no-store' })
  const err = outcome as Error
  if (err instanceof CloudError && err.offline) return c.json({ error: 'This media is stored in the cloud and the cloud is unreachable right now', code: 'server' }, 503, { 'Retry-After': '10' })
  return c.json({ error: err.message || 'Media not available', code: 'not_found' }, 404)
}

/** localSource() hook (render, transcribe, contact sheets): fetch a missing cloud file before use. */
export async function fetchMissingMedia(row: AssetRow, key: string): Promise<boolean> {
  if (!(await isRemoteAsset(row.id))) return false
  await ensureLocal(row, key)
  return true
}

let eager: Promise<void> | undefined

/** Background download of every cloud asset's variants (mediaSync: 'all'). */
export function prefetchAllMedia(): Promise<void> {
  eager ??= (async () => {
    const remote = [...(await syncRows('asset')).values()].filter((r) => r.remote).map((r) => r.id)
    if (!remote.length) return
    const { assets } = await import('../db/schema')
    const { inArray } = await import('drizzle-orm')
    const rows = await ctx().db.select().from(assets).where(inArray(assets.id, remote))
    const jobs: Array<[AssetRow, string]> = []
    for (const r of rows) for (const k of [r.thumbKey, r.filmstripKey, r.proxyKey, r.sourceKey]) if (k) jobs.push([r, k])
    let i = 0
    const worker = async () => {
      while (i < jobs.length) {
        const [r, k] = jobs[i++]
        if (r.status !== 'ready' && k !== r.sourceKey) continue
        await ensureLocal(r, k).catch((err) => log.warn('desktop: prefetch failed', { assetId: r.id, err: (err as Error).message }))
      }
    }
    await Promise.all([worker(), worker()])
  })().finally(() => {
    eager = undefined
  })
  return eager
}
