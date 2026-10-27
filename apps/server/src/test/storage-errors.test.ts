// Storage errors say what is wrong by their code (network, disk full, permissions, a revoked key), and only a real 404
// reads as "not found" (PIP-26). Download names that aren't plain ASCII survive the S3 signed URL (PIP-32).
// No bucket is contacted: the S3 client's send is replaced, and presigning is computed locally.
import { describe, expect, it } from 'vitest'
import { contentDisposition } from '../media/serve'
import { friendlyProcessingError } from '../media/process'
import { describeStorageError } from '../services/storage-health'
import { S3Storage } from '../storage/s3'

const sysErr = (code: string, message = `${code} something`) => Object.assign(new Error(message), { code })
const s3Err = (name: string, status: number) => Object.assign(new Error(name), { name, $metadata: { httpStatusCode: status } })

function bucket(fail?: unknown) {
  const s = new S3Storage({ bucket: 'b', endpoint: 'http://127.0.0.1:9', region: 'auto', accessKeyId: 'AK', secretAccessKey: 'SK', forcePathStyle: true })
  if (fail) (s as unknown as { client: { send: () => Promise<never> } }).client.send = async () => Promise.reject(fail)
  return s
}

describe('storage errors (PIP-26)', () => {
  it('network, disk and permission errors keep their wording', () => {
    expect(describeStorageError(sysErr('ECONNREFUSED', 'connect ECONNREFUSED 127.0.0.1:9'))).toMatch(/can't be reached \(ECONNREFUSED\)/)
    expect(describeStorageError(sysErr('ECONNRESET'))).toMatch(/can't be reached/)
    expect(describeStorageError(new TypeError('fetch failed', { cause: sysErr('ENOTFOUND') }))).toMatch(/can't be reached \(ENOTFOUND\)/)
    expect(describeStorageError(Object.assign(new Error('timed out'), { name: 'TimeoutError' }))).toMatch(/can't be reached/)
    expect(describeStorageError(sysErr('ENOSPC', 'ENOSPC: no space left on device, write'))).toMatch(/^Storage is full/)
    expect(describeStorageError(sysErr('EACCES', "EACCES: permission denied, open '/data/storage/x'"))).toMatch(/isn't allowed to read or write/)
    expect(describeStorageError(s3Err('SlowDown', 503))).toMatch(/having trouble/)
    expect(describeStorageError(s3Err('NoSuchKey', 404))).toMatch(/isn't in storage/)
    // what worked before still does
    expect(describeStorageError({ name: 'InvalidAccessKeyId', $metadata: { httpStatusCode: 403 } })).toMatch(/rotated or revoked/)
    expect(describeStorageError({ name: 'Whatever', $metadata: { httpStatusCode: 403 } })).toMatch(/refused.*\(403\)/)
  })

  it('a clip whose download from the bucket broke says so, not "Processing failed: read ECONNRESET"', () => {
    expect(friendlyProcessingError(sysErr('ECONNRESET', 'read ECONNRESET'))).toMatch(/can't be reached/)
    expect(friendlyProcessingError(s3Err('NoSuchKey', 404))).toMatch(/isn't in storage/)
  })

  it('only a 404 is "not there": a refused key or an unreachable bucket is an error', async () => {
    expect(await bucket(s3Err('NotFound', 404)).stat('k')).toBeNull()
    await expect(bucket(s3Err('Forbidden', 403)).stat('k')).rejects.toMatchObject({ name: 'Forbidden' })
    await expect(bucket(sysErr('ECONNREFUSED')).stat('k')).rejects.toMatchObject({ code: 'ECONNREFUSED' })
    // a missing bucket also answers 404, but is not a missing file
    await expect(bucket(s3Err('NoSuchBucket', 404)).stat('k')).rejects.toMatchObject({ name: 'NoSuchBucket' })
  })
})

describe('download names on S3 (PIP-32)', () => {
  const name = "Café — résumé (final) it's 日本*!.mp4"

  it('the signed URL names the download in UTF-8, the way local storage does', async () => {
    const url = await bucket().presignGet('ws/w/assets/a/source.mp4', { contentType: 'video/mp4', disposition: contentDisposition('attachment', name) })
    const header = new URL(url).searchParams.get('response-content-disposition')!
    expect(header).toBe(contentDisposition('attachment', name))
    // a header value: Latin-1 only
    expect(/^[\x20-\x7e]*$/.test(header)).toBe(true)
    const m = header.match(/filename\*=UTF-8''([^;]+)$/)!
    // RFC 5987 attr-chars only, so a parser can't end the value early at the apostrophe
    expect(m[1]).toMatch(/^[A-Za-z0-9!#$&+\-.^_`|~%]+$/)
    expect(m[1]).not.toMatch(/['()*]/)
    expect(decodeURIComponent(m[1])).toBe(name)
    expect(header).toMatch(/^attachment; filename="Caf_ _ r_sum_ \(final\) it's __\*!\.mp4"; /)
  })
})
