// Global editor keyboard shortcuts. Ignored while typing in inputs; panels that own keys (transcript words,
// canvas nudge) stop propagation before this window listener sees the event.
import { useEffect } from 'react'
import * as A from './actions'
import { flush } from './persistence'
import { useEditor } from './store'

function typing(e: KeyboardEvent): boolean {
  const t = e.target as HTMLElement | null
  if (!t) return false
  if (t.closest('input, textarea, select, [contenteditable="true"]')) {
    const inp = t as HTMLInputElement
    // range/checkbox inputs don't take text; let shortcuts through except arrows
    if (inp.tagName === 'INPUT' && (inp.type === 'range' || inp.type === 'checkbox' || inp.type === 'color')) return e.key.startsWith('Arrow')
    return true
  }
  return false
}

export function handleKey(e: KeyboardEvent) {
  if (typing(e)) return
  const s = useEditor.getState()
  if (s.exportOpen) return
  const mod = e.ctrlKey || e.metaKey
  const k = e.key
  const lower = k.length === 1 ? k.toLowerCase() : k
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

export function useShortcuts() {
  useEffect(() => {
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [])
}
