// The editor on a phone (below 760 px, see the phone block in editor.css): the stage comes first and the side
// panels open over it as sheets, one at a time (the media / comments panel beside the rail; Properties and
// Version history from the bottom).
import { useEditor } from './store'

export const PHONE_QUERY = '(max-width: 760px)'

export function isPhoneWidth(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(PHONE_QUERY).matches
}

/** On a phone: open the editor with both panels closed, and opening a side panel closes the other side's. Returns a stop. */
export function startPhoneSheets(): () => void {
  if (isPhoneWidth()) useEditor.setState({ leftCollapsed: true, rightCollapsed: true })
  return useEditor.subscribe((s, prev) => {
    if (!isPhoneWidth()) return
    const leftOpened = !s.leftCollapsed && prev.leftCollapsed
    const rightOpened = (!s.rightCollapsed && prev.rightCollapsed) || (s.versionsOpen && !prev.versionsOpen)
    // (version history stays: closing it ends a preview, which is the person's call)
    if (leftOpened && !s.rightCollapsed) useEditor.setState({ rightCollapsed: true })
    else if (rightOpened && !s.leftCollapsed) useEditor.setState({ leftCollapsed: true })
  })
}
