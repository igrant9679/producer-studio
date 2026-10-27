// One tooltip layer for the whole app (added 23 Oct 2026). Any element opts in with attributes:
//   data-tip="Split"  data-tip-desc="Cut the selected clip in two at the playhead"  data-tip-kbd="Ctrl+B"
//   data-tip-side="right|left|top|bottom"   (default: below, or above when there's no room)
// Native `title` tooltips are slow, unstyled, can't carry a description, and don't show on disabled buttons in
// some browsers. This listens once on the document, so existing buttons only gain attributes — no wrappers.
// Moving between neighbours shows the next tip at once (no second delay), like a toolbar should.
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

type Side = 'top' | 'bottom' | 'left' | 'right'
interface Tip {
  title: string
  desc?: string
  kbd?: string
  rect: DOMRect
  side?: Side
}

const SHOW_DELAY = 350
const WARM_MS = 600

/** The element already shows this text as its label (the sidebar when it isn't collapsed): a tip would only repeat it. */
function labelShowing(el: Element, title: string): boolean {
  const label = el.querySelector('.ps-nav-text')
  return label instanceof HTMLElement && getComputedStyle(label).display !== 'none' && label.textContent?.trim() === title.trim()
}

function tipFrom(el: Element): Tip | null {
  const title = el.getAttribute('data-tip')
  if (!title || labelShowing(el, title)) return null
  return {
    title,
    desc: el.getAttribute('data-tip-desc') || undefined,
    kbd: el.getAttribute('data-tip-kbd') || undefined,
    side: (el.getAttribute('data-tip-side') as Side | null) || undefined,
    rect: el.getBoundingClientRect(),
  }
}

export function TooltipLayer() {
  const [tip, setTip] = useState<Tip | null>(null)
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)
  const boxRef = useRef<HTMLDivElement>(null)
  const state = useRef<{ el: Element | null; timer?: number; hiddenAt: number }>({ el: null, hiddenAt: 0 })

  useEffect(() => {
    const s = state.current
    const hide = () => {
      window.clearTimeout(s.timer)
      if (s.el) s.hiddenAt = Date.now()
      s.el = null
      setTip(null)
    }
    const over = (e: PointerEvent) => {
      if (e.pointerType === 'touch') return
      const el = (e.target as Element | null)?.closest?.('[data-tip]') ?? null
      if (el === s.el) return
      window.clearTimeout(s.timer)
      if (!el) return hide()
      if (s.el) s.hiddenAt = Date.now()
      s.el = el
      setTip(null)
      const warm = Date.now() - s.hiddenAt < WARM_MS
      s.timer = window.setTimeout(() => {
        if (s.el === el && el.isConnected) setTip(tipFrom(el))
      }, warm ? 0 : SHOW_DELAY)
    }
    const leaveDoc = (e: PointerEvent) => {
      if (!e.relatedTarget) hide()
    }
    document.addEventListener('pointerover', over)
    document.addEventListener('pointerout', leaveDoc)
    document.addEventListener('pointerdown', hide, true)
    document.addEventListener('keydown', hide, true)
    window.addEventListener('scroll', hide, true)
    window.addEventListener('blur', hide)
    return () => {
      document.removeEventListener('pointerover', over)
      document.removeEventListener('pointerout', leaveDoc)
      document.removeEventListener('pointerdown', hide, true)
      document.removeEventListener('keydown', hide, true)
      window.removeEventListener('scroll', hide, true)
      window.removeEventListener('blur', hide)
      window.clearTimeout(s.timer)
    }
  }, [])

  // place after render, when the box's size is known; keep it on screen
  useEffect(() => {
    if (!tip || !boxRef.current) return setPos(null)
    const b = boxRef.current.getBoundingClientRect()
    const r = tip.rect
    const gap = 8
    const vw = window.innerWidth
    const vh = window.innerHeight
    let side: Side = tip.side ?? 'bottom'
    if (side === 'bottom' && r.bottom + gap + b.height > vh) side = 'top'
    if (side === 'top' && r.top - gap - b.height < 0) side = 'bottom'
    if (side === 'right' && r.right + gap + b.width > vw) side = 'left'
    if (side === 'left' && r.left - gap - b.width < 0) side = 'right'
    let left = side === 'right' ? r.right + gap : side === 'left' ? r.left - gap - b.width : r.left + r.width / 2 - b.width / 2
    let top = side === 'bottom' ? r.bottom + gap : side === 'top' ? r.top - gap - b.height : r.top + r.height / 2 - b.height / 2
    left = Math.max(6, Math.min(vw - b.width - 6, left))
    top = Math.max(6, Math.min(vh - b.height - 6, top))
    setPos({ left, top })
  }, [tip])

  if (!tip) return null
  return createPortal(
    <div
      ref={boxRef}
      className="ps-tip"
      role="tooltip"
      style={pos ? { left: pos.left, top: pos.top } : { left: -9999, top: -9999, visibility: 'hidden' }}
    >
      <div className="ps-tip-head">
        <b>{tip.title}</b>
        {tip.kbd && <kbd>{tip.kbd}</kbd>}
      </div>
      {tip.desc && <div className="ps-tip-desc">{tip.desc}</div>}
    </div>,
    document.body,
  )
}

/** Spread onto an element: `<button {...tipProps('Split', 'Cut at the playhead', 'Ctrl+B')}>`. */
export function tipProps(title: string, desc?: string, kbd?: string, side?: Side): Record<string, string> {
  const p: Record<string, string> = { 'data-tip': title, 'aria-label': kbd ? `${title} (${kbd})` : title }
  if (desc) p['data-tip-desc'] = desc
  if (kbd) p['data-tip-kbd'] = kbd
  if (side) p['data-tip-side'] = side
  return p
}
