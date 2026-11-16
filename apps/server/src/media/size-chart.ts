// A film's characters side by side at their true sizes relative to each other.
//
// Each character has its own reference picture, and fills it: a fox and a songbird are both "one character, head to
// foot". So nothing shows the clip model that the bird stands a quarter as high as the fox, and in a real film it came
// out the size of the fox's head in the two-shots and small again when it sat on the fox. This puts the pictures on one
// ground line, each cut to its character (the plain ground around it trimmed away) and scaled so the heights are in the
// proportion the script's cast gives (ScriptCharacter.heightCm). It is made here, from the pictures already painted, so
// the proportion is exact and the characters are the very ones in their own pictures; it is sent with each clip that
// shows them together, after their own pictures.
import sharp from 'sharp'

/** The tallest character's height in the chart, the space around the row, and between two characters (pixels). */
const TALLEST = 880
const MARGIN = 72
const GAP = 96
/** The smallest a character is drawn (a mouse beside a horse is still there to be seen). */
const SMALLEST = 28
/** The chart is never wider than this (a long row is scaled down whole). */
const MAX_WIDTH = 2600

export interface Placed {
  left: number
  top: number
  width: number
  height: number
}

/**
 * Where each character goes: `boxes` are the characters' own sizes in their pictures (pixels), `heights` how tall each
 * really stands (any unit, the same for all). Tallest first is not assumed; the row keeps the order given.
 */
export function chartLayout(boxes: Array<{ width: number; height: number }>, heights: number[]): { width: number; height: number; placed: Placed[] } {
  const most = Math.max(...heights)
  let sized = boxes.map((b, i) => {
    const h = Math.max(SMALLEST, Math.round((TALLEST * heights[i]) / most))
    return { width: Math.max(1, Math.round((b.width * h) / b.height)), height: h }
  })
  const rowWidth = () => sized.reduce((a, s) => a + s.width, 0) + GAP * (sized.length - 1) + MARGIN * 2
  if (rowWidth() > MAX_WIDTH) {
    const k = (MAX_WIDTH - MARGIN * 2 - GAP * (sized.length - 1)) / sized.reduce((a, s) => a + s.width, 0)
    sized = sized.map((s) => ({ width: Math.max(1, Math.round(s.width * k)), height: Math.max(1, Math.round(s.height * k)) }))
  }
  const tall = Math.max(...sized.map((s) => s.height))
  const height = tall + MARGIN * 2
  let left = MARGIN
  const placed = sized.map((s) => {
    // everyone stands on the same line
    const p = { left, top: MARGIN + tall - s.height, width: s.width, height: s.height }
    left += s.width + GAP
    return p
  })
  return { width: rowWidth(), height, placed }
}

/** A picture cut to what is in it: the plain ground around the character trimmed away (the whole picture when it can't be). */
async function cutOut(file: string): Promise<{ data: Buffer; width: number; height: number }> {
  try {
    // (a generous threshold: the ground of a painted picture is never one flat colour, and the soft shadow under the
    // feet goes with it, so everyone's feet end up on the line)
    const { data, info } = await sharp(file).trim({ threshold: 40 }).png().toBuffer({ resolveWithObject: true })
    // (a trim that leaves next to nothing found a speck, not the character)
    if (info.width >= 16 && info.height >= 16) return { data, width: info.width, height: info.height }
  } catch {
    /* nothing to trim (a picture of one colour), or not a picture sharp can cut: the whole picture stands in */
  }
  const { data, info } = await sharp(file).png().toBuffer({ resolveWithObject: true })
  return { data, width: info.width, height: info.height }
}

/**
 * Write the chart (a JPEG) for these characters, in this order: each one's reference picture and how tall it stands.
 * The ground is the colour of the first picture's own ground, so the cut-outs sit in it.
 */
export async function sizeChart(characters: Array<{ file: string; heightCm: number }>, outFile: string): Promise<void> {
  const cuts = await Promise.all(characters.map((c) => cutOut(c.file)))
  const layout = chartLayout(cuts, characters.map((c) => c.heightCm))
  const corner = await sharp(characters[0].file).extract({ left: 0, top: 0, width: 1, height: 1 }).removeAlpha().raw().toBuffer()
  const ground = { r: corner[0] ?? 217, g: corner[1] ?? 217, b: corner[2] ?? 217 }
  const parts = await Promise.all(cuts.map(async (c, i) => ({ input: await sharp(c.data).resize(layout.placed[i].width, layout.placed[i].height, { fit: 'fill' }).png().toBuffer(), left: layout.placed[i].left, top: layout.placed[i].top })))
  await sharp({ create: { width: layout.width, height: layout.height, channels: 3, background: ground } })
    .composite(parts)
    .jpeg({ quality: 90 })
    .toFile(outFile)
}
