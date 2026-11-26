// Settings → Space: the space's membership, bought on the membership website (meyousocial.com). Shows the plan and
// whether it is active; an owner of a space without an active one goes to the website with a claim, so what they buy
// there lands on this space (routes/workspaces.ts membership/claim, docs/integrations/meyousocial.md).
import { BadgeCheck, ExternalLink, Sparkles } from 'lucide-react'
import { useState } from 'react'
import type { SpaceMembershipResponse } from '@producer/core'
import { api } from '../../lib/api'
import { toastError } from '../../lib/toast'
import { Spinner, useAsync } from '../ui'

const STATUS: Record<NonNullable<SpaceMembershipResponse['membership']>['status'], string> = {
  active: 'Active',
  past_due: 'Payment due',
  paused: 'Paused',
  cancelled: 'Cancelled',
  expired: 'Ended',
}

const title = (s: string) => s.replace(/(^|-)(\w)/g, (_m, sep: string, c: string) => `${sep ? ' ' : ''}${c.toUpperCase()}`)

export function SpaceMembership({ workspaceId }: { workspaceId: string }) {
  const m = useAsync(() => api.membership(workspaceId), [workspaceId])
  const [busy, setBusy] = useState(false)
  const d = m.data
  // nothing to show where memberships aren't set up (the desktop app, a server without them) and the space has none
  if (!d || (!d.membership && !d.canClaim)) return null
  const p = d.membership
  const active = p?.status === 'active'
  const claim = async () => {
    setBusy(true)
    try {
      const r = await api.claimMembership(workspaceId)
      window.location.assign(r.url)
    } catch (e) {
      toastError(e)
      setBusy(false)
    }
  }
  return (
    <section className="card ps-brand-sec" style={{ marginBottom: 18 }} aria-label="Membership">
      <div className="ps-brand-sec-head">
        {active ? <BadgeCheck size={15} /> : <Sparkles size={15} />} <strong>Membership</strong>
        <span className="muted">{p ? `${title(p.plan)} · ${STATUS[p.status] ?? p.status}${p.seats ? ` · ${p.seats} seat${p.seats === 1 ? '' : 's'}` : ''}` : 'This space has no membership'}</span>
      </div>
      <p className="muted" style={{ fontSize: '0.8125rem', margin: '0 0 12px' }}>
        {active
          ? 'This space uses the server’s AI as part of its membership. Plans, seats and billing are managed on the membership website.'
          : p
            ? 'This space’s membership isn’t active, so it no longer uses the server’s AI. Everything in it stays: renew to pick up where you left off.'
            : 'Join on the membership website to give this space the server’s AI and a team’s seats. You come back here when you’re done.'}
      </p>
      <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
        {d.canClaim && (
          <button className="btn primary sm" disabled={busy} onClick={() => void claim()}>
            {busy ? <Spinner size={13} /> : <Sparkles size={14} />} {p ? 'Renew the membership' : 'Get a membership for this space'}
          </button>
        )}
        {p && (
          <a className="btn sm" href={d.membershipUrl} target="_blank" rel="noreferrer noopener">
            <ExternalLink size={14} /> Manage on the membership website
          </a>
        )}
      </div>
    </section>
  )
}
