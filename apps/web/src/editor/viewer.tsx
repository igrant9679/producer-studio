// Viewer mode. Someone with view access to a project's space opens the editor read-only: they look, play, scrub,
// select to inspect and comment, and nothing they do changes the project. One guard holds it: the store's
// `commit` (and undo, redo, replaceSilently) refuses while `readOnly` is set, with a note saying who can edit. On
// top of that the write controls are disabled with the same tooltip: panels sit inside <ViewOnly> (a disabled
// fieldset disables every control in it), drags and drops check `isReadOnly()` before they start, and the handles
// on the canvas and the timeline are hidden (`.ed-readonly`, viewer.css).
import clsx from 'clsx'
import { Eye } from 'lucide-react'
import { useMemo, type CSSProperties, type ReactNode } from 'react'
import { canEdit, useSession } from '../lib/session'
import { toast } from '../lib/toast'
import { viewOnlyTip, type EditGate } from '../shell/ui'
import { useEditor } from './store'
import './viewer.css'

/** Whether the signed-in person only views projects of this space (the demo, with no space, is always editable). */
export function readOnlyFor(workspaceId: string | undefined): { readOnly: boolean; tip?: string } {
  if (!workspaceId) return { readOnly: false }
  const ws = useSession.getState().workspaces.find((w) => w.id === workspaceId)
  // a space the session doesn't list yet (just joined): the server decides, as it always does
  if (!ws || canEdit(ws)) return { readOnly: false }
  return { readOnly: true, tip: viewOnlyTip(ws) }
}

/**
 * Keep the editor's viewer flag in step with the person's role in the project's space: set on load, and changed
 * live when an owner changes the role (the session refreshes its spaces on a workspace event). Returns a stop.
 */
export function startViewerMode(): () => void {
  const apply = () => {
    const s = useEditor.getState()
    const next = s.demo ? { readOnly: false } : readOnlyFor(s.workspaceId)
    if (next.readOnly === s.readOnly && next.tip === s.readOnlyTip) return
    useEditor.setState({ readOnly: next.readOnly, readOnlyTip: next.tip, ...(next.readOnly ? { editingTextId: null } : {}) })
  }
  apply()
  const a = useEditor.subscribe((s, p) => {
    if (s.workspaceId !== p.workspaceId || s.demo !== p.demo || s.session !== p.session) apply()
  })
  const b = useSession.subscribe((s, p) => {
    if (s.workspaces !== p.workspaces) apply()
  })
  return () => {
    a()
    b()
  }
}

export const isReadOnly = () => useEditor.getState().readOnly

/** For writes that aren't a commit (uploads, jobs): true, with the note, when the person only views. */
export function refuseReadOnly(): boolean {
  const s = useEditor.getState()
  if (!s.readOnly) return false
  toast(s.readOnlyTip ?? 'This project is view only.')
  return true
}

/** useEditGate for the editor: the role in the open project's space (which need not be the shell's current one). */
export function useEditorGate(): EditGate {
  const ro = useEditor((s) => s.readOnly)
  const tip = useEditor((s) => s.readOnlyTip)
  return useMemo(() => (ro ? { canEdit: false, tip, props: { disabled: true, 'data-tip': tip } } : { canEdit: true, props: {} }), [ro, tip])
}

/**
 * Write controls go inside: for a viewer every button, field and menu item in it is disabled, and the tooltip layer
 * shows the control's name with who can use it. `inline` keeps the surrounding layout (display: contents).
 */
export function ViewOnly({ children, className, style, inline }: { children: ReactNode; className?: string; style?: CSSProperties; inline?: boolean }) {
  const ro = useEditor((s) => s.readOnly)
  const tip = useEditor((s) => s.readOnlyTip)
  return (
    <fieldset className={clsx('ed-viewonly', inline && 'inline', className)} style={style} disabled={ro} data-ro-tip={ro ? tip ?? 'View only' : undefined}>
      {children}
    </fieldset>
  )
}

/** The top bar's "View only" badge. */
export function ViewOnlyBadge() {
  const ro = useEditor((s) => s.readOnly)
  const tip = useEditor((s) => s.readOnlyTip)
  if (!ro) return null
  return (
    <span className="ed-ro-badge" role="status" data-tip="View only" data-tip-desc={`${tip ?? ''} You can play, scrub, look at every setting and comment.`.trim()}>
      <Eye size={13} aria-hidden="true" /> View only
    </span>
  )
}
