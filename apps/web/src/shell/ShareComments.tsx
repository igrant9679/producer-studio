// Comments on the share page (E-22), when the link allows them: visitors read the team's threads, jump to their
// moments, and leave their own at the video's current time (optionally on a point of the frame) with their name.
import type { ReviewComment } from '@producer/core'
import { COMMENT_MAX, COMMENT_NAME_MAX, threadsOf } from '@producer/core'
import { MapPin, MessageSquare } from 'lucide-react'
import { useEffect, useId, useMemo, useState, type RefObject } from 'react'
import { create } from 'zustand'
import { shareApi } from '../lib/collabApi'
import { clock, CommentPins, CommentThreadView } from './components/CommentThreads'
import { Spinner } from './ui'

interface ShareCommentState {
  list: ReviewComment[]
  picking: boolean
  point?: { x: number; y: number }
  set: (p: Partial<ShareCommentState>) => void
}

/** Shared by the list under the video and the pins over it. */
const useShareComments = create<ShareCommentState>((set) => ({ list: [], picking: false, set: (p) => set(p) }))

const NAME_KEY = 'ps.share.name'

/** The video's current time, kept up to date. */
function useVideoTime(video: RefObject<HTMLVideoElement>): number {
  const [t, setT] = useState(0)
  useEffect(() => {
    const v = video.current
    if (!v) return
    const on = () => setT(v.currentTime || 0)
    v.addEventListener('timeupdate', on)
    v.addEventListener('seeked', on)
    return () => {
      v.removeEventListener('timeupdate', on)
      v.removeEventListener('seeked', on)
    }
  }, [video])
  return t
}

export function ShareCommentPins({ video }: { video: RefObject<HTMLVideoElement> }) {
  const list = useShareComments((s) => s.list)
  const picking = useShareComments((s) => s.picking)
  const point = useShareComments((s) => s.point)
  const time = useVideoTime(video)
  const threads = useMemo(() => threadsOf(list), [list])
  return <CommentPins threads={threads} time={time} picking={picking} point={point} onPick={(p) => useShareComments.getState().set({ point: p, picking: false })} />
}

export function ShareComments({ token, shareKey, video }: { token: string; shareKey?: string; video: RefObject<HTMLVideoElement> }) {
  const id = useId()
  const list = useShareComments((s) => s.list)
  const point = useShareComments((s) => s.point)
  const picking = useShareComments((s) => s.picking)
  const set = useShareComments((s) => s.set)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string>()
  const [name, setName] = useState(() => {
    try {
      return localStorage.getItem(NAME_KEY) ?? ''
    } catch {
      return ''
    }
  })
  const [text, setText] = useState('')
  const [pinned, setPinned] = useState(true)
  const [busy, setBusy] = useState(false)
  const time = useVideoTime(video)
  const threads = useMemo(() => threadsOf(list), [list])

  useEffect(() => {
    let alive = true
    set({ list: [], point: undefined, picking: false })
    shareApi
      .comments(token, shareKey)
      .then((l) => alive && set({ list: l }))
      .catch((e) => alive && setError(e instanceof Error ? e.message : String(e)))
      .finally(() => alive && setLoading(false))
    return () => {
      alive = false
    }
  }, [token, shareKey, set])

  const seek = (t: number) => {
    const v = video.current
    if (!v) return
    v.currentTime = t
    v.pause()
  }

  async function post(body: string, parentId?: string) {
    const who = name.trim()
    if (!who) throw new Error('Add your name first')
    try {
      localStorage.setItem(NAME_KEY, who)
    } catch {
      /* this visit only */
    }
    const at = video.current?.currentTime ?? time
    const c = await shareApi.addComment(token, { body, name: who, ...(parentId ? { parentId } : pinned ? { at, ...(point ?? {}) } : {}) }, shareKey)
    set({ list: [...useShareComments.getState().list, c], ...(parentId ? {} : { point: undefined }) })
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!text.trim()) return
    setBusy(true)
    setError(undefined)
    try {
      await post(text.trim())
      setText('')
    } catch (e2) {
      setError(e2 instanceof Error ? e2.message : String(e2))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="ps-share-comments" aria-labelledby={`${id}-h`}>
      <h2 id={`${id}-h`}>
        <MessageSquare size={16} aria-hidden="true" /> Comments
      </h2>
      <form className="ps-cm-compose" onSubmit={submit} aria-label="Add a comment">
        <div className="ps-cm-compose-row">
          <label className="label" htmlFor={`${id}-name`} style={{ margin: 0 }}>Your name</label>
          <input id={`${id}-name`} className="input ps-inline-input" value={name} maxLength={COMMENT_NAME_MAX} autoComplete="name" onChange={(e) => setName(e.target.value)} style={{ maxWidth: 220 }} />
        </div>
        <label className="ps-cm-sr" htmlFor={`${id}-body`}>Comment</label>
        <textarea id={`${id}-body`} className="input" rows={3} maxLength={COMMENT_MAX} placeholder="What should change here?" value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && (e.ctrlKey || e.metaKey) && void submit(e)} />
        <div className="ps-cm-compose-row">
          <label className="ps-share-check" style={{ margin: 0 }}>
            <input type="checkbox" checked={pinned} onChange={(e) => setPinned(e.target.checked)} /> At {clock(time)}
          </label>
          <button type="button" className="btn sm ghost" aria-pressed={picking || !!point} disabled={!pinned} onClick={() => set(point ? { point: undefined } : { picking: !picking })}>
            <MapPin size={12} /> {point ? 'Remove the point' : picking ? 'Click the video…' : 'Point at the frame'}
          </button>
          <span className="spacer" />
          <button type="submit" className="btn sm primary" disabled={busy || !text.trim() || !name.trim()}>{busy && <Spinner size={12} />} Comment</button>
        </div>
        {error && <div className="ps-field-err" role="alert">{error}</div>}
      </form>
      {loading ? (
        <Spinner size={18} />
      ) : threads.length ? (
        <ul className="ps-cm-list" aria-label="Comment threads">
          {threads.map((t) => (
            <CommentThreadView key={t.id} thread={t} active={t.at !== undefined && Math.abs(t.at - time) < 1} actions={{ onSeek: seek, onReply: (body) => post(body, t.id) }} />
          ))}
        </ul>
      ) : (
        <p className="muted">No comments yet. Pause where something should change and say what.</p>
      )}
    </section>
  )
}
