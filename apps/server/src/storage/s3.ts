import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import {
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import type { Config } from '../config'
import { type Storage, UploadTooLargeError } from './index'

/**
 * A bucket that stops answering must fail the call, not hold a job "running" for good: connecting gets 10 s, and a
 * socket that carries nothing for 2 minutes is closed. There is no limit on the whole request (a 4 GB upload is
 * legitimately long while it keeps moving).
 */
export const S3_TIMEOUTS = { connectMs: 10_000, idleMs: 120_000 }

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
      // The SDK's default adds CRC32 checksums: a presigned upload URL then carries the checksum of an empty body
      // (which a validating bucket rejects against the real bytes) and streamed puts use aws-chunked trailers that
      // S3-compatible stores don't all accept. Only send checksums where an operation requires one.
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
    })
  }

  async put(key: string, body: Buffer | Readable, opts: { contentType?: string; maxBytes?: number } = {}) {
    if (Buffer.isBuffer(body)) {
      if (opts.maxBytes && body.length > opts.maxBytes) throw new UploadTooLargeError(opts.maxBytes)
      await this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: body, ContentType: opts.contentType }))
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
    await this.client.send(
      new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: fs.createReadStream(filePath), ContentLength: st.size, ContentType: contentType }),
    )
    return { size: st.size }
  }

  async getStream(key: string, range?: { start: number; end: number }) {
    const res = await this.client.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: key, Range: range ? `bytes=${range.start}-${range.end}` : undefined }),
    )
    return res.Body as Readable
  }

  async download(key: string, destPath: string) {
    await fsp.mkdir(path.dirname(destPath), { recursive: true })
    const body = await this.getStream(key)
    await pipeline(body, idleGuard(this.idleMs), fs.createWriteStream(destPath))
  }

  async stat(key: string) {
    try {
      const res = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }))
      return { size: Number(res.ContentLength ?? 0), mtimeMs: res.LastModified?.getTime() ?? 0 }
    } catch {
      return null
    }
  }

  async delete(key: string) {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }))
  }

  async deletePrefix(prefix: string) {
    let token: string | undefined
    do {
      const list = await this.client.send(new ListObjectsV2Command({ Bucket: this.bucket, Prefix: prefix, ContinuationToken: token }))
      const keys = (list.Contents ?? []).map((o) => ({ Key: o.Key! }))
      if (keys.length) await this.client.send(new DeleteObjectsCommand({ Bucket: this.bucket, Delete: { Objects: keys } }))
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
}
