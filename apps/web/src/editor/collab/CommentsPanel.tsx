// The editor's Comments panel (E-22): review threads pinned to times (and points on the frame), from the team and
// from share-page visitors. Everyone who can open the project comments here, viewers included.
import { COMMENT_MAX, threadsOf } from '@producer/core'
import { MapPin, MessageSquare } from 'lucide-react'
import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { useSession } from '../../lib/session'
import { clock, CommentThreadView } from '../../shell/components/CommentThreads'
import * as A from '../actions'
import { Empty } from '../controls'
import { useEditor } from '../store'
import { addComment, removeComment, resolveComment, useComments } from './comments'
import './collab.css'

export function CommentsPanel() {
  const id = useId()
  const demo = useEditor((s) => s.demo)
  const playhead = useEditor((s) => Math.floor(s.playhead))
  const readOnly = useEditor((s) => s.readOnly)
  const tip = useEditor((s) => s.readOnlyTip)
  const me = useSession((s) => s.user?.id)
  const { list, loading, error, showResolved, activeId, picking, point } = useComments()
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const all = useMemo(() => threadsOf(list), [list])
  const open = all.filter((t) => !t.resolved)
  const threads = showResolved ? all : open
  const listRef = useRef<HTMLUListElement>(null)

  // a thread picked on the ruler scrolls into view
  useEffect(() => {
    if (!activeId) return
    const el = [...(listRef.current?.querySelectorAll<HTMLElement>('[data-comment]') ?? [])].find((x) => x.dataset.comment === activeId)
    el?.scrollIntoView?.({ block: 'nearest' })
  }, [activeId])

  if (demo) return <Empty icon={<MessageSquare size={20} />} title="Sign in to comment">Review comments are kept with a project on the server, so the demo has none.</Empty>

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!text.trim()) return
    setBusy(true)
    if (await addComment(text.trim())) setText('')
    setBusy(false)
  }
  const seek = (t: number) => {
    useEditor.getState().setPlaying(false)
    A.seek(t)
  }

  return (
    <div className="ed-comments">
      <form className="ps-cm-compose" onSubmit={submit} aria-label="Add a comment">
        <label className="ps-cm-sr" htmlFor={`${id}-body`}>Comment at {clock(playhead)}</label>
        <textarea
          id={`${id}-body`}
          className="input"
          rows={3}
          maxLength={COMMENT_MAX}
          placeholder={`Comment at ${clock(playhead)}…`}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) void submit(e)
          }}
        />
        <div className="ps-cm-compose-row">
          <button
            type="button"
            className="btn sm ghost"
            aria-pressed={picking || !!point}
            onClick={() => useComments.getState().set(point ? { point: undefined } : { picking: !picking })}
            data-tip={point ? 'Remove the point' : 'Point at the frame'}
            data-tip-desc="Click the canvas where the comment is about. The pin shows there around this moment."
          >
            <MapPin size={12} /> {point ? 'Pinned on the frame' : picking ? 'Click the canvas…' : 'Point at the frame'}
          </button>
          <span className="spacer" />
          <button type="submit" className="btn sm primary" disabled={busy || !text.trim()} data-tip-kbd="Ctrl+Enter">Comment</button>
        </div>
      </form>
      <div className="ed-comments-head">
        <span className="muted">{open.length} open{all.length > open.length ? `, ${all.length - open.length} resolved` : ''}</span>
        <span className="spacer" />
        <label className="ed-comments-toggle">
          <input type="checkbox" checked={showResolved} onChange={(e) => useComments.getState().set({ showResolved: e.target.checked })} /> Show resolved
        </label>
      </div>
      {error && <p className="ps-field-err" role="alert">{error}</p>}
      {loading ? (
        <p className="muted">Loading comments…</p>
      ) : threads.length ? (
        <ul className="ps-cm-list" ref={listRef} aria-label="Comment threads">
          {threads.map((t) => {
            const canResolve = !readOnly || (!!me && t.author.id === me)
            return (
              <CommentThreadView
                key={t.id}
                thread={t}
                active={t.id === activeId}
                actions={{
                  onSeek: (at) => {
                    useComments.getState().set({ activeId: t.id })
                    seek(at)
                  },
                  onReply: async (body) => void (await addComment(body, { parentId: t.id })),
                  onResolve: (r) => resolveComment(t.id, r),
                  resolveTip: canResolve ? undefined : tip,
                  onDelete: (c) => removeComment(c.id),
                }}
              />
            )
          })}
        </ul>
      ) : (
        <Empty icon={<MessageSquare size={20} />} title={all.length ? 'Every thread is resolved' : 'No comments yet'}>
          Move the playhead to a moment and say what should change. Comments from a share link land here too.
        </Empty>
      )}
    </div>
  )
}
