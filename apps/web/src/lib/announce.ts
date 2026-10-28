// One polite live region for the whole app: screen readers hear a change of state once (saved, couldn't save, a
// job started or finished), not every tick of a progress bar. The region is created on first use and stays, so
// the text arriving in it is what gets read.
import { useEffect, useRef } from 'react'

const SAME_WITHIN_MS = 2000

let region: HTMLElement | undefined
let last = { text: '', at: 0 }
let timer: ReturnType<typeof setTimeout> | undefined

function liveRegion(): HTMLElement {
  if (region?.isConnected) return region
  region = document.createElement('div')
  region.className = 'ps-sr'
  region.setAttribute('role', 'status')
  region.setAttribute('aria-live', 'polite')
  region.setAttribute('aria-atomic', 'true')
  region.dataset.announcer = ''
  document.body.appendChild(region)
  return region
}

/** Say `text` once. The same words again within two seconds are not repeated. */
export function announce(text: string, now = Date.now()) {
  if (typeof document === 'undefined' || !text) return
  if (text === last.text && now - last.at < SAME_WITHIN_MS) return
  last = { text, at: now }
  const el = liveRegion()
  // cleared, then set on the next tick: a reader notices the same words said again later
  el.textContent = ''
  clearTimeout(timer)
  timer = setTimeout(() => (el.textContent = text), 50)
}

/**
 * Say `text` when it changes while the component is on screen (a run starting, a copy becoming ready), but not
 * what it already said when it appeared: switching to a tab doesn't repeat its state.
 */
export function useAnnounceChange(text: string | undefined) {
  const prev = useRef(text)
  useEffect(() => {
    if (text !== prev.current && text) announce(text)
    prev.current = text
  }, [text])
}

/** For tests: what the region says now. */
export function announced(): string {
  return region?.textContent ?? ''
}

export function resetAnnouncer() {
  clearTimeout(timer)
  region?.remove()
  region = undefined
  last = { text: '', at: 0 }
}
