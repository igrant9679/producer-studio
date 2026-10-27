// Cloud media on the desktop: asset records arrive with the change feed, bytes are fetched on demand (first request
// of a variant) or eagerly (Settings → Download all), cached in local storage under the same keys, sha256-verified
// for the source, and then served like any local file (Range support). While a download runs, the media route
// answers 202 + Retry-After and the editor retries.
import crypto from 'node:crypto'
import fsp from 'node:fs/promises'
import { Readable, Transform } from 'node:stream'
import type { Context } from 'hono'
import { ctx } from '../context'
import type { AssetRow } from '../services/assets'
import { log } from '../log'
import { waveformKey } from '../media/process'
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
  if (row.meta?.waveformFull && key === waveformKey(row)) return 'waveform'
  return null
}

async function download(row: AssetRow, key: string, variant: Variant): Promise<void> {
  const c = cloud()
  if (!c) throw new CloudError(0, { error: 'This computer is not linked to the cloud' }, true)
  // a slow link keeps going; a download that stops moving fails (and is tried again on the next request)
  const res = await c.request('GET', `/api/media/${encodeURIComponent(row.id)}/${variant}`, { idleTimeoutMs: 60_000 })
  if (!res.ok || !res.body) {
    await res.body?.cancel().catch(() => undefined)
    throw new CloudError(res.status, { error: `The cloud has no ${variant} for this asset (HTTP ${res.status})` }, res.status >= 502)
  }
  // media never comes as a web page: that's a Wi-Fi sign-in page answering for the cloud
  if (/^text\/html/i.test(res.headers.get('content-type') ?? '')) {
    await res.body.cancel().catch(() => undefined)
    throw new CloudError(0, { error: 'The cloud is unreachable (something else answered instead, such as a Wi-Fi sign-in page)' }, true)
  }
  const hash = crypto.createHash('sha256')
  const tap = new Transform({
    transform(chunk: Buffer, _e, cb) {
      hash.update(chunk)
      cb(null, chunk)
    },
  })
  const body = Readable.fromWeb(res.body as import('node:stream/web').ReadableStream)
  // .pipe() doesn't pass a failed download on: without this the save would wait for good
  body.on('error', (err) => tap.destroy(err))
  const storage = ctx().storage
  // an original lands under a temporary name and takes its own only once its hash checks out: nothing can read it before
  const verify = variant === 'source' && !!row.sha256 && !!storage.localPath
  const target = verify ? `${key}.download` : key
  await storage.put(target, body.pipe(tap), { contentType: res.headers.get('content-type') ?? undefined })
  if (verify) {
    const got = hash.digest('hex')
    if (got !== row.sha256) {
      await storage.delete(target)
      throw new Error(`Downloaded media for ${row.name} failed its integrity check (sha256 mismatch)`)
    }
    await fsp.rename(storage.localPath!(target), storage.localPath!(key))
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
