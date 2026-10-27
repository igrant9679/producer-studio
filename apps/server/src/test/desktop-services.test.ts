// Desktop services without a cloud: batch dubbing's tracked list under concurrent changes (DSK-24) and a bounded,
// awaited VoiceStudio stop at shutdown (DSK-25).
import http from 'node:http'
import type net from 'node:net'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { setup } from './helpers'

let server: http.Server
let base = ''
let releaseA!: () => void
const holdA = new Promise<void>((r) => (releaseA = r))
let askedA!: () => void
const askedForA = new Promise<void>((r) => (askedA = r))

beforeAll(async () => {
  await setup()
  const { ensureDesktopTables } = await import('../desktop/db')
  await ensureDesktopTables()
  // a stand-in VoiceStudio: job A finishes (failed) only when the test says so; C is still running
  server = http.createServer(async (req, res) => {
    const id = decodeURIComponent(req.url!.split('/').pop()!)
    if (id === 'A') {
      askedA()
      await holdA
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ id, status: id === 'A' ? 'failed' : 'running' }))
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  base = `http://127.0.0.1:${(server.address() as net.AddressInfo).port}`
})

afterAll(() => {
  server?.closeAllConnections?.()
  server?.close()
  vi.restoreAllMocks()
})

describe('batch dubbing keeps what was tracked during a poll (DSK-24)', () => {
  it('neither drops a job tracked meanwhile nor brings back one untracked meanwhile', async () => {
    const { voiceStudio } = await import('../desktop/voicestudio/runtime')
    vi.spyOn(voiceStudio, 'status').mockReturnValue({ ...voiceStudio.status(), state: 'running' })
    vi.spyOn(voiceStudio, 'url').mockReturnValue(base)
    const b = await import('../desktop/voicestudio/batch')
    const job = (jobId: string) => ({ jobId, workspaceId: 'w', userId: 'u', name: jobId, langs: ['es'] })
    await b.trackBatch(job('A'))
    await b.trackBatch(job('C'))
    b.stopBatchWatcher()
    const poll = b.pollBatches()
    await askedForA
    // while the poll waits on A: B is queued from Voice Studio and C is cancelled there
    await b.trackBatch(job('B'))
    await b.untrackBatch('C')
    b.stopBatchWatcher()
    releaseA()
    await poll
    expect((await b.trackedBatches()).map((t) => t.jobId)).toEqual(['B'])
  })
})

describe('shutdown gives VoiceStudio its time, within a bound (DSK-25)', () => {
  it('waits for VoiceStudio to stop, and no longer than the bound when it hangs', async () => {
    const { voiceStudio } = await import('../desktop/voicestudio/runtime')
    const { stopDesktopServices } = await import('../desktop')
    let stopped = false
    const stop = vi.spyOn(voiceStudio, 'stop').mockImplementation(() => new Promise<void>((r) => setTimeout(() => ((stopped = true), r()), 300)))
    await stopDesktopServices(5000)
    expect(stopped).toBe(true)
    stop.mockImplementation(() => new Promise<void>(() => undefined))
    const t0 = Date.now()
    await stopDesktopServices(400)
    expect(Date.now() - t0).toBeLessThan(2000)
  })
})
