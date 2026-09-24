import { Crown, Eye, Pencil, Plus, UserPlus, Users } from 'lucide-react'
import { useState } from 'react'
import { api } from '../../lib/api'
import { useSession } from '../../lib/session'
import { CreateSpaceModal, InviteForm } from '../modals'
import { Avatar, EmptyState, spaceColor, useAsync, usePageTitle } from '../ui'

const ROLE: Record<string, { label: string; icon: React.ReactNode; desc: string }> = {
  owner: { label: 'Owner', icon: <Crown size={13} />, desc: 'Manage members, brand kit and everything in the space' },
  editor: { label: 'Editor', icon: <Pencil size={13} />, desc: 'Create and edit projects, upload media' },
  viewer: { label: 'Viewer', icon: <Eye size={13} />, desc: 'View projects and exports' },
}

export default function SpacePage() {
  usePageTitle('Members')
  const workspaceId = useSession((s) => s.workspaceId)
  const user = useSession((s) => s.user)
  const workspaces = useSession((s) => s.workspaces)
  const setWorkspace = useSession((s) => s.setWorkspace)
  const ws = workspaces.find((w) => w.id === workspaceId)
  const [create, setCreate] = useState(false)
  const members = useAsync(() => (workspaceId ? api.members(workspaceId) : Promise.resolve([])), [workspaceId])
  const canInvite = ws?.role === 'owner' || ws?.role === 'editor'

  return (
    <div className="ps-page narrow">
      <div className="ps-page-head">
        <div className="row" style={{ gap: 16, alignItems: 'center' }}>
          <span className="ps-space-avatar" style={{ width: 56, height: 56, borderRadius: 16, fontSize: 24, background: spaceColor(ws?.id ?? '') }}>{(ws?.name ?? '?').slice(0, 1).toUpperCase()}</span>
          <div>
            <span className="eyebrow">{ws?.personal ? 'Personal space' : 'Team space'}</span>
            <h1 style={{ marginTop: 4 }}>{ws?.name}</h1>
          </div>
        </div>
        <span className="spacer" />
        <button className="btn" onClick={() => setCreate(true)}><Plus size={15} /> Create space</button>
      </div>

      <section className="card ps-brand-sec" style={{ marginBottom: 18 }}>
        <div className="ps-brand-sec-head"><UserPlus size={15} /> <strong>Invite people</strong><span className="muted">They’ll get an invite link to join {ws?.name}</span></div>
        {ws?.personal && <div className="ps-alert info" style={{ marginBottom: 12 }}>Personal spaces are just for you. Create a team space to collaborate — projects, media and the brand kit are shared with everyone in it.</div>}
        {canInvite && workspaceId ? <InviteForm workspaceId={workspaceId} onInvited={members.reload} /> : <div className="muted">Only owners and editors can invite people.</div>}
      </section>

      <section className="card ps-brand-sec">
        <div className="ps-brand-sec-head"><Users size={15} /> <strong>Members</strong><span className="muted">{members.data ? `${members.data.length}` : ''}</span></div>
        {members.loading && !members.data ? (
          [0, 1, 2].map((i) => <div key={i} className="skeleton" style={{ height: 52, marginBottom: 8 }} />)
        ) : members.error ? (
          <div className="ps-alert">Couldn’t load members. <button className="btn sm" onClick={members.reload}>Retry</button></div>
        ) : !members.data?.length ? (
          <EmptyState icon={<Users size={22} />} title="Just you so far" body="Invite teammates above to start collaborating." />
        ) : (
          <div className="ps-members">
            {members.data.map((m) => (
              <div key={m.userId} className="ps-member">
                <Avatar name={m.name} color={m.userId === user?.id ? user?.avatarColor : spaceColor(m.userId)} size={36} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <strong>{m.name}{m.userId === user?.id && <span className="muted" style={{ fontWeight: 500 }}> (you)</span>}</strong>
                  <span>{m.email}</span>
                </div>
                <span className={`ps-role ${m.role}`} title={ROLE[m.role]?.desc}>{ROLE[m.role]?.icon} {ROLE[m.role]?.label ?? m.role}</span>
              </div>
            ))}
          </div>
        )}
        <div className="muted" style={{ fontSize: 12, marginTop: 14 }}>Changing roles and removing members is coming soon.</div>
      </section>

      {workspaces.length > 1 && (
        <section className="ps-section">
          <div className="ps-section-head"><h2 className="ps-h2">Your spaces</h2></div>
          <div className="ps-grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))' }}>
            {workspaces.map((w) => (
              <button key={w.id} className={`ps-space-card ${w.id === workspaceId ? 'on' : ''}`} onClick={() => setWorkspace(w.id)}>
                <span className="ps-space-avatar" style={{ background: spaceColor(w.id) }}>{w.name.slice(0, 1).toUpperCase()}</span>
                <span style={{ flex: 1, minWidth: 0, textAlign: 'left' }}>
                  <strong>{w.name}</strong>
                  <span>{w.personal ? 'Personal' : `${w.memberCount} members`} · {w.role}</span>
                </span>
              </button>
            ))}
          </div>
        </section>
      )}
      {create && <CreateSpaceModal onClose={() => setCreate(false)} />}
    </div>
  )
}
