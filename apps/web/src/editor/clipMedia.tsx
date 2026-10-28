// Replace a clip's media (from the clip menu, or Alt+drop from the library onto the clip) and split a clip at its
// scene changes (E-10).
import type { Asset, Item, ReplaceRefusal, SceneCuts } from '@producer/core'
import { findItem, isEditable, replaceClipMedia, replaceRefusal, splitAtSourceTimes } from '@producer/core'
import { Film, Image as ImageIcon, Music, Replace, ScanLine } from 'lucide-react'
import { create } from 'zustand'
import { api, waitForJob } from '../lib/api'
import { toast, toastError } from '../lib/toast'
import { LOCKED_NOTE, demoBlocked } from './actions'
import { MenuItem } from './controls'
import { EditorDialog } from './Dialogs'
import { thumbUrl } from './media'
import { useEditor } from './store'
import { shortDuration } from './timelineMath'
import { libraryAssets, useLibrary } from './uploads'

const S = () => useEditor.getState()

const REFUSED: Record<ReplaceRefusal, string> = {
  missing: 'Only video, image and audio clips have media to replace',
  locked: LOCKED_NOTE,
  kind: 'Replace a clip with media of the same kind: a video with a video, a picture with a picture, a sound with a sound',
  same: 'This clip already uses that media',
}

/** Swap the clip's media, keeping its timing, effects and keyframes. Says why when it can't. */
export function replaceMedia(itemId: string, asset: Asset): boolean {
  const s = S()
  const why = replaceRefusal(s.project, itemId, asset)
  if (why) {
    toast(REFUSED[why])
    return false
  }
  const r = replaceClipMedia(s.project, itemId, asset)
  s.commit(r.project, 'Replace media', { selection: [itemId] })
  if (r.shortened) toast(`${asset.name} is shorter than the clip, so the clip is shorter now`)
  return true
}

/** Whether a library item dropped on this clip with Alt held would replace its media. */
export function canDropReplace(itemId: string, asset: Asset): boolean {
  return replaceRefusal(S().project, itemId, asset) === null
}

/** Ask the server where the clip's picture changes, then split the clip at each change. */
export async function splitAtScenes(itemId: string) {
  if (demoBlocked('scene detection')) return
  const s = S()
  const it = findItem(s.project, itemId)?.item
  if (it?.type !== 'video') return toast('Scene detection works on video clips')
  if (!isEditable(s.project, itemId)) return toast(LOCKED_NOTE)
  if (it.freezeAt !== undefined) return toast('A freeze frame shows one picture: there are no scene changes to split at')
  const session = s.session
  const from = it.in
  const to = it.in + it.duration * it.speed
  try {
    toast('Looking for scene changes…')
    const job = await api.detectScenes(it.assetId, { from, to })
    const done = await waitForJob<SceneCuts>(job.id)
    const now = S()
    // another project opened, or the clip went away, meanwhile
    if (now.session !== session || !findItem(now.project, itemId)) return
    const r = splitAtSourceTimes(now.project, itemId, done.result?.cuts ?? [])
    if (!r.count) return toast('No scene changes found in this clip')
    now.commit(r.project, 'Split at scene changes')
    toast(`Split at ${r.count} scene change${r.count > 1 ? 's' : ''}`)
  } catch (e) {
    toastError(e, 'Couldn’t find the scene changes')
  }
}

/** The clip menu's entries: Replace media… for any media clip, Split at scene changes for a video. */
export function ClipMediaMenuItems({ item, run }: { item: Item; run: (fn: () => void) => () => void }) {
  if (item.type !== 'video' && item.type !== 'image' && item.type !== 'audio') return null
  return (
    <>
      <div className="ed-menu-sep" />
      <MenuItem icon={<Replace size={14} />} label="Replace media…" kbd="Alt drop" onClick={run(() => openReplace(item.id))} />
      {item.type === 'video' && item.freezeAt === undefined && <MenuItem icon={<ScanLine size={14} />} label="Split at scene changes" onClick={run(() => void splitAtScenes(item.id))} />}
    </>
  )
}

/** Which clip's media the replace dialog is choosing for. */
export const useReplace = create<{ itemId: string | null }>(() => ({ itemId: null }))
export const openReplace = (itemId: string) => useReplace.setState({ itemId })

export function ReplaceMediaHost() {
  const itemId = useReplace((s) => s.itemId)
  return itemId ? <ReplaceMediaDialog itemId={itemId} /> : null
}

const KIND_ICON = { video: Film, image: ImageIcon, audio: Music }

function ReplaceMediaDialog({ itemId }: { itemId: string }) {
  const item = useEditor((s) => findItem(s.project, itemId)?.item)
  useLibrary((s) => s.records)
  const close = () => useReplace.setState({ itemId: null })
  const kind = item && 'assetId' in item ? item.type : null
  const current = item && 'assetId' in item ? item.assetId : null
  const list = kind ? libraryAssets([kind]).filter((x) => x.asset.id !== current && x.status === 'ready') : []
  const kindName = kind === 'image' ? 'picture' : kind ?? 'clip'
  return (
    <EditorDialog title={`Replace ${kindName}`} onClose={close} style={{ maxWidth: 560 }}>
      <div className="ed-replace">
        <p className="ed-note">The clip keeps its place, length, effects, keyframes and transitions; only its media changes.</p>
        {!kind && <p className="ed-note">This clip is gone.</p>}
        {kind && !list.length && <p className="ed-note">No other {kindName}s in the media library yet. Upload one first.</p>}
        <ul className="ed-replace-list" aria-label={`${kindName[0].toUpperCase()}${kindName.slice(1)}s in the media library`}>
          {list.map(({ asset }) => {
            const Icon = KIND_ICON[asset.kind]
            const thumb = thumbUrl(asset)
            return (
              <li key={asset.id}>
                <button
                  type="button"
                  className="ed-replace-item"
                  onClick={() => {
                    if (replaceMedia(itemId, asset)) close()
                  }}
                >
                  <span className="th" style={thumb ? { backgroundImage: `url("${thumb}")` } : undefined}>{!thumb && <Icon size={16} />}</span>
                  <span className="nm">{asset.name}</span>
                  {asset.duration !== undefined && asset.kind !== 'image' && <span className="sub">{shortDuration(asset.duration)}</span>}
                </button>
              </li>
            )
          })}
        </ul>
      </div>
      <footer>
        <button className="btn sm" onClick={close}>Cancel</button>
      </footer>
    </EditorDialog>
  )
}
