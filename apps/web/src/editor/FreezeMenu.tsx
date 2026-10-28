// Freeze frames (E-24): how long a new freeze holds, at the playhead or at the end of a clip, and the hold of one
// already made. Used by the timeline toolbar's Freeze button and the properties panel.
import { FREEZE_MAX, FREEZE_MIN, setFreezeHold, type VideoItem } from '@producer/core'
import clsx from 'clsx'
import { Snowflake, X } from 'lucide-react'
import { useRef, useState } from 'react'
import { tipProps } from '../lib/tooltip'
import * as A from './actions'
import { Field, Menu, NumberInput } from './controls'
import { useEditor } from './store'

/** The hold length for new freeze frames, and the two ways to make one. */
export function FreezeControls({ onDone }: { onDone?: () => void }) {
  const sec = useEditor((s) => s.freezeSec)
  const run = (fn: () => void) => () => {
    fn()
    onDone?.()
  }
  return (
    <>
      <Field label="Hold for">
        <NumberInput value={sec} min={FREEZE_MIN} max={FREEZE_MAX} step={0.1} suffix="s" width={70} onChange={(v) => useEditor.setState({ freezeSec: v })} />
      </Field>
      <div className="ed-freeze-btns">
        <button type="button" className="btn sm" onClick={run(A.freeze)}>
          <Snowflake size={13} /> At the playhead
        </button>
        <button type="button" className="btn sm" onClick={run(A.freezeEnd)}>
          <Snowflake size={13} /> At the end of the clip
        </button>
      </div>
    </>
  )
}

/** The toolbar's Freeze button: opens the hold length and where to freeze. */
export function FreezeButton() {
  const [at, setAt] = useState<{ left: number; top: number } | null>(null)
  const btn = useRef<HTMLButtonElement>(null)
  const sec = useEditor((s) => s.freezeSec)
  return (
    <>
      <button
        ref={btn}
        type="button"
        className={clsx('tl-btn', at && 'on')}
        {...tipProps('Freeze frame', `Hold a frame still (now ${+sec.toFixed(2)} s): the one under the playhead, or a clip's last frame.`, undefined, 'top')}
        aria-haspopup="dialog"
        aria-expanded={!!at}
        onClick={() => {
          if (at) return setAt(null)
          const r = btn.current!.getBoundingClientRect()
          setAt({ left: Math.max(8, Math.min(r.left, window.innerWidth - 290)), top: Math.max(8, r.top - 150) })
        }}
      >
        <Snowflake size={15} />
      </button>
      {at && (
        <Menu open onClose={() => setAt(null)} role="dialog" label="Freeze frame" className="tl-freezepop" style={at}>
          <div className="row" style={{ marginBottom: 6 }}>
            <span className="eyebrow">Freeze frame</span>
            <div className="spacer" />
            <button type="button" className="btn sm ghost icon" onClick={() => setAt(null)} aria-label="Close">
              <X size={14} />
            </button>
          </div>
          <FreezeControls onDone={() => setAt(null)} />
        </Menu>
      )}
    </>
  )
}

/** How long a freeze frame holds; later clips on its track follow its end. */
export function FreezeHold({ item }: { item: VideoItem }) {
  return (
    <Field label="Hold for">
      <NumberInput
        value={item.duration}
        min={FREEZE_MIN}
        max={FREEZE_MAX}
        step={0.1}
        suffix="s"
        width={70}
        onChange={(v) => {
          const s = useEditor.getState()
          s.commit(setFreezeHold(s.project, item.id, v), 'Freeze length', { coalesce: `freeze:${item.id}` })
        }}
      />
    </Field>
  )
}
