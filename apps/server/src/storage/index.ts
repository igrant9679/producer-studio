// Object storage abstraction: local disk (dev default) or S3-compatible (S3_BUCKET set).
import type { Readable } from 'node:stream'

export interface StatResult {
  size: number
  mtimeMs: number
}

export interface Storage {
  kind: 'local' | 's3'
  put(key: string, body: Buffer | Readable, opts?: { contentType?: string; maxBytes?: number }): Promise<{ size: number }>
  putFile(key: string, filePath: string, contentType?: string): Promise<{ size: number }>
  /** Stream an object (optionally a byte range, inclusive end). */
  getStream(key: string, range?: { start: number; end: number }): Promise<Readable>
  /** Copy an object to a local file (hardlink/copy for local, download for S3). */
  download(key: string, destPath: string): Promise<void>
  stat(key: string): Promise<StatResult | null>
  delete(key: string): Promise<void>
  deletePrefix(prefix: string): Promise<void>
  /** S3 only: presigned PUT URL. */
  presignPut?(key: string, contentType: string, expiresSec?: number): Promise<string>
  /** S3 only: presigned GET URL. */
  presignGet?(key: string, opts?: { expiresSec?: number; contentType?: string; filename?: string }): Promise<string>
  /** Local only: absolute path of an object on disk. */
  localPath?(key: string): string
}

export class UploadTooLargeError extends Error {
  constructor(public limit: number) {
    super(`Upload exceeds the ${Math.round(limit / 1024 / 1024)} MB limit`)
  }
}

export async function createStorage(cfg: { dataDir: string; s3?: import('../config').Config['s3'] }): Promise<Storage> {
  if (cfg.s3) {
    const { S3Storage } = await import('./s3')
    return new S3Storage(cfg.s3)
  }
  const { LocalStorage } = await import('./local')
  const path = await import('node:path')
  return new LocalStorage(path.join(cfg.dataDir, 'storage'))
}
