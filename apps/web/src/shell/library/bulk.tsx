// Bulk actions in the Library (A-13): the selection (click, shift-click ranges, keyboard), running one action over
// many items, and the dialogs they need (another space, tags).
import type { Workspace } from '@producer/core'
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { canEdit, useSession } from '../../lib/session'
import { selectWithClick } from '../pages/libraryLogic'
import { Modal, Spinner } from '../ui'

/** Run `fn` over every item, a few at a time; what failed is returned, never thrown. */
export async function runAll<T>(items: T[], fn: (t: T) => Promise<unknown>, at = 4): Promise<Array<{ item: T; error: unknown }>> {
  const failed: Array<{ item: T; error: unknown }> = []
  let i = 0
  const worker = async () => {
    while (i < items.length) {
      const item = items[i++]
      try {
        await fn(item)
      } catch (error) {
        failed.push({ item, error })
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(at, items.length) }, worker))
  return failed
}

/** Several downloads, one after another (browsers allow a click-started run of them). */
export function downloadAll(urls: string[]) {
  urls.forEach((url, i) =>
    setTimeout(() => {
      const a = document.createElement('a')
      a.href = url
      a.download = ''
      a.rel = 'noopener'
      document.body.appendChild(a)
      a.click()
      a.remove()
    }, i * 400),
  )
}

/**
 * The selected ids of a list shown in `order`: a click toggles one, shift-click selects the range from the last one
 * clicked; Ctrl+A selects everything shown and Escape clears (handled by `onKeyDown` on the grid). Ids no longer
 * shown leave the selection.
 */
export function useSelection(order: string[], resetKey: unknown) {
  const [sel, setSel] = useState<Set<string>>(new Set())
  const anchor = useRef<string>()
  useEffect(() => {
    setSel(new Set())
    anchor.current = undefined
  }, [resetKey])
  const shown = useMemo(() => new Set(order), [order])
  useEffect(() => {
    setSel((s) => ([...s].every((id) => shown.has(id)) ? s : new Set([...s].filter((id) => shown.has(id)))))
  }, [shown])
  const toggle = useCallback(
    (id: string, how?: { shift: boolean }) => {
      setSel((s) => selectWithClick(order, s, anchor.current, id, !!how?.shift))
      anchor.current = id
    },
    [order],
  )
  const clear = useCallback(() => setSel(new Set()), [])
  const all = order.length > 0 && order.every((id) => sel.has(id))
  const selectAll = useCallback(() => setSel(new Set(order)), [order])
  const onKeyDown = useCallback(
    (e: KeyboardEvent) => {
      const t = e.target as HTMLElement
      if (/INPUT|TEXTAREA|SELECT/.test(t.tagName)) return
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
        e.preventDefault()
        setSel(new Set(order))
      } else if (e.key === 'Escape' && sel.size) {
        e.preventDefault()
        e.stopPropagation()
        setSel(new Set())
      }
    },
    [order, sel.size],
  )
  return { sel, setSel, toggle, clear, all, selectAll, onKeyDown, ids: order.filter((id) => sel.has(id)) }
}

/** Another space the person edits, and whether to copy or move there. */
export function SpacePickerModal({ what, onClose, onPick }: { what: string; onClose: () => void; onPick: (workspaceId: string, move: boolean) => Promise<void> }) {
  const current = useSession((s) => s.workspaceId)
  const spaces = useSession((s) => s.workspaces).filter((w: Workspace) => w.id !== current && canEdit(w))
  const [to, setTo] = useState(spaces[0]?.id ?? '')
  const [move, setMove] = useState(false)
  const [busy, setBusy] = useState(false)
  return (
    <Modal
      title={`Copy or move ${what}`}
      subtitle="To another space you can edit. Clips a project uses are copied with it; moving puts the originals in this space’s trash."
      onClose={onClose}
      width={460}
      footer={
        <>
          <button className="btn ghost" onClick={onClose}>Cancel</button>
          <button
            className="btn primary"
            disabled={!to || busy}
            onClick={async () => {
              setBusy(true)
              try {
                await onPick(to, move)
              } finally {
                setBusy(false)
              }
            }}
          >
            {busy && <Spinner size={14} />} {move ? 'Move' : 'Copy'}
          </button>
        </>
      }
    >
      {spaces.length ? (
        <div className="ps-lib-col" style={{ gap: 12 }}>
          <label className="ps-lib-col" style={{ gap: 6 }}>
            <span className="label">Space</span>
            <select className="input" value={to} onChange={(e) => setTo(e.target.value)} aria-label="Space">
              {spaces.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
            </select>
          </label>
          <fieldset className="ps-lib-radios">
            <legend className="label">What to do</legend>
            <label><input type="radio" name="copy-move" checked={!move} onChange={() => setMove(false)} /> Copy (keep it here too)</label>
            <label><input type="radio" name="copy-move" checked={move} onChange={() => setMove(true)} /> Move (put the original in this space’s trash)</label>
          </fieldset>
        </div>
      ) : (
        <p className="muted">You don’t edit any other space. Create one, or ask an owner to make you an editor.</p>
      )}
    </Modal>
  )
}

/** Tags for one project or several (A-12): comma separated, with the space's tags to pick from. */
export function TagsModal({ initial, suggestions, count, onClose, onSave }: { initial: string[]; suggestions: string[]; count: number; onClose: () => void; onSave: (tags: string[]) => Promise<void> }) {
  const [text, setText] = useState(initial.join(', '))
  const [busy, setBusy] = useState(false)
  const have = new Set(text.split(',').map((t) => t.trim().toLowerCase()))
  const add = (t: string) => setText((cur) => (cur.trim() ? `${cur.replace(/,\s*$/, '')}, ${t}` : t))
  const save = async () => {
    setBusy(true)
    try {
      await onSave(text.split(',').map((t) => t.trim()).filter(Boolean))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Modal
      title={count > 1 ? `Tags for ${count} projects` : 'Tags'}
      subtitle={count > 1 ? 'These replace the tags the selected projects have now.' : 'Group projects in a big space: filter the Library by a tag.'}
      onClose={onClose}
      width={460}
      initialFocus="input"
      footer={
        <>
          <button className="btn ghost" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={busy} onClick={() => void save()}>{busy && <Spinner size={14} />} Save tags</button>
        </>
      }
    >
      <label className="ps-lib-col" style={{ gap: 6 }}>
        <span className="label">Tags, separated by commas</span>
        <input className="input" value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void save()} placeholder="Launch, Q3 campaign" aria-label="Tags" />
      </label>
      {suggestions.filter((s) => !have.has(s.toLowerCase())).length > 0 && (
        <div className="row" style={{ gap: 6, flexWrap: 'wrap', marginTop: 12 }} role="group" aria-label="Tags in this space">
          {suggestions
            .filter((s) => !have.has(s.toLowerCase()))
            .slice(0, 12)
            .map((s) => (
              <button key={s} type="button" className="chip" onClick={() => add(s)} aria-label={`Add tag ${s}`}>+ {s}</button>
            ))}
        </div>
      )}
    </Modal>
  )
}

/** "3 projects" / "1 clip". */
export const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`
