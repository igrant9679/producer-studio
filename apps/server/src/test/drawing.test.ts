// AI-drawn scenes: the sandbox that runs the model's drawing code (frames from t alone, errors with their time, an
// endless loop stopped, no way out to the network) and the write → fix → look loop, with a scripted model. Needs the
// export's Chrome (skipped without it).
import fs from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import path from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import * as z from 'zod/v4'
import { strongestModel } from '@producer/core'
import { DRAWING_LIMITS, DRAWN_SYSTEM, MAX_FIXES, MAX_LOOKS, THREE_GUIDE, TooSlowError, buildDrawingPrompt, drawingPalette, inWorkLine, stepReporter, writeDrawing } from '../ai/drawn'
import type { AiProvider, StructuredRequest } from '../ai/provider'
import { toSceneVisual, VisualSchema } from '../ai/scenes'
import { ctx } from '../context'
import { DrawingError, type DrawingEnv, renderDrawing, testDrawing, uses3d } from '../media/drawing'
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

/** An answer that never comes: the request ends only when it is told to stop, as a real one does. */
const HANG = Symbol('an answer that never comes')

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
      if (a === HANG) {
        return new Promise<T>((_, reject) => {
          const stop = () => reject(new Error('the request was aborted'))
          if (req.signal?.aborted) stop()
          else req.signal?.addEventListener('abort', stop, { once: true })
        })
      }
      return req.schema.parse(a) as T
    },
  }
}

describe('a drawing too slow to use', () => {
  it('is told so when its try-out takes too long, or its render could not finish in time, and how to make it lighter', async ({ skip }) => {
    if (!chrome) skip()
    // (env: 1.2 s at 10 fps = 12 frames to try, 12 to render)
    const slow = await testDrawing(GOOD, env, [0.2], undefined, { limitMs: 0 }).catch((e: unknown) => e)
    expect(slow).toBeInstanceOf(DrawingError)
    expect((slow as DrawingError).message).toMatch(/^Too slow to draw: 1 of its 12 test frames took \d+ s\. Build everything once \(env\.memo/)
    expect((slow as DrawingError).at).toBe(0)
    const heavy = await testDrawing(GOOD, env, [0.2], undefined, { renderLimitMs: 1 }).catch((e: unknown) => e)
    expect(heavy).toBeInstanceOf(DrawingError)
    expect((heavy as DrawingError).message).toMatch(/^Too slow to render: a frame takes about [\d.]+ s to draw, so this scene's 12 frames would take about \d+ minutes \(the limit is 0\)\. Build everything once/)
    // with the usual limits the same drawing passes, and says how far it is frame by frame
    const seen: number[] = []
    const shots = await testDrawing(GOOD, env, [0.2], undefined, { onProgress: (f) => seen.push(f) })
    expect(shots).toHaveLength(1)
    expect(seen).toHaveLength(12)
    expect(seen.at(-1)).toBe(1)
  }, 120_000)
})

describe('one film, many scenes', () => {
  const o = { description: 'The fox curls round the bird', narration: 'n', headline: 'h', env: { width: 1280, height: 720, fps: 30, duration: 5, words: [], palette: { canvas: '#fff', ink: '#111', accent: '#f60' }, fonts: { headline: 'A', body: 'B' } } }

  it('a later scene is shown an earlier scene’s code and told to keep what appears again the same', () => {
    const plain = buildDrawingPrompt(o as never)
    expect(plain).not.toContain('THE SAME FILM')
    const later = buildDrawingPrompt({ ...o, reference: 'function draw(ctx, t, env) { /* the fox */ }' } as never)
    expect(later).toContain('THE SAME FILM, AN EARLIER SCENE')
    expect(later).toContain('/* the fox */')
    expect(later).toMatch(/must look the same/)
    expect(later).toMatch(/never copy its action or its camera/)
    // a very long scene is cut, not sent whole
    expect(buildDrawingPrompt({ ...o, reference: 'x'.repeat(40_000) } as never).length).toBeLessThan(plain.length + 17_500)
  })

  it('the note’s own colours win over the palette, and characters stay big', () => {
    const p = buildDrawingPrompt({ ...o, style: 'studio3d' } as never)
    expect(p).toMatch(/an orange fox is orange, never the accent/)
    expect(p).toMatch(/at least a quarter of the frame's height/)
    expect(DRAWN_SYSTEM).toMatch(/A colour the director's note names is the note's to choose/)
  })
})

describe('writing a drawing', () => {
  it('fixes code that fails once, then looks at its frames and keeps a fix that runs', async ({ skip }) => {
    if (!chrome) skip()
    const model = scripted([
      { plan: 'a disc', code: 'function draw(ctx, t) { nope(); }' },
      { plan: 'a disc', code: '```js\n' + GOOD + '\n```' },
      { problems: 'too small', changed: true, code: GOOD.replace('10 + 20 * k', '14 + 20 * k') },
    ])
    const working: string[] = []
    const r = await writeDrawing(model, { description: 'A disc grows on grow', narration: 'Plant it and watch it grow.', headline: 'Grow', env, onWorking: (c) => working.push(c) })
    expect(r.code).toContain('14 + 20 * k')
    // the first code that runs is announced once (the video's other scenes start from it), before the looks change it
    expect(working).toEqual([GOOD])
    // write, fix, look (fixes it), look again (the scripted model has nothing more to say: the fix it made stays)
    expect(model.calls).toHaveLength(4)
    expect(model.calls[3].prompt).toMatch(/after 1 round of your own fixes/)
    expect(model.calls[3].prompt).toContain('14 + 20 * k')
    // the fix request carries the error; the look carries four frames
    expect(model.calls[1].prompt).toMatch(/YOUR CODE FAILED at t = 0\.00 s: nope is not defined/)
    expect(model.calls[2].images).toHaveLength(4)
    expect(model.calls[2].images[0]).toMatchObject({ mediaType: 'image/jpeg' })
    expect(z.toJSONSchema(model.calls[0].schema as z.ZodType)).toBeTruthy()
    // every request to the model can say its answer is still arriving (the job's no-progress watchdog listens)
    expect(model.calls.every((c) => typeof c.onActivity === 'function')).toBe(true)
    // and asks for medium thinking: the strongest models' default made one scene a 20-minute, several-dollar answer
    expect(model.calls.every((c) => c.effort === 'medium')).toBe(true)
  }, 180_000)

  it('while a long answer streams in, the step is reported again, but not on every chunk', () => {
    const said: string[] = []
    let now = 1_000_000
    const r = stepReporter((_f, m) => said.push(m), 20_000, () => now)
    r.say(0.05, 'Writing the animation')
    // the answer takes a minute to arrive, a chunk every second
    for (let i = 0; i < 60; i++) {
      now += 1000
      r.alive()
    }
    // (said again every 20 s; once a minute has gone by it says how long the step has taken)
    expect(said).toEqual(['Writing the animation', 'Writing the animation', 'Writing the animation', 'Writing the animation (1 min)'])
    // the next step replaces it, and is what gets repeated from then on
    r.say(0.3, 'Trying the animation')
    now += 25_000
    r.alive()
    r.alive()
    expect(said.slice(4)).toEqual(['Trying the animation', 'Trying the animation'])
    // nobody listening: nothing to do
    expect(() => stepReporter(undefined).alive()).not.toThrow()
  })

  it('several scenes in work are one status line naming them all, not two lines taking turns', () => {
    // one scene alone reads as it always did
    expect(inWorkLine([])).toBeUndefined()
    expect(inWorkLine([{ label: 'Drawing s01', step: 'Checking the animation (3 min)' }])).toBe('Drawing s01: Checking the animation (3 min)')
    expect(inWorkLine([{ label: 'Drawing s01' }])).toBe('Drawing s01')
    // two under way (seen on the live site on 15 Nov: the line flipped between them every 10 to 20 s)
    const s01 = { label: 'Drawing s01', step: 'Checking the animation (3 min)' }
    const s02 = { label: 'Drawing s02', step: 'Writing the animation (1 min)' }
    expect(inWorkLine([s01, s02])).toBe('Drawing s01 (checking, 3 min) and s02 (writing, 1 min)')
    // whichever of them reports, the line is the same until a step or a minute changes
    expect(inWorkLine([s01, { ...s02 }])).toBe(inWorkLine([s01, s02]))
    // the first leads and two more follow it: three at once; a step in its first minute has no time yet
    expect(inWorkLine([{ label: 'Drawing s01', step: 'Checking the animation again (2 min)' }, { label: 'Drawing s02', step: 'Trying the animation' }, { label: 'Drawing s03', step: 'Writing the animation again, more simply (1 min)' }])).toBe(
      'Drawing s01 (checking again, 2 min), s02 (trying) and s03 (writing again, 1 min)',
    )
    expect(inWorkLine([{ label: 'Drawing s01', step: 'Rendering the animation' }, { label: 'Drawing s02' }])).toBe('Drawing s01 (rendering) and s02')
    // different kinds of work keep their own words
    expect(inWorkLine([{ label: 'Making an AI clip for s01', step: 'Generating the clip' }, { label: 'Drawing s02', step: 'Writing the animation' }])).toBe('Making an AI clip for s01 (generating) and Drawing s02 (writing)')
  })

  it('a step under way is said again by the clock though nothing arrives (the model thinking sends no word), and not after it ends', async () => {
    const said: string[] = []
    let now = 1_000_000
    const r = stepReporter((_f, m) => said.push(m), 250, () => now)
    r.say(0.05, 'Writing the animation')
    // 1.2 s of work during which nothing calls alive(); the clock says a minute goes by every 280 ms
    const tick = setInterval(() => (now += 60_000), 280)
    const out = await r.during(new Promise<string>((res) => setTimeout(() => res('the code'), 1200)))
    clearInterval(tick)
    expect(out).toBe('the code')
    expect(said.length).toBeGreaterThanOrEqual(3)
    expect(said[0]).toBe('Writing the animation')
    expect(said.at(-1)).toMatch(/^Writing the animation \(\d+ min\)$/)
    const n = said.length
    await new Promise((res) => setTimeout(res, 700))
    expect(said).toHaveLength(n)
    // work that fails is passed on as it is, and the saying stops too
    await expect(r.during(Promise.reject(new Error('no')))).rejects.toThrow('no')
  })

  it('an answer that takes too long is given up, and the code is asked for once more with less thinking', async ({ skip }) => {
    if (!chrome) skip()
    const model = scripted([HANG, { plan: 'p', code: GOOD }, { problems: 'none', changed: false, code: GOOD }])
    const said: string[] = []
    const r = await writeDrawing(model, { description: 'd', narration: 'n', headline: 'h', env, limits: { writeMs: 200 }, progress: (_f, m) => said.push(m) })
    expect(r.code).toBe(GOOD)
    // the write (given up), the write again with less thinking, one look
    expect(model.calls.map((c) => c.effort)).toEqual(['medium', 'low', 'medium'])
    // the answer given up was told to stop; the next one wasn't
    expect(model.calls[0].signal?.aborted).toBe(true)
    expect(model.calls[1].signal?.aborted).toBe(false)
    expect(said).toContain('Writing the animation again, more simply')
    // the limits a real drawing gets: each well under the 20 minutes a silent job is given
    expect(DRAWING_LIMITS).toEqual({ writeMs: 12 * 60_000, againMs: 8 * 60_000, lookMs: 6 * 60_000, looksUntilMs: 15 * 60_000 })
  }, 120_000)

  it('too slow twice: the scene can’t be drawn, and says why; stopping the job is a stop, not slowness', async () => {
    // (no browser needed: nothing runs before the code arrives)
    const model = scripted([HANG, HANG])
    const err = await writeDrawing(model, { description: 'd', narration: 'n', headline: 'h', env, limits: { writeMs: 100, againMs: 150 } }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(TooSlowError)
    expect(err).toMatchObject({ status: 504, message: expect.stringMatching(/^the AI took longer than \d+ minutes to answer$/) })
    expect(model.calls).toHaveLength(2)
    expect(new TooSlowError(8 * 60_000).message).toBe('the AI took longer than 8 minutes to answer')
    // the job is stopped while an answer is awaited: that request is told to stop at once, and it isn't called slow
    const job = new AbortController()
    const waiting = scripted([HANG])
    const stopped = writeDrawing(waiting, { description: 'd', narration: 'n', headline: 'h', env, signal: job.signal }).catch((e: unknown) => e)
    setTimeout(() => job.abort(), 60)
    expect(await stopped).not.toBeInstanceOf(TooSlowError)
    expect(waiting.calls[0].signal?.aborted).toBe(true)
  })

  it('a look that takes too long is skipped, and no new look starts late: the code that runs is kept', async ({ skip }) => {
    if (!chrome) skip()
    const slowLook = scripted([{ plan: 'p', code: GOOD }, HANG])
    expect((await writeDrawing(slowLook, { description: 'd', narration: 'n', headline: 'h', env, limits: { lookMs: 200 } })).code).toBe(GOOD)
    expect(slowLook.calls).toHaveLength(2)
    expect(slowLook.calls[1].signal?.aborted).toBe(true)
    // a scene that has already taken long enough gets its first look and no more
    const v1 = GOOD.replace('10 + 20 * k', '11 + 20 * k')
    const picky = scripted([{ plan: 'p', code: GOOD }, { problems: 'more', changed: true, code: v1 }, { problems: 'more', changed: true, code: GOOD.replace('10 + 20 * k', '12 + 20 * k') }])
    expect((await writeDrawing(picky, { description: 'd', narration: 'n', headline: 'h', env, limits: { looksUntilMs: 1 } })).code).toBe(v1)
    expect(picky.calls).toHaveLength(2)
  }, 180_000)

  it('keeps the working code when the reviewed version breaks; gives up when the fix fails too', async ({ skip }) => {
    if (!chrome) skip()
    const keep = await writeDrawing(scripted([{ plan: 'p', code: GOOD }, { problems: 'x', changed: true, code: 'function draw() { boom() }' }]), { description: 'd', narration: 'n', headline: 'h', env })
    expect(keep.code).toBe(GOOD)
    // up to MAX_FIXES fixes, then it gives up with the last error
    const fails = writeDrawing(scripted([{ plan: 'p', code: 'function draw() { a() }' }, { plan: 'p', code: 'function draw() { b() }' }, { plan: 'p', code: 'function draw() { zz() }' }]), { description: 'd', narration: 'n', headline: 'h', env })
    await expect(fails).rejects.toMatchObject({ status: 502, message: expect.stringContaining('zz is not defined') })
    expect(MAX_FIXES).toBe(2)
  }, 180_000)

  it('looks again after each fix, up to MAX_LOOKS, and stops when it is happy', async ({ skip }) => {
    if (!chrome) skip()
    const v = (n: number) => GOOD.replace('10 + 20 * k', `${10 + n} + 20 * k`)
    const happy = scripted([{ plan: 'p', code: GOOD }, { problems: 'small', changed: true, code: v(1) }, { problems: 'none', changed: false, code: v(1) }])
    expect((await writeDrawing(happy, { description: 'd', narration: 'n', headline: 'h', env })).code).toBe(v(1))
    expect(happy.calls).toHaveLength(3)
    const picky = scripted([{ plan: 'p', code: GOOD }, ...[1, 2, 3, 4].map((n) => ({ problems: 'more', changed: true, code: v(n) }))])
    expect((await writeDrawing(picky, { description: 'd', narration: 'n', headline: 'h', env })).code).toBe(v(MAX_LOOKS))
    expect(picky.calls).toHaveLength(1 + MAX_LOOKS)
    // each look sees the frames of the version it is judging
    expect(picky.calls.slice(1).every((c) => c.images.length === 4)).toBe(true)
  }, 240_000)
})

describe('the writer and the API', () => {
  it('a drawn scene comes from the writer’s note, and the API takes its code back', () => {
    const blank = { points: [], diagramType: 'none', items: [], details: [], values: [], unit: '', center: '', leftTitle: '', leftPoints: [], rightTitle: '', rightPoints: [], prompt: '', query: '', mediaId: '', libraryId: '', animStyle: 'none', objects: [], labels: [] } as const
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

  it('the 3D styles get the stage guide and their own backdrop colours; the others don’t', () => {
    const brand = { canvas: '#101010', accent: '#ff5500', ink: '#ffffff' }
    expect(drawingPalette('clay3d', brand)).toEqual({ canvas: '#efe6d8', ink: '#3b3330', accent: '#ff5500' })
    const clay = buildDrawingPrompt({ description: 'A robot waves', narration: 'Meet Bolt.', headline: 'Bolt', env, style: 'clay3d' })
    expect(clay).toMatch(/DRAWING STYLE: 3D clay\. 3D clay animation/)
    expect(clay).toContain(THREE_GUIDE)
    expect(buildDrawingPrompt({ description: 'x', narration: 'y', headline: 'z', env, style: 'watercolour' })).not.toContain('env.stage3d')
    expect(uses3d("const s = env.stage3d('main', () => ({}))")).toBe(true)
    expect(uses3d('const m = env . material3d("#fff")')).toBe(true)
    expect(uses3d(GOOD)).toBe(false)
  })

  it('ships the three.js bundle built from the installed package, with its licence', async () => {
    const dir = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..', '..', 'vendor', 'three')
    // @ts-expect-error plain .mjs script without types
    const { bundleThree } = await import('../../scripts/build-three.mjs')
    expect(fs.readFileSync(path.join(dir, 'three.js'), 'utf8').replace(/\r\n/g, '\n')).toBe(await bundleThree())
    expect(fs.readFileSync(path.join(dir, 'LICENSE'), 'utf8')).toMatch(/The MIT License/)
    expect(fs.readFileSync(path.join(dir, 'PROVENANCE.md'), 'utf8')).toMatch(/three@0\.186\.1/)
  }, 60_000)

  it('ships the anidoodle bundle built from the vendored sources, with its licence', async () => {
    const dir = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..', '..', 'vendor', 'anidoodle')
    // @ts-expect-error plain .mjs script without types
    const { bundleAnidoodle } = await import('../../scripts/build-anidoodle.mjs')
    expect(fs.readFileSync(path.join(dir, 'anidoodle.js'), 'utf8').replace(/\r\n/g, '\n')).toBe(await bundleAnidoodle())
    expect(fs.readFileSync(path.join(dir, 'LICENSE'), 'utf8')).toMatch(/Apache License/)
    expect(fs.readFileSync(path.join(dir, 'NOTICE'), 'utf8')).toMatch(/Alex Greenshpun/)
  }, 60_000)
})

/** A lit 3D scene: a glossy rounded box turning on its word, a clay ball, a 2D label pinned to the ball. */
const CUBE = `function draw(ctx, t, env) {
  const g = ctx.createLinearGradient(0, 0, 0, env.H); g.addColorStop(0, '#ffffff'); g.addColorStop(1, env.palette.canvas);
  ctx.fillStyle = g; ctx.fillRect(0, 0, env.W, env.H);
  const s = env.stage3d('main', (THREE, st) => {
    const box = st.add(new THREE.Mesh(new THREE.RoundedBoxGeometry(2, 2, 2, 4, 0.3), env.material3d(env.palette.accent, 'glossy')));
    const ball = st.add(new THREE.Mesh(new THREE.SphereGeometry(0.7, 32, 24), env.material3d('#4a90e2', 'clay')));
    ball.position.set(2.4, 0.7, 0);
    return { box, ball };
  });
  s.parts.box.position.y = 1 + 0.3 * env.progress(t, env.wordAt('grow') ?? 0.5, 0.3, env.ease.back);
  s.parts.box.rotation.y = t * 1.5;
  s.render(ctx);
  const p = s.project(s.parts.ball);
  ctx.fillStyle = env.palette.ink; ctx.fillRect(p.x - 2, p.y - 2, 4, 4);
}`

describe('3D drawings', () => {
  it('render lit three.js scenes over the 2D frame, from t alone, the same every time', async ({ skip }) => {
    if (!chrome) skip()
    const e = { ...env, palette: { canvas: '#efe6d8', accent: '#ff5500', ink: '#222222' } }
    const [a, b] = await testDrawing(CUBE, e, [0.1, 1.0])
    expect(a.subarray(0, 2).equals(Buffer.from([0xff, 0xd8]))).toBe(true)
    expect(a.equals(b)).toBe(false)
    const [again] = await testDrawing(CUBE, e, [0.1])
    expect(again.equals(a)).toBe(true)
  }, 300_000)

  it('a drawing that doesn’t use 3D gets no WebGL at all, and a stage asked for in a roundabout way says why it can’t work', async ({ skip }) => {
    if (!chrome) skip()
    const probe = `function draw(ctx, t, env) { const c = document.createElement('canvas'); if (c.getContext('webgl') || c.getContext('webgl2')) throw new Error('webgl is on'); const stage = env['stage' + '3d']; if (window.THREE || !stage) throw new Error('three is loaded'); try { stage('x', () => ({})); } catch (e) { if (!/not loaded on this page/.test(e.message)) throw e; return; } throw new Error('stage3d worked'); }`
    await expect(testDrawing(probe, env, [0.5])).resolves.toHaveLength(1)
  }, 120_000)
})

describe('the animation model', () => {
  it('is the most capable on the key’s list: tier first, then version; never an image, audio or mini model', () => {
    expect(strongestModel('anthropic', ['claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5', 'claude-opus-4-1-20250805'])).toBe('claude-opus-5-5')
    expect(strongestModel('anthropic', ['claude-opus-5-5', 'claude-fable-5-2', 'claude-fable-5-1', 'claude-sonnet-5-5'])).toBe('claude-fable-5-2')
    expect(strongestModel('gemini', ['gemini-3-flash', 'gemini-3.1-pro-preview', 'gemini-3-pro', 'gemini-3.1-flash-image', 'gemini-3-flash-lite'])).toBe('gemini-3.1-pro-preview')
    expect(strongestModel('gemini', ['gemini-3-flash', 'gemini-3-flash-lite', 'gemini-2.5-pro-preview-tts'])).toBe('gemini-3-flash')
    expect(strongestModel('openai', ['gpt-5.5-mini', 'gpt-5.5', 'gpt-5.6', 'gpt-5.6-pro', 'gpt-realtime', 'gpt-image-2', 'gpt-5.10'])).toBe('gpt-5.10')
    expect(strongestModel('openai', ['text-embedding-3-small'])).toBeUndefined()
    expect(strongestModel('gemini', undefined)).toBeUndefined()
  })
})
