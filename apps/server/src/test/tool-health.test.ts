// The desktop checks its bundled tools at start and says what is broken and what to do (D-13).
import path from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { type ToolDeps, checkTools } from '../services/tool-health'
import { setup, signup, type TestEnv } from './helpers'

const cfg = { ffmpegPath: '/tools/ffmpeg', ffprobePath: '/tools/ffprobe', whisperCli: '/tools/whisper-cli', whisperModel: '/tools/ggml-small.en.bin', kokoroCache: '/tools/models', chromePath: '/tools/chrome/chrome-headless-shell-win64/chrome-headless-shell' }

/** A machine where everything is installed, with `over` changing one thing. */
function deps(over: Partial<ToolDeps> = {}): ToolDeps {
  return {
    exists: () => true,
    size: () => 480 * 1024 * 1024,
    run: async (bin) => ({ code: 0, out: `${path.basename(bin)} version 7.0.2-static Copyright (c) 2000-2024` }),
    resolvable: () => true,
    readdir: () => ['model_quantized.onnx'],
    ...over,
  }
}

const by = async (d: ToolDeps, c: Partial<typeof cfg> = {}) => {
  const h = await checkTools({ ...cfg, ...c }, d, 1)
  return { h, t: Object.fromEntries(h.tools.map((x) => [x.id, x])) }
}

describe('bundled tool check (D-13)', () => {
  it('a complete install is healthy, with versions and what each tool is for', async () => {
    const { h, t } = await by(deps())
    expect(h).toMatchObject({ ok: true, checkedAt: 1 })
    expect(h.tools.map((x) => x.id)).toEqual(['ffmpeg', 'ffprobe', 'whisper', 'kokoro', 'renderer'])
    expect(t.ffmpeg).toMatchObject({ status: 'ok', detail: 'ffmpeg 7.0.2-static' })
    expect(t.whisper).toMatchObject({ status: 'ok', detail: 'Model ggml-small.en.bin' })
    for (const x of h.tools) expect(x.needed.length).toBeGreaterThan(3)
  })

  it('ffmpeg that is gone, won’t start or isn’t ffmpeg is an error that says to reinstall', async () => {
    const gone = await by(deps({ exists: (p) => p !== cfg.ffmpegPath }))
    expect(gone.h.ok).toBe(false)
    expect(gone.t.ffmpeg).toMatchObject({ status: 'error', detail: expect.stringMatching(/Not found at \/tools\/ffmpeg\. Reinstall/) })
    const blocked = await by(deps({ run: async (bin) => (bin === cfg.ffmpegPath ? { code: -1, out: '', error: 'spawn EPERM' } : { code: 0, out: 'ffprobe version 7' }) }))
    expect(blocked.t.ffmpeg).toMatchObject({ status: 'error', detail: expect.stringMatching(/Couldn’t start: spawn EPERM/) })
    const wrong = await by(deps({ run: async () => ({ code: 0, out: 'hello' }) }))
    expect(wrong.t.ffprobe).toMatchObject({ status: 'error', detail: expect.stringMatching(/didn’t answer as ffprobe does/) })
  })

  it('ffmpeg that is only slow to answer (a first run being scanned) is a warning, not a reason to reinstall', async () => {
    const slow = await by(deps({ run: async (bin) => (bin === cfg.ffmpegPath ? { code: -1, out: '', error: 'timeout' } : { code: 0, out: 'ffprobe version 7' }) }))
    expect(slow.t.ffmpeg).toMatchObject({ status: 'warn', detail: expect.stringMatching(/Didn’t answer within 60 s\. The first start after installing/) })
    expect(slow.t.ffmpeg.detail).not.toMatch(/Reinstall/)
    expect(slow.h.ok).toBe(true)
  })

  it('a missing or cut-off speech model is an error; an absent voice model or browser only a warning', async () => {
    const noModel = await by(deps({ exists: (p) => p !== cfg.whisperModel }))
    expect(noModel.t.whisper).toMatchObject({ status: 'error', detail: expect.stringMatching(/speech model is missing/) })
    const stub = await by(deps({ size: () => 12 }))
    expect(stub.t.whisper).toMatchObject({ status: 'error', detail: expect.stringMatching(/damaged or incomplete/) })
    const none = await by(deps(), { whisperCli: undefined })
    expect(none.t.whisper.status).toBe('error')
    // these download on first use: the app works, so it isn't "broken"
    const fresh = await by(deps({ readdir: () => [] }), { chromePath: undefined })
    expect(fresh.t.kokoro).toMatchObject({ status: 'warn', detail: expect.stringMatching(/downloads .* first time/) })
    expect(fresh.t.renderer).toMatchObject({ status: 'warn', detail: expect.stringMatching(/first export downloads it/) })
    expect(fresh.h.ok).toBe(true)
    const noRenderer = await by(deps({ resolvable: (m) => m !== 'hyperframes/package.json' }))
    expect(noRenderer.t.renderer.status).toBe('error')
  })

  it('runs the real ffmpeg this server uses', async () => {
    const { ctx } = await import('../context')
    await setup()
    const h = await checkTools(ctx().config)
    expect(h.tools.find((t) => t.id === 'ffmpeg')).toMatchObject({ status: 'ok', detail: expect.stringMatching(/^ffmpeg \S+/) })
    expect(h.tools.find((t) => t.id === 'ffprobe')).toMatchObject({ status: 'ok' })
  })
})

describe('GET /api/tools/health', () => {
  let env: TestEnv
  beforeAll(async () => {
    env = await setup()
  })

  it('is not there on the cloud', async () => {
    const { client } = await signup(env.app)
    expect((await client.json('GET', '/api/tools/health')).status).toBe(404)
  })

  it('on the desktop answers the local session, and not without one', async () => {
    const { ctx } = await import('../context')
    const { client } = await signup(env.app)
    const cfg = ctx().config as { mode: string }
    const was = cfg.mode
    try {
      cfg.mode = 'desktop'
      const r = await client.json('GET', '/api/tools/health?refresh=1')
      expect(r.status).toBe(200)
      expect(r.body.tools.map((t: { id: string }) => t.id)).toEqual(['ffmpeg', 'ffprobe', 'whisper', 'kokoro', 'renderer'])
      expect(typeof r.body.ok).toBe('boolean')
      const anon = await env.app.request('/api/tools/health')
      expect(anon.status).toBe(401)
    } finally {
      cfg.mode = was
    }
  })
})
