// Stopping the local engine on quit (DSK-25) and log files that rotate while the app runs (DSK-31).
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { RotatingLog } from '../logs'
import { stopGracefully } from '../proc'

/** A stand-in child process that exits `exitAfterMs` after its stdin closes (never, when undefined). */
function child(opts: { exitAfterMs?: number; exited?: boolean } = {}) {
  const em = new EventEmitter()
  const c = Object.assign(em, {
    pid: 4242,
    exitCode: opts.exited ? 0 : (null as number | null),
    signalCode: null,
    stdinClosed: false,
    stdin: {
      end: () => {
        c.stdinClosed = true
        if (opts.exitAfterMs !== undefined)
          setTimeout(() => {
            c.exitCode = 0
            em.emit('exit')
          }, opts.exitAfterMs)
      },
    },
  })
  return c
}

describe('stopping the engine (DSK-25)', () => {
  it('never kills a process that has already exited (its id may belong to another program now)', async () => {
    const killed: Array<number | undefined> = []
    expect(await stopGracefully(child({ exited: true }), 100, (pid) => killed.push(pid))).toBe(true)
    // it exits on its own in time: nothing is killed afterwards either
    const c = child({ exitAfterMs: 50 })
    expect(await stopGracefully(c, 1000, (pid) => killed.push(pid))).toBe(true)
    expect(c.stdinClosed).toBe(true)
    expect(killed).toEqual([])
  })

  it('kills the tree only when it is still running after the grace time', async () => {
    const killed: Array<number | undefined> = []
    const t0 = Date.now()
    expect(await stopGracefully(child(), 150, (pid) => killed.push(pid))).toBe(false)
    expect(Date.now() - t0).toBeGreaterThanOrEqual(140)
    expect(killed).toEqual([4242])
  })
})

describe('log files (DSK-31)', () => {
  it('rotate by size while running, keeping one previous file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-logs-'))
    const file = path.join(dir, 'logs', 'server.log')
    const log = new RotatingLog(file, 1000)
    for (let i = 0; i < 25; i++) log.write(`${'x'.repeat(99)}\n`)
    log.close()
    expect(fs.statSync(file).size).toBeLessThanOrEqual(1000)
    expect(fs.statSync(`${file}.1`).size).toBeLessThanOrEqual(1000)
    expect(fs.readdirSync(path.dirname(file)).sort()).toEqual(['server.log', 'server.log.1'])
    // a file already over the limit at launch rotates first
    fs.writeFileSync(file, 'y'.repeat(2000))
    const again = new RotatingLog(file, 1000)
    again.write('z\n')
    again.close()
    expect(fs.readFileSync(file, 'utf8')).toBe('z\n')
  })
})
