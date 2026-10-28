// The undo history as a list (E-25): every step by its label, the current one marked; choosing a step undoes or redoes
// to it in one go. Opened from the timeline toolbar.
import clsx from 'clsx'
import { History } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { tipProps } from '../lib/tooltip'
import { Menu, MenuItem } from './controls'
import { HISTORY_CAP, useEditor, type EditorState } from './store'

export interface HistoryStep {
  /** 0 is the document as opened; the current state is `past.length`. */
  index: number
  label: string
}

/** The steps, oldest first: the opened document, each change made since, then the ones undone (redo). */
export function historySteps(s: Pick<EditorState, 'history'>): HistoryStep[] {
  const { past, future } = s.history
  const first = past.length >= HISTORY_CAP ? 'Earlier changes' : 'Opened the project'
  return [{ index: 0, label: first }, ...past.map((e, i) => ({ index: i + 1, label: e.label })), ...future.map((e, j) => ({ index: past.length + 1 + j, label: e.label }))]
}

/** Undo or redo until step `index` is the current one. */
export function jumpToStep(index: number) {
  const s = useEditor.getState()
  const at = s.history.past.length
  for (let i = at; i > index; i--) useEditor.getState().undo()
  for (let i = at; i < index; i++) useEditor.getState().redo()
}

export function HistoryButton() {
  const [at, setAt] = useState<{ left: number; top: number } | null>(null)
  const btn = useRef<HTMLButtonElement>(null)
  const steps = useEditor((s) => s.history.past.length + s.history.future.length)
  return (
    <>
      <button
        ref={btn}
        type="button"
        className={clsx('tl-btn', at && 'on')}
        {...tipProps('History', 'Every change made since the project opened, by name. Choose one to go back (or forward) to it.', undefined, 'top')}
        aria-haspopup="menu"
        aria-expanded={!!at}
        disabled={!steps}
        onClick={() => {
          if (at) return setAt(null)
          const r = btn.current!.getBoundingClientRect()
          setAt({ left: Math.max(8, Math.min(r.left, window.innerWidth - 270)), top: Math.max(8, r.top - 8) })
        }}
      >
        <History size={15} />
      </button>
      {at && <HistoryList at={at} onClose={() => setAt(null)} />}
    </>
  )
}

function HistoryList({ at, onClose }: { at: { left: number; top: number }; onClose: () => void }) {
  const history = useEditor((s) => s.history)
  const steps = historySteps({ history })
  const current = history.past.length
  const box = useRef<HTMLDivElement>(null)
  // open on the current step (the menu focuses its first item before this runs)
  useEffect(() => {
    box.current?.querySelector<HTMLElement>('[aria-checked="true"]')?.focus({ preventScroll: false })
  }, [])
  return (
    <Menu open onClose={onClose} label="History" className="tl-history" style={{ left: at.left, bottom: window.innerHeight - at.top }}>
      <div ref={box} className="tl-history-list">
        {steps.map((st) => (
          <MenuItem key={st.index} label={<span className={clsx(st.index > current && 'undone')}>{st.label}</span>} active={st.index === current} onClick={() => jumpToStep(st.index)} />
        ))}
      </div>
    </Menu>
  )
}
