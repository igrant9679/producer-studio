// AI-drawn scenes, for real: the locally signed-in Claude Code CLI (the desktop edition's provider) writes the drawing
// code, the sandbox renders it, and a contact sheet of the clip is written for a person to look at (DRAWN_SHEET=<file>).
// Runs only with REAL_DRAW=1 (it uses the CLI's subscription and takes a few minutes). DRAWN_STYLE=<id> draws them in a
// drawing style (core's DRAWING_STYLES), DRAWN_ONLY=<name> draws one scene. DRAWN_FILM=1 draws two scenes of one silent
// story instead, the second shown the first's code, to look at whether its characters and colours stay the same.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { ClaudeCliProvider } from '../ai/cli'
import { drawingPalette, writeDrawing } from '../ai/drawn'
import { drawingStyleOf } from '@producer/core'
import { syntheticTranscript } from '../ai/produce'
import { type DrawingEnv, renderDrawing, testDrawing } from '../media/drawing'
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

describe.skipIf(!REAL || process.env.DRAWN_FILM === '1')('AI-drawn scenes, drawn and rendered', () => {
  const style = drawingStyleOf(process.env.DRAWN_STYLE)
  for (const sc of SCENES.filter((s) => !process.env.DRAWN_ONLY || s.name === process.env.DRAWN_ONLY)) {
    it(`draws “${sc.name}”`, async () => {
      const voice = 0.5
      const t = syntheticTranscript(sc.narration, sc.narration.split(/\s+/).length / 2.6)
      const words = t.segments.flatMap((s) => s.words ?? []).map((w) => ({ w: w.w, start: voice + w.start }))
      const env: DrawingEnv = {
        ...sc.size,
        fps: 30,
        duration: (words.at(-1)?.start ?? 4) + 1.8,
        words,
        palette: drawingPalette(style, { canvas: '#14161f', accent: '#ff6b4a', ink: '#f4f1ea' }),
        fonts: { headline: 'Montserrat', body: 'Inter' },
      }
      const made = await writeDrawing(new ClaudeCliProvider(), { description: sc.description, narration: sc.narration, headline: sc.headline, env, style, progress: (_f, m) => console.log(sc.name, m) })
      fs.writeFileSync(path.join(dir, `${sc.name}.js`), made.code)
      const file = path.join(dir, `${sc.name}.mp4`)
      await renderDrawing(made.code, env, file)
      const shots = [0.12, 0.3, 0.48, 0.66, 0.84, 0.98].map((k) => k * env.duration)
      for (const [i, at] of shots.entries()) await ffmpeg(['-ss', at.toFixed(2), '-i', file, '-frames:v', '1', '-vf', `scale=${sc.size.width > sc.size.height ? 480 : 270}:-2`, path.join(dir, `${sc.name}-${i}.png`)])
      const sheet = path.join(process.env.DRAWN_SHEET || dir, `drawn-${sc.name}-${style}.png`)
      await ffmpeg(['-framerate', '1', '-i', path.join(dir, `${sc.name}-%d.png`), '-vf', `tile=${sc.size.width > sc.size.height ? '3x2' : '6x1'}:padding=6:color=white`, '-frames:v', '1', sheet])
      console.log(JSON.stringify({ plan: made.plan, code: path.join(dir, `${sc.name}.js`), clip: file, sheet }))
      expect(fs.statSync(file).size).toBeGreaterThan(10_000)
    }, 1_200_000)
  }
})

// Two scenes of one story (the scenes a real video on production was made from), nobody speaking, no words on screen.
const FILM = [
  {
    name: 'film-1-meeting',
    narration: 'A small orange fox wanders alone through a glowing forest. Beneath a tall tree sits a tiny blue bird, head down. The fox steps closer, tilts its head, and smiles.',
    description:
      "A forest floor with rounded trees and soft beams of light. On 'wanders alone', a small orange fox walks in from the left, the camera tracking beside it at its eye level. On 'tiny blue bird', the camera eases ahead to reveal a little blue bird sitting still beneath a large tree, its head drooping. On 'steps closer', the fox slows and takes three careful steps toward the bird. On 'tilts its head', the fox tilts its head to one side; the camera pushes into a gentle close-up of both faces as the fox's mouth curves into a smile and the bird lifts its head to look up.",
  },
  {
    name: 'film-2-storm',
    narration: 'Dark clouds roll in and heavy rain falls. The little bird struggles to fly. The fox runs to a great tree and curls around its friend, keeping it dry.',
    description:
      "The meadow from a wide angle. On 'dark clouds roll in', heavy grey clouds slide across the sky and the light dims. On 'heavy rain falls', streaks of rain sweep down across the scene. On 'struggles to fly', the blue bird flaps hard, rises a little, then drops low, wings drooping. On 'runs to a great tree', the fox dashes toward a huge tree with a wide canopy and the camera follows low and fast. On 'curls around its friend', the fox settles beneath the branches and wraps its body and tail around the bird; the camera slowly moves in as rain keeps falling just beyond the canopy's edge.",
  },
]

describe.skipIf(!REAL || process.env.DRAWN_FILM !== '1')('two scenes of one film', () => {
  const style = drawingStyleOf(process.env.DRAWN_STYLE)
  it('the second scene is shown the first, and keeps its characters', async () => {
    let reference: string | undefined
    for (const sc of FILM) {
      const env: DrawingEnv = {
        width: 1280,
        height: 720,
        fps: 30,
        duration: sc.narration.split(/\s+/).length / 2.6 + 2.1,
        words: [],
        palette: drawingPalette(style, { canvas: '#14161f', accent: '#ff6b4a', ink: '#f4f1ea' }),
        fonts: { headline: 'Montserrat', body: 'Inter' },
      }
      // a scene written on an earlier run (its code saved next to the sheets) is rendered again as it is
      const saved = process.env.DRAWN_SHEET ? path.join(process.env.DRAWN_SHEET, `${sc.name}.js`) : ''
      const made =
        saved && fs.existsSync(saved)
          ? { code: fs.readFileSync(saved, 'utf8'), plan: '(saved code)' }
          : await writeDrawing(new ClaudeCliProvider(), { description: sc.description, narration: sc.narration, headline: '', env, style, silent: true, noWords: true, reference, progress: (_f, m) => console.log(sc.name, m) })
      reference ??= made.code
      fs.writeFileSync(saved || path.join(dir, `${sc.name}.js`), made.code)
      // six frames across the scene are enough to look at (a whole 3D clip is more than a small machine renders)
      const shots = [0.08, 0.26, 0.44, 0.62, 0.8, 0.97].map((k) => k * env.duration)
      const frames = await testDrawing(made.code, env, shots)
      for (const [i, jpg] of frames.entries()) fs.writeFileSync(path.join(dir, `${sc.name}-${i}.jpg`), jpg)
      const sheet = path.join(process.env.DRAWN_SHEET || dir, `drawn-${sc.name}-${style}.png`)
      await ffmpeg(['-y', '-framerate', '1', '-i', path.join(dir, `${sc.name}-%d.jpg`), '-vf', 'scale=480:-2,tile=3x2:padding=6:color=white', '-frames:v', '1', sheet])
      console.log(JSON.stringify({ plan: made.plan, sheet }))
      expect(fs.statSync(sheet).size).toBeGreaterThan(10_000)
    }
  }, 3_600_000)
})
