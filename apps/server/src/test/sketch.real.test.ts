// Sketch it in, for real: a frame of the demo city clip sketched in each medium in the drawing sandbox (anidoodle's
// marks and photo fields, our tracing). Checks that it starts on bare paper, that lines go down and grow, that the
// colour ending ends on the picture, and that a frame is the same picture however the frames before it went.
// Runs only with REAL_RENDER=1 (needs the export's Chrome); SKETCH_SHEET=<dir> keeps the frames for a person to look at,
// SKETCH_PICTURE=<file> sketches another picture.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import sharp from 'sharp'
import { beforeAll, describe, expect, it } from 'vitest'
import type { SketchStyleId } from '@producer/core'
import { type DrawingEnv, renderDrawing, testDrawing } from '../media/drawing'
import { ffmpeg } from '../media/proc'
import { SKETCH_MEDIA, sketchCode, sketchFrame } from '../media/sketch'
import { setup } from './helpers'

const REAL = process.env.REAL_RENDER === '1'
const CLIP = path.resolve(__dirname, '../../../web/public/demo/clip-city.mp4')
let dir = ''
let picture = ''
let size = { width: 0, height: 0 }

beforeAll(async () => {
  if (!REAL) return
  await setup()
  dir = process.env.SKETCH_SHEET || fs.mkdtempSync(path.join(os.tmpdir(), 'ps-sketch-'))
  fs.mkdirSync(dir, { recursive: true })
  // SKETCH_PICTURE=<file> sketches that picture instead of the demo clip's frame
  const png = process.env.SKETCH_PICTURE || path.join(dir, 'picture.png')
  if (!process.env.SKETCH_PICTURE) await ffmpeg(['-ss', '2', '-i', CLIP, '-frames:v', '1', png])
  const jpg = await sharp(png).jpeg({ quality: 90 }).toBuffer({ resolveWithObject: true })
  picture = `data:image/jpeg;base64,${jpg.data.toString('base64')}`
  // a smaller frame than the job's (same shape) keeps the test quick
  const f = sketchFrame(jpg.info.width, jpg.info.height)
  size = { width: Math.round(f.width / 2 / 2) * 2, height: Math.round(f.height / 2 / 2) * 2 }
}, 120_000)

const envFor = (style: SketchStyleId, duration: number): DrawingEnv => ({
  ...size,
  duration,
  fps: 30,
  words: [],
  palette: { canvas: SKETCH_MEDIA[style].paper, ink: SKETCH_MEDIA[style].ink, accent: SKETCH_MEDIA[style].ink },
  fonts: { headline: 'Inter', body: 'Inter' },
  images: { picture },
})

/** How far a frame is from plain paper: the share of pixels more than 40 levels away from the paper colour. */
async function inked(jpeg: Buffer, paper: string): Promise<number> {
  const { data, info } = await sharp(jpeg).raw().toBuffer({ resolveWithObject: true })
  const p = [1, 3, 5].map((i) => parseInt(paper.slice(i, i + 2), 16))
  let n = 0
  for (let i = 0; i < data.length; i += info.channels) if (Math.abs(data[i] - p[0]) + Math.abs(data[i + 1] - p[1]) + Math.abs(data[i + 2] - p[2]) > 120) n++
  return n / (info.width * info.height)
}

describe.skipIf(!REAL)('Sketch it in, rendered', () => {
  for (const style of ['pencil', 'ink', 'charcoal', 'chalk'] as const) {
    it(`sketches the picture in ${style}`, async () => {
      const env = envFor(style, 6)
      const times = [0.05, 1.2, 2.4, 3.6, 5.95]
      const frames = await testDrawing(sketchCode({ style, colour: true }), env, times)
      frames.forEach((f, i) => fs.writeFileSync(path.join(dir, `${style}-${i}.jpg`), f))
      const ink = await Promise.all(frames.map((f) => inked(f, SKETCH_MEDIA[style].paper)))
      console.log(style, ink.map((v) => v.toFixed(3)).join(' '))
      // bare paper first, then more and more lines, and the picture at the end
      expect(ink[0]).toBeLessThan(0.02)
      expect(ink[1]).toBeGreaterThan(ink[0])
      expect(ink[2]).toBeGreaterThan(ink[1])
      expect(ink[3]).toBeGreaterThanOrEqual(ink[2] * 0.9)
      expect(ink[4]).toBeGreaterThan(0.2)
    }, 300_000)
  }

  it('draws the same frame whatever came before it', async () => {
    const env = envFor('pencil', 5)
    const code = sketchCode({ style: 'pencil', colour: false })
    // every frame in order, against a page that jumps straight to the late frames
    const inOrder = await testDrawing(code, env, [2.5, 4.9])
    const late = await testDrawing(code, { ...env, duration: 5 }, [4.9, 2.5])
    const a = await sharp(inOrder[0]).raw().toBuffer()
    const b = await sharp(late[1]).raw().toBuffer()
    let diff = 0
    for (let i = 0; i < a.length; i++) diff = Math.max(diff, Math.abs(a[i] - b[i]))
    expect(diff).toBeLessThan(24)
  }, 300_000)

  it('renders a clip', async () => {
    const out = path.join(dir, 'pencil.mp4')
    await renderDrawing(sketchCode({ style: 'pencil', colour: true }), envFor('pencil', 4), out)
    expect(fs.statSync(out).size).toBeGreaterThan(20_000)
  }, 300_000)
})
