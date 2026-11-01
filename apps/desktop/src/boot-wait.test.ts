import { describe, expect, it } from 'vitest'
import { type BootWaitDeps, waitForEngine } from './boot-wait'

/** A fake clock: each probe or sleep moves time on; the engine answers from `readyAt` (ms) or exits at `exitAt`. */
function engine(o: { readyAt?: number; exitAt?: number; code?: number }) {
  let t = 0
  const events: string[] = []
  const d: BootWaitDeps = {
    exitCode: () => (o.exitAt !== undefined && t >= o.exitAt ? (o.code ?? 1) : null),
    probe: async () => {
      t += 50
      return o.readyAt !== undefined && t >= o.readyAt
    },
    sleep: async (ms) => {
      t += ms
    },
    now: () => t,
    onSlow: () => events.push(`slow@${t}`),
  }
  return { d, events, at: () => t }
}

describe('waiting for the engine at start-up', () => {
  it('returns as soon as the engine answers, without calling the start slow', async () => {
    const e = engine({ readyAt: 3_000 })
    await waitForEngine(e.d, 'server.log')
    expect(e.at()).toBeLessThan(3_500)
    expect(e.events).toEqual([])
  })

  it('keeps waiting past 90 s for a first start that is slow, and says once that it is slow', async () => {
    const e = engine({ readyAt: 124_000 })
    await waitForEngine(e.d, 'server.log')
    expect(e.at()).toBeGreaterThanOrEqual(124_000)
    expect(e.events).toHaveLength(1)
    expect(Number(e.events[0].slice(5))).toBeGreaterThanOrEqual(20_000)
  })

  it('stops at once when the engine exits, naming the log', async () => {
    const e = engine({ exitAt: 4_000, code: 3 })
    await expect(waitForEngine(e.d, 'C:/logs/server.log')).rejects.toThrow('The local server exited during startup (code 3). See C:/logs/server.log')
    expect(e.at()).toBeLessThan(5_000)
  })

  it('gives up at the limit when the engine never answers', async () => {
    const e = engine({})
    await expect(waitForEngine(e.d, 'server.log')).rejects.toThrow('did not start within 5 minutes')
    expect(e.at()).toBeGreaterThanOrEqual(300_000)
  })
})
