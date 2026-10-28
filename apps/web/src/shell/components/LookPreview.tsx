// A built-in look played by the editor's own renderer (A-22): the preview is the project it starts, in the aspect and
// brand kit picked, made here on demand instead of a stored video. Still (a frame with the headline up) when not
// playing or when the person asked for reduced motion.
import type { Project } from '@producer/core'
import { StageRenderer, projectDuration } from '@producer/core'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'

/** The moment shown as a still: the title card with its headline in. */
export const LOOK_STILL_AT = 1.6

export function prefersReducedMotion(): boolean {
  try {
    return typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
  } catch {
    return false
  }
}

export function LookPreview({ doc, playing, className }: { doc: Project; playing: boolean; className?: string }) {
  const wrap = useRef<HTMLDivElement>(null)
  const stage = useRef<HTMLDivElement>(null)
  const renderer = useRef<StageRenderer | null>(null)
  const [width, setWidth] = useState(0)

  useLayoutEffect(() => {
    const el = wrap.current
    if (!el) return
    setWidth(el.clientWidth)
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => setWidth(el.clientWidth))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  useEffect(() => {
    const r = new StageRenderer(stage.current!, doc, { mode: 'preview', resolveUrl: () => '' })
    renderer.current = r
    r.render(LOOK_STILL_AT)
    return () => {
      renderer.current = null
      r.destroy()
    }
  }, [doc])

  useEffect(() => {
    const r = renderer.current
    if (!r) return
    if (!playing || prefersReducedMotion() || typeof requestAnimationFrame === 'undefined') {
      r.render(LOOK_STILL_AT)
      return
    }
    const length = Math.max(1, projectDuration(doc))
    const t0 = performance.now()
    let raf = 0
    const tick = (now: number) => {
      renderer.current?.render(((now - t0) / 1000) % length)
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [playing, doc])

  const k = width ? width / doc.width : 0
  return (
    <div ref={wrap} className={className} style={{ position: 'relative', overflow: 'hidden', aspectRatio: `${doc.width} / ${doc.height}`, background: doc.background }} aria-hidden="true" data-look-preview={doc.name}>
      <div ref={stage} style={{ position: 'absolute', left: 0, top: 0, width: doc.width, height: doc.height, transformOrigin: '0 0', transform: `scale(${k})` }} />
    </div>
  )
}
