// Text effects library: looks made from the text style's own outline, shadow, glow, box and gradient, sized from the
// font size so they hold on any canvas. Applying one replaces the decoration the text had and keeps its font.
import type { TextStyle } from './types'
import { round } from './util'

export interface TextEffect {
  id: string
  name: string
  /** The decoration for a style at its font size (colours may come from the style). */
  make: (s: TextStyle) => Partial<TextStyle>
}

const k = (s: TextStyle, f: number) => round(s.fontSize * f, 2)

export const TEXT_EFFECTS: TextEffect[] = [
  { id: 'plain', name: 'Plain', make: () => ({}) },
  { id: 'outline', name: 'Outline', make: (s) => ({ stroke: { color: '#000000', width: k(s, 0.06) } }) },
  { id: 'hollow', name: 'Hollow', make: (s) => ({ color: 'transparent', stroke: { color: s.color === 'transparent' ? '#ffffff' : s.color, width: k(s, 0.035) } }) },
  { id: 'shadow', name: 'Soft shadow', make: (s) => ({ shadow: { color: 'rgba(0,0,0,0.6)', blur: k(s, 0.14), x: 0, y: k(s, 0.05) } }) },
  { id: 'drop', name: 'Pop shadow', make: (s) => ({ shadow: { color: '#000000', blur: 0, x: k(s, 0.06), y: k(s, 0.06) } }) },
  { id: 'glow', name: 'Glow', make: (s) => ({ glow: { color: s.color === 'transparent' ? '#ffffff' : s.color, blur: k(s, 0.25) } }) },
  { id: 'neon', name: 'Neon', make: (s) => ({ color: '#fff4fd', glow: { color: '#ff2bd6', blur: k(s, 0.3) }, stroke: { color: '#ff7be6', width: k(s, 0.012) } }) },
  { id: 'gradient', name: 'Sunset', make: () => ({ gradient: { from: '#ffd84d', to: '#ff4f8b', angle: 90 } }) },
  { id: 'ocean', name: 'Ocean', make: () => ({ gradient: { from: '#35e0ff', to: '#7950f2', angle: 135 } }) },
  { id: 'chrome', name: 'Chrome', make: (s) => ({ gradient: { from: '#ffffff', to: '#8d97a8', angle: 180 }, stroke: { color: '#2a2f3a', width: k(s, 0.02) } }) },
  { id: 'highlight', name: 'Highlight', make: (s) => ({ color: '#111111', background: { color: '#ffe14d', radius: k(s, 0.14), padding: k(s, 0.24), opacity: 1 } }) },
  { id: 'retro', name: 'Retro', make: (s) => ({ color: '#ffd84d', stroke: { color: '#2b1a4a', width: k(s, 0.05) }, shadow: { color: '#ff4f8b', blur: 0, x: k(s, 0.07), y: k(s, 0.07) } }) },
]

/** `style` with an effect's decoration in place of the old one (outline, shadow, glow, box, gradient). */
export function applyTextEffect(style: TextStyle, id: string): TextStyle {
  const fx = TEXT_EFFECTS.find((e) => e.id === id)
  const { stroke: _s, shadow: _h, glow: _g, background: _b, gradient: _r, ...rest } = style
  const base: TextStyle = { ...rest }
  // an effect that had made the letters see-through hands back a fill
  if (base.color === 'transparent') base.color = '#ffffff'
  return fx ? { ...base, ...fx.make(base) } : base
}
