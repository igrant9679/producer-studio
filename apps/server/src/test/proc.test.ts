// Cancelling ends the whole process tree: Chrome and its ffmpeg run in process groups of their own, and a parent
// killed outright never closes them (PIP-3).
import { spawn } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { type KillSystem, killTree, run } from '../media/proc'

const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function until(test: () => boolean, ms: number) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (test()) return true
    await new Promise((r) => setTimeout(r, 100))
  }
  return test()
}

describe('ending a process tree', () => {
  it('on Linux and macOS: SIGTERM to the group and every descendant, then SIGKILL after the grace period', async () => {
    const sent: string[] = []
    const sys: KillSystem = {
      platform: 'linux',
      kill: (pid, sig) => void sent.push(`${sig} ${pid}`),
      // 100 → 200 (renderer CLI) → 300 (Chrome, its own group) → 400 (Chrome's ffmpeg)
      descendants: () => [200, 300, 400],
      taskkill: () => undefined,
    }
    killTree(100, 50, sys)
    expect(sent).toEqual(['SIGTERM -100', 'SIGTERM 100', 'SIGTERM 200', 'SIGTERM 300', 'SIGTERM 400'])
    await new Promise((r) => setTimeout(r, 120))
    expect(sent.slice(5)).toEqual(['SIGKILL -100', 'SIGKILL 100', 'SIGKILL 200', 'SIGKILL 300', 'SIGKILL 400'])
  })

  it('on Windows (the desktop edition) kills the tree', () => {
    const killed: number[] = []
    killTree(42, 50, { platform: 'win32', kill: () => undefined, descendants: () => [], taskkill: (pid) => void killed.push(pid) })
    expect(killed).toEqual([42])
  })

  it('cancelling a run ends a grandchild that left the process group', async () => {
    // the child starts a detached grandchild (like Chrome under the renderer), prints its pid, then waits
    const script = `
      const { spawn } = require('node:child_process')
      const g = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' })
      g.unref()
      console.log('grandchild ' + g.pid)
      setInterval(() => {}, 1000)
    `
    const ac = new AbortController()
    let grandchild = 0
    const done = run(process.execPath, ['-e', script], {
      signal: ac.signal,
      onStdout: (s) => {
        const m = s.match(/grandchild (\d+)/)
        if (m) grandchild = Number(m[1])
      },
    }).catch((e: Error) => e)
    expect(await until(() => grandchild > 0, 10_000)).toBe(true)
    expect(alive(grandchild)).toBe(true)
    ac.abort()
    expect(((await done) as Error).name).toBe('CancelledError')
    const gone = await until(() => !alive(grandchild), 8_000)
    if (!gone) spawn(process.platform === 'win32' ? 'taskkill' : 'kill', process.platform === 'win32' ? ['/pid', String(grandchild), '/F'] : ['-9', String(grandchild)])
    expect(gone).toBe(true)
  })
})
