// Marker commands (E-6): M adds one at the playhead, Shift+M / Alt+M jump to the next / previous, beat detection on a
// music clip. The ruler (Markers.tsx) and the clip menu call these too.
import { addBeatMarkers, addMarker, findItem, markersOf, nextMarker, removeMarkers, updateMarker } from '@producer/core'
import { toast } from '../lib/toast'
import * as A from './actions'
import { useEditor } from './store'
import { FULL_RATE, fetchFullWaveform } from './waveform'

const S = () => useEditor.getState()

/** Add a marker at the playhead (one already there is kept); returns its id. */
export function addMarkerAtPlayhead(): string {
  const { project, playhead } = S()
  const { project: p, id } = addMarker(project, playhead)
  if (p !== project) S().commit(p, 'Add marker')
  return id
}

export function jumpToMarker(dir: 1 | -1) {
  const { project, playhead } = S()
  const m = nextMarker(project, playhead, dir)
  if (!m) return toast(markersOf(project).length ? `No marker ${dir > 0 ? 'after' : 'before'} the playhead` : 'No markers yet: press M to add one at the playhead')
  S().setPlaying(false)
  A.seek(m.t)
}

export function renameMarker(id: string, name: string) {
  S().commit(updateMarker(S().project, id, { name }), 'Rename marker')
}

/** Drag or nudge a marker; repeated moves of one marker make one undo step. */
export function moveMarker(id: string, t: number) {
  S().commit(updateMarker(S().project, id, { t }), 'Move marker', { coalesce: `marker:${id}` })
}

export function deleteMarker(id: string) {
  S().commit(removeMarkers(S().project, [id]), 'Delete marker')
}

export function clearBeatMarkers() {
  const p = S().project
  S().commit(removeMarkers(p, (p.markers ?? []).filter((m) => m.beat).map((m) => m.id)), 'Remove beat markers')
}

/** Detect the beats of a music (or any sound) clip from its waveform and mark them on the timeline. */
export async function detectBeatsOn(itemId: string) {
  const s = S()
  const f = findItem(s.project, itemId)
  if (!f || (f.item.type !== 'audio' && f.item.type !== 'video')) return
  const asset = s.project.assets[f.item.assetId]
  if (!asset?.waveform?.length && !asset?.waveformSrc) return toast("This clip's waveform isn't ready yet: try again once it has finished processing")
  // the full waveform (50 peaks a second) when the clip record carries a shortened one
  const full = asset.waveformSrc && (asset.waveformRate ?? FULL_RATE) < FULL_RATE ? await fetchFullWaveform(asset.waveformSrc) : null
  const now = S()
  if (now.session !== s.session) return
  const r = addBeatMarkers(now.project, itemId, full ? { values: full, rate: FULL_RATE, scale: 1 / 255 } : undefined)
  if (!r.count) return toast('No clear beats found in this clip')
  now.commit(r.project, 'Detect beats')
  toast(`Marked ${r.count} beat${r.count === 1 ? '' : 's'}: clips snap to them while you drag`)
}
