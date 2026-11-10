// AI-drawn scenes: the sandbox that runs the model's drawing code (frames from t alone, errors with their time, an
// endless loop stopped, no way out to the network) and the write → fix → look loop, with a scripted model. Needs the
// export's Chrome (skipped without it).
import fs from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import path from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import * as z from 'zod/v4'
import { buildDrawingPrompt, drawingPalette, writeDrawing } from '../ai/drawn'
import type { AiProvider, StructuredRequest } from '../ai/provider'
import { toSceneVisual, VisualSchema } from '../ai/scenes'
import { ctx } from '../context'
import { DrawingError, type DrawingEnv, renderDrawing, testDrawing } from '../media/drawing'
import { probe } from '../media/process'
import { setup } from './helpers'

let chrome = false
beforeAll(async () => {
  await setup()
  chrome = !!ctx().config.chromePath && fs.existsSync(ctx().config.chromePath!)
}, 120_000)

const env: DrawingEnv = {
  width: 320,
  height: 180,
  fps: 10,
  duration: 1.2,
  words: [
    { w: 'Plant', start: 0.3 },
    { w: 'grow', start: 0.8 },
  ],
  palette: { canvas: '#101010', accent: '#ff5500', ink: '#ffffff' },
  fonts: { headline: 'Montserrat', body: 'Inter' },
}

/** A disc that moves right with t, the accent colour, entering on "grow". */
const GOOD = `function draw(ctx, t, env) {
  const k = env.progress(t, env.wordAt('grow') ?? 0.5, 0.3);
  ctx.fillStyle = env.palette.accent;
  ctx.beginPath(); ctx.arc(20 + t * 200, env.H / 2, 10 + 20 * k, 0, Math.PI * 2); ctx.fill();
  env.rough.line(0, 10, env.W, 10, { stroke: env.palette.ink, seed: 1 + Math.floor(t * 6) % 3 });
  const r = env.rand(7)(); if (r < 0 || r > 1) throw new Error('rand out of range');
}`

describe('the drawing sandbox', () => {
  it('draws frames from t, with the helpers, the same every time', async ({ skip }) => {
    if (!chrome) skip()
    const [a, b] = await testDrawing(GOOD, env, [0.2, 1.0])
    expect(a.subarray(0, 2).equals(Buffer.from([0xff, 0xd8]))).toBe(true)
    expect(a.equals(b)).toBe(false)
    const [again] = await testDrawing(GOOD, env, [0.2])
    expect(again.equals(a)).toBe(true)
  }, 120_000)

  it('says what failed and when: a compile error, a throw at some t, no draw function', async ({ skip }) => {
    if (!chrome) skip()
    await expect(testDrawing('function draw(ctx, t, env) { ctx.fillStyle = ; }', env, [0])).rejects.toBeInstanceOf(DrawingError)
    const err = (await testDrawing('function draw(ctx, t) { if (t > 0.5) throw new Error("boom at " + t.toFixed(1)) }', env, [0]).catch((e) => e)) as DrawingError
    expect(err).toBeInstanceOf(DrawingError)
    expect(err.message).toContain('boom at 0.6')
    expect(err.at).toBeCloseTo(0.6, 3)
    expect(((await testDrawing('const x = 1', env, [0]).catch((e) => e)) as Error).message).toMatch(/does not define function draw/)
  }, 120_000)

  it('stops an endless loop', async ({ skip }) => {
    if (!chrome) skip()
    const t0 = Date.now()
    const err = (await testDrawing('function draw() { for (;;) {} }', env, [0]).catch((e) => e)) as DrawingError
    expect(err).toBeInstanceOf(DrawingError)
    expect(Date.now() - t0).toBeLessThan(40_000)
  }, 60_000)

  it('reaches nothing outside: no fetch, no XHR, no images, no WebSocket, not even this machine', async ({ skip }) => {
    if (!chrome) skip()
    let hits = 0
    const server = http.createServer((_req, res) => {
      hits++
      res.end('ok')
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/x`
    try {
      const code = `function draw(ctx, t, env) {
        const tries = [];
        try { fetch('${url}?f'); tries.push('fetch'); } catch (e) {}
        try { const x = new XMLHttpRequest(); x.open('GET', '${url}?x'); x.send(); tries.push('xhr'); } catch (e) {}
        try { new WebSocket('ws://127.0.0.1:1'); tries.push('ws'); } catch (e) {}
        try { const i = document.createElement('img'); i.src = '${url}?img'; document.body.appendChild(i); } catch (e) {}
        try { const s = document.createElement('script'); s.src = '${url}?js'; document.body.appendChild(s); } catch (e) {}
        try { const f = document.createElement('iframe'); f.src = '${url}?frame'; document.body.appendChild(f); } catch (e) {}
        try { navigator.sendBeacon('${url}?beacon'); tries.push('beacon'); } catch (e) {}
        if (tries.length) throw new Error('reachable: ' + tries.join(','));
      }`
      await testDrawing(code, env, [0])
      await new Promise((r) => setTimeout(r, 800))
      expect(hits).toBe(0)
    } finally {
      server.close()
    }
  }, 120_000)

  it('gives the drawing anidoodle’s media and marks, built once and drawn the same every time', async ({ skip }) => {
    if (!chrome) skip()
    // a pencil line drawn on, a watercolour wash, a shaded form, hatching laid down in order, paper grain over it all
    const code = `function draw(ctx, t, env) {
      const d = env.doodle(ctx, t, 'pencil');
      d.group('paint', () => d.wash(env.shapes.oval(160, 95, 70, 45, 12), env.palette.accent, { alpha: 0.6, seed: 3 }));
      d.form(env.shapes.softBox(250, 90, 60, 50), '#7fb0d8', '#40607e', { seed: 4 });
      d.pen([[20, 150], [120, 120], [220, 150], [300, 130]], { color: env.palette.ink, seed: 5, progress: env.progress(t, 0, 1, env.ease.linear) });
      const inks = env.memo('hatch', () => env.marks.hatch(env.marks.ellR(70, 70, 45, 35), { ang: -0.9, gap: 5, len: 18, w: 1.2, col: env.palette.ink, a: 0.8, seed: 9 }));
      if (!inks.length) throw new Error('no hatching');
      env.marks.play(ctx, inks, t, 0.1, 1.0);
      d.paper('paper', 0.35);
    }`
    const [a, b] = await testDrawing(code, { ...env, palette: { canvas: '#f5f0e4', accent: '#d9632e', ink: '#3a3236' } }, [0.15, 1.1])
    expect(a.equals(b)).toBe(false)
    const [again] = await testDrawing(code, { ...env, palette: { canvas: '#f5f0e4', accent: '#d9632e', ink: '#3a3236' } }, [0.15])
    expect(again.equals(a)).toBe(true)
  }, 120_000)

  it('reads pictures it was given as data URLs, and nothing else', async ({ skip }) => {
    if (!chrome) skip()
    const png = await (await import('sharp')).default({ create: { width: 8, height: 8, channels: 3, background: '#00ff00' } }).png().toBuffer()
    const code = `function draw(ctx, t, env) {
      const img = env.image('pic');
      if (!img || img.naturalWidth !== 8) throw new Error('no picture');
      if (env.image('missing')) throw new Error('a picture that was never given');
      ctx.drawImage(img, 0, 0, env.W, env.H);
    }`
    const [f] = await testDrawing(code, { ...env, images: { pic: `data:image/png;base64,${png.toString('base64')}` } }, [0])
    const px = await (await import('sharp')).default(f).raw().toBuffer()
    expect(px[1]).toBeGreaterThan(200)
    expect(px[0]).toBeLessThan(60)
  }, 120_000)

  it('renders the whole scene to an mp4 at the frame rate', async ({ skip }) => {
    if (!chrome) skip()
    const out = path.join(ctx().config.dataDir, 'drawn-test.mp4')
    await renderDrawing(GOOD, env, out)
    const p = await probe(out)
    expect(p.width).toBe(320)
    expect(p.height).toBe(180)
    expect(p.duration).toBeGreaterThan(1.0)
    expect(p.duration).toBeLessThan(1.5)
  }, 120_000)
})

/** A model that answers each structured() call from a script, and records what it was sent. */
function scripted(answers: unknown[]): AiProvider & { calls: Array<StructuredRequest<unknown>> } {
  const calls: Array<StructuredRequest<unknown>> = []
  return {
    id: 'anthropic-api',
    calls,
    status: async () => ({ configured: true }) as never,
    write: async () => '',
    runAgent: async () => ({ text: '' }),
    structured: async <T,>(req: StructuredRequest<T>) => {
      calls.push(req as StructuredRequest<unknown>)
      const a = answers.shift()
      if (!a) throw new Error('no more answers')
      return req.schema.parse(a) as T
    },
  }
}

describe('writing a drawing', () => {
  it('fixes code that fails once, then looks at its frames and keeps a fix that runs', async ({ skip }) => {
    if (!chrome) skip()
    const model = scripted([
      { plan: 'a disc', code: 'function draw(ctx, t) { nope(); }' },
      { plan: 'a disc', code: '```js\n' + GOOD + '\n```' },
      { problems: 'too small', changed: true, code: GOOD.replace('10 + 20 * k', '14 + 20 * k') },
    ])
    const r = await writeDrawing(model, { description: 'A disc grows on grow', narration: 'Plant it and watch it grow.', headline: 'Grow', env })
    expect(r.code).toContain('14 + 20 * k')
    expect(model.calls).toHaveLength(3)
    // the fix request carries the error; the look carries four frames
    expect(model.calls[1].prompt).toMatch(/YOUR CODE FAILED at t = 0\.00 s: nope is not defined/)
    expect(model.calls[2].images).toHaveLength(4)
    expect(model.calls[2].images[0]).toMatchObject({ mediaType: 'image/jpeg' })
    expect(z.toJSONSchema(model.calls[0].schema as z.ZodType)).toBeTruthy()
  }, 180_000)

  it('keeps the working code when the reviewed version breaks; gives up when the fix fails too', async ({ skip }) => {
    if (!chrome) skip()
    const keep = await writeDrawing(scripted([{ plan: 'p', code: GOOD }, { problems: 'x', changed: true, code: 'function draw() { boom() }' }]), { description: 'd', narration: 'n', headline: 'h', env })
    expect(keep.code).toBe(GOOD)
    const fails = writeDrawing(scripted([{ plan: 'p', code: 'function draw() { a() }' }, { plan: 'p', code: 'function draw() { b() }' }]), { description: 'd', narration: 'n', headline: 'h', env })
    await expect(fails).rejects.toMatchObject({ status: 502, message: expect.stringContaining('b is not defined') })
  }, 180_000)
})

describe('the writer and the API', () => {
  it('a drawn scene comes from the writer’s note, and the API takes its code back', () => {
    const blank = { points: [], diagramType: 'none', items: [], details: [], values: [], unit: '', center: '', leftTitle: '', leftPoints: [], rightTitle: '', rightPoints: [], prompt: '', query: '', mediaId: '', animStyle: 'none', objects: [], labels: [] } as const
    expect(toSceneVisual({ ...blank, kind: 'drawn', prompt: ' A seed grows on "grow" ' } as never, ['motion', 'drawn'])).toEqual({ kind: 'drawn', prompt: 'A seed grows on "grow"' })
    expect(toSceneVisual({ ...blank, kind: 'drawn', prompt: '' } as never, ['motion', 'drawn']).kind).toBe('motion')
    expect(toSceneVisual({ ...blank, kind: 'drawn', prompt: 'x' } as never, ['motion']).kind).toBe('motion')
    expect(VisualSchema.safeParse({ kind: 'drawn', prompt: 'x', code: GOOD, assetId: 'as_1' }).success).toBe(true)
    expect(VisualSchema.safeParse({ kind: 'drawn', prompt: 'x', code: 'x'.repeat(60_001) }).success).toBe(false)
  })
})

describe('drawing styles and the bundled media', () => {
  it('asks for the style’s recipe and draws it on its own paper and ink, keeping the brand’s accent', () => {
    const brand = { canvas: '#101010', accent: '#ff5500', ink: '#ffffff' }
    expect(drawingPalette('clean', brand)).toEqual(brand)
    expect(drawingPalette('blueprint', brand)).toEqual({ canvas: '#1d4378', ink: '#f2f0e8', accent: '#ff5500' })
    const plain = buildDrawingPrompt({ description: 'A seed grows', narration: 'Plant it.', headline: 'Grow', env })
    expect(plain).not.toMatch(/DRAWING STYLE/)
    const styled = buildDrawingPrompt({ description: 'A seed grows', narration: 'Plant it.', headline: 'Grow', env, style: 'watercolour' })
    expect(styled).toMatch(/DRAWING STYLE: Pencil and watercolour\. Pencil and pan watercolour/)
  })

  it('ships the anidoodle bundle built from the vendored sources, with its licence', async () => {
    const dir = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..', '..', 'vendor', 'anidoodle')
    // @ts-expect-error plain .mjs script without types
    const { bundleAnidoodle } = await import('../../scripts/build-anidoodle.mjs')
    expect(fs.readFileSync(path.join(dir, 'anidoodle.js'), 'utf8').replace(/\r\n/g, '\n')).toBe(await bundleAnidoodle())
    expect(fs.readFileSync(path.join(dir, 'LICENSE'), 'utf8')).toMatch(/Apache License/)
    expect(fs.readFileSync(path.join(dir, 'NOTICE'), 'utf8')).toMatch(/Alex Greenshpun/)
  }, 60_000)
})
