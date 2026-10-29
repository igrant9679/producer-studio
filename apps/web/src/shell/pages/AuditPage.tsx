// A space's audit log (P-8), for its owners: who invited, removed or changed whom, handed the space over, or changed
// its AI keys, with when and from where. Beside the Activity page (SpaceLogTabs).
import type { AuditEntry, AuditKind } from '@producer/core'
import { auditSentence } from '@producer/core'
import { KeyRound, Lock, ShieldCheck, Sparkles, Trash2, UserCog, UserMinus, UserPlus } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import { opsApi } from '../../lib/opsApi'
import { currentWorkspace, useSession } from '../../lib/session'
import { SpaceLogTabs } from '../components/SpaceLogTabs'
import { EmptyState, Spinner, usePageTitle } from '../ui'
import { relativeTime } from '../util'
import './activity.css'

const ICON: Partial<Record<AuditKind, ReactNode>> = {
  'invite.created': <UserPlus size={15} />,
  'invite.resent': <UserPlus size={15} />,
  'invite.accepted': <UserPlus size={15} />,
  'invite.withdrawn': <UserMinus size={15} />,
  'member.role': <UserCog size={15} />,
  'member.transfer': <UserCog size={15} />,
  'member.removed': <UserMinus size={15} />,
  'member.left': <UserMinus size={15} />,
  'ai.key.set': <KeyRound size={15} />,
  'ai.key.removed': <KeyRound size={15} />,
  'ai.builtin': <Sparkles size={15} />,
  'workspace.deleted': <Trash2 size={15} />,
}

const FILTERS: Array<{ id: string; label: string; test: (k: AuditKind) => boolean }> = [
  { id: 'all', label: 'Everything', test: () => true },
  { id: 'invite', label: 'Invites', test: (k) => k.startsWith('invite.') },
  { id: 'member', label: 'Members', test: (k) => k.startsWith('member.') },
  { id: 'ai', label: 'AI', test: (k) => k.startsWith('ai.') },
]

/** Where it came from, in a few words (address and browser), for the line under an entry. */
export function auditWhere(e: AuditEntry): string {
  const ua = e.userAgent ?? ''
  const browser = /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : /Electron|ProducerStudio/i.test(ua) ? 'desktop app' : ua.split(/[\s/]/)[0]
  return [e.ip, browser].filter(Boolean).join(' · ')
}

export function AuditList({ items, label }: { items: AuditEntry[]; label: string }) {
  return (
    <ol className="ps-activity" aria-label={label}>
      {items.map((e) => (
        <li key={e.id} className="ps-activity-item">
          <span className="ps-activity-icon" aria-hidden="true">{ICON[e.kind] ?? <ShieldCheck size={15} />}</span>
          <span className="ps-activity-text">
            {auditSentence(e)}
            {(e.ip || e.userAgent || e.requestId) && (
              <span className="ps-audit-meta">
                {auditWhere(e)}
                {e.requestId && <> · reference {e.requestId}</>}
              </span>
            )}
          </span>
          <time dateTime={new Date(e.at).toISOString()} title={new Date(e.at).toLocaleString()}>{relativeTime(e.at)}</time>
        </li>
      ))}
    </ol>
  )
}

export default function AuditPage() {
  usePageTitle('Audit')
  const ws = useSession(currentWorkspace)
  const owner = ws?.role === 'owner'
  const [items, setItems] = useState<AuditEntry[]>()
  const [next, setNext] = useState<string>()
  const [error, setError] = useState<string>()
  const [more, setMore] = useState(false)
  const [filter, setFilter] = useState('all')

  useEffect(() => {
    if (!ws || !owner) return
    let alive = true
    setItems(undefined)
    setNext(undefined)
    setError(undefined)
    opsApi
      .spaceAudit(ws.id)
      .then((p) => {
        if (!alive) return
        setItems(p.items)
        setNext(p.nextCursor)
      })
      .catch((e) => alive && setError(e instanceof Error ? e.message : String(e)))
    return () => {
      alive = false
    }
  }, [ws?.id, owner])

  async function loadMore() {
    if (!ws || !next) return
    setMore(true)
    try {
      const p = await opsApi.spaceAudit(ws.id, { cursor: next })
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
          <h1>Audit</h1>
          <p>Who changed access to this space: invites, roles, hand-overs, people removed, and its AI keys, with when and from where.</p>
        </div>
      </div>
      <SpaceLogTabs />
      {!owner ? (
        <EmptyState icon={<Lock size={24} />} title="Only owners can read the audit log" body="Ask an owner of this space if you need to know who changed its members or keys." />
      ) : (
        <>
          <div className="row ps-activity-filters" role="group" aria-label="Show">
            {FILTERS.map((f) => (
              <button key={f.id} type="button" className={`chip${filter === f.id ? ' active' : ''}`} aria-pressed={filter === f.id} onClick={() => setFilter(f.id)}>
                {f.label}
              </button>
            ))}
          </div>
          {error ? (
            <div className="ps-alert" role="alert">Couldn’t load the audit log: {error}</div>
          ) : !items ? (
            <Spinner size={20} />
          ) : !shown.length ? (
            <EmptyState icon={<ShieldCheck size={24} />} title={items.length ? 'Nothing of that kind yet' : 'Nothing yet'} body="Invite someone, change a role or an AI key, and it shows here." />
          ) : (
            <AuditList items={shown} label="Audit log, newest first" />
          )}
          {next && items && (
            <div className="row" style={{ justifyContent: 'center', marginTop: 12 }}>
              <button className="btn" onClick={() => void loadMore()} disabled={more}>{more && <Spinner size={13} />} Show older</button>
            </div>
          )}
        </>
      )}
    </div>
  )
}
