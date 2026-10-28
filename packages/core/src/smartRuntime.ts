// The renderer's part of masks and chroma keys (E-21), shared by the preview and the export: the mask goes on the layer
// box as a CSS mask; the key is an SVG filter (kept in one hidden <svg> in the stage) on the clip's picture, before the
// layer's own colour filters. HyperFrames copies a video's filter onto the frame image it draws in its place.
import { keyFilterMarkup } from './key'
import type { FrameLayer } from './types'

/** CSS declarations a layer's wrapper gets for its mask ('' without one). */
export function smartWrapCss(layer: FrameLayer): string {
  const m = layer.smart?.mask
  if (!m) return ''
  return `-webkit-mask-image:${m};mask-image:${m};-webkit-mask-size:100% 100%;mask-size:100% 100%;-webkit-mask-repeat:no-repeat;mask-repeat:no-repeat;`
}

/** The filter id of an item's key (ids are the document's own, kept to safe characters). */
export function keyFilterId(itemId: string): string {
  return `ps-key-${itemId.replace(/[^A-Za-z0-9_-]/g, '_')}`
}

const drawn = new WeakMap<HTMLElement, Map<string, string>>()

/** The hidden <svg> holding the stage's key filters. */
function defsOf(root: HTMLElement): SVGSVGElement {
  let svg = root.querySelector(':scope > svg[data-ps-keys]') as SVGSVGElement | null
  if (!svg) {
    svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    svg.setAttribute('data-ps-keys', '1')
    svg.setAttribute('aria-hidden', 'true')
    svg.setAttribute('width', '0')
    svg.setAttribute('height', '0')
    svg.style.cssText = 'position:absolute;width:0;height:0;overflow:hidden;pointer-events:none'
    root.appendChild(svg)
  }
  return svg
}

/**
 * Key a layer's picture (and the still the export holds before its file starts), or take the key off. The filter is
 * written only when the key changes.
 */
export function applyKey(root: HTMLElement, layer: FrameLayer, targets: Array<HTMLElement | undefined>): void {
  const key = layer.smart?.key
  const id = keyFilterId(layer.itemId)
  if (key) {
    const markup = keyFilterMarkup(id, key)
    const seen = drawn.get(root) ?? new Map<string, string>()
    drawn.set(root, seen)
    const svg = defsOf(root)
    if (seen.get(id) !== markup || !svg.querySelector(`#${id}`)) {
      svg.querySelector(`#${id}`)?.remove()
      // parsed as SVG: innerHTML on an <svg> element makes SVG nodes
      const holder = document.createElementNS('http://www.w3.org/2000/svg', 'g')
      holder.innerHTML = markup
      const f = holder.firstElementChild
      if (f) svg.appendChild(f)
      seen.set(id, markup)
    }
  }
  const value = key ? `url(#${id})` : ''
  // (the renderer resets a picture's style when its crop changes: look at the style itself, not a note of it)
  for (const t of targets) if (t && t.style.filter.includes(id) !== !!key) t.style.filter = value
}
