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

export class S3Storage implements Storage {
  kind = 's3' as const
  private client: S3Client
  private bucket: string

  constructor(cfg: NonNullable<Config['s3']>) {
    this.bucket = cfg.bucket
    this.client = new S3Client({
      region: cfg.region,
      endpoint: cfg.endpoint,
      forcePathStyle: cfg.forcePathStyle,
      credentials: cfg.accessKeyId && cfg.secretAccessKey ? { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey } : undefined,
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
    await pipeline(body, fs.createWriteStream(destPath))
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

  presignPut(key: string, contentType: string, expiresSec = 3600) {
    return getSignedUrl(this.client, new PutObjectCommand({ Bucket: this.bucket, Key: key, ContentType: contentType }), { expiresIn: expiresSec })
  }

  presignGet(key: string, opts: { expiresSec?: number; contentType?: string; filename?: string } = {}) {
    return getSignedUrl(
      this.client,
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
        ResponseContentType: opts.contentType,
        ResponseContentDisposition: opts.filename ? `inline; filename="${opts.filename.replace(/"/g, '')}"` : undefined,
      }),
      { expiresIn: opts.expiresSec ?? 900 },
    )
  }
}
