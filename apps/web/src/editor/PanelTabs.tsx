// The Properties panel's tab row: a tablist (one tab stop; arrow keys, Home and End move and select) that scrolls
// sideways when its tabs don't fit (a phone, a big text size), fading on the side that has more and keeping the
// chosen tab in view.
import clsx from 'clsx'
import { useEffect, useLayoutEffect, useRef, type ReactNode } from 'react'

export const panelTabId = (id: string) => `ed-ptab-${id}`
export const PANEL_ID = 'ed-props-panel'

/** "left", "right", "both" or "" : which sides of a sideways-scrolling row have more to show. */
export function scrollCue(el: Pick<HTMLElement, 'scrollLeft' | 'scrollWidth' | 'clientWidth'>): '' | 'left' | 'right' | 'both' {
  const left = el.scrollLeft > 1
  const right = el.scrollLeft + el.clientWidth < el.scrollWidth - 1
  return left && right ? 'both' : left ? 'left' : right ? 'right' : ''
}

function markCue(el: HTMLElement) {
  const cue = scrollCue(el)
  if (cue) el.dataset.more = cue
  else delete el.dataset.more
}

/** Keeps `data-more` on the element up to date as it scrolls or changes size. */
export function useScrollCue(ref: React.RefObject<HTMLElement>, deps: unknown[] = []) {
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const update = () => markCue(el)
    update()
    el.addEventListener('scroll', update, { passive: true })
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(update) : undefined
    ro?.observe(el)
    window.addEventListener('resize', update)
    return () => {
      el.removeEventListener('scroll', update)
      ro?.disconnect()
      window.removeEventListener('resize', update)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)
}

export function PanelTabs({ tabs, value, onChange, label, children }: { tabs: Array<{ id: string; label: string }>; value: string; onChange: (id: string) => void; label: string; children?: ReactNode }) {
  const row = useRef<HTMLDivElement>(null)
  useScrollCue(row, [tabs.map((t) => t.id).join()])
  // the chosen tab stays in view (it may have been picked from elsewhere: a shortcut, the assistant)
  useEffect(() => {
    const el = row.current
    if (!el) return
    el.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' })
    markCue(el)
  }, [value])
  const onKeyDown = (e: React.KeyboardEvent) => {
    const i = Math.max(0, tabs.findIndex((t) => t.id === value))
    const n = tabs.length
    const next = e.key === 'ArrowRight' ? (i + 1) % n : e.key === 'ArrowLeft' ? (i - 1 + n) % n : e.key === 'Home' ? 0 : e.key === 'End' ? n - 1 : -1
    if (next < 0) return
    e.preventDefault()
    e.stopPropagation()
    onChange(tabs[next].id)
    row.current?.querySelector<HTMLElement>(`#${panelTabId(tabs[next].id)}`)?.focus()
  }
  return (
    <div className="ed-tabs">
      <div ref={row} className="ed-tablist" role="tablist" aria-label={label} onKeyDown={onKeyDown}>
        {tabs.map((t) => {
          const on = t.id === value
          return (
            <button key={t.id} type="button" role="tab" id={panelTabId(t.id)} aria-selected={on} aria-controls={on ? PANEL_ID : undefined} tabIndex={on ? 0 : -1} className={clsx(on && 'on')} onClick={() => onChange(t.id)}>
              {t.label}
            </button>
          )
        })}
      </div>
      {children}
    </div>
  )
}
