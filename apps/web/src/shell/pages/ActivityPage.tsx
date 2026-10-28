// The space's activity (A-23): what happened, newest first — projects created, renamed and exported, links shared,
// changed and revoked, comments, and member changes — with a link to each project.
import type { ActivityEntry, ActivityKind } from '@producer/core'
import { activitySentence } from '@producer/core'
import { Activity, FilePlus2, Link2, MessageSquare, Pencil, Send, UserCog, UserMinus, UserPlus } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { collabApi } from '../../lib/collabApi'
import { currentWorkspace, useSession } from '../../lib/session'
import { EmptyState, Spinner, usePageTitle } from '../ui'
import { relativeTime } from '../util'
import './activity.css'

const ICON: Record<ActivityKind, ReactNode> = {
  'project.created': <FilePlus2 size={15} />,
  'project.renamed': <Pencil size={15} />,
  'project.exported': <Send size={15} />,
  'share.created': <Link2 size={15} />,
  'share.changed': <Link2 size={15} />,
  'share.revoked': <Link2 size={15} />,
  'comment.added': <MessageSquare size={15} />,
  'member.joined': <UserPlus size={15} />,
  'member.role': <UserCog size={15} />,
  'member.removed': <UserMinus size={15} />,
  'member.left': <UserMinus size={15} />,
}

const FILTERS: Array<{ id: string; label: string; test: (k: ActivityKind) => boolean }> = [
  { id: 'all', label: 'Everything', test: () => true },
  { id: 'project', label: 'Projects', test: (k) => k.startsWith('project.') },
  { id: 'share', label: 'Sharing', test: (k) => k.startsWith('share.') },
  { id: 'comment', label: 'Comments', test: (k) => k.startsWith('comment.') },
  { id: 'member', label: 'Members', test: (k) => k.startsWith('member.') },
]

export default function ActivityPage() {
  usePageTitle('Activity')
  const ws = useSession(currentWorkspace)
  const [items, setItems] = useState<ActivityEntry[]>()
  const [next, setNext] = useState<string>()
  const [error, setError] = useState<string>()
  const [more, setMore] = useState(false)
  const [filter, setFilter] = useState('all')

  useEffect(() => {
    if (!ws) return
    let alive = true
    setItems(undefined)
    setError(undefined)
    collabApi
      .activity(ws.id)
      .then((p) => {
        if (!alive) return
        setItems(p.items)
        setNext(p.nextCursor)
      })
      .catch((e) => alive && setError(e instanceof Error ? e.message : String(e)))
    return () => {
      alive = false
    }
  }, [ws])

  async function loadMore() {
    if (!ws || !next) return
    setMore(true)
    try {
      const p = await collabApi.activity(ws.id, next)
      setItems((cur) => [...(cur ?? []), ...p.items])
      setNext(p.nextCursor)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setMore(false)
    }
  }

  const test = FILTERS.find((f) => f.id === filter)!.test
  const shown = (items ?? []).filter((e) => test(e.kind))

  return (
    <div className="ps-page narrow">
      <div className="ps-page-head">
        <div>
          <span className="eyebrow">{ws?.name ?? 'Space'}</span>
          <h1>Activity</h1>
          <p>What happened in this space: projects made, renamed and exported, links shared, comments and member changes.</p>
        </div>
      </div>
      <div className="row ps-activity-filters" role="group" aria-label="Show">
        {FILTERS.map((f) => (
          <button key={f.id} type="button" className={`chip${filter === f.id ? ' active' : ''}`} aria-pressed={filter === f.id} onClick={() => setFilter(f.id)}>
            {f.label}
          </button>
        ))}
      </div>
      {error ? (
        <div className="ps-alert" role="alert">Couldn’t load the activity: {error}</div>
      ) : !items ? (
        <Spinner size={20} />
      ) : !shown.length ? (
        <EmptyState icon={<Activity size={24} />} title={items.length ? 'Nothing of that kind yet' : 'Nothing yet'} body="Make, export or share a project, or invite someone, and it shows here." />
      ) : (
        <ol className="ps-activity" aria-label="Activity, newest first">
          {shown.map((e) => (
            <li key={e.id} className="ps-activity-item">
              <span className="ps-activity-icon" aria-hidden="true">{ICON[e.kind] ?? <Activity size={15} />}</span>
              <span className="ps-activity-text">
                {activitySentence(e)}
                {e.projectId && e.kind !== 'share.revoked' && (
                  <>
                    {' · '}
                    <Link to={`/edit/${e.projectId}`} className="ps-link" aria-label={`Open ${String(e.data.project ?? e.data.to ?? 'the project')}`}>Open</Link>
                  </>
                )}
              </span>
              <time dateTime={new Date(e.createdAt).toISOString()} title={new Date(e.createdAt).toLocaleString()}>{relativeTime(e.createdAt)}</time>
            </li>
          ))}
        </ol>
      )}
      {next && items && (
        <div className="row" style={{ justifyContent: 'center', marginTop: 12 }}>
          <button className="btn" onClick={() => void loadMore()} disabled={more}>{more && <Spinner size={13} />} Show older</button>
        </div>
      )}
    </div>
  )
}
