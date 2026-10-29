import crypto from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { PartSizeError, type Storage, type UploadedPart, UploadTooLargeError } from './index'
import { withRetry } from './retry'

function safeKey(key: string): string {
  const norm = key.replace(/\\/g, '/')
  if (norm.split('/').some((seg) => seg === '..' || seg === '') || path.isAbsolute(norm)) throw new Error(`Invalid storage key: ${key}`)
  return norm
}

/** Where a multipart upload's parts wait until they are joined: beside the objects, never one of them. */
const MULTIPART_DIR = '.multipart'

export class LocalStorage implements Storage {
  kind = 'local' as const
  constructor(private root: string) {
    fs.mkdirSync(root, { recursive: true })
  }

  localPath(key: string): string {
    return path.join(this.root, ...safeKey(key).split('/'))
  }

  async put(key: string, body: Buffer | Readable, opts: { maxBytes?: number } = {}) {
    const dest = this.localPath(key)
    await fsp.mkdir(path.dirname(dest), { recursive: true })
    const tmp = `${dest}.part-${process.pid}-${Date.now()}`
    let size = 0
    const limit = opts.maxBytes ?? Infinity
    const counter = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        size += chunk.length
        if (size > limit) cb(new UploadTooLargeError(limit))
        else cb(null, chunk)
      },
    })
    const src = Buffer.isBuffer(body) ? Readable.from([body]) : body
    try {
      await pipeline(src, counter, fs.createWriteStream(tmp))
      await withRetry('rename', () => fsp.rename(tmp, dest))
    } catch (err) {
      await fsp.rm(tmp, { force: true })
      throw err
    }
    return { size }
  }

  async putFile(key: string, filePath: string) {
    const dest = this.localPath(key)
    await fsp.mkdir(path.dirname(dest), { recursive: true })
    await withRetry('copy file', () => fsp.copyFile(filePath, dest))
    const st = await fsp.stat(dest)
    return { size: st.size }
  }

  async getStream(key: string, range?: { start: number; end: number }) {
    const p = this.localPath(key)
    await fsp.access(p)
    return fs.createReadStream(p, range ? { start: range.start, end: range.end } : undefined)
  }

  async download(key: string, destPath: string) {
    const src = this.localPath(key)
    await fsp.mkdir(path.dirname(destPath), { recursive: true })
    await fsp.rm(destPath, { force: true })
    try {
      await fsp.link(src, destPath)
    } catch {
      await withRetry('copy file', () => fsp.copyFile(src, destPath))
    }
  }

  async copy(from: string, to: string) {
    const src = this.localPath(from)
    const dest = this.localPath(to)
    await fsp.mkdir(path.dirname(dest), { recursive: true })
    await fsp.rm(dest, { force: true })
    // a copy, not a link: deleting or replacing one object must never touch the other
    await withRetry('copy file', () => fsp.copyFile(src, dest))
  }

  async stat(key: string) {
    try {
      const st = await fsp.stat(this.localPath(key))
      return st.isFile() ? { size: st.size, mtimeMs: st.mtimeMs } : null
    } catch (err) {
      // a missing file is null; a folder the server may not read (EACCES, EIO) is an error to report
      const code = (err as NodeJS.ErrnoException).code
      if (!code || code === 'ENOENT' || code === 'ENOTDIR') return null
      throw err
    }
  }

  async delete(key: string) {
    await withRetry('delete', () => fsp.rm(this.localPath(key), { force: true }))
  }

  async deletePrefix(prefix: string) {
    const p = this.localPath(prefix.replace(/\/+$/, ''))
    await withRetry('delete folder', () => fsp.rm(p, { recursive: true, force: true }))
  }

  // ---- multipart (P-5): parts are files in .multipart/<uploadId>/, joined in order on complete ----

  private partsDir(uploadId: string): string {
    if (!/^[a-f0-9]{32}$/.test(uploadId)) throw new Error('Invalid upload id')
    return path.join(this.root, MULTIPART_DIR, uploadId)
  }

  async createMultipart(key: string, _contentType?: string) {
    const id = crypto.randomBytes(16).toString('hex')
    const dir = this.partsDir(id)
    await fsp.mkdir(dir, { recursive: true })
    await fsp.writeFile(path.join(dir, 'key'), safeKey(key))
    return id
  }

  async putPart(key: string, uploadId: string, partNumber: number, body: Readable, size: number) {
    const dir = this.partsDir(uploadId)
    if ((await fsp.readFile(path.join(dir, 'key'), 'utf8').catch(() => '')) !== safeKey(key)) throw Object.assign(new Error('No such upload'), { code: 'NoSuchUpload' })
    const dest = path.join(dir, `${partNumber}.part`)
    const tmp = `${dest}.${process.pid}-${Date.now()}`
    let got = 0
    const hash = crypto.createHash('md5')
    const counter = new Transform({
      transform(chunk: Buffer, _e, cb) {
        got += chunk.length
        if (got > size) return cb(new UploadTooLargeError(size))
        hash.update(chunk)
        cb(null, chunk)
      },
    })
    try {
      await pipeline(body, counter, fs.createWriteStream(tmp))
      if (got !== size) throw new PartSizeError(size, got)
      await fsp.rename(tmp, dest)
      // the part's checksum, as S3 gives one, so a resumed upload can tell a part it already sent
      await fsp.writeFile(`${dest}.etag`, hash.digest('hex'))
    } catch (err) {
      await fsp.rm(tmp, { force: true })
      throw err
    }
    return { size: got }
  }

  async listParts(_key: string, uploadId: string): Promise<UploadedPart[]> {
    const dir = this.partsDir(uploadId)
    const names = await fsp.readdir(dir).catch(() => {
      throw Object.assign(new Error('No such upload'), { code: 'NoSuchUpload' })
    })
    const parts: UploadedPart[] = []
    for (const n of names) {
      const m = n.match(/^(\d+)\.part$/)
      if (!m) continue
      const st = await fsp.stat(path.join(dir, n)).catch(() => null)
      const etag = await fsp.readFile(path.join(dir, `${n}.etag`), 'utf8').catch(() => '')
      if (st && etag) parts.push({ partNumber: Number(m[1]), size: st.size, etag })
    }
    return parts.sort((a, b) => a.partNumber - b.partNumber)
  }

  async completeMultipart(key: string, uploadId: string, parts: UploadedPart[]) {
    const dir = this.partsDir(uploadId)
    const dest = this.localPath(key)
    await fsp.mkdir(path.dirname(dest), { recursive: true })
    const tmp = `${dest}.join-${process.pid}-${Date.now()}`
    const files = parts.map((p) => path.join(dir, `${p.partNumber}.part`))
    try {
      await pipeline(
        Readable.from(
          (async function* () {
            for (const f of files) for await (const chunk of fs.createReadStream(f)) yield chunk as Buffer
          })(),
        ),
        fs.createWriteStream(tmp),
      )
      await fsp.rename(tmp, dest)
    } catch (err) {
      await fsp.rm(tmp, { force: true })
      throw err
    }
    await fsp.rm(dir, { recursive: true, force: true })
  }

  async abortMultipart(_key: string, uploadId: string) {
    await fsp.rm(this.partsDir(uploadId), { recursive: true, force: true })
  }
}
