// Blender scenes: the harness's code checks (run with plain Python, no Blender needed), the job settings, the AI's
// write-try-fix-look loop on a Blender runner, and RunPod's pod lifecycle against a fake API and a fake pod that
// answers through an in-memory store. With REAL_BLENDER=1 and BLENDER_PATH set, a real scene is tried and rendered.
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { BLENDER_SYSTEM, MAX_LOOKS, writeDrawing } from '../ai/drawn'
import type { AiProvider } from '../ai/provider'
import { HttpError } from '../http'
import { BlenderUnavailableError, HARNESS_PY, LocalBlender, type BlenderRunner, blenderEnv, blenderFrame, blenderSpec, findLocalBlender, localBlenderVersion } from '../media/blender'
import { DrawingError, type DrawingEnv } from '../media/drawing'
import { BLENDER_LINUX, IDLE_SECONDS, RunpodBlender, RUNPOD_GPUS, SLOTS, setRunpodDeps, testRunpodKey } from '../media/runpod'
import type { Storage } from '../storage'
import { setup } from './helpers'

const env: DrawingEnv = { width: 1920, height: 1080, duration: 4, fps: 30, words: [{ w: 'Grow', start: 1.2 }], palette: { canvas: '#efe6d8', accent: '#ff5500', ink: '#222222' }, fonts: { headline: 'Inter', body: 'Inter' } }

const GOOD = `import bpy
import math
import random

def build(scene, env):
    random.seed(1)
    st = env.stage()
    bpy.ops.mesh.primitive_uv_sphere_add(radius=0.8, location=(0, 0, 0.8), segments=48, ring_count=24)
    ball = bpy.context.active_object
    bpy.ops.object.shade_smooth()
    ball.data.materials.append(env.material('accent', 'glossy'))
    grow = env.frame(env.word_at('grow', 1.0))
    env.key(ball, 'scale', 1, (0.01, 0.01, 0.01))
    env.key(ball, 'scale', grow, (1.0, 1.0, 1.0))
    env.interpolate(ball, 'BACK', 'EASE_OUT')
    env.key(st.camera, 'location', 1, (0, -9, 2.4))
    env.key(st.camera, 'location', env.frames, (0, -7.5, 2.0))
    print(f"built {len(scene.objects)} objects, {math.pi:.2f}")
`

const python = ['python3', 'python'].find((p) => spawnSync(p, ['-c', 'import ast, sys; sys.exit(0 if sys.version_info >= (3, 8) else 1)'], { stdio: 'ignore' }).status === 0)

function check(code: string): string[] {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(process.env.TEMP || process.env.TMPDIR || '/tmp'), 'ps-blender-check-'))
  try {
    fs.writeFileSync(path.join(dir, 'code.py'), code)
    const r = spawnSync(python!, ['-I', HARNESS_PY(), '--check', path.join(dir, 'code.py')], { encoding: 'utf8' })
    return JSON.parse(r.stdout) as string[]
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

describe('the harness’s code checks', () => {
  it('lets a scene that only builds, lights and keyframes through', ({ skip }) => {
    if (!python) skip()
    expect(check(GOOD)).toEqual([])
  })

  it('refuses code that reaches outside the scene: files, imports, scripts, dunders, operators outside modelling', ({ skip }) => {
    if (!python) skip()
    const bad = `import os
import bpy
from subprocess import run
def build(scene, env):
    open('secrets.txt').read()
    getattr(bpy, 'ops')
    exec('1')
    bpy.ops.wm.save_as_mainfile()
    o = bpy.ops
    scene.render.filepath = '/tmp/x'
    x = ().__class__
    bpy.utils.register_class(None)
    bpy.app.handlers.frame_change_pre.append(None)
    "{0.__class__}".format(1)
    bpy.data.texts.new('a')
    bpy.data.images.load('c:/x.png')
    bpy.ops.font.open(filepath='x')
    bpy.ops.text.run_script()
    d = bpy.data.objects['a'].driver_add('location')
    d.driver.expression = 'x'
`
    const problems = check(bad).join('\n')
    for (const want of [
      'line 1: import os is not allowed',
      'line 3: from subprocess import is not allowed',
      'line 5: open is not allowed',
      'line 6: getattr is not allowed',
      'line 7: exec is not allowed',
      'line 8: bpy.ops may only be used as',
      'line 9: bpy.ops may only be used as',
      'line 10: .filepath is not allowed',
      'line 11: attributes starting with _',
      'line 12: .utils is not allowed',
      'line 13: .app is not allowed',
      'line 14: .format is not allowed',
      'line 15: .texts is not allowed',
      'line 16: .load is not allowed',
      'line 17: the argument filepath= is not allowed',
      'line 18: bpy.ops may only be used as',
    ])
      expect(problems).toContain(want)
    expect(check('x = 1').join()).toContain('def build(scene, env)')
    expect(check('def build(scene, env):\n    return (').join()).toMatch(/line \d+: SyntaxError/)
  })
})

describe('what Blender is told', () => {
  it('frames are 1-based, on the scene’s clock, within the scene; test frames at the looked-at times', () => {
    expect(blenderFrame(env, 0)).toBe(1)
    expect(blenderFrame(env, 1.2)).toBe(37)
    expect(blenderFrame(env, 99)).toBe(120)
    const spec = blenderSpec(env, 'test', [0.5, 3.9])
    expect(spec).toMatchObject({ mode: 'test', width: 1920, height: 1080, fps: 30, duration: 4, frames: [16, 118], engine: 'auto', palette: env.palette, words: env.words })
    expect(blenderSpec(env, 'render').frames).toBeUndefined()
  })

  it('runs with none of this server’s secrets, its own folders inside the throwaway one', () => {
    process.env.PS_TEST_SECRET = 'sk-ant-should-not-leak'
    const e = blenderEnv('/work/x')
    expect(Object.values(e).join(' ')).not.toContain('sk-ant')
    expect(e).toMatchObject({ HOME: '/work/x', TEMP: '/work/x', BLENDER_USER_RESOURCES: path.join('/work/x', 'user') })
    expect(Object.keys(e).some((k) => /KEY|SECRET|TOKEN|DATABASE|AWS|S3/i.test(k))).toBe(false)
    delete process.env.PS_TEST_SECRET
  })

  it('BLENDER_PATH that doesn’t exist finds nothing (no guessing past it)', () => {
    const was = process.env.BLENDER_PATH
    process.env.BLENDER_PATH = path.join('/nowhere', 'blender.exe')
    expect(findLocalBlender()).toBeUndefined()
    if (was === undefined) delete process.env.BLENDER_PATH
    else process.env.BLENDER_PATH = was
  })
})

/** A scripted model: each structured() call returns the next answer. */
function scripted(answers: Array<Record<string, unknown>>): AiProvider & { calls: Array<{ system: string; prompt: string; images: unknown[] }> } {
  const calls: Array<{ system: string; prompt: string; images: unknown[] }> = []
  return {
    id: 'anthropic-api',
    calls,
    async structured(o: { system: string; prompt: string; images: unknown[] }) {
      calls.push(o)
      const a = answers[Math.min(calls.length - 1, answers.length - 1)]
      return a as never
    },
  } as unknown as AiProvider & { calls: Array<{ system: string; prompt: string; images: unknown[] }> }
}

describe('the AI writes Blender scenes', () => {
  it('is told Blender’s contract, tries the script in Blender, fixes what fails, then looks at the renders', async () => {
    const tried: string[] = []
    const runner: BlenderRunner = {
      where: 'computer',
      async test(code) {
        tried.push(code)
        if (code.includes('broken')) throw new DrawingError('line 3: NameError: name broken is not defined')
        return [Buffer.from('jpeg-1'), Buffer.from('jpeg-2'), Buffer.from('jpeg-3'), Buffer.from('jpeg-4')]
      },
      async render() {},
      async close() {},
    }
    const model = scripted([
      { plan: 'p', code: '```python\ndef build(scene, env):\n    broken\n```' },
      { plan: 'p', code: GOOD },
      { problems: 'none', changed: false, code: GOOD },
    ])
    const r = await writeDrawing(model, { description: 'A ball pops up on grow', narration: 'Plant it and watch it grow.', headline: 'Grow', env, style: 'blender', blender: runner })
    expect(r.code).toBe(GOOD.trim())
    expect(tried).toEqual(['def build(scene, env):\n    broken', GOOD.trim()])
    expect(model.calls.every((c) => c.system === BLENDER_SYSTEM)).toBe(true)
    expect(model.calls[0].prompt).toMatch(/Build this scene in Blender[\s\S]*frames 1 to 120 at 30 fps[\s\S]*Grow@1\.20/)
    expect(model.calls[1].prompt).toContain('YOUR CODE FAILED: line 3: NameError')
    expect(model.calls[2].images).toHaveLength(4)
    expect(model.calls.length).toBeLessThanOrEqual(2 + MAX_LOOKS)
  })

  it('a Blender or graphics card that can’t render isn’t the AI’s to fix: it stops at once', async () => {
    const runner: BlenderRunner = {
      where: 'runpod',
      async test() {
        throw new HttpError(502, 'server', 'the graphics card couldn’t render it (out of memory)')
      },
      async render() {},
      async close() {},
    }
    const model = scripted([{ plan: 'p', code: GOOD }])
    await expect(writeDrawing(model, { description: 'd', narration: 'n', headline: 'h', env, style: 'blender', blender: runner })).rejects.toMatchObject({ status: 502, message: expect.stringContaining('graphics card') })
    expect(model.calls).toHaveLength(1)
  })
})

// --- RunPod --------------------------------------------------------------------------------------------------------

const KEY = 'rpa_TESTKEY0123456789ABCDEFGHIJ'

/** An in-memory store standing in for S3: presigned links are just markers the fake pod understands. */
function memoryStorage() {
  const objects = new Map<string, Buffer>()
  const listeners: Array<(key: string, body: Buffer) => void> = []
  const st = {
    kind: 's3' as const,
    objects,
    onPut: (f: (key: string, body: Buffer) => void) => listeners.push(f),
    async put(key: string, body: Buffer) {
      objects.set(key, Buffer.from(body))
      for (const l of listeners) l(key, Buffer.from(body))
      return { size: body.length }
    },
    async stat(key: string) {
      return objects.has(key) ? { size: objects.get(key)!.length, mtimeMs: 0 } : null
    },
    async getStream(key: string) {
      const { Readable } = await import('node:stream')
      if (!objects.has(key)) throw new Error(`no such object ${key}`)
      return Readable.from([objects.get(key)!])
    },
    async download(key: string, dest: string) {
      fs.writeFileSync(dest, objects.get(key)!)
    },
    async presignGet(key: string) {
      return `https://s3.test/get/${key}?sig=1`
    },
    async presignPut(key: string, type: string) {
      return `https://s3.test/put/${key}?type=${encodeURIComponent(type)}&sig=1`
    },
    async deletePrefix(prefix: string) {
      for (const k of [...objects.keys()]) if (k.startsWith(prefix)) objects.delete(k)
    },
  }
  return st
}

interface ApiCall {
  method: string
  url: string
  auth?: string
  body?: Record<string, unknown>
}

type PodAnswer = (job: { code: string; spec: Record<string, unknown>; uploads: Record<string, string> }) => { result: Record<string, unknown>; files?: Record<string, Buffer | undefined> }

function fakeRunpod(o: { createStatus?: number[]; podAnswers?: PodAnswer; boot?: Record<string, unknown> } = {}) {
  const st = memoryStorage()
  const calls: ApiCall[] = []
  const statuses = [...(o.createStatus ?? [201])]
  const keyOf = (url: string) => decodeURIComponent(url.replace(/^https:\/\/s3\.test\/(get|put)\//, '').replace(/\?.*$/, ''))
  // the "pod": once created it boots (boot.json) and answers each job written to its slots
  let created = false
  st.onPut((key, body) => {
    if (!created || !/\/job-\d+\.json$/.test(key)) return
    const job = JSON.parse(body.toString()) as { stop?: boolean; code: string; spec: Record<string, unknown>; uploads: Record<string, string> }
    if (job.stop) return
    const a = o.podAnswers?.(job) ?? { result: { ok: true } }
    queueMicrotask(() => {
      for (const [name, data] of Object.entries(a.files ?? {})) if (data && job.uploads[name]) st.objects.set(keyOf(job.uploads[name]), data)
      st.objects.set(keyOf(job.uploads['result.json']), Buffer.from(JSON.stringify(a.result)))
    })
  })
  const fetchFn = async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers)
    const c: ApiCall = { method: init?.method ?? 'GET', url: String(input), ...(headers.get('authorization') ? { auth: headers.get('authorization')! } : {}), ...(typeof init?.body === 'string' ? { body: JSON.parse(init.body) as Record<string, unknown> } : {}) }
    calls.push(c)
    const json = (status: number, b: unknown) => new Response(b === undefined ? '' : JSON.stringify(b), { status })
    if (c.auth !== `Bearer ${KEY}`) return json(401, { error: 'invalid api key' })
    if (c.method === 'POST' && c.url.endsWith('/v1/pods')) {
      const status = statuses.shift() ?? 201
      if (status !== 201) return json(status, { error: 'There are no longer any instances available with the requested specifications.' })
      created = true
      const manifest = JSON.parse(st.objects.get(keyOf(String((c.body!.env as Record<string, string>).PS_MANIFEST)))!.toString()) as { config: { bootUrl: string } }
      queueMicrotask(() => st.objects.set(keyOf(manifest.config.bootUrl), Buffer.from(JSON.stringify(o.boot ?? { ok: true, gpu: 'NVIDIA GeForce RTX 4090', version: 'Blender 5.2.4' }))))
      return json(201, { id: 'pod-abc', costPerHr: 0.69, desiredStatus: 'RUNNING', gpu: { id: 'NVIDIA GeForce RTX 4090', displayName: 'RTX 4090' } })
    }
    if (c.method === 'GET' && c.url.endsWith('/v1/pods')) return json(200, [])
    if (c.method === 'GET' && c.url.includes('/v1/pods/')) return json(200, { id: 'pod-abc', desiredStatus: 'RUNNING' })
    if (c.method === 'DELETE' && c.url.endsWith('/v1/pods/pod-abc')) return new Response(null, { status: 204 })
    return json(404, { error: 'not found' })
  }
  let clock = 0
  setRunpodDeps({ fetch: fetchFn as typeof fetch, storage: () => st as unknown as Storage, now: () => clock, sleep: async (ms) => void (clock += ms) })
  return { st, calls }
}

describe('Blender on a rented RunPod graphics card', () => {
  afterEach(() => setRunpodDeps(null))

  it('rents one card for the video, sends it jobs through storage, and gives it back with everything it was sent', async () => {
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3])
    const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypmp42'), Buffer.alloc(16, 1)])
    const seen: Array<{ code: string; spec: Record<string, unknown>; uploads: Record<string, string> }> = []
    const { st, calls } = fakeRunpod({
      podAnswers: (job) => {
        seen.push(job)
        if (job.spec.mode === 'test') return { result: { ok: true, frames: ['test-0.jpg', 'test-1.jpg'], engine: 'eevee' }, files: { 'test-0.jpg': jpeg, 'test-1.jpg': jpeg } }
        return { result: { ok: true, video: 'video.mp4', engine: 'cycles-optix' }, files: { 'video.mp4': mp4 } }
      },
    })
    const runner = new RunpodBlender(KEY)
    const frames = await runner.test(GOOD, env, [0.5, 3.5])
    expect(frames).toEqual([jpeg, jpeg])
    const out = path.join(fs.mkdtempSync(path.join(fs.realpathSync(process.env.TEMP || process.env.TMPDIR || '/tmp'), 'ps-rp-')), 'scene.mp4')
    await runner.render(GOOD, env, out)
    expect(fs.readFileSync(out).equals(mp4)).toBe(true)
    // the card asked for: our GPUs in order, RunPod's CUDA image, no ports open, one link and nothing else in its environment
    const create = calls.find((c) => c.method === 'POST')!
    expect(create.body).toMatchObject({ gpuTypeIds: RUNPOD_GPUS, gpuCount: 1, cloudType: 'SECURE', ports: [], volumeInGb: 0, interruptible: false })
    expect(Object.keys(create.body!.env as object)).toEqual(['PS_MANIFEST'])
    expect(JSON.stringify(create.body)).not.toContain(KEY)
    expect((create.body!.dockerStartCmd as string[]).join(' ')).toContain('exec bash /ps/boot.sh')
    // the manifest: Blender from blender.org with its checksum, job slots, the self-delete timer, our three files
    const manifestKey = [...st.objects.keys()].find((k) => k.endsWith('manifest.json'))!
    const manifest = JSON.parse(st.objects.get(manifestKey)!.toString()) as { config: Record<string, unknown>; boot: string; pod: string; harness: string }
    expect(manifest.config).toMatchObject({ blenderUrl: BLENDER_LINUX.url, blenderSha256: BLENDER_LINUX.sha256, idleSeconds: IDLE_SECONDS })
    expect(manifest.config.slots).toHaveLength(SLOTS)
    expect(manifest.boot).toContain('sha256sum -c')
    expect(manifest.boot + manifest.pod + manifest.harness).not.toContain(String.fromCharCode(13))
    expect(manifest.pod).toContain('def terminate')
    expect(manifest.harness).toContain('def check(code)')
    // each job: the code, the harness's settings (no secrets), upload links for its results
    expect(seen.map((j) => j.spec.mode)).toEqual(['test', 'render'])
    expect(seen[0].spec).toMatchObject({ frames: [16, 106], width: 1920, fps: 30 })
    expect(Object.keys(seen[0].uploads).sort()).toEqual(['result.json', 'test-0.jpg', 'test-1.jpg'])
    expect(Object.keys(seen[1].uploads).sort()).toEqual(['result.json', 'video.mp4'])
    expect(runner.info).toEqual({ gpu: 'NVIDIA GeForce RTX 4090', costPerHr: 0.69 })
    // done: a stop job, the pod deleted, its storage emptied
    await runner.close()
    expect(calls.filter((c) => c.method === 'DELETE').map((c) => c.url)).toEqual(['https://rest.runpod.io/v1/pods/pod-abc'])
    expect([...st.objects.keys()].filter((k) => k.startsWith('blender-jobs/'))).toEqual([])
    await runner.close()
    expect(calls.filter((c) => c.method === 'DELETE')).toHaveLength(1)
  })

  it('a code problem goes back to the AI to fix; a render failure doesn’t', async () => {
    fakeRunpod({ podAnswers: (job) => ({ result: job.spec.mode === 'test' ? { ok: false, error: 'line 4: NameError: name x is not defined' } : { ok: false, error: 'CUDA error: out of memory', render: true } }) })
    const runner = new RunpodBlender(KEY)
    await expect(runner.test(GOOD, env, [1])).rejects.toBeInstanceOf(DrawingError)
    await expect(runner.render(GOOD, env, path.join(process.env.TEMP || '/tmp', 'never.mp4'))).rejects.toMatchObject({ status: 502, message: expect.stringContaining('graphics card couldn’t render it') })
    await runner.close()
  })

  it('tries the community cloud when the secure one has no card, and says plainly when the key is refused', async () => {
    const { calls } = fakeRunpod({ createStatus: [500, 201], podAnswers: () => ({ result: { ok: true, frames: ['test-0.jpg'] }, files: { 'test-0.jpg': Buffer.from([0xff, 0xd8]) } }) })
    const runner = new RunpodBlender(KEY)
    await runner.test(GOOD, env, [1])
    expect(calls.filter((c) => c.method === 'POST').map((c) => c.body!.cloudType)).toEqual(['SECURE', 'COMMUNITY'])
    await runner.close()
    const { calls: c2, st } = fakeRunpod()
    const bad = new RunpodBlender('rpa_WRONGKEY0123456789')
    await expect(bad.test(GOOD, env, [1])).rejects.toMatchObject({ status: 502, message: expect.stringContaining('RunPod didn’t accept the key') })
    expect(c2.filter((c) => c.method === 'POST')).toHaveLength(1)
    // nothing left behind, and no pod to delete
    expect([...st.objects.keys()].filter((k) => k.startsWith('blender-jobs/'))).toEqual([])
    await bad.close()
    expect(c2.filter((c) => c.method === 'DELETE')).toHaveLength(0)
  })

  it('a card that fails to set itself up is given back, with its reason', async () => {
    const { calls } = fakeRunpod({ boot: { ok: false, error: 'the graphics card could not be set up (step at line 17)' } })
    const runner = new RunpodBlender(KEY)
    // Blender can't be used for this video: assembly draws the rest in the 3D studio style
    await expect(runner.test(GOOD, env, [1])).rejects.toBeInstanceOf(BlenderUnavailableError)
    await expect(runner.test(GOOD, env, [1])).rejects.toMatchObject({ message: expect.stringContaining('could not be set up') })
    // a second scene doesn't rent another
    await expect(runner.test(GOOD, env, [1])).rejects.toThrow()
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(1)
    await runner.close()
    expect(calls.filter((c) => c.method === 'DELETE')).toHaveLength(1)
  })

  it('tests a key by listing its pods', async () => {
    fakeRunpod()
    expect(await testRunpodKey(KEY)).toMatchObject({ ok: true })
    expect(await testRunpodKey('rpa_NOPE0123456789')).toMatchObject({ ok: false, detail: expect.stringContaining('didn’t accept this key') })
  })
})

// --- a real Blender (REAL_BLENDER=1, BLENDER_PATH=...) ----------------------------------------------------------------

describe('a real Blender', () => {
  const exe = process.env.REAL_BLENDER === '1' ? findLocalBlender() : undefined
  beforeAll(async () => {
    if (exe) await setup()
  })

  it('tries and renders a scene the way it would for a video', async ({ skip }) => {
    if (!exe) skip()
    expect(await localBlenderVersion(exe!)).toMatch(/^Blender \d+\.\d+/)
    const runner = new LocalBlender(exe!)
    const small = { ...env, width: 640, height: 360, duration: 2 }
    const frames = await runner.test(GOOD, small, [0.2, 1.8])
    expect(frames).toHaveLength(2)
    expect(frames[0].subarray(0, 2).equals(Buffer.from([0xff, 0xd8]))).toBe(true)
    expect(frames[0].equals(frames[1])).toBe(false)
    if (process.env.REAL_BLENDER_OUT) frames.forEach((f, i) => fs.writeFileSync(path.join(process.env.REAL_BLENDER_OUT!, `test-${i}.jpg`), f))
    // the sandbox holds inside Blender too
    await expect(runner.test(GOOD.replace('random.seed(1)', "open('x')"), small, [1])).rejects.toThrow(/open is not allowed/)
    const out = path.join(process.env.REAL_BLENDER_OUT || fs.mkdtempSync(path.join(fs.realpathSync(process.env.TEMP || '/tmp'), 'ps-bl-')), 'scene.mp4')
    await runner.render(GOOD, small, out)
    expect(fs.statSync(out).size).toBeGreaterThan(1000)
  }, 900_000)
})
