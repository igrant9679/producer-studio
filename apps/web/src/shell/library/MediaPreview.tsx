// A clip's preview in the Library (A-15): next / previous through what the grid shows (buttons and the arrow keys),
// its transcript (click a line to play from there), "Use in a new project" and the original's download.
import type { AssetRecord, Transcript } from '@producer/core'
import { AudioLines, ChevronLeft, ChevronRight, Clapperboard, Download } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { api, mediaUrl } from '../../lib/api'
import { ORIGIN_LABEL } from '../pages/libraryLogic'
import { Modal, Spinner } from '../ui'
import { downloadUrl, formatBytes, formatDuration } from '../util'

export function MediaPreview({ a, list, onMove, onClose, onUse, canEdit, startAt }: {
  a: AssetRecord
  /** What the grid shows, in order: the arrows step through it. */
  list: AssetRecord[]
  onMove: (to: AssetRecord) => void
  onClose: () => void
  /** "Use in a new project" (editors). */
  onUse?: (a: AssetRecord) => void
  canEdit: boolean
  /** Seconds to start from (a search hit's words). */
  startAt?: number
}) {
  const k = a.asset.kind
  const i = list.findIndex((x) => x.asset.id === a.asset.id)
  const prev = i > 0 ? list[i - 1] : undefined
  const next = i >= 0 && i < list.length - 1 ? list[i + 1] : undefined
  const media = useRef<HTMLVideoElement & HTMLAudioElement>(null)
  // the full record has the transcript (lists carry light ones)
  const [transcript, setTranscript] = useState<Transcript | null | undefined>(a.asset.transcript)
  useEffect(() => {
    let alive = true
    setTranscript(a.asset.transcript)
    if (!a.asset.transcript && a.transcriptRev && k !== 'image')
      api
        .asset(a.asset.id)
        .then((full) => alive && setTranscript(full.asset.transcript ?? null))
        .catch(() => alive && setTranscript(null))
    return () => {
      alive = false
    }
  }, [a.asset.id, a.asset.transcript, a.transcriptRev, k])
  useEffect(() => {
    if (startAt && media.current) media.current.currentTime = startAt
  }, [startAt, a.asset.id])
  const seek = (t: number) => {
    const m = media.current
    if (!m) return
    m.currentTime = t
    void m.play?.()?.catch?.(() => undefined)
  }
  return (
    <Modal
      title={a.asset.name}
      subtitle={`${ORIGIN_LABEL[a.origin] ?? a.origin} · ${formatBytes(a.asset.sizeBytes)}${a.asset.duration ? ` · ${formatDuration(a.asset.duration)}` : ''}${a.asset.width ? ` · ${a.asset.width}×${a.asset.height}` : ''}${list.length > 1 && i >= 0 ? ` · ${i + 1} of ${list.length}` : ''}`}
      onClose={onClose}
      width={900}
      className="ps-media-preview"
    >
      <div
        className="ps-preview-wrap"
        onKeyDown={(e) => {
          const t = e.target as HTMLElement
          if (/INPUT|TEXTAREA/.test(t.tagName)) return
          if (e.key === 'ArrowLeft' && prev && t.tagName !== 'VIDEO' && t.tagName !== 'AUDIO') {
            e.preventDefault()
            onMove(prev)
          } else if (e.key === 'ArrowRight' && next && t.tagName !== 'VIDEO' && t.tagName !== 'AUDIO') {
            e.preventDefault()
            onMove(next)
          }
        }}
      >
        <button className="btn icon ps-preview-nav prev" onClick={() => prev && onMove(prev)} disabled={!prev} aria-label={prev ? `Previous: ${prev.asset.name}` : 'Previous'} data-tip="Previous" data-tip-kbd="←">
          <ChevronLeft size={18} />
        </button>
        <div className="ps-preview" key={a.asset.id}>
          {k === 'video' && <video ref={media} src={mediaUrl(a.asset.id, 'proxy')} poster={mediaUrl(a.asset.id, 'thumb')} controls autoPlay playsInline onError={(e) => { const v = e.currentTarget; if (!v.dataset.fallback) { v.dataset.fallback = '1'; v.src = mediaUrl(a.asset.id, 'source') } }} />}
          {k === 'audio' && (
            <div className="ps-preview-audio">
              <AudioLines size={46} />
              <audio ref={media} src={mediaUrl(a.asset.id, 'source')} controls autoPlay style={{ width: '100%' }} />
            </div>
          )}
          {k === 'image' && <img src={mediaUrl(a.asset.id, 'source')} alt={a.asset.name} />}
        </div>
        <button className="btn icon ps-preview-nav next" onClick={() => next && onMove(next)} disabled={!next} aria-label={next ? `Next: ${next.asset.name}` : 'Next'} data-tip="Next" data-tip-kbd="→">
          <ChevronRight size={18} />
        </button>
      </div>
      {k !== 'image' && (
        <section className="ps-preview-transcript" aria-label="Transcript">
          {transcript === undefined && a.transcriptRev ? (
            <div className="row muted"><Spinner size={14} /> Loading the transcript…</div>
          ) : transcript?.segments.length ? (
            <ol>
              {transcript.segments.map((s, n) => (
                <li key={n}>
                  <button type="button" className="ps-preview-line" onClick={() => seek(s.start)} aria-label={`Play from ${formatDuration(s.start)}: ${s.text}`}>
                    <span className="mono muted">{formatDuration(s.start)}</span> {s.speaker && <strong>{s.speaker}: </strong>}
                    {s.text}
                  </button>
                </li>
              ))}
            </ol>
          ) : (
            <p className="muted">No transcript yet. Open the clip in the editor to transcribe it.</p>
          )}
        </section>
      )}
      <div className="row" style={{ justifyContent: 'flex-end', marginTop: 14, flexWrap: 'wrap' }}>
        {onUse && (
          <button className="btn" disabled={!canEdit} onClick={() => onUse(a)}>
            <Clapperboard size={14} /> Use in a new project
          </button>
        )}
        <a className="btn" href={downloadUrl(mediaUrl(a.asset.id, 'source'))} download><Download size={14} /> Download original</a>
      </div>
    </Modal>
  )
}
