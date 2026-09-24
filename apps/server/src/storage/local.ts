import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { type Storage, UploadTooLargeError } from './index'

function safeKey(key: string): string {
  const norm = key.replace(/\\/g, '/')
  if (norm.split('/').some((seg) => seg === '..' || seg === '') || path.isAbsolute(norm)) throw new Error(`Invalid storage key: ${key}`)
  return norm
}

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
      await fsp.rename(tmp, dest)
    } catch (err) {
      await fsp.rm(tmp, { force: true })
      throw err
    }
    return { size }
  }

  async putFile(key: string, filePath: string) {
    const dest = this.localPath(key)
    await fsp.mkdir(path.dirname(dest), { recursive: true })
    await fsp.copyFile(filePath, dest)
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
      await fsp.copyFile(src, destPath)
    }
  }

  async stat(key: string) {
    try {
      const st = await fsp.stat(this.localPath(key))
      return st.isFile() ? { size: st.size, mtimeMs: st.mtimeMs } : null
    } catch {
      return null
    }
  }

  async delete(key: string) {
    await fsp.rm(this.localPath(key), { force: true })
  }

  async deletePrefix(prefix: string) {
    const p = this.localPath(prefix.replace(/\/+$/, ''))
    await fsp.rm(p, { recursive: true, force: true })
  }
}
