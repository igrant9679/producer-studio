// Stopping a child process tree (no Electron here, so it can be tested on its own).
import { spawn } from 'node:child_process'

export function killTree(pid: number | undefined) {
  if (!pid) return
  if (process.platform === 'win32') spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }).on('error', () => undefined)
  else
    try {
      process.kill(-pid, 'SIGKILL')
    } catch {
      /* gone */
    }
}

export interface Stoppable {
  pid?: number
  exitCode: number | null
  signalCode?: NodeJS.Signals | null
  stdin?: { end(): void } | null
  once(event: 'exit', fn: () => void): unknown
}

const exited = (c: Stoppable) => c.exitCode !== null || (c.signalCode ?? null) !== null

/**
 * Ask a child to stop (close its stdin) and wait up to `graceMs` for it to exit. Only a child still running after that
 * has its tree killed: an id that has already exited may belong to another program by now. Returns whether it exited
 * on its own.
 */
export async function stopGracefully(child: Stoppable, graceMs: number, kill: (pid: number | undefined) => void = killTree): Promise<boolean> {
  if (exited(child)) return true
  child.stdin?.end()
  const onTime = await new Promise<boolean>((resolve) => {
    const t = setTimeout(() => resolve(false), graceMs)
    child.once('exit', () => {
      clearTimeout(t)
      resolve(true)
    })
  })
  if (!onTime && !exited(child)) kill(child.pid)
  return onTime
}
