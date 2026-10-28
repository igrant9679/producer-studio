// Log files that rotate by size while the app runs (not only at launch): past `maxBytes` the file becomes `<file>.1`
// (replacing the previous one) and a new one starts. No Electron here, so it can be tested on its own.
import fs from 'node:fs'
import path from 'node:path'

export const LOG_MAX_BYTES = 10 * 1024 * 1024

export class RotatingLog {
  private size = 0
  private fd?: number

  constructor(
    readonly file: string,
    private maxBytes = LOG_MAX_BYTES,
  ) {}

  private open() {
    if (this.fd !== undefined) return
    fs.mkdirSync(path.dirname(this.file), { recursive: true })
    try {
      this.size = fs.statSync(this.file).size
    } catch {
      this.size = 0
    }
    if (this.size >= this.maxBytes) this.rotate()
    this.fd = fs.openSync(this.file, 'a')
  }

  private rotate() {
    if (this.fd !== undefined) fs.closeSync(this.fd)
    this.fd = undefined
    try {
      fs.renameSync(this.file, `${this.file}.1`)
    } catch {
      /* nothing to rotate */
    }
    this.size = 0
  }

  /** Append (a string or a chunk of a child's output). Never throws: logging must not take the app down. */
  write(chunk: string | Buffer) {
    try {
      this.open()
      const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
      if (this.size > 0 && this.size + buf.length > this.maxBytes) {
        this.rotate()
        this.open()
      }
      fs.writeSync(this.fd!, buf)
      this.size += buf.length
    } catch {
      /* disk full, folder gone: carry on without the log */
    }
  }

  close() {
    if (this.fd !== undefined) fs.closeSync(this.fd)
    this.fd = undefined
  }
}
