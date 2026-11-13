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
  { id: 'clay3d', label: '3D clay', about: 'Soft, rounded 3D models like a clay or toy animation, warmly lit' },
  { id: 'studio3d', label: '3D studio', about: 'Glossy, polished 3D objects in a lit studio, like a product film' },
  { id: 'isometric3d', label: '3D isometric', about: 'A tidy little 3D world seen from above at an angle, for processes and systems' },
  { id: 'blender', label: 'Blender (cinematic 3D)', about: 'Full 3D scenes the AI builds, lights and animates in Blender, rendered on a graphics card: the most polished look, and the slowest' },
  { id: 'lottie', label: 'Motion graphics (Lottie)', about: 'Clean flat motion graphics — shapes, icons and text that slide, pop and draw on — built as real Lottie animations' },
] as const

export type DrawingStyleId = (typeof DRAWING_STYLES)[number]['id']

export const DEFAULT_DRAWING_STYLE: DrawingStyleId = 'clean'

/** The styles drawn in 3D (three.js in the drawing sandbox): slower to render, a lit, modelled look. */
export const is3dDrawingStyle = (id: string | undefined) => id === 'clay3d' || id === 'studio3d' || id === 'isometric3d'

/** Drawn in Blender (the AI writes a Blender script; this computer's Blender or a rented RunPod graphics card renders it). */
export const isBlenderStyle = (id: string | undefined) => id === 'blender'

/** Lottie motion graphics (the AI builds a Lottie animation, rendered in the drawing sandbox). */
export const isLottieStyle = (id: string | undefined) => id === 'lottie'

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
