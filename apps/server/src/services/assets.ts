import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import { ctx } from '../context'
import { type AssetMeta, assets } from '../db/schema'
import { assetRecord } from '../dto'
import { notFound } from '../http'
import { newId } from '../ids'

export type AssetRow = typeof assets.$inferSelect

export function emitAsset(a: AssetRow) {
  ctx().bus.publish(a.workspaceId, 'asset', assetRecord(a), { id: a.id })
}

export async function loadAsset(id: string): Promise<AssetRow> {
  const row = (await ctx().db.select().from(assets).where(eq(assets.id, id)).limit(1))[0]
  if (!row) throw notFound('Asset not found')
  return row
}

export async function updateAsset(id: string, patch: Partial<AssetRow>): Promise<AssetRow> {
  const [row] = await ctx()
    .db.update(assets)
    .set({ ...patch, updatedAt: Date.now() })
    .where(eq(assets.id, id))
    .returning()
  if (!row) throw notFound('Asset not found')
  emitAsset(row)
  return row
}

export async function mergeAssetMeta(id: string, patch: Partial<AssetMeta>): Promise<AssetRow> {
  const cur = await loadAsset(id)
  return updateAsset(id, { meta: { ...(cur.meta ?? {}), ...patch } })
}

export const assetPrefix = (workspaceId: string, assetId: string) => `ws/${workspaceId}/assets/${assetId}`

export function extFor(filename: string, mime: string): string {
  const fromName = path.extname(filename).toLowerCase().replace(/[^a-z0-9.]/g, '')
  if (fromName && fromName.length <= 6) return fromName
  const map: Record<string, string> = { 'video/mp4': '.mp4', 'video/quicktime': '.mov', 'video/webm': '.webm', 'audio/wav': '.wav', 'audio/x-wav': '.wav', 'audio/mpeg': '.mp3', 'audio/mp4': '.m4a', 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/gif': '.gif' }
  return map[mime] ?? '.bin'
}

export function kindFromMime(mime: string, filename = ''): 'video' | 'audio' | 'image' {
  if (mime.startsWith('video/')) return 'video'
  if (mime.startsWith('audio/')) return 'audio'
  if (mime.startsWith('image/')) return 'image'
  const ext = path.extname(filename).toLowerCase()
  if (['.wav', '.mp3', '.m4a', '.aac', '.flac', '.ogg', '.opus'].includes(ext)) return 'audio'
  if (['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.svg'].includes(ext)) return 'image'
  return 'video'
}

export const MIME_BY_EXT: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.flac': 'audio/flac',
  '.ogg': 'audio/ogg',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
}

/** Create an asset row from a local file already produced on the server (TTS, render, freeze frame). */
export async function createAssetFromFile(opts: {
  workspaceId: string
  userId: string
  projectId?: string | null
  filePath: string
  name: string
  mime: string
  kind: 'video' | 'audio' | 'image'
  origin: string
  meta?: AssetMeta
  status?: 'processing' | 'ready'
}): Promise<AssetRow> {
  const id = newId('as')
  const key = `${assetPrefix(opts.workspaceId, id)}/source${path.extname(opts.filePath) || extFor(opts.name, opts.mime)}`
  const { size } = await ctx().storage.putFile(key, opts.filePath, opts.mime)
  const now = Date.now()
  const [row] = await ctx()
    .db.insert(assets)
    .values({
      id,
      workspaceId: opts.workspaceId,
      projectId: opts.projectId ?? null,
      kind: opts.kind,
      name: opts.name,
      mime: opts.mime,
      size,
      status: opts.status ?? 'processing',
      origin: opts.origin,
      sourceKey: key,
      meta: opts.meta ?? {},
      createdBy: opts.userId,
      createdAt: now,
      updatedAt: now,
    })
    .returning()
  emitAsset(row)
  return row
}

type MissingMediaFetcher = (row: AssetRow, key: string) => Promise<boolean>
let missingMediaFetcher: MissingMediaFetcher | undefined

/** Desktop hook: fetch a cloud asset's bytes into local storage the first time a job needs them. */
export function setMissingMediaFetcher(fn: MissingMediaFetcher | undefined) {
  missingMediaFetcher = fn
}

/** A local filesystem path for an asset's source (downloaded to `tmpDir` for S3). */
export async function localSource(row: AssetRow, tmpDir: string, key = row.sourceKey): Promise<string> {
  const s = ctx().storage
  if (s.localPath) {
    const p = s.localPath(key)
    if (fs.existsSync(p)) return p
    if (missingMediaFetcher && (await missingMediaFetcher(row, key)) && fs.existsSync(p)) return p
    throw notFound('Asset file is missing from storage')
  }
  const dest = path.join(tmpDir, `${row.id}${path.extname(key)}`)
  if (!fs.existsSync(dest)) await s.download(key, dest)
  return dest
}

export function tmpDir(tag: string): string {
  const d = path.join(ctx().config.dataDir, 'tmp', `${tag}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`)
  fs.mkdirSync(d, { recursive: true })
  return d
}

/** sha256 (hex) of a stored object, streamed. */
export async function hashObject(key: string): Promise<string> {
  const h = crypto.createHash('sha256')
  const stream = await ctx().storage.getStream(key)
  for await (const chunk of stream) h.update(chunk as Buffer)
  return h.digest('hex')
}
