// The looks an AI-drawn scene can be drawn in (the brief's `drawingStyle`), and the looks of a picture sketched in
// (the editor's Smart tab). The server holds the recipes the AI follows (ai/drawn.ts) and the sketch's media
// (media/sketch.ts); the media themselves are anidoodle's (Apache-2.0, apps/server/vendor/anidoodle).

export const DRAWING_STYLES = [
  { id: 'clean', label: 'Clean and simple', about: 'Flat shapes with outlines, in your brand colours' },
  { id: 'sketchbook', label: 'Pencil sketch', about: 'Graphite lines and hatching on cream paper' },
  { id: 'watercolour', label: 'Pencil and watercolour', about: 'Soft washes of colour under a pencil line' },
  { id: 'ink', label: 'Ink and wash', about: 'A pen line with grey washes and one colour' },
  { id: 'storybook', label: 'Storybook', about: 'Rounded, softly lit painted shapes, like a picture book' },
  { id: 'riso', label: 'Risograph print', about: 'Two inks printed a little off register, with halftone dots' },
  { id: 'halftone', label: 'Newsprint', about: 'Black and one spot colour in printed dots' },
  { id: 'blueprint', label: 'Blueprint', about: 'White lines on blue paper, like a technical drawing' },
  { id: 'chalkboard', label: 'Chalkboard', about: 'Chalk on a dark slate' },
  { id: 'whiteboard', label: 'Whiteboard', about: 'Marker drawn on a whiteboard as it is explained' },
] as const

export type DrawingStyleId = (typeof DRAWING_STYLES)[number]['id']

export const DEFAULT_DRAWING_STYLE: DrawingStyleId = 'clean'

/** A known style id, or the default (an old or mistyped value draws as before). */
export function drawingStyleOf(v: unknown): DrawingStyleId {
  return DRAWING_STYLES.some((s) => s.id === v) ? (v as DrawingStyleId) : DEFAULT_DRAWING_STYLE
}

/** How a picture is sketched in: the medium it is drawn with. */
export const SKETCH_STYLES = [
  { id: 'pencil', label: 'Pencil', about: 'Graphite on cream paper' },
  { id: 'ink', label: 'Ink', about: 'A fine black pen on white paper' },
  { id: 'charcoal', label: 'Charcoal', about: 'Broad, soft strokes on toothy paper' },
  { id: 'chalk', label: 'Chalk', about: 'White chalk on a dark slate' },
] as const

export type SketchStyleId = (typeof SKETCH_STYLES)[number]['id']

/** The sketch's length: at least long enough to see it drawn, at most what one job renders comfortably. */
export const SKETCH_SECONDS = { min: 3, max: 30, default: 8 } as const
