// The storage layer (P-5, P-21): passing failures are tried again with backoff, objects copy inside storage, and
// multipart uploads (parts in any order, listed for a resume, joined on complete) work on disk and on S3.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PartSizeError, type Storage, UploadTooLargeError } from '../storage'
import { LocalStorage } from '../storage/local'
import { isTransientStorageError, STORAGE_RETRY, withRetry } from '../storage/retry'
import { S3Storage } from '../storage/s3'
import { type FakeS3, startFakeS3 } from './fake-s3'

let s3: FakeS3
let local: LocalStorage
let bucket: S3Storage

beforeAll(async () => {
  STORAGE_RETRY.baseMs = 1
  s3 = await startFakeS3()
  bucket = new S3Storage({ bucket: s3.bucket, endpoint: s3.url, region: 'auto', accessKeyId: 'k', secretAccessKey: 's', forcePathStyle: true }, { connectMs: 2000, idleMs: 5000 })
  local = new LocalStorage(fs.mkdtempSync(path.join(os.tmpdir(), 'ps-store-')))
})

afterAll(async () => {
  STORAGE_RETRY.baseMs = 250
  await s3.close()
})

const text = async (st: Storage, key: string) => {
  const chunks: Buffer[] = []
  for await (const c of await st.getStream(key)) chunks.push(c as Buffer)
  return Buffer.concat(chunks).toString()
}

describe('retries for passing storage errors (P-21)', () => {
  it('tells passing failures from lasting ones', () => {
    expect(isTransientStorageError(Object.assign(new Error('reset'), { code: 'ECONNRESET' }))).toBe(true)
    expect(isTransientStorageError({ name: 'SlowDown', $metadata: { httpStatusCode: 503 } })).toBe(true)
    expect(isTransientStorageError({ name: 'InternalError', $metadata: { httpStatusCode: 500 } })).toBe(true)
    expect(isTransientStorageError({ name: 'NoSuchKey', $metadata: { httpStatusCode: 404 } })).toBe(false)
    expect(isTransientStorageError({ name: 'InvalidAccessKeyId', $metadata: { httpStatusCode: 403 } })).toBe(false)
    expect(isTransientStorageError(Object.assign(new Error('full'), { code: 'ENOSPC' }))).toBe(false)
    // a silent bucket is asked once more, not four times
    expect(isTransientStorageError({ name: 'TimeoutError' }, 1)).toBe(true)
    expect(isTransientStorageError({ name: 'TimeoutError' }, 2)).toBe(false)
  })

  it('tries again and succeeds; gives up after the last try; never retries a lasting error', async () => {
    let n = 0
    expect(await withRetry('t', async () => (++n < 3 ? Promise.reject(Object.assign(new Error('x'), { code: 'ECONNRESET' })) : 'ok'))).toBe('ok')
    expect(n).toBe(3)
    n = 0
    await expect(withRetry('t', async () => (n++, Promise.reject(Object.assign(new Error('x'), { code: 'EPIPE' }))))).rejects.toThrow('x')
    expect(n).toBe(STORAGE_RETRY.attempts)
    n = 0
    await expect(withRetry('t', async () => (n++, Promise.reject({ name: 'AccessDenied', $metadata: { httpStatusCode: 403 } })))).rejects.toBeTruthy()
    expect(n).toBe(1)
  })

  it('an S3 upload, read and delete go through a bucket that says "slow down" twice', async () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ps-s3f-')), 'a.txt')
    fs.writeFileSync(file, 'hello bucket')
    s3.failNext(2, (m) => m === 'PUT')
    await bucket.putFile('ws/w/assets/a/source.txt', file, 'text/plain')
    expect(s3.objects.get('ws/w/assets/a/source.txt')?.body.toString()).toBe('hello bucket')
    s3.failNext(1, (m) => m === 'GET')
    expect(await text(bucket, 'ws/w/assets/a/source.txt')).toBe('hello bucket')
    s3.failNext(1, (m) => m === 'GET')
    const dl = path.join(path.dirname(file), 'dl.txt')
    await bucket.download('ws/w/assets/a/source.txt', dl)
    expect(fs.readFileSync(dl, 'utf8')).toBe('hello bucket')
    s3.failNext(1, (m) => m === 'HEAD')
    expect((await bucket.stat('ws/w/assets/a/source.txt'))?.size).toBe(12)
    s3.failNext(1, (m) => m === 'DELETE')
    await bucket.delete('ws/w/assets/a/source.txt')
    expect(s3.objects.has('ws/w/assets/a/source.txt')).toBe(false)
  })
})

describe.each([
  ['local', () => local as Storage],
  ['s3', () => bucket as Storage],
])('%s storage: copies and multipart uploads (P-5)', (kind, st) => {
  it('copies an object inside storage', async () => {
    await st().put(`ws/w/assets/c/source.mp4`, Buffer.from('original'), { contentType: 'video/mp4' })
    await st().copy('ws/w/assets/c/source.mp4', 'ws/v/assets/d/source.mp4', 'video/mp4')
    expect(await text(st(), 'ws/v/assets/d/source.mp4')).toBe('original')
    // the copy stands on its own
    await st().delete('ws/w/assets/c/source.mp4')
    expect(await text(st(), 'ws/v/assets/d/source.mp4')).toBe('original')
  })

  it('takes parts in any order, lists what arrived, and joins them in order', async () => {
    const key = `ws/w/assets/m-${kind}/source.bin`
    const id = await st().createMultipart(key, 'application/octet-stream')
    const send = async (n: number, s: string) => {
      if (st().presignPart) {
        const url = await st().presignPart!(key, id, n, s.length)
        // the part's length is signed into its URL
        expect(new URL(url).searchParams.get('X-Amz-SignedHeaders')).toMatch(/content-length/)
        const r = await fetch(url, { method: 'PUT', body: s })
        expect(r.ok).toBe(true)
      } else await st().putPart!(key, id, n, Readable.from([Buffer.from(s)]), s.length)
    }
    await send(2, 'BBBB')
    await send(1, 'AAAA')
    expect((await st().listParts(key, id)).map((p) => [p.partNumber, p.size])).toEqual([[1, 4], [2, 4]])
    await send(3, 'CC')
    const parts = await st().listParts(key, id)
    expect(parts.every((p) => p.etag)).toBe(true)
    await st().completeMultipart(key, id, parts)
    expect(await text(st(), key)).toBe('AAAABBBBCC')
  })

  it('an aborted upload is gone', async () => {
    const key = `ws/w/assets/x-${kind}/source.bin`
    const id = await st().createMultipart(key, 'application/octet-stream')
    await st().abortMultipart(key, id)
    await expect(st().listParts(key, id)).rejects.toBeTruthy()
  })
})

describe('local parts are exactly the size announced', () => {
  it('refuses a longer or a shorter part, and keeps nothing of it', async () => {
    const key = 'ws/w/assets/p/source.bin'
    const id = await local.createMultipart(key, 'application/octet-stream')
    await expect(local.putPart(key, id, 1, Readable.from([Buffer.from('12345')]), 4)).rejects.toBeInstanceOf(UploadTooLargeError)
    await expect(local.putPart(key, id, 1, Readable.from([Buffer.from('123')]), 4)).rejects.toBeInstanceOf(PartSizeError)
    expect(await local.listParts(key, id)).toEqual([])
    // another object's upload id can't be written to
    await expect(local.putPart('ws/w/assets/q/source.bin', id, 1, Readable.from([Buffer.from('1234')]), 4)).rejects.toThrow(/No such upload/)
  })
})
