// Lottie motion graphics and rigged characters in the drawing sandbox: the Lottie builder's JSON (standard bodymovin
// v5: layers, keyframes, eases, trim paths, text, parenting) and the 2D puppet's schedule (mouth on the words, walks,
// entrances, head moves) in Node; the vendored lottie-web and Open Peeps files against their provenance; and, with
// Chrome, real renders: a Lottie scene (shapes from lottie-web, text in the brand font), an Open Peeps character that
// talks and walks, a 3D rigged character, and the guides each drawing style's prompt carries.
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { CHARACTER_GUIDE, LOTTIE_GUIDE, PEEPS_GUIDE, THREE_GUIDE, buildDrawingPrompt, guidesFor } from '../ai/drawn'
import { type DrawingEnv, testDrawing, uses3d, usesLottie, usesPeeps } from '../media/drawing'
import { ctx } from '../context'
import { setup } from './helpers'

const SERVER = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..', '..')
/** A sandbox script run as the page runs it (a plain script), with a module object to read its API from. */
function script<T>(file: string): T {
  const mod: { exports: unknown } = { exports: {} }
  new Function('module', fs.readFileSync(path.join(SERVER, 'sandbox', file), 'utf8'))(mod)
  return mod.exports as T
}
const MG = script<{
  Scene: new (o: Record<string, unknown>) => Record<string, (...a: unknown[]) => unknown> & { toLottie(): Record<string, unknown> }
  sample: (p: unknown, f: number) => unknown
  bezier: (x: number, o: number[], i: number[]) => number
}>('lottie-mg.js')
const PEEPS = script<{
  mouthOpenness: (talks: Array<{ t0: number; t1: number }>, words: Array<{ start: number; end?: number }>, t: number) => number
  placement: (o: Record<string, unknown>, t: number) => { x: number; y: number; lift: number; alpha: number; scale: number; walking: boolean }
  headTurn: (o: Record<string, unknown>, t: number, talking: boolean) => { deg: number; dip: number }
  latest: (track: Array<{ t: number; v: string }>, t: number, def: string) => { v: string; at: number }
}>('peeps.js')

type Json = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any

describe('the Lottie builder', () => {
  const scene = () => new MG.Scene({ width: 1280, height: 720, fps: 30, duration: 4, fonts: { headline: 'Inter', body: 'Inter' } })

  it('compiles to standard Lottie: first-added layer at the back, eased keyframes, a static value when nothing moves', () => {
    const s = scene() as Json
    const dot = s.circle({ x: 100, y: 200, r: 40, fill: '#ff5a36' }).pop(0.5)
    s.rect({ x: 640, y: 360, w: 300, h: 80, radius: 12, fill: '#111111', stroke: '#ffffff', strokeWidth: 4 })
    const j = s.toLottie() as Json
    expect(j).toMatchObject({ v: '5.9.0', fr: 30, ip: 0, op: 120, w: 1280, h: 720, assets: [] })
    expect(j.layers.map((l: Json) => l.nm)).toEqual(['rect 2', 'ellipse 1'])
    const ell = j.layers[1]
    expect(ell.ks.p).toEqual({ a: 0, k: [100, 200] })
    // pop: scale 0 → 100% over 0.5 s from frame 15, eased 'back' (overshoot handles), two-dimensional
    expect(ell.ks.s.a).toBe(1)
    expect(ell.ks.s.k.map((k: Json) => [k.t, k.s])).toEqual([[15, [0, 0]], [30, [100, 100]]])
    expect(ell.ks.s.k[0].o).toEqual({ x: [0.34, 0.34], y: [1.56, 1.56] })
    expect(ell.shapes[0].it.map((i: Json) => i.ty)).toEqual(['el', 'fl', 'tr'])
    expect(ell.shapes[0].it[1].c.k).toEqual([1, 90 / 255, 54 / 255, 1])
    expect(j.layers[0].shapes[0].it.map((i: Json) => i.ty)).toEqual(['rc', 'fl', 'st', 'tr'])
    expect(dot).toBeTruthy()
  })

  it('a drawn-on path has trim paths between the path and its stroke, and sits at the origin (its points are pixels)', () => {
    const s = scene() as Json
    s.path([[0, 0], [100, 50]], { stroke: '#000000', strokeWidth: 8, closed: false }).drawOn(1, 2)
    const l = (s.toLottie() as Json).layers[0]
    expect(l.ks.p.k).toEqual([0, 0])
    expect(l.shapes[0].it.map((i: Json) => i.ty)).toEqual(['sh', 'tm', 'st', 'tr'])
    expect(l.shapes[0].it[1].e.k.map((k: Json) => [k.t, k.s])).toEqual([[30, [0]], [60, [100]]])
    expect(l.shapes[0].it[0].ks.k).toMatchObject({ c: false, v: [[0, 0], [100, 50]] })
    expect(() => (scene() as Json).circle({ fill: '#000000' }).drawOn(0, 1)).toThrow(/drawOn needs a stroke/)
  })

  it('text is a real text layer with its font listed; groups are null layers their children follow', () => {
    const s = scene() as Json
    const g = s.group({ x: 300, y: 300 })
    s.text('Two\nlines', { x: 0, y: 0, size: 40, color: '#ffffff', parent: g, align: 'left' }).fadeIn(0.2)
    g.spin(0, 2, 90)
    const j = s.toLottie() as Json
    const [text, nul] = j.layers
    expect(nul.ty).toBe(3)
    expect(text).toMatchObject({ ty: 5, parent: nul.ind })
    expect(text.t.d.k[0].s).toMatchObject({ s: 40, t: 'Two\rlines', j: 0, f: 'Inter-700', fc: [1, 1, 1], lh: 48 })
    expect(j.fonts.list).toEqual([{ fName: 'Inter-700', fFamily: 'Inter', fStyle: 'Bold', fWeight: '700', ascent: 72, origin: 0 }])
    expect(nul.ks.r.k.map((k: Json) => [k.t, k.s])).toEqual([[0, [0]], [60, [90]]])
  })

  it('a bad colour, ease or time is a plain error the AI can fix', () => {
    expect(() => (scene() as Json).circle({ fill: 'orange-ish' })).not.toThrow()
    expect(() => (scene() as Json).circle({ fill: 'orange-ish' }) && (scene() as Json).toLottie()).not.toThrow()
    expect(() => {
      const s = scene() as Json
      s.circle({ fill: 'orange-ish' })
      s.toLottie()
    }).toThrow(/not a colour: orange-ish/)
    expect(() => (scene() as Json).rect({}).at(1, { x: 5 }, 'wobbly')).toThrow(/unknown ease "wobbly"/)
    expect(() => (scene() as Json).rect({}).at('soon', { x: 5 })).toThrow(/a time must be a number of seconds/)
  })

  it('samples keyframes the way lottie-web eases them (used for the text it draws itself)', () => {
    const p = { a: 1, k: [{ t: 0, s: [0], o: { x: [0], y: [0] }, i: { x: [1], y: [1] } }, { t: 10, s: [100] }] }
    expect(MG.sample(p, -5)).toBe(0)
    expect(MG.sample(p, 5)).toBeCloseTo(50, 1)
    expect(MG.sample(p, 20)).toBe(100)
    expect(MG.bezier(0.5, [0.42, 0], [0.58, 1])).toBeCloseTo(0.5, 2)
  })
})

describe('the 2D character’s schedule', () => {
  const words = [{ start: 1, end: 1.4 }, { start: 1.6, end: 1.7 }, { start: 3, end: 3.5 }]

  it('the mouth opens and shuts once over each narration word inside a talk window, and stays shut outside it', () => {
    const talks = [{ t0: 0.5, t1: 2 }]
    expect(PEEPS.mouthOpenness(talks, words, 0.8)).toBe(0)
    expect(PEEPS.mouthOpenness(talks, words, 1.2)).toBeGreaterThan(0.5)
    expect(PEEPS.mouthOpenness(talks, words, 1.01)).toBeLessThan(0.2)
    expect(PEEPS.mouthOpenness(talks, words, 1.5)).toBe(0)
    expect(PEEPS.mouthOpenness(talks, words, 1.65)).toBeGreaterThan(0.4)
    // a word outside the window: shut
    expect(PEEPS.mouthOpenness(talks, words, 3.2)).toBe(0)
    // no word timings: steady flaps
    expect(PEEPS.mouthOpenness(talks, [], 0.6)).toBeGreaterThan(0)
  })

  it('walks, enters and exits from t alone', () => {
    const o = { x: 100, y: 600, moves: [{ t0: 1, t1: 3, x0: 100, y0: 600, x: 500, y: 600, walk: true, steps: 2.2 }], shows: [{ kind: 'enter', t: 0, from: 'pop', dur: 0.5, distance: 700 }, { kind: 'exit', t: 5, to: 'fade', dur: 0.5, distance: 700 }] }
    expect(PEEPS.placement(o, 0).x).toBe(100)
    expect(PEEPS.placement(o, 0).scale).toBeCloseTo(0, 6)
    expect(PEEPS.placement(o, 0.5).scale).toBeCloseTo(1, 5)
    const mid = PEEPS.placement(o, 2)
    expect(mid.x).toBeCloseTo(300, 5)
    expect(mid.walking).toBe(true)
    expect(PEEPS.placement(o, 4)).toMatchObject({ x: 500, walking: false, alpha: 1 })
    expect(PEEPS.placement(o, 5.6).alpha).toBe(0)
  })

  it('the pose and face in force are the last ones started; a nod dips the head and a tilt turns it', () => {
    const track = [{ t: -1, v: 'RestingBW' }, { t: 2, v: 'PointingFingerBW' }]
    expect(PEEPS.latest(track, 1.9, 'x').v).toBe('RestingBW')
    expect(PEEPS.latest(track, 2, 'x')).toEqual({ v: 'PointingFingerBW', at: 2 })
    const o = { heads: [{ kind: 'nod', t: 1, dur: 0.8 }, { kind: 'tilt', t: 3, deg: 12, dur: 1.2 }] }
    expect(PEEPS.headTurn(o, 1.4, false).dip).toBeGreaterThan(0)
    expect(Math.abs(PEEPS.headTurn(o, 3.6, false).deg)).toBeGreaterThan(9)
  })
})

describe('the vendored files', () => {
  it('lottie-web is the light canvas build its provenance names, unchanged, with its licence', () => {
    const dir = path.join(SERVER, 'vendor', 'lottie')
    const sha = crypto.createHash('sha256').update(fs.readFileSync(path.join(dir, 'lottie.js'))).digest('hex')
    expect(fs.readFileSync(path.join(dir, 'PROVENANCE.md'), 'utf8')).toContain(sha)
    expect(fs.readFileSync(path.join(dir, 'PROVENANCE.md'), 'utf8')).toMatch(/lottie-web@5\.13\.0/)
    expect(fs.readFileSync(path.join(dir, 'LICENSE'), 'utf8')).toMatch(/The MIT License/)
    // the light build: no expressions engine (nothing in an animation can run code)
    expect(fs.readFileSync(path.join(dir, 'lottie.js'), 'utf8')).not.toMatch(/ExpressionManager|expressionHelpers/)
  })

  it('the Open Peeps art: every part has paths and a box, bodies carry their poses, with the licence and provenance', () => {
    const dir = path.join(SERVER, 'vendor', 'peeps')
    const d = JSON.parse(fs.readFileSync(path.join(dir, 'peeps.json'), 'utf8'))
    expect(Object.keys(d.face)).toEqual(expect.arrayContaining(['Smile', 'SmileNM', 'Calm', 'CalmNM', 'Explaining']))
    expect(Object.keys(d.standing)).toEqual(expect.arrayContaining(['RestingBW', 'WalkingBW', 'WalkingWB', 'PointingFingerBW']))
    expect(Object.keys(d.sitting)).not.toContain('Bike')
    for (const cat of ['face', 'hair', 'facialHair', 'accessories', 'standing', 'sitting', 'bust'])
      for (const [name, part] of Object.entries<Json>(d[cat])) {
        expect(part.paths.length, `${cat}/${name}`).toBeGreaterThan(0)
        expect(part.box[2] > part.box[0] && part.box[3] > part.box[1], `${cat}/${name} box`).toBe(true)
      }
    expect(fs.readFileSync(path.join(dir, 'LICENSE'), 'utf8')).toMatch(/MIT/)
    expect(fs.readFileSync(path.join(dir, 'PROVENANCE.md'), 'utf8')).toMatch(/CC0/)
  })
})

describe('what each drawing style is told', () => {
  const env: DrawingEnv = { width: 1280, height: 720, duration: 4, fps: 30, words: [], palette: { canvas: '#fff', accent: '#f50', ink: '#111' }, fonts: { headline: 'Inter', body: 'Inter' } }
  it('2D styles get the people guide; 3D styles the stage and the rigged character; Lottie its builder; Blender none', () => {
    expect(guidesFor('watercolour')).toContain(PEEPS_GUIDE)
    expect(guidesFor('clean')).toContain(PEEPS_GUIDE)
    expect(guidesFor('clay3d')).toContain(THREE_GUIDE)
    expect(guidesFor('clay3d')).toContain(CHARACTER_GUIDE)
    expect(guidesFor('clay3d')).not.toContain(PEEPS_GUIDE)
    expect(guidesFor('lottie')).toBe(`\n${LOTTIE_GUIDE}\n`)
    expect(guidesFor('blender')).toBe('')
    expect(buildDrawingPrompt({ description: 'A chart', narration: 'n', headline: 'h', env, style: 'lottie' })).toMatch(/DRAWING STYLE: Motion graphics \(Lottie\)[\s\S]*env\.motionGraphics/)
    expect(usesPeeps("const a = env.peep('a', {})")).toBe(true)
    expect(usesLottie('env.motionGraphics("m", s => {})')).toBe(true)
    expect(uses3d("env.character('hero', {})")).toBe(true)
    expect(usesPeeps('function draw(ctx, t, env) {}')).toBe(false)
  })
})

// --- real renders (Chrome) -----------------------------------------------------------------------------------------

let chrome = false

describe('real renders', () => {
  const env: DrawingEnv = { width: 640, height: 360, duration: 3, fps: 30, words: [{ w: 'Hello', start: 0.5, end: 0.9 }, { w: 'there', start: 1.0, end: 1.4 }], palette: { canvas: '#f4efe6', accent: '#ff5a36', ink: '#1d1d1f' }, fonts: { headline: 'Inter', body: 'Inter' } }
  beforeAll(async () => {
    await setup()
    chrome = !!ctx().config.chromePath && fs.existsSync(ctx().config.chromePath!)
  })
  const at = (jpg: Buffer) => jpg.length

  it('a Lottie scene: lottie-web draws the shapes, the text is drawn in its font, and it moves', async ({ skip }) => {
    if (!chrome) skip()
    const code = `function draw(ctx, t, env) {
      ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, env.W, env.H);
      const m = env.motionGraphics('main', (s) => {
        s.circle({ x: 160, y: 180, r: 70, fill: env.palette.accent }).pop(0.3);
        s.rect({ x: 430, y: 150, w: 260, h: 60, radius: 12, fill: '#1d1d1f' }).slideIn(0.8, 0.5);
        s.text('Hello', { x: 430, y: 150, size: 34, color: '#ffffff' }).fadeIn(1.0, 0.4);
        s.path([[300, 300], [400, 250], [560, 280]], { stroke: env.palette.accent, strokeWidth: 8, closed: false }).drawOn(1.5, 2.5);
      });
      m.render(ctx, t);
      if (t > 2.9) {
        const px = (x, y) => Array.from(ctx.getImageData(x, y, 1, 1).data).slice(0, 3).join(',');
        const white = (x0, y0, x1, y1) => { const d = ctx.getImageData(x0, y0, x1 - x0, y1 - y0).data; let n = 0; for (let i = 0; i < d.length; i += 4) if (d[i] > 200 && d[i + 1] > 200 && d[i + 2] > 200) n++; return n };
        if (px(160, 180) !== '255,90,54') throw new Error('no circle: ' + px(160, 180));
        if (white(360, 135, 500, 165) < 80) throw new Error('no text on the bar');
        if (px(400, 251) === '255,255,255' && px(399, 252) === '255,255,255') throw new Error('no line drawn on');
      }
    }`
    const [a, b, c] = await testDrawing(code, env, [0.1, 1.6, 2.95])
    expect(a.equals(b)).toBe(false)
    expect(b.equals(c)).toBe(false)
    expect(at(c)).toBeGreaterThan(1000)
  }, 180_000)

  it('an Open Peeps character: drawn, talking on the words, then walking; a wrong name lists the right ones', async ({ skip }) => {
    if (!chrome) skip()
    const code = `function draw(ctx, t, env) {
      ctx.fillStyle = env.palette.canvas; ctx.fillRect(0, 0, env.W, env.H);
      const sam = env.peep('sam', { body: 'Resting', face: 'Smile', hair: 'Afro', x: 200, y: 340, height: 300 });
      if (!sam.o.ready) { sam.o.ready = true; sam.talk(0, 1.5).walk(1.8, 2.8, 460) }
      sam.draw(ctx, t);
    }`
    const [shut, open, walked] = await testDrawing(code, env, [0.2, 0.7, 2.9])
    // the mouth is open on "Hello" (0.5-0.9 s) and shut before it: the frames differ
    expect(shut.equals(open)).toBe(false)
    expect(walked.equals(open)).toBe(false)
    const bad = `function draw(ctx, t, env) { env.peep('x', { body: 'Skating' }).draw(ctx, t) }`
    await expect(testDrawing(bad, env, [0])).rejects.toThrow(/unknown standing "Skating" \(try: BlazerBW/)
  }, 180_000)

  it('a rigged 3D character walks and waves on the lit stage', async ({ skip }) => {
    if (!chrome) skip()
    const code = `function draw(ctx, t, env) {
      ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, env.W, env.H);
      const s = env.stage3d('main', (THREE, st) => { const hero = env.character('hero', { height: 1.7 }); st.add(hero.group); hero.group.scale.setScalar(1.6); hero.walk(0).wave(1.0, { dur: 1.2 }); return { hero }; });
      s.parts.hero.update(t);
      s.render(ctx);
    }`
    const [a, b] = await testDrawing(code, { ...env, duration: 2 }, [0.3, 1.5])
    expect(a.equals(b)).toBe(false)
  }, 300_000)
})
