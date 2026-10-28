import { Check, Clock, Copy, Crown, Eye, Pencil, Plus, Send, Settings2, Trash2, UserPlus, Users } from 'lucide-react'
import type { Member, PendingInvite } from '@producer/core'
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '../../lib/api'
import { accountApi } from '../../lib/accountApi'
import { useSession } from '../../lib/session'
import { toast, toastError } from '../../lib/toast'
import { useSystem } from '../system'
import { absoluteUrl, copyText, relativeTime } from '../util'
import { CreateSpaceModal, DeleteSpaceModal, InviteForm, RenameSpaceModal } from '../modals'
import { Avatar, ConfirmDialog, EmptyState, spaceColor, useAsync, usePageTitle } from '../ui'

const ROLE: Record<string, { label: string; icon: React.ReactNode; desc: string }> = {
  owner: { label: 'Owner', icon: <Crown size={13} />, desc: 'Manage members, brand kit and everything in the space' },
  editor: { label: 'Editor', icon: <Pencil size={13} />, desc: 'Create and edit projects, upload media' },
  viewer: { label: 'Viewer', icon: <Eye size={13} />, desc: 'View projects and exports' },
}

const shortDate = (ms: number) => new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })

/** The second line of a waiting invite: its role, when it was emailed, and until when the link works. */
export function inviteLine(p: PendingInvite): string {
  const role = ROLE[p.role]?.label ?? p.role
  if (p.status === 'expired') return `${role} · expired ${shortDate(p.expiresAt)}; send it again for 7 more days`
  return `${role} · ${p.sentAt ? `emailed ${relativeTime(p.sentAt)} · ` : ''}link works until ${shortDate(p.expiresAt)}`
}

export default function SpacePage() {
  usePageTitle('Members')
  const workspaceId = useSession((s) => s.workspaceId)
  const user = useSession((s) => s.user)
  const workspaces = useSession((s) => s.workspaces)
  const setWorkspace = useSession((s) => s.setWorkspace)
  const ws = workspaces.find((w) => w.id === workspaceId)
  const [modal, setModal] = useState<'create' | 'rename' | 'delete'>()
  const members = useAsync(() => (workspaceId ? api.members(workspaceId) : Promise.resolve([])), [workspaceId])
  const isOwner = ws?.role === 'owner'
  const pending = useAsync(() => (workspaceId && isOwner ? api.invites(workspaceId) : Promise.resolve([])), [workspaceId, isOwner])
  const [copied, setCopied] = useState<string>()
  const navigate = useNavigate()
  const refreshWorkspaces = useSession((s) => s.refreshWorkspaces)
  const [removing, setRemoving] = useState<Member>()
  const [handingOver, setHandingOver] = useState<Member>()
  const [handTo, setHandTo] = useState('')
  const [busy, setBusy] = useState<string>()
  const mail = useSystem((s) => !!s.info?.mail)
  async function changeRole(m: Member, role: Member['role'], undoing = false) {
    if (!workspaceId || role === m.role) return
    setBusy(m.userId)
    try {
      await api.setMemberRole(workspaceId, m.userId, role)
      members.setData((cur) => (cur ?? []).map((x) => (x.userId === m.userId ? { ...x, role } : x)))
      if (m.userId === user?.id) await refreshWorkspaces()
      const was = m.role
      // stepping yourself down leaves you no way back: no Undo then
      const canUndo = !undoing && m.userId !== user?.id
      toast(`${m.name} is now ${ROLE[role]?.label.toLowerCase() ?? role}`, canUndo ? { label: 'Undo', run: () => void changeRole({ ...m, role }, was, true) } : undefined)
    } catch (e) {
      toastError(e)
    } finally {
      setBusy(undefined)
    }
  }
  async function remove(m: Member) {
    if (!workspaceId) return
    const leaving = m.userId === user?.id
    setBusy(m.userId)
    try {
      await api.removeMember(workspaceId, m.userId)
      setRemoving(undefined)
      if (leaving) {
        await refreshWorkspaces()
        toast(`You left “${ws?.name ?? 'the space'}”`)
        navigate('/')
      } else {
        members.setData((cur) => (cur ?? []).filter((x) => x.userId !== m.userId))
        pending.reload()
        toast(`Removed ${m.name}`)
      }
    } catch (e) {
      toastError(e)
    } finally {
      setBusy(undefined)
    }
  }
  async function resend(p: PendingInvite) {
    if (!workspaceId) return
    setBusy(p.token)
    try {
      const r = await accountApi.resendInvite(workspaceId, p.token)
      toast(r.emailed ? `Sent the invite to ${p.email} again` : `The link for ${p.email} works for 7 more days. Copy it and send it to them.`)
      pending.reload()
    } catch (e) {
      toastError(e, 'Couldn’t send it again')
    } finally {
      setBusy(undefined)
    }
  }
  async function handOver(m: Member) {
    if (!workspaceId) return
    setBusy('handover')
    try {
      await accountApi.transferOwnership(workspaceId, m.userId)
      setHandingOver(undefined)
      await refreshWorkspaces()
      members.reload()
      toast(`${m.name} is now an owner of “${ws?.name}”. You’re an editor.`)
    } catch (e) {
      toastError(e, 'Couldn’t hand the space over')
    } finally {
      setBusy(undefined)
    }
  }
  async function withdraw(token: string, email: string) {
    if (!workspaceId) return
    try {
      await api.revokeInvite(workspaceId, token)
      toast(`Withdrew the invite for ${email}`)
      pending.reload()
    } catch (e) {
      toastError(e)
    }
  }

  return (
    <div className="ps-page narrow">
      <div className="ps-page-head">
        <div className="row" style={{ gap: 16, alignItems: 'center' }}>
          <span className="ps-space-avatar" style={{ width: 56, height: 56, borderRadius: 16, fontSize: '1.5rem', background: spaceColor(ws?.id ?? '') }}>{(ws?.name ?? '?').slice(0, 1).toUpperCase()}</span>
          <div>
            <span className="eyebrow">{ws?.personal ? 'Personal space' : 'Team space'}</span>
            <h1 style={{ marginTop: 4 }}>{ws?.name}</h1>
          </div>
        </div>
        <span className="spacer" />
        {isOwner && <button className="btn" onClick={() => setModal('rename')}><Pencil size={15} /> Rename</button>}
        <button className="btn" onClick={() => setModal('create')}><Plus size={15} /> Create space</button>
      </div>

      {ws?.personal ? (
        <div className="ps-alert info" style={{ marginBottom: 18 }}>
          <span style={{ flex: 1 }}>Personal spaces are just for you. Create a team space to collaborate — projects, media and the brand kit are shared with everyone in it.</span>
          <button className="btn sm" onClick={() => setModal('create')}><Plus size={14} /> Create a team space</button>
        </div>
      ) : (
        <section className="card ps-brand-sec" style={{ marginBottom: 18 }}>
          <div className="ps-brand-sec-head"><UserPlus size={15} /> <strong>Invite people</strong><span className="muted">{mail ? 'Email' : 'Make'} a link for one person to join {ws?.name}</span></div>
          {isOwner && workspaceId ? (
            <InviteForm
              workspaceId={workspaceId}
              onInvited={() => {
                members.reload()
                pending.reload()
              }}
            />
          ) : (
            <div className="muted">Only owners of this space can invite people.</div>
          )}
          {isOwner && !!pending.data?.length && (
            <div className="ps-members" style={{ marginTop: 16 }}>
              <div className="muted" style={{ fontSize: '0.75rem', marginBottom: 6 }}>Waiting to be accepted</div>
              {pending.data.map((p) => {
                const expired = p.status === 'expired'
                return (
                  <div key={p.token} className="ps-member">
                    <Clock size={18} style={{ color: expired ? 'var(--danger)' : 'var(--text-3)', flex: 'none' }} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <strong>{p.email}</strong>
                      <span>{inviteLine(p)}</span>
                    </div>
                    {!expired && (
                      <button
                        className="btn sm"
                        aria-label={`Copy the invite link for ${p.email}`}
                        onClick={async () => {
                          if (await copyText(absoluteUrl(p.inviteUrl))) setCopied(p.token)
                        }}
                      >
                        {copied === p.token ? <Check size={14} /> : <Copy size={14} />} {copied === p.token ? 'Copied' : 'Copy link'}
                      </button>
                    )}
                    <button className="btn sm" disabled={busy === p.token} onClick={() => void resend(p)} aria-label={`${mail ? 'Resend the invite to' : 'Renew the invite link for'} ${p.email}`}>
                      <Send size={14} /> {mail ? 'Resend' : 'Renew'}
                    </button>
                    <button className="btn sm ghost" onClick={() => void withdraw(p.token, p.email)} aria-label={`Withdraw the invite for ${p.email}`}>Withdraw</button>
                  </div>
                )
              })}
            </div>
          )}
        </section>
      )}

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
                {isOwner ? (
                  <select className="input" style={{ width: 120 }} value={m.role} disabled={busy === m.userId} onChange={(e) => void changeRole(m, e.target.value as Member['role'])} aria-label={`Role for ${m.name}`} title={ROLE[m.role]?.desc}>
                    <option value="owner">Owner</option>
                    <option value="editor">Editor</option>
                    <option value="viewer">Viewer</option>
                  </select>
                ) : (
                  <span className={`ps-role ${m.role}`} title={ROLE[m.role]?.desc}>{ROLE[m.role]?.icon} {ROLE[m.role]?.label ?? m.role}</span>
                )}
                {m.userId === user?.id
                  ? !(ws?.personal && isOwner) && <button className="btn sm ghost" disabled={busy === m.userId} onClick={() => setRemoving(m)}>Leave</button>
                  : isOwner && <button className="btn sm ghost" disabled={busy === m.userId} onClick={() => setRemoving(m)} aria-label={`Remove ${m.name}`}>Remove</button>}
              </div>
            ))}
          </div>
        )}
      </section>

      {isOwner && ws && (
        <section className="card ps-brand-sec" style={{ marginTop: 18 }}>
          <div className="ps-brand-sec-head"><Settings2 size={15} /> <strong>Space settings</strong><span className="muted">Only owners see this</span></div>
          <div className="ps-space-setting">
            <div>
              <strong>Name</strong>
              <span className="muted">{ws.name}</span>
            </div>
            <button className="btn sm" onClick={() => setModal('rename')}><Pencil size={14} /> Rename</button>
          </div>
          {!ws.personal && (
            <div className="ps-space-setting">
              <div>
                <strong>Hand over this space</strong>
                <span className="muted">Make someone else an owner and step down to editor in one go.</span>
              </div>
              <div className="row" style={{ gap: 6 }}>
                <select className="input" style={{ width: 170 }} value={handTo} onChange={(e) => setHandTo(e.target.value)} aria-label="Member to hand the space to">
                  <option value="">Choose a member…</option>
                  {(members.data ?? [])
                    .filter((m) => m.userId !== user?.id)
                    .map((m) => (
                      <option key={m.userId} value={m.userId}>{m.name}</option>
                    ))}
                </select>
                <button className="btn sm" disabled={!handTo} onClick={() => setHandingOver(members.data?.find((m) => m.userId === handTo))}><Crown size={14} /> Hand over</button>
              </div>
            </div>
          )}
          <div className="ps-space-setting">
            <div>
              <strong>Delete this space</strong>
              <span className="muted">
                {ws.personal ? 'Your personal space can’t be deleted.' : 'Permanently deletes its projects, media, exports and brand kit for every member.'}
              </span>
            </div>
            {!ws.personal && <button className="btn sm ps-btn-danger-outline" onClick={() => setModal('delete')}><Trash2 size={14} /> Delete space</button>}
          </div>
        </section>
      )}

      {workspaces.length > 1 && (
        <section className="ps-section">
          <div className="ps-section-head"><h2 className="ps-h2">Your spaces</h2></div>
          <div className="ps-grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))' }}>
            {workspaces.map((w) => (
              <button key={w.id} className={`ps-space-card ${w.id === workspaceId ? 'on' : ''}`} onClick={() => setWorkspace(w.id)}>
                <span className="ps-space-avatar" style={{ background: spaceColor(w.id) }}>{w.name.slice(0, 1).toUpperCase()}</span>
                <span style={{ flex: 1, minWidth: 0, textAlign: 'left' }}>
                  <strong>{w.name}</strong>
                  <span>{w.personal ? 'Personal' : `${w.memberCount} member${w.memberCount === 1 ? '' : 's'}`} · {w.role}</span>
                </span>
              </button>
            ))}
          </div>
        </section>
      )}
      {removing && (
        <ConfirmDialog
          title={removing.userId === user?.id ? `Leave “${ws?.name}”?` : `Remove ${removing.name} from “${ws?.name}”?`}
          body={
            removing.userId === user?.id
              ? 'You’ll lose access to its projects, media and brand kit. An owner can invite you back.'
              : 'They lose access to its projects, media and brand kit at once, and any invite still waiting for them is withdrawn. Their work stays in the space.'
          }
          confirmLabel={removing.userId === user?.id ? 'Leave space' : 'Remove'}
          busy={busy === removing.userId}
          onConfirm={() => void remove(removing)}
          onClose={() => setRemoving(undefined)}
        />
      )}
      {handingOver && (
        <ConfirmDialog
          title={`Hand “${ws?.name}” over to ${handingOver.name}?`}
          body={`${handingOver.name} becomes an owner and you become an editor. You can only get ownership back if an owner gives it to you.`}
          confirmLabel="Hand over"
          busy={busy === 'handover'}
          onConfirm={() => void handOver(handingOver)}
          onClose={() => setHandingOver(undefined)}
        />
      )}
      {modal === 'create' && <CreateSpaceModal onClose={() => setModal(undefined)} />}
      {modal === 'rename' && ws && <RenameSpaceModal ws={ws} onClose={() => setModal(undefined)} />}
      {modal === 'delete' && ws && <DeleteSpaceModal ws={ws} onClose={() => setModal(undefined)} />}
    </div>
  )
}
