// Files dropped from the desktop onto the timeline (E-9): they upload like any other, and each lands on the timeline
// where it was dropped (that track and time) once the server has processed it, one after another from the drop point.
import { acceptsItem, findItem, itemEnd, type Asset } from '@producer/core'
import { toast } from '../lib/toast'
import * as A from './actions'
import { useEditor } from './store'
import { fileKind, uploadFiles, useLibrary } from './uploads'
import { gapToAboveIndex, type DropTarget, type Row } from './timelineMath'

/** Where a drop should go: a track that takes the clip, or a new overlay track above stacking index `overlayAbove`. */
export interface Placement {
  trackId?: string
  overlayAbove?: number
}

/** The placement for media of `kind` dropped on `target` (the asset panels' drops use the same rule). */
export function placementFor(kind: Asset['kind'], target: DropTarget | null, rows: Row[], mainIndex: number): Placement {
  const type = kind === 'audio' ? 'audio' : kind
  if (target?.type === 'row' && acceptsItem(target.row.track.kind, type) && !target.row.track.locked) return { trackId: target.row.track.id }
  // a new overlay track at the gap (or directly above a row that can't hold video or images)
  if (target && kind !== 'audio') return { overlayAbove: target.type === 'gap' ? gapToAboveIndex(target.gap, rows, mainIndex) : Math.max(mainIndex, target.row.index) }
  return {}
}

/** Put a clip on the timeline at `t` by a placement made earlier (the track may have gone since). */
export function placeAsset(asset: Asset, t: number, pl: Placement): string | undefined {
  const p = useEditor.getState().project
  const type = asset.kind === 'audio' ? 'audio' : asset.kind
  const tr = pl.trackId ? p.tracks.find((x) => x.id === pl.trackId) : undefined
  if (tr && acceptsItem(tr.kind, type) && !tr.locked) return A.addAssetAt(asset, t, { trackId: tr.id })
  if (pl.overlayAbove !== undefined && asset.kind !== 'audio') return A.addAssetAt(asset, t, { overlay: { above: Math.min(pl.overlayAbove, p.tracks.length - 1) } })
  return A.addAssetAt(asset, t)
}

const WAIT_MS = 60 * 60 * 1000

/** The clip once it is ready to edit; null when processing failed, it never got there, or another project opened. */
export function whenReady(assetId: string, session = useEditor.getState().session): Promise<Asset | null> {
  const now = () => {
    const s = useEditor.getState()
    if (s.session !== session) return null
    const rec = useLibrary.getState().records.find((r) => r.asset.id === assetId)
    if (rec?.status === 'ready') return rec.asset
    if (rec?.status === 'error') return null
    // the demo imports straight into the project
    if (s.demo && s.project.assets[assetId]) return s.project.assets[assetId]
    return undefined
  }
  const first = now()
  if (first !== undefined) return Promise.resolve(first)
  return new Promise((resolve) => {
    const done = (v: Asset | null) => {
      offLib()
      offEd()
      clearTimeout(timer)
      resolve(v)
    }
    const check = () => {
      const v = now()
      if (v !== undefined) done(v)
    }
    const offLib = useLibrary.subscribe(check)
    const offEd = useEditor.subscribe(check)
    const timer = setTimeout(() => done(null), WAIT_MS)
  })
}

/** Upload files dropped at time `t` with a placement; each goes on the timeline when ready, the next after it. */
export async function uploadToTimeline(files: File[], t: number, place: (kind: Asset['kind']) => Placement): Promise<void> {
  const usable = files.filter((f) => fileKind(f))
  if (!usable.length) return void uploadFiles(files)
  const session = useEditor.getState().session
  toast(usable.length > 1 ? `Uploading ${usable.length} files: they go on the timeline as each is ready` : `Uploading ${usable[0].name}: it goes on the timeline when it's ready`)
  let at = t
  let chain = Promise.resolve()
  await uploadFiles(files, {
    onUploaded: (assetId, file) => {
      const pl = place(fileKind(file)!)
      chain = chain.then(async () => {
        const asset = await whenReady(assetId, session)
        if (!asset) return
        const id = placeAsset(asset, at, pl)
        const it = id ? findItem(useEditor.getState().project, id)?.item : undefined
        if (it) at = itemEnd(it)
      })
    },
  })
  await chain
}
