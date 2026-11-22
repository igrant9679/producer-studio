// Watching a clip before it goes on the timeline (21 Nov 2026, the owner: "I should be able to play/sample the videos in
// the library before deciding to copy them to the timeline"): a player with sound and controls, for the clip library's
// clips and the space's own, with Add at playhead (and Make it your own for a library clip) beside it.
import { Plus, Wand2 } from 'lucide-react'
import { EditorDialog } from './Dialogs'

export function ClipPreview({ title, detail, src, poster, onAdd, onCustomize, onClose }: { title: string; detail?: string; src: string; poster?: string; onAdd?: () => void; onCustomize?: () => void; onClose: () => void }) {
  return (
    <EditorDialog title={title} onClose={onClose} style={{ maxWidth: 760 }}>
      <div className="ed-clip-preview">
        <video src={src} poster={poster} controls autoPlay playsInline aria-label={`${title}, preview`} />
        {detail && <p className="muted">{detail}</p>}
        <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          {onAdd && (
            <button
              type="button"
              className="btn sm primary"
              data-autofocus
              onClick={() => {
                onAdd()
                onClose()
              }}
            >
              <Plus size={13} /> Add at playhead
            </button>
          )}
          {onCustomize && (
            <button
              type="button"
              className="btn sm"
              onClick={() => {
                onClose()
                onCustomize()
              }}
            >
              <Wand2 size={13} /> Make it your own
            </button>
          )}
        </div>
      </div>
    </EditorDialog>
  )
}
