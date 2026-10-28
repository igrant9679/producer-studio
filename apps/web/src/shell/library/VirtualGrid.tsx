// A card grid that draws only the rows in view once a library is big (A-15). Small libraries render as a plain CSS
// grid; where the size can't be measured (tests, a hidden tab) everything is drawn.
import clsx from 'clsx'
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { gridColumns, windowRows } from '../pages/libraryLogic'

/** Above this many cards the grid is windowed. */
export const VIRTUAL_FROM = 120
const MIN_COL = 220
const GAP = 18

function scrollParent(el: HTMLElement | null): HTMLElement | null {
  return (el?.closest('.ps-content') as HTMLElement | null) ?? null
}

/** Move focus between cards with the arrow keys (by a row up and down), Home and End. */
export function moveCardFocus(e: KeyboardEvent<HTMLElement>, cols: number) {
  const card = (e.target as HTMLElement).closest<HTMLElement>('[data-card]')
  if (!card || card !== e.target) return
  const all = [...e.currentTarget.querySelectorAll<HTMLElement>('[data-card]')]
  const i = all.indexOf(card)
  const step = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : e.key === 'ArrowDown' ? cols : e.key === 'ArrowUp' ? -cols : 0
  let to = -1
  if (step) to = Math.min(all.length - 1, Math.max(0, i + step))
  else if (e.key === 'Home') to = 0
  else if (e.key === 'End') to = all.length - 1
  if (to < 0 || to === i) return
  e.preventDefault()
  all[to].focus()
  all[to].scrollIntoView?.({ block: 'nearest' })
}

export function VirtualGrid<T>({ items, keyOf, render, className, label, onKeyDown }: {
  items: T[]
  keyOf: (t: T) => string
  render: (t: T) => ReactNode
  className?: string
  label?: string
  onKeyDown?: (e: KeyboardEvent<HTMLDivElement>, cols: number) => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [box, setBox] = useState({ width: 0, scrollTop: 0, viewport: 0, top: 0 })
  const [rowHeight, setRowHeight] = useState(0)
  const big = items.length > VIRTUAL_FROM

  useLayoutEffect(() => {
    const el = ref.current
    const sp = scrollParent(el)
    if (!el || !sp) return
    const measure = () => {
      const r = el.getBoundingClientRect()
      const s = sp.getBoundingClientRect()
      setBox({ width: el.clientWidth, scrollTop: sp.scrollTop, viewport: sp.clientHeight, top: r.top - s.top + sp.scrollTop })
    }
    measure()
    sp.addEventListener('scroll', measure, { passive: true })
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : undefined
    ro?.observe(el)
    ro?.observe(sp)
    return () => {
      sp.removeEventListener('scroll', measure)
      ro?.disconnect()
    }
  }, [big])

  const cols = box.width ? gridColumns(box.width, MIN_COL, GAP) : 1
  const windowed = big && box.width > 0 && box.viewport > 0
  // a row's height from the first one drawn (cards are as tall as their width makes them)
  useEffect(() => {
    if (!windowed) return
    const first = ref.current?.querySelector<HTMLElement>('[data-vrow]')
    if (first?.offsetHeight) setRowHeight(first.offsetHeight + GAP)
  }, [windowed, box.width, items.length])

  const est = rowHeight || Math.round(((box.width - GAP * (cols - 1)) / cols) * (9 / 16) + 70 + GAP)
  const w = windowed ? windowRows({ scrollTop: box.scrollTop, viewport: box.viewport, top: box.top, rowHeight: est, count: items.length, cols }) : { first: 0, last: items.length, padTop: 0, padBottom: 0 }
  const shown = items.slice(w.first, w.last)
  return (
    <div
      ref={ref}
      className={clsx('ps-grid', className)}
      role="list"
      aria-label={label}
      aria-rowcount={windowed ? Math.ceil(items.length / cols) : undefined}
      style={windowed ? { gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`, paddingTop: w.padTop, paddingBottom: w.padBottom } : undefined}
      onKeyDown={(e) => {
        onKeyDown?.(e, cols)
        if (!e.defaultPrevented) moveCardFocus(e, cols)
      }}
    >
      {shown.map((t, i) => (
        <div key={keyOf(t)} role="listitem" className="ps-vcell" {...(i === 0 ? { 'data-vrow': '' } : {})}>
          {render(t)}
        </div>
      ))}
    </div>
  )
}
