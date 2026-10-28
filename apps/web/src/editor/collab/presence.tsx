// Who else has this project open (A-23): the editor beats every PRESENCE_BEAT_MS while open, says goodbye when it
// closes, and `presence` live updates keep the avatars in the top bar current.
import type { PresenceEntry, ProjectPresence } from '@producer/core'
import { PRESENCE_BEAT_MS } from '@producer/core'
import { create } from 'zustand'
import { collabApi } from '../../lib/collabApi'
import { useSession } from '../../lib/session'
import './collab.css'

interface PresenceState {
  projectId?: string
  people: PresenceEntry[]
}

export const usePresence = create<PresenceState>(() => ({ people: [] }))

/** This tab, so one person's two tabs count once and closing one leaves the other. */
const client = `t${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`

export function onPresenceEvent(p: ProjectPresence) {
  if (p.projectId === usePresence.getState().projectId) usePresence.setState({ people: p.people })
}

/** Beat while the project is open here. Returns the goodbye. */
export function startPresence(projectId: string): () => void {
  usePresence.setState({ projectId, people: [] })
  let stopped = false
  const beat = () => {
    collabApi
      .beat(projectId, client)
      .then((p) => !stopped && onPresenceEvent(p))
      .catch(() => undefined)
  }
  beat()
  const timer = setInterval(beat, PRESENCE_BEAT_MS)
  const onVisible = () => document.visibilityState === 'visible' && beat()
  // closing the tab: a request that outlives the page
  const goodbye = () => {
    void fetch(`/api/projects/${encodeURIComponent(projectId)}/presence`, { method: 'POST', credentials: 'include', keepalive: true, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client, open: false }) }).catch(() => undefined)
  }
  document.addEventListener('visibilitychange', onVisible)
  window.addEventListener('pagehide', goodbye)
  return () => {
    stopped = true
    clearInterval(timer)
    document.removeEventListener('visibilitychange', onVisible)
    window.removeEventListener('pagehide', goodbye)
    goodbye()
    if (usePresence.getState().projectId === projectId) usePresence.setState({ projectId: undefined, people: [] })
  }
}

const ROLE: Record<string, string> = { owner: 'owner', editor: 'editor', viewer: 'viewing' }

/** The top bar's avatars: everyone else who has this project open now. */
export function PresenceAvatars() {
  const people = usePresence((s) => s.people)
  const me = useSession((s) => s.user?.id)
  const others = people.filter((p) => p.userId !== me)
  if (!others.length) return null
  const names = others.map((p) => `${p.name}${p.role ? ` (${ROLE[p.role] ?? p.role})` : ''}`)
  const label = `${others.length === 1 ? '1 other person has' : `${others.length} other people have`} this project open: ${names.join(', ')}`
  const shown = others.slice(0, 4)
  return (
    <div className="ed-presence" role="group" aria-label={label} data-tip="Also here now" data-tip-desc={names.join(', ')}>
      {shown.map((p) => (
        <span key={p.userId} className="ed-presence-av" style={{ background: p.color }} aria-hidden="true">
          {(p.name.trim()[0] ?? '?').toUpperCase()}
        </span>
      ))}
      {others.length > shown.length && (
        <span className="ed-presence-av ed-presence-more" aria-hidden="true">
          +{others.length - shown.length}
        </span>
      )}
    </div>
  )
}
