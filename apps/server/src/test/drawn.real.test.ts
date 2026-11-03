// AI-drawn scenes, for real: the locally signed-in Claude Code CLI (the desktop edition's provider) writes the drawing
// code, the sandbox renders it, and a contact sheet of the clip is written for a person to look at (DRAWN_SHEET=<file>).
// Runs only with REAL_DRAW=1 (it uses the CLI's subscription and takes a few minutes).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { ClaudeCliProvider } from '../ai/cli'
import { writeDrawing } from '../ai/drawn'
import { syntheticTranscript } from '../ai/produce'
import { type DrawingEnv, renderDrawing } from '../media/drawing'
import { ffmpeg } from '../media/proc'
import { setup } from './helpers'

const REAL = process.env.REAL_DRAW === '1'
let dir = ''

beforeAll(async () => {
  if (!REAL) return
  await setup()
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-drawn-'))
}, 120_000)

const SCENES = [
  {
    name: 'seed',
    size: { width: 1280, height: 720 },
    headline: 'Small ideas grow',
    narration: 'Plant one small idea, let it grow with care, and the results will follow.',
    description: 'A seed drops into a mound of soil on "plant", a sprout pushes up and becomes a young tree on "grow" (gentle hand-drawn lines that boil), three apples pop onto the branches on "results".',
  },
  {
    name: 'parcel',
    size: { width: 720, height: 1280 },
    headline: 'Out the door in a day',
    narration: 'You order in the morning, we pack it by noon, and the van is at your door that evening.',
    description: 'Vertical. A phone shows a tap on "order", a smiling packer folds a box shut on "pack", a little delivery van drives in from the side and stops at a front door on "door". Flat shapes, hand-drawn outlines.',
  },
]

describe.skipIf(!REAL)('AI-drawn scenes, drawn and rendered', () => {
  for (const sc of SCENES) {
    it(`draws “${sc.name}”`, async () => {
      const voice = 0.5
      const t = syntheticTranscript(sc.narration, sc.narration.split(/\s+/).length / 2.6)
      const words = t.segments.flatMap((s) => s.words ?? []).map((w) => ({ w: w.w, start: voice + w.start }))
      const env: DrawingEnv = {
        ...sc.size,
        fps: 30,
        duration: (words.at(-1)?.start ?? 4) + 1.8,
        words,
        palette: { canvas: '#14161f', accent: '#ff6b4a', ink: '#f4f1ea' },
        fonts: { headline: 'Montserrat', body: 'Inter' },
      }
      const made = await writeDrawing(new ClaudeCliProvider(), { description: sc.description, narration: sc.narration, headline: sc.headline, env, progress: (_f, m) => console.log(sc.name, m) })
      fs.writeFileSync(path.join(dir, `${sc.name}.js`), made.code)
      const file = path.join(dir, `${sc.name}.mp4`)
      await renderDrawing(made.code, env, file)
      const shots = [0.12, 0.3, 0.48, 0.66, 0.84, 0.98].map((k) => k * env.duration)
      for (const [i, at] of shots.entries()) await ffmpeg(['-ss', at.toFixed(2), '-i', file, '-frames:v', '1', '-vf', `scale=${sc.size.width > sc.size.height ? 480 : 270}:-2`, path.join(dir, `${sc.name}-${i}.png`)])
      const sheet = path.join(process.env.DRAWN_SHEET || dir, `drawn-${sc.name}.png`)
      await ffmpeg(['-framerate', '1', '-i', path.join(dir, `${sc.name}-%d.png`), '-vf', `tile=${sc.size.width > sc.size.height ? '3x2' : '6x1'}:padding=6:color=white`, '-frames:v', '1', sheet])
      console.log(JSON.stringify({ plan: made.plan, code: path.join(dir, `${sc.name}.js`), clip: file, sheet }))
      expect(fs.statSync(file).size).toBeGreaterThan(10_000)
    }, 1_200_000)
  }
})
