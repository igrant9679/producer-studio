// Global editor keyboard shortcuts. Ignored while typing in inputs; a control reached by keyboard keeps the keys
// it uses (Space on a button, arrows on a slider); copy and cut leave selected text to the browser. Panels that own
// keys (transcript words, canvas nudge, timeline clips) handle them first, and `data-local-keys` marks a box whose
// Delete, Backspace, Escape and Ctrl+A are its own.
import { useEffect } from 'react'
import * as A from './actions'
import { flush } from './persistence'
import { useEditor } from './store'

const NOT_TEXT = new Set(['range', 'checkbox', 'radio', 'color', 'button', 'submit', 'reset', 'file', 'image'])
const CONTROL = 'button, a[href], input, summary, [role="button"], [role="checkbox"], [role="switch"], [role="slider"], [role="tab"], [role="menuitem"], [role="option"], [role="radio"]'
/** Keys a focused control answers to itself. */
const CONTROL_KEYS = new Set([' ', 'Enter', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown', 'Backspace', 'Delete'])

/** Controls focused with the mouse: clicking a toolbar button leaves focus on it, but Space should still play. */
const pointerFocused = new WeakSet<EventTarget>()
let pointerAt = -Infinity

function textEntry(t: HTMLElement): boolean {
  if (t.closest('textarea, select, [contenteditable]:not([contenteditable="false"])')) return true
  return t.tagName === 'INPUT' && !NOT_TEXT.has((t as HTMLInputElement).type)
}

/** The event belongs to the element that has focus, not to the editor. */
function ownedByTarget(e: KeyboardEvent): boolean {
  const t = e.target as HTMLElement | null
  if (!t || !t.closest) return false
  if (textEntry(t)) return true
  const mod = e.ctrlKey || e.metaKey
  if (t.closest('[data-local-keys]') && (e.key === 'Delete' || e.key === 'Backspace' || e.key === 'Escape' || (mod && e.key.toLowerCase() === 'a'))) return true
  if (!mod && CONTROL_KEYS.has(e.key) && !t.closest('[data-tl-clip]')) {
    const ctl = t.closest(CONTROL)
    // a slider moves with the arrows however it was focused
    if (ctl && ctl.tagName === 'INPUT' && e.key !== ' ' && e.key !== 'Enter' && e.key !== 'Backspace' && e.key !== 'Delete') return true
    if (ctl && !pointerFocused.has(ctl)) return true
  }
  return false
}

/** Text the person selected on the page (a note, a toast, a transcript line): Ctrl+C copies that. */
function selectedText(): boolean {
  const sel = typeof window !== 'undefined' ? window.getSelection?.() : null
  return !!sel && !sel.isCollapsed && sel.toString().trim().length > 0
}

export function handleKey(e: KeyboardEvent) {
  // whatever takes focus after a key (Tab) was reached by keyboard
  pointerAt = -Infinity
  if (ownedByTarget(e)) return
  const s = useEditor.getState()
  if (s.exportOpen) return
  const mod = e.ctrlKey || e.metaKey
  const k = e.key
  const lower = k.length === 1 ? k.toLowerCase() : k
  if (mod && (lower === 'c' || lower === 'x') && selectedText()) return
  const done = () => {
    e.preventDefault()
    e.stopPropagation()
  }
  if (k === '?' || (e.shiftKey && k === '/')) return done(), s.set({ shortcutsOpen: !s.shortcutsOpen })
  if (s.shortcutsOpen) {
    if (k === 'Escape') s.set({ shortcutsOpen: false })
    return
  }
  if (mod && e.shiftKey && lower === 'f') return done(), s.set({ fullscreen: !s.fullscreen })
  if (mod && lower === 'z') return done(), e.shiftKey ? s.redo() : s.undo()
  if (mod && lower === 'y') return done(), s.redo()
  if (mod && lower === 'b') return done(), A.split()
  if (mod && lower === 'c') return done(), A.copy()
  if (mod && lower === 'x') return done(), A.cut()
  if (mod && lower === 'v') return done(), A.paste()
  if (mod && lower === 'd') return done(), A.duplicate()
  if (mod && lower === 'a') return done(), A.selectAll()
  if (mod && e.shiftKey && lower === 's') return done(), A.separate()
  if (mod && lower === 's') return done(), void flush()
  if (mod && (k === '=' || k === '+')) return done(), s.setZoom(s.zoom * 1.4)
  if (mod && (k === '-' || k === '_')) return done(), s.setZoom(s.zoom / 1.4)
  if (mod) return
  if (k === ' ') return done(), A.togglePlay()
  if (k === 'Delete' || k === 'Backspace') return done(), A.remove(e.shiftKey)
  if (k === 'ArrowLeft') return done(), s.setPlaying(false), e.shiftKey ? A.seek(s.playhead - 1) : A.stepFrames(-1)
  if (k === 'ArrowRight') return done(), s.setPlaying(false), e.shiftKey ? A.seek(s.playhead + 1) : A.stepFrames(1)
  if (k === 'Home') return done(), A.seek(0)
  if (k === 'End') return done(), A.seek(A.totalDuration())
  if (k === 'Escape') {
    if (s.fullscreen) return s.set({ fullscreen: false })
    if (s.editingTextId) return s.set({ editingTextId: null })
    return s.select([])
  }
  if (e.shiftKey && lower === 'f') return done(), s.set({ canvasZoom: 'fit' })
  if (e.shiftKey && (k === ')' || k === '0')) return done(), s.set({ canvasZoom: 0.5 })
  if (e.shiftKey && (k === '!' || k === '1')) return done(), s.set({ canvasZoom: 1 })
  if (e.shiftKey && (k === '@' || k === '2')) return done(), s.set({ canvasZoom: 2 })
  if (e.shiftKey || e.altKey) return
  if (lower === 's') return done(), s.set({ snapping: !s.snapping })
  if (lower === 'v') return done(), s.set({ canvasTool: 'select' })
  if (lower === 'h') return done(), s.set({ canvasTool: 'hand' })
}

function onPointerDown() {
  pointerAt = performance.now()
}
function onFocusIn(e: FocusEvent) {
  if (e.target && performance.now() - pointerAt < 600) pointerFocused.add(e.target)
  else if (e.target) pointerFocused.delete(e.target)
}

export function useShortcuts() {
  useEffect(() => {
    window.addEventListener('keydown', handleKey)
    window.addEventListener('pointerdown', onPointerDown, true)
    window.addEventListener('mousedown', onPointerDown, true)
    window.addEventListener('focusin', onFocusIn, true)
    return () => {
      window.removeEventListener('keydown', handleKey)
      window.removeEventListener('pointerdown', onPointerDown, true)
      window.removeEventListener('mousedown', onPointerDown, true)
      window.removeEventListener('focusin', onFocusIn, true)
    }
  }, [])
}
