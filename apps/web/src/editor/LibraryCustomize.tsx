// Making a library item a space's own (21 Nov 2026, the owner: "The clips and samples should be available for users to
// insert into their videos and customize based on their needs/brand/topic"): an animation drawn again in the space's
// brand colours and fonts (free), or any item remade for the video's topic on the space's own AI keys. Each says what
// it costs before it starts; what it makes goes into the space's media and onto the timeline at the playhead.
import { type AssetRecord, type Job, type LibraryClip, type LibraryCustomMode, type LibraryTrack, aspectOf, itemEnd, libraryCustomCost, updateItem, type AudioItem } from '@producer/core'
import { Palette, Sparkles } from 'lucide-react'
import { useState } from 'react'
import { api, waitForJob } from '../lib/api'
import { toast, toastError } from '../lib/toast'
import * as A from './actions'
import { EditorDialog } from './Dialogs'
import { useEditor } from './store'
import { upsertRecord } from './uploads'

export type CustomizableItem = ({ kind: 'music' } & LibraryTrack) | LibraryClip

/**
 * A song put at the playhead ends with the video: cut where the last picture ends, with a fade out (free; a song
 * shorter than what is left is kept whole).
 */
export function fitSongToVideo(itemId: string | undefined) {
  if (!itemId) return
  const s = useEditor.getState()
  const p = s.project
  const item = p.tracks.flatMap((t) => t.items).find((i) => i.id === itemId) as AudioItem | undefined
  if (!item || item.type !== 'audio') return
  const end = Math.max(0, ...p.tracks.filter((t) => t.kind !== 'audio').flatMap((t) => t.items.map(itemEnd)))
  const room = end - item.start
  if (room < 4 || itemEnd(item) <= end) return
  s.commit(updateItem<AudioItem>(p, itemId, { duration: Math.round(room * 1000) / 1000, fadeOut: Math.min(2, room / 3) }), 'Fit the music to the video')
}

export function LibraryCustomize({ item, onClose }: { item: CustomizableItem; onClose: () => void }) {
  const [topic, setTopic] = useState('')
  const [busy, setBusy] = useState<LibraryCustomMode | null>(null)
  const [progress, setProgress] = useState<{ p: number; message: string } | null>(null)
  const [error, setError] = useState<string>()
  const canBrand = item.kind === 'animation'
  async function go(mode: LibraryCustomMode) {
    if (A.demoBlocked('making library items your own')) return
    const s = useEditor.getState()
    if (!s.workspaceId) return
    setBusy(mode)
    setError(undefined)
    setProgress({ p: 0, message: 'Starting' })
    try {
      const aspect = aspectOf(s.project)
      const job = await api.customizeLibrary(item.kind === 'music' ? 'music' : 'clip', item.id, {
        workspaceId: s.workspaceId,
        projectId: s.projectId || undefined,
        mode,
        ...(mode === 'topic' ? { topic: topic.trim() } : {}),
        ...(aspect === '16:9' || aspect === '9:16' || aspect === '1:1' ? { aspect } : {}),
      })
      const done = await waitForJob<{ asset: AssetRecord }>(job.id, (j: Job<{ asset: AssetRecord }>) => setProgress({ p: Math.max(0, j.progress), message: j.message }), 1500, { patienceMs: 60_000 })
      if (done.status !== 'done' || !done.result?.asset) throw new Error(done.error || 'It couldn’t be made. Try again in a minute.')
      const rec = done.result.asset
      upsertRecord(rec)
      const id = A.addAssetAt(rec.asset, useEditor.getState().playhead)
      if (item.kind === 'music') fitSongToVideo(id)
      toast(`Added “${rec.asset.name}” at the playhead`)
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      toastError(e)
    } finally {
      setBusy(null)
      setProgress(null)
    }
  }
  const topicOk = topic.trim().length >= 3
  return (
    <EditorDialog title={`Make “${item.title}” your own`} onClose={() => (busy ? undefined : onClose())} canClose={!busy} style={{ maxWidth: 520 }}>
      <div className="ed-help ed-custom">
        {canBrand && (
          <section aria-label="In your brand">
            <div className="eyebrow">In your brand</div>
            <p>Drawn again in your brand kit’s colours and fonts (Brand tab). {libraryCustomCost(item, 'brand')}</p>
            <button type="button" className="btn sm" disabled={!!busy} onClick={() => void go('brand')}>
              <Palette size={13} /> Draw it in my brand
            </button>
          </section>
        )}
        <section aria-label="For your topic">
          <div className="eyebrow">For your topic</div>
          <label className="ed-custom-label" htmlFor="lib-topic">
            What is your video about?
          </label>
          <textarea id="lib-topic" className="ed-input" rows={2} maxLength={300} placeholder={item.kind === 'music' ? 'e.g. a calm yoga studio, or a product launch' : 'e.g. our new electric bike'} value={topic} onChange={(e) => setTopic(e.target.value)} disabled={!!busy} />
          <p className="muted">
            {item.kind === 'music' ? 'The song is written again in the same genre, to suit it.' : 'It is made again about this, keeping the style and the kind of motion.'} {libraryCustomCost(item, 'topic')}
          </p>
          <button type="button" className="btn sm primary" disabled={!!busy || !topicOk} onClick={() => void go('topic')}>
            <Sparkles size={13} /> Remake it for this topic
          </button>
        </section>
        {progress && (
          <div role="status" className="ed-custom-progress">
            <div className="ed-bar">
              <div style={{ width: `${Math.round(progress.p * 100)}%` }} />
            </div>
            <span className="muted">{progress.message || 'Working on it'}</span>
          </div>
        )}
        {error && (
          <p className="ed-note ed-note-warn" role="alert">
            {error}
          </p>
        )}
      </div>
    </EditorDialog>
  )
}
