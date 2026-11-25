// Making a library item a space's own (21 Nov 2026, the owner: "The clips and samples should be available for users to
// insert into their videos and customize based on their needs/brand/topic", and then "the branding doesn't need to
// affect the animations so much as the Narrative Text, Titles, Thumbnail, company stamp/logo"):
//   In your brand (a clip): the clip goes on the timeline with a title, a line of narrative text and the brand's logo
//     stamp laid over it in the brand kit's fonts and colours (libraryBrand.ts); free, and all editable after.
//   For your topic: the item remade about the video's topic on the space's own AI keys (a library.custom job); it says
//     what it costs before it starts.
// What either makes goes into the space's media and onto the timeline at the playhead.
import { type Asset, type AssetRecord, type AudioItem, type BrandKitDoc, type Job, type LibraryClip, type LibraryTrack, aspectOf, itemEnd, libraryCustomCost, updateItem } from '@producer/core'
import { Loader2, Palette, Sparkles } from 'lucide-react'
import { useEffect, useState } from 'react'
import { api, waitForJob } from '../lib/api'
import { toast, toastError } from '../lib/toast'
import * as A from './actions'
import { EditorDialog } from './Dialogs'
import { addClipInBrand } from './libraryBrand'
import { useEditor } from './store'
import { upsertRecord } from './uploads'
import { useSystem } from '../shell/system'

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

/** The space's brand kit and its logo (when the kit has one), for "In your brand". */
function useBrand(enabled: boolean) {
  const workspaceId = useEditor((s) => s.workspaceId)
  const [brand, setBrand] = useState<BrandKitDoc | null | undefined>(undefined)
  const [logo, setLogo] = useState<Asset | undefined>()
  useEffect(() => {
    if (!enabled || !workspaceId) return
    let live = true
    api
      .brand(workspaceId)
      .then(async (b) => {
        if (!live) return
        setBrand(b)
        if (b.logoAssetId) {
          const rec = await api.asset(b.logoAssetId).catch(() => undefined)
          if (live && rec) setLogo(rec.asset)
        }
      })
      .catch(() => live && setBrand(null))
    return () => {
      live = false
    }
  }, [enabled, workspaceId])
  return { brand, logo }
}

export function LibraryCustomize({ item, onClose }: { item: CustomizableItem; onClose: () => void }) {
  const desktop = useSystem((s) => s.info?.mode === 'desktop')
  const isClip = item.kind !== 'music'
  const { brand, logo } = useBrand(isClip)
  const [title, setTitle] = useState('')
  const [text, setText] = useState('')
  const [stamp, setStamp] = useState(true)
  const [topic, setTopic] = useState('')
  const [busy, setBusy] = useState<'brand' | 'topic' | null>(null)
  const [progress, setProgress] = useState<{ p: number; message: string } | null>(null)
  const [error, setError] = useState<string>()

  async function inBrand() {
    if (A.demoBlocked('adding library clips in your brand') || !brand || item.kind === 'music') return
    const s = useEditor.getState()
    if (!s.workspaceId) return
    setBusy('brand')
    setError(undefined)
    try {
      const rec = await api.addLibraryClip(item.id, { workspaceId: s.workspaceId, projectId: s.projectId || undefined })
      upsertRecord(rec)
      addClipInBrand(rec.asset, brand, { title, text, stamp }, logo)
      toast(`Added “${item.title}” in your brand at the playhead`)
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      toastError(e)
    } finally {
      setBusy(null)
    }
  }

  async function forTopic() {
    if (A.demoBlocked('making library items your own')) return
    const s = useEditor.getState()
    if (!s.workspaceId) return
    setBusy('topic')
    setError(undefined)
    setProgress({ p: 0, message: 'Starting' })
    try {
      const aspect = aspectOf(s.project)
      const job = await api.customizeLibrary(item.kind === 'music' ? 'music' : 'clip', item.id, {
        workspaceId: s.workspaceId,
        projectId: s.projectId || undefined,
        mode: 'topic',
        topic: topic.trim(),
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
    <EditorDialog title={`Make “${item.title}” your own`} onClose={() => (busy ? undefined : onClose())} canClose={!busy} style={{ maxWidth: 540 }}>
      <div className="ed-help ed-custom">
        {isClip && (
          <section aria-label="In your brand">
            <div className="eyebrow">In your brand</div>
            {brand === undefined ? (
              <p className="muted">
                <Loader2 size={12} className="spin" /> Loading your brand kit…
              </p>
            ) : brand === null ? (
              <p className="muted">This space has no brand kit yet: set one up on the Brand kit page.</p>
            ) : (
              <>
                <p>
                  The clip with your words and mark over it, in {brand.fonts.headline} and your brand colours. Free, and you can change any of it on the timeline after.
                </p>
                <label className="ed-custom-label" htmlFor="lib-title">
                  Title (optional)
                </label>
                <input id="lib-title" className="ed-input" maxLength={80} placeholder="e.g. Spring launch" value={title} onChange={(e) => setTitle(e.target.value)} disabled={!!busy} />
                <label className="ed-custom-label" htmlFor="lib-text">
                  Narrative text (optional)
                </label>
                <textarea id="lib-text" className="ed-input" rows={2} maxLength={160} placeholder="e.g. Faster checkout for every customer" value={text} onChange={(e) => setText(e.target.value)} disabled={!!busy} />
                <label className="ed-custom-check">
                  <input type="checkbox" checked={stamp} onChange={(e) => setStamp(e.target.checked)} disabled={!!busy} />
                  {logo ? 'Stamp your logo in the corner' : `Stamp “${brand.name}” in the corner (add a logo on the Brand kit page to stamp that instead)`}
                </label>
                <button type="button" className="btn sm" disabled={!!busy} onClick={() => void inBrand()}>
                  {busy === 'brand' ? <Loader2 size={13} className="spin" /> : <Palette size={13} />} Add it in my brand
                </button>
              </>
            )}
          </section>
        )}
        {/* remaking an item reads the library's own files: on producerstudio.app only, not in the desktop app */}
        {!desktop && <section aria-label="For your topic">
          <div className="eyebrow">For your topic</div>
          <label className="ed-custom-label" htmlFor="lib-topic">
            What is your video about?
          </label>
          <textarea id="lib-topic" className="ed-input" rows={2} maxLength={300} placeholder={item.kind === 'music' ? 'e.g. a calm yoga studio, or a product launch' : 'e.g. our new electric bike'} value={topic} onChange={(e) => setTopic(e.target.value)} disabled={!!busy} />
          <p className="muted">
            {item.kind === 'music' ? 'The song is written again in the same genre, to suit it.' : 'It is made again about this, keeping the style and the kind of motion.'} {libraryCustomCost(item)}
          </p>
          <button type="button" className="btn sm primary" disabled={!!busy || !topicOk} onClick={() => void forTopic()}>
            <Sparkles size={13} /> Remake it for this topic
          </button>
        </section>}
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
