import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CopyObjectCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  ListPartsCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
  UploadPartCopyCommand,
} from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import type { Config } from '../config'
import { isStorageNotFound } from './errors'
import { type Storage, type UploadedPart, UploadTooLargeError } from './index'
import { withRetry } from './retry'

/**
 * A bucket that stops answering must fail the call, not hold a job "running" for good: connecting gets 10 s, and a
 * socket that carries nothing for 2 minutes is closed. There is no limit on the whole request (a 4 GB upload is
 * legitimately long while it keeps moving).
 */
export const S3_TIMEOUTS = { connectMs: 10_000, idleMs: 120_000 }

/** The largest object one CopyObject may copy; bigger ones are copied a gigabyte at a time. */
export const S3_COPY_MAX = 5 * 1024 ** 3
const COPY_PART = 1024 ** 3

/** Errors a stream that delivers nothing for `ms` (the SDK's idle timeout stops once response headers arrive). */
function idleGuard(ms: number) {
  let timer: NodeJS.Timeout | undefined
  const t: Transform = new Transform({
    transform(chunk, _e, cb) {
      arm()
      cb(null, chunk)
    },
    flush(cb) {
      clearTimeout(timer)
      cb()
    },
  })
  const arm = () => {
    clearTimeout(timer)
    timer = setTimeout(() => t.destroy(Object.assign(new Error(`The storage download stalled: nothing arrived for ${Math.round(ms / 1000)} s`), { code: 'ETIMEDOUT' })), ms)
    timer.unref()
  }
  t.on('close', () => clearTimeout(timer))
  arm()
  return t
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyCommand = any

export class S3Storage implements Storage {
  kind = 's3' as const
  private client: S3Client
  private bucket: string
  private idleMs: number

  constructor(cfg: NonNullable<Config['s3']>, timeouts = S3_TIMEOUTS) {
    this.bucket = cfg.bucket
    this.idleMs = timeouts.idleMs
    this.client = new S3Client({
      region: cfg.region,
      endpoint: cfg.endpoint,
      forcePathStyle: cfg.forcePathStyle,
      credentials: cfg.accessKeyId && cfg.secretAccessKey ? { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey } : undefined,
      requestHandler: { connectionTimeout: timeouts.connectMs, socketTimeout: timeouts.idleMs },
      // tries again here (withRetry), not in the SDK as well: the SDK's own retries don't cover a download cut off
      // half way, and both together would multiply
      maxAttempts: 1,
      // The SDK's default adds CRC32 checksums: a presigned upload URL then carries the checksum of an empty body
      // (which a validating bucket rejects against the real bytes) and streamed puts use aws-chunked trailers that
      // S3-compatible stores don't all accept. Only send checksums where an operation requires one.
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
    })
  }

  /** One S3 call, made again after a passing failure (P-21). `make` builds the command afresh for each try. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private send(what: string, make: () => AnyCommand): Promise<any> {
    return withRetry(`s3 ${what}`, () => this.client.send(make()))
  }

  async put(key: string, body: Buffer | Readable, opts: { contentType?: string; maxBytes?: number } = {}) {
    if (Buffer.isBuffer(body)) {
      if (opts.maxBytes && body.length > opts.maxBytes) throw new UploadTooLargeError(opts.maxBytes)
      await this.send('put', () => new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: body, ContentType: opts.contentType }))
      return { size: body.length }
    }
    // Buffer streamed uploads through a temp file so the SDK gets a known length.
    const tmp = path.join(os.tmpdir(), `ps-up-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    let size = 0
    const limit = opts.maxBytes ?? Infinity
    const counter = new Transform({
      transform(chunk: Buffer, _e, cb) {
        size += chunk.length
        if (size > limit) cb(new UploadTooLargeError(limit))
        else cb(null, chunk)
      },
    })
    try {
      await pipeline(body, counter, fs.createWriteStream(tmp))
      await this.putFile(key, tmp, opts.contentType)
    } finally {
      await fsp.rm(tmp, { force: true })
    }
    return { size }
  }

  async putFile(key: string, filePath: string, contentType?: string) {
    const st = await fsp.stat(filePath)
    // a fresh file stream on each try: a body half-sent can't be sent again
    await this.send('put file', () => new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: fs.createReadStream(filePath), ContentLength: st.size, ContentType: contentType }))
    return { size: st.size }
  }

  async getStream(key: string, range?: { start: number; end: number }) {
    const res = await this.send('get', () => new GetObjectCommand({ Bucket: this.bucket, Key: key, Range: range ? `bytes=${range.start}-${range.end}` : undefined }))
    return res.Body as Readable
  }

  async download(key: string, destPath: string) {
    await fsp.mkdir(path.dirname(destPath), { recursive: true })
    // a download cut off half way starts again from the beginning
    await withRetry(`s3 download`, async () => {
      const res = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }))
      await pipeline(res.Body as Readable, idleGuard(this.idleMs), fs.createWriteStream(destPath))
    })
  }

  async copy(from: string, to: string, contentType?: string) {
    const head = await this.send('stat', () => new HeadObjectCommand({ Bucket: this.bucket, Key: from }))
    const size = Number(head.ContentLength ?? 0)
    const source = `${this.bucket}/${from.split('/').map(encodeURIComponent).join('/')}`
    const type = contentType ?? head.ContentType
    if (size <= S3_COPY_MAX) {
      await this.send('copy', () => new CopyObjectCommand({ Bucket: this.bucket, Key: to, CopySource: source, ContentType: type, MetadataDirective: 'REPLACE' }))
      return
    }
    const uploadId = await this.createMultipart(to, type ?? 'application/octet-stream')
    try {
      const parts: UploadedPart[] = []
      for (let start = 0, n = 1; start < size; start += COPY_PART, n++) {
        const end = Math.min(size, start + COPY_PART) - 1
        const r = await this.send('copy part', () => new UploadPartCopyCommand({ Bucket: this.bucket, Key: to, UploadId: uploadId, PartNumber: n, CopySource: source, CopySourceRange: `bytes=${start}-${end}` }))
        parts.push({ partNumber: n, size: end - start + 1, etag: r.CopyPartResult?.ETag ?? '' })
      }
      await this.completeMultipart(to, uploadId, parts)
    } catch (err) {
      await this.abortMultipart(to, uploadId).catch(() => undefined)
      throw err
    }
  }

  async stat(key: string) {
    try {
      const res = await this.send('stat', () => new HeadObjectCommand({ Bucket: this.bucket, Key: key }))
      return { size: Number(res.ContentLength ?? 0), mtimeMs: res.LastModified?.getTime() ?? 0 }
    } catch (err) {
      // only a 404 is "not there": a revoked key or an unreachable bucket must not read as a missing file
      if (isStorageNotFound(err)) return null
      throw err
    }
  }

  async delete(key: string) {
    await this.send('delete', () => new DeleteObjectCommand({ Bucket: this.bucket, Key: key }))
  }

  async deletePrefix(prefix: string) {
    let token: string | undefined
    do {
      const list = await this.send('list', () => new ListObjectsV2Command({ Bucket: this.bucket, Prefix: prefix, ContinuationToken: token }))
      const keys = ((list.Contents ?? []) as Array<{ Key?: string }>).map((o) => ({ Key: o.Key! }))
      if (keys.length) await this.send('delete many', () => new DeleteObjectsCommand({ Bucket: this.bucket, Delete: { Objects: keys } }))
      token = list.IsTruncated ? list.NextContinuationToken : undefined
    } while (token)
  }

  presignPut(key: string, contentType: string, opts: { size?: number; expiresSec?: number } = {}) {
    // Content-Length is part of the signature, so the declared size is the only size the bucket will take
    // (otherwise a client could declare 1 byte, pass the upload limit, and PUT up to 5 GB).
    return getSignedUrl(this.client, new PutObjectCommand({ Bucket: this.bucket, Key: key, ContentType: contentType, ContentLength: opts.size }), {
      expiresIn: opts.expiresSec ?? 3600,
    })
  }

  presignGet(key: string, opts: { expiresSec?: number; contentType?: string; disposition?: string } = {}) {
    return getSignedUrl(
      this.client,
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
        ResponseContentType: opts.contentType,
        ResponseContentDisposition: opts.disposition,
      }),
      { expiresIn: opts.expiresSec ?? 900 },
    )
  }

  // ---- multipart (P-5) ----

  async createMultipart(key: string, contentType: string) {
    const r = await this.send('start upload', () => new CreateMultipartUploadCommand({ Bucket: this.bucket, Key: key, ContentType: contentType }))
    if (!r.UploadId) throw new Error('The storage bucket did not start the upload')
    return r.UploadId as string
  }

  presignPart(key: string, uploadId: string, partNumber: number, size: number, expiresSec = 3600) {
    // the part's length is signed: the bucket takes exactly `size` bytes for it, so the whole is the size announced
    return getSignedUrl(this.client, new UploadPartCommand({ Bucket: this.bucket, Key: key, UploadId: uploadId, PartNumber: partNumber, ContentLength: size }), {
      expiresIn: expiresSec,
    })
  }

  async listParts(key: string, uploadId: string): Promise<UploadedPart[]> {
    const parts: UploadedPart[] = []
    let marker: string | undefined
    do {
      const r = await this.send('list parts', () => new ListPartsCommand({ Bucket: this.bucket, Key: key, UploadId: uploadId, PartNumberMarker: marker }))
      for (const p of (r.Parts ?? []) as Array<{ PartNumber?: number; Size?: number; ETag?: string }>) parts.push({ partNumber: p.PartNumber ?? 0, size: Number(p.Size ?? 0), etag: p.ETag ?? '' })
      marker = r.IsTruncated ? String(r.NextPartNumberMarker ?? '') || undefined : undefined
    } while (marker)
    return parts.sort((a, b) => a.partNumber - b.partNumber)
  }

  async completeMultipart(key: string, uploadId: string, parts: UploadedPart[]) {
    await this.send(
      'finish upload',
      () => new CompleteMultipartUploadCommand({ Bucket: this.bucket, Key: key, UploadId: uploadId, MultipartUpload: { Parts: parts.map((p) => ({ PartNumber: p.partNumber, ETag: p.etag })) } }),
    )
  }

  async abortMultipart(key: string, uploadId: string) {
    await this.send('abort upload', () => new AbortMultipartUploadCommand({ Bucket: this.bucket, Key: key, UploadId: uploadId }))
  }
}
