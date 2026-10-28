// Colour commands shared by the Effects / Filters panels, the timeline menu and the shortcuts.
import { addAdjustmentLayer, itemEnd } from '@producer/core'
import * as A from './actions'
import { useEditor } from './store'

/**
 * Add an adjustment layer above every track: over the selected clips' time when there is a selection, else from the
 * playhead to the end of the project (at least 5 s). It is selected, with its Colour tab open.
 */
export function addAdjustment() {
  const s = useEditor.getState()
  const sel = A.selectedItems()
  const start = sel.length ? Math.min(...sel.map((i) => i.start)) : s.playhead
  const duration = sel.length ? Math.max(...sel.map(itemEnd)) - start : undefined
  const { project, id } = addAdjustmentLayer(s.project, start, duration && duration > 0.05 ? duration : undefined)
  s.commit(project, 'Add adjustment layer', { selection: [id] })
  s.set({ activeRightTab: 'adjust', rightCollapsed: false })
}
