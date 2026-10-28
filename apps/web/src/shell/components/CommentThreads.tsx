// A review comment thread (E-22), shared by the editor's Comments panel and the share page: the time it is pinned to
// (a button that jumps there), who said what, replies, and the actions the reader may take.
import type { CommentThread, ReviewComment } from '@producer/core'
import clsx from 'clsx'
import { Check, CornerDownRight, MapPin, RotateCcw, Trash2 } from 'lucide-react'
import { useId, useState } from 'react'
import { relativeTime } from '../util'
import './comments.css'

/** 0:12 / 1:02:03 with tenths under a minute's precision dropped. */
export function clock(t: number): string {
  const s = Math.max(0, Math.floor(t))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const ss = String(s % 60).padStart(2, '0')
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`
}

function Avatar({ c }: { c: ReviewComment }) {
  return (
    <span className="ps-cm-avatar" style={{ background: c.author.color ?? 'var(--surface-3)' }} aria-hidden="true">
      {(c.author.name.trim()[0] ?? '?').toUpperCase()}
    </span>
  )
}

function Body({ c }: { c: ReviewComment }) {
  return (
    <div className="ps-cm-body">
      <div className="ps-cm-who">
        <Avatar c={c} />
        <b>{c.author.name}</b>
        {c.author.guest && <span className="ps-cm-guest">guest</span>}
        <span className="muted">{relativeTime(c.createdAt)}</span>
      </div>
      <p>{c.body}</p>
    </div>
  )
}

/** How close to a comment's time its pin shows on the picture (seconds either side). */
export const PIN_WINDOW = 1.5

/**
 * Pins over the picture (the share page's video, the editor's canvas): threads with a point near `time`, and while
 * `picking`, a click anywhere sets the new comment's point (0–1 from the top left).
 */
export function CommentPins({ threads, time, picking, point, onPick }: { threads: CommentThread[]; time: number; picking: boolean; point?: { x: number; y: number }; onPick: (p: { x: number; y: number }) => void }) {
  const near = threads.filter((t) => t.x !== undefined && t.y !== undefined && t.at !== undefined && !t.resolved && Math.abs(t.at - time) <= PIN_WINDOW)
  return (
    <div
      className={clsx('ps-cm-pins', picking && 'picking')}
      aria-hidden={!picking}
      role={picking ? 'button' : undefined}
      aria-label={picking ? 'Click the picture where your comment points' : undefined}
      onClick={(e) => {
        if (!picking) return
        e.stopPropagation()
        const r = e.currentTarget.getBoundingClientRect()
        onPick({ x: Math.min(1, Math.max(0, (e.clientX - r.left) / (r.width || 1))), y: Math.min(1, Math.max(0, (e.clientY - r.top) / (r.height || 1))) })
      }}
    >
      {near.map((t, i) => (
        <span key={t.id} className="ps-cm-pin" style={{ left: `${t.x! * 100}%`, top: `${t.y! * 100}%`, background: t.author.color }} title={`${t.author.name}: ${t.body}`}>
          {i + 1}
        </span>
      ))}
      {point && <span className="ps-cm-pin new" style={{ left: `${point.x * 100}%`, top: `${point.y * 100}%` }} />}
    </div>
  )
}

export interface ThreadActions {
  onSeek: (t: number) => void
  onReply?: (body: string) => Promise<void>
  onResolve?: (resolved: boolean) => Promise<void>
  onDelete?: (c: ReviewComment) => Promise<void>
  /** Why actions are closed (a viewer can't resolve someone else's thread), for the tooltip. */
  resolveTip?: string
}

export function CommentThreadView({ thread, active, actions }: { thread: CommentThread; active?: boolean; actions: ThreadActions }) {
  const id = useId()
  const [replying, setReplying] = useState(false)
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const run = async (fn: () => Promise<void>) => {
    setBusy(true)
    try {
      await fn()
    } finally {
      setBusy(false)
    }
  }
  const send = (e: React.FormEvent) => {
    e.preventDefault()
    if (!text.trim() || !actions.onReply) return
    void run(async () => {
      await actions.onReply!(text.trim())
      setText('')
      setReplying(false)
    })
  }
  const where = thread.at !== undefined ? clock(thread.at) : undefined
  return (
    <li className={clsx('ps-cm-thread', thread.resolved && 'resolved', active && 'active')} aria-label={`${where ? `At ${where}: ` : ''}${thread.author.name}${thread.resolved ? ' (resolved)' : ''}`} data-comment={thread.id}>
      <div className="ps-cm-top">
        {where ? (
          <button type="button" className="ps-cm-time" onClick={() => actions.onSeek(thread.at!)} aria-label={`Go to ${where}`}>
            {where}
            {thread.x !== undefined && <MapPin size={11} aria-label="on the frame" />}
          </button>
        ) : (
          <span className="ps-cm-time none">No time</span>
        )}
        <span className="spacer" />
        {thread.resolved && <span className="ps-cm-resolved"><Check size={12} aria-hidden="true" /> Resolved{thread.resolved.by ? ` by ${thread.resolved.by}` : ''}</span>}
        {actions.onResolve && (
          <button type="button" className="btn sm ghost" disabled={busy || !!actions.resolveTip} data-tip={actions.resolveTip} onClick={() => void run(() => actions.onResolve!(!thread.resolved))}>
            {thread.resolved ? <RotateCcw size={12} /> : <Check size={12} />} {thread.resolved ? 'Reopen' : 'Resolve'}
          </button>
        )}
        {actions.onDelete && thread.canDelete && (
          <button type="button" className="btn sm ghost icon" disabled={busy} aria-label={`Delete the comment by ${thread.author.name}${thread.replies.length ? ' and its replies' : ''}`} onClick={() => void run(() => actions.onDelete!(thread))}>
            <Trash2 size={12} />
          </button>
        )}
      </div>
      <Body c={thread} />
      {thread.replies.length > 0 && (
        <ul className="ps-cm-replies" aria-label="Replies">
          {thread.replies.map((r) => (
            <li key={r.id} className="ps-cm-reply">
              <CornerDownRight size={12} className="ps-cm-reply-icon" aria-hidden="true" />
              <Body c={r} />
              {actions.onDelete && r.canDelete && (
                <button type="button" className="btn sm ghost icon" disabled={busy} aria-label={`Delete the reply by ${r.author.name}`} onClick={() => void run(() => actions.onDelete!(r))}>
                  <Trash2 size={12} />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {actions.onReply &&
        (replying ? (
          <form className="ps-cm-replyform" onSubmit={send}>
            <label className="ps-cm-sr" htmlFor={`${id}-r`}>Reply to {thread.author.name}</label>
            <textarea
              id={`${id}-r`}
              className="input"
              rows={2}
              autoFocus
              value={text}
              maxLength={2000}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  e.stopPropagation()
                  setReplying(false)
                }
                if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) send(e)
              }}
            />
            <div className="row" style={{ gap: 6, justifyContent: 'flex-end' }}>
              <button type="button" className="btn sm ghost" onClick={() => setReplying(false)}>Cancel</button>
              <button type="submit" className="btn sm primary" disabled={busy || !text.trim()}>Reply</button>
            </div>
          </form>
        ) : (
          <button type="button" className="btn sm ghost ps-cm-replybtn" onClick={() => setReplying(true)}>Reply</button>
        ))}
    </li>
  )
}
