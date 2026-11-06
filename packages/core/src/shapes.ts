// Shapes drawn as SVG paths (tracker #8): triangle, polygon, star, arrow and speech bubble, in the item's own box
// (0..width × 0..height) so they stretch with it like the rectangle and ellipse do. The runtime draws them the same
// way in the preview and the export; rectangle, ellipse and line stay CSS.
import type { ShapeItem } from './types'

export type PathShape = 'triangle' | 'polygon' | 'star' | 'arrow' | 'bubble'
export const PATH_SHAPES: readonly PathShape[] = ['triangle', 'polygon', 'star', 'arrow', 'bubble']
export const isPathShape = (s: ShapeItem['shape']): s is PathShape => (PATH_SHAPES as readonly string[]).includes(s)

const r2 = (n: number) => Math.round(n * 100) / 100

function ring(w: number, h: number, n: number, inner?: number): string {
  const pts: string[] = []
  const count = inner !== undefined ? n * 2 : n
  for (let i = 0; i < count; i++) {
    const a = -Math.PI / 2 + (i * 2 * Math.PI) / count
    const k = inner !== undefined && i % 2 === 1 ? inner : 1
    pts.push(`${r2(w / 2 + (w / 2) * k * Math.cos(a))} ${r2(h / 2 + (h / 2) * k * Math.sin(a))}`)
  }
  return `M ${pts.join(' L ')} Z`
}

/** The outline of a path shape in its box. `points`: a polygon's sides (3-12), a star's points (3-12). */
export function shapePath(shape: PathShape, w: number, h: number, points?: number): string {
  const n = Math.max(3, Math.min(12, Math.round(points ?? (shape === 'star' ? 5 : 6))))
  switch (shape) {
    case 'triangle':
      return `M ${r2(w / 2)} 0 L ${r2(w)} ${r2(h)} L 0 ${r2(h)} Z`
    case 'polygon':
      return ring(w, h, n)
    case 'star':
      return ring(w, h, n, 0.45)
    case 'arrow': {
      // a shaft half the box high, a head the last third of its length
      const head = Math.min(w * 0.4, h * 1.2)
      return `M 0 ${r2(h * 0.3)} L ${r2(w - head)} ${r2(h * 0.3)} L ${r2(w - head)} 0 L ${r2(w)} ${r2(h / 2)} L ${r2(w - head)} ${r2(h)} L ${r2(w - head)} ${r2(h * 0.7)} L 0 ${r2(h * 0.7)} Z`
    }
    case 'bubble': {
      // a rounded box over the top four fifths, a tail down from its lower left
      const b = h * 0.8
      const r = Math.min(w, b) * 0.18
      return (
        `M ${r2(r)} 0 L ${r2(w - r)} 0 Q ${r2(w)} 0 ${r2(w)} ${r2(r)} L ${r2(w)} ${r2(b - r)} Q ${r2(w)} ${r2(b)} ${r2(w - r)} ${r2(b)} ` +
        `L ${r2(w * 0.38)} ${r2(b)} L ${r2(w * 0.2)} ${r2(h)} L ${r2(w * 0.24)} ${r2(b)} L ${r2(r)} ${r2(b)} Q 0 ${r2(b)} 0 ${r2(b - r)} L 0 ${r2(r)} Q 0 0 ${r2(r)} 0 Z`
      )
    }
  }
}

/** The SVG that draws a path shape: fill and an inside border that keeps its width however the box is stretched. */
export function shapeSvg(s: Pick<ShapeItem, 'shape' | 'width' | 'height' | 'points' | 'stroke'>, fill: string, stroke?: string): string {
  if (!isPathShape(s.shape)) return ''
  const w = Math.max(1, s.width)
  const h = Math.max(1, s.height)
  const sw = s.stroke && stroke ? Math.max(0, s.stroke.width) : 0
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="100%" height="100%" viewBox="${-sw / 2} ${-sw / 2} ${w + sw} ${h + sw}" preserveAspectRatio="none" style="display:block;overflow:visible">` +
    `<path d="${shapePath(s.shape, w, h, s.points)}" fill="${fill}"${sw ? ` stroke="${stroke}" stroke-width="${r2(sw)}" stroke-linejoin="round"` : ''}/></svg>`
  )
}
