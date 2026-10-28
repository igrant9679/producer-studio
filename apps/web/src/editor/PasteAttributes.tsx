// Paste attributes (Ctrl Alt V): the copied clip's colour, effects, transform, speed or volume onto the selected
// clips, chosen in a dialog with a checkbox per group.
import type { AttributeGroup, Item } from '@producer/core'
import { ATTRIBUTE_GROUPS, hasAttributes, isEditable, pastableGroups, pasteAttributes } from '@producer/core'
import { useId, useState } from 'react'
import { create } from 'zustand'
import { toast } from '../lib/toast'
import './colour.css'
import * as A from './actions'
import { EditorDialog } from './Dialogs'
import { useEditor } from './store'

export const usePasteAttributes = create<{ open: boolean }>(() => ({ open: false }))

const S = () => useEditor.getState()

/** The clip whose attributes are pasted (the first one copied) and the selected clips that can take some of them. */
function sourceAndTargets(): { src?: Item; targets: Item[] } {
  const src = S().clipboard[0]
  const targets = src ? A.selectedItems().filter((i) => i.id !== src.id && isEditable(S().project, i.id)) : []
  return { src, targets }
}

export function openPasteAttributes() {
  const { src, targets } = sourceAndTargets()
  if (!src) return toast('Copy a clip first (Ctrl C), then select the clips to paste its attributes onto')
  if (!A.selectedItems().length) return toast('Select the clips to paste the attributes onto')
  if (!targets.length) return toast(A.LOCKED_NOTE)
  if (!pastableGroups(src, targets).length) return toast("The selected clips can't take any of the copied clip's attributes")
  usePasteAttributes.setState({ open: true })
}

export function PasteAttributesHost() {
  const open = usePasteAttributes((s) => s.open)
  return open ? <PasteAttributesDialog /> : null
}

function name(it: Item): string {
  if (it.type === 'text' || it.type === 'caption') return `“${it.text.split('\n')[0].slice(0, 40)}”`
  return it.name ?? S().project.assets['assetId' in it ? it.assetId : '']?.name ?? it.type
}

function PasteAttributesDialog() {
  const close = () => usePasteAttributes.setState({ open: false })
  const formId = useId()
  const [{ src, targets }] = useState(sourceAndTargets)
  const can = src ? pastableGroups(src, targets) : []
  // speed changes how long the clips are: only when asked for
  const [on, setOn] = useState<Set<AttributeGroup>>(() => new Set(can.filter((g) => g !== 'speed')))
  if (!src) return null
  const paste = () => {
    const groups = [...on].filter((g) => can.includes(g))
    if (!groups.length) return
    const s = S()
    s.commit(pasteAttributes(s.project, src, targets.map((t) => t.id), groups), 'Paste attributes')
    const lut = 'grade' in src && src.grade?.lut
    if (groups.includes('colour') && lut && !s.project.luts?.[lut.id]) toast("The copied clip's LUT isn't in this project: load the .cube file here to use it")
    close()
  }
  return (
    <EditorDialog title="Paste attributes" onClose={close} style={{ maxWidth: 420 }}>
      <form
        id={formId}
        className="ed-pasteattrs"
        onSubmit={(e) => {
          e.preventDefault()
          paste()
        }}
      >
        <p className="muted">
          From {name(src)} onto {targets.length === 1 ? name(targets[0]) : `${targets.length} clips`}.
        </p>
        <fieldset className="ed-attrs">
          <legend>Attributes to paste</legend>
          {ATTRIBUTE_GROUPS.map((g) => {
            const ok = can.includes(g.id)
            const takers = targets.filter((t) => hasAttributes(t, g.id)).length
            return (
              <label key={g.id} className={ok ? undefined : 'muted'}>
                <input
                  type="checkbox"
                  checked={ok && on.has(g.id)}
                  disabled={!ok}
                  onChange={(e) => {
                    const next = new Set(on)
                    if (e.target.checked) next.add(g.id)
                    else next.delete(g.id)
                    setOn(next)
                  }}
                />
                <span>
                  <b>{g.name}</b>
                  <small>{ok ? (takers < targets.length ? `${g.hint} · ${takers} of ${targets.length} clips take it` : g.hint) : `The ${hasAttributes(src, g.id) ? 'selected clips have' : 'copied clip has'} none`}</small>
                </span>
              </label>
            )
          })}
        </fieldset>
      </form>
      <footer>
        <button type="button" className="btn sm" onClick={close}>Cancel</button>
        <button type="submit" form={formId} className="btn sm primary" disabled={![...on].some((g) => can.includes(g))}>Paste</button>
      </footer>
    </EditorDialog>
  )
}
