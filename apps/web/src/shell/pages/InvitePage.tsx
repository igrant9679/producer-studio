// /invite/:token — where an invite link lands (behind sign-in; ?next= brings a new account back here).
// Only the account the invite was sent to can accept it; anyone else is told whose it is and can switch account.
import type { InviteInfo } from '@producer/core'
import { Clock, LogOut, MailCheck, UserX, Users } from 'lucide-react'
import { useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { HttpError, api } from '../../lib/api'
import { useSession } from '../../lib/session'
import { toast } from '../../lib/toast'
import { EmptyState, Spinner, useAsync, usePageTitle } from '../ui'

const ROLE_WORD: Record<string, string> = { owner: 'an owner', editor: 'an editor', viewer: 'a viewer' }

const day = (ms: number) => new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' })

export default function InvitePage() {
  usePageTitle('Invitation')
  const { token = '' } = useParams()
  const navigate = useNavigate()
  const user = useSession((s) => s.user)
  const refreshWorkspaces = useSession((s) => s.refreshWorkspaces)
  const setWorkspace = useSession((s) => s.setWorkspace)
  const logout = useSession((s) => s.logout)
  const info = useAsync(() => api.inviteInfo(token), [token])
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string>()

  async function accept(inv: InviteInfo) {
    setBusy(true)
    setErr(undefined)
    try {
      const ws = await api.acceptInvite(token)
      await refreshWorkspaces()
      setWorkspace(ws.id)
      toast(`You joined “${ws.name}”`)
      navigate('/', { replace: true })
    } catch (e) {
      setErr(e instanceof HttpError ? e.body.error || e.message : `Couldn’t join ${inv.workspaceName}. Try again.`)
      info.reload()
    } finally {
      setBusy(false)
    }
  }

  async function switchAccount() {
    await logout()
    navigate(`/login?next=${encodeURIComponent(`/invite/${token}`)}`, { replace: true })
  }

  async function open(inv: InviteInfo) {
    await refreshWorkspaces()
    setWorkspace(inv.workspaceId)
    navigate('/')
  }

  const page = (node: React.ReactNode) => <div className="ps-page narrow" style={{ paddingTop: 70 }}>{node}</div>

  if (info.loading && !info.data) return page(<div style={{ display: 'grid', placeItems: 'center' }}><Spinner size={22} /></div>)
  if (info.error || !info.data) {
    const missing = info.error instanceof HttpError && info.error.status === 404
    return page(
      <EmptyState
        icon={<UserX size={24} />}
        title={missing ? 'This invite link doesn’t work' : 'Couldn’t load this invite'}
        body={missing ? 'It may be mistyped, or the space was deleted. Ask the person who invited you for a new link.' : 'Check your connection and try again.'}
        action={missing ? <Link className="btn" to="/">Go to Home</Link> : <button className="btn primary" onClick={info.reload}>Try again</button>}
      />,
    )
  }

  const inv = info.data
  const role = ROLE_WORD[inv.role] ?? inv.role
  if (inv.status === 'accepted' || (inv.member && inv.status !== 'pending'))
    return page(
      <EmptyState
        icon={<Users size={24} />}
        title={inv.member ? `You’re in ${inv.workspaceName}` : 'This invite has already been used'}
        body={inv.member ? 'Open the space to see its projects, media and brand kit.' : `It was accepted${inv.acceptedAt ? ` on ${day(inv.acceptedAt)}` : ''}. If you need access, ask an owner of ${inv.workspaceName} for a new invite.`}
        action={inv.member ? <button className="btn primary" onClick={() => void open(inv)}>Open {inv.workspaceName}</button> : <Link className="btn" to="/">Go to Home</Link>}
      />,
    )
  if (inv.status === 'revoked' || inv.status === 'expired')
    return page(
      <EmptyState
        icon={<Clock size={24} />}
        title={inv.status === 'revoked' ? 'This invite was withdrawn' : 'This invite has expired'}
        body={inv.status === 'revoked' ? `An owner of ${inv.workspaceName} withdrew it. Ask them for a new one if you still need access.` : `It stopped working on ${day(inv.expiresAt)}. Ask an owner of ${inv.workspaceName} for a new one.`}
        action={<Link className="btn" to="/">Go to Home</Link>}
      />,
    )
  if (!inv.forYou)
    return page(
      <EmptyState
        icon={<MailCheck size={24} />}
        title={`This invite is for ${inv.email}`}
        body={`You’re signed in as ${user?.email ?? 'another account'}. Sign in as ${inv.email} (or create that account) to join ${inv.workspaceName}.`}
        action={<button className="btn primary" onClick={() => void switchAccount()}><LogOut size={14} /> Use another account</button>}
      />,
    )
  return page(
    <EmptyState
      icon={<Users size={24} />}
      title={`Join ${inv.workspaceName}`}
      body={
        <>
          You’ve been invited as {role}. {inv.member ? 'You’re already a member; accepting gives you this role if it’s higher.' : 'You’ll see its projects, media and brand kit.'} The link works until {day(inv.expiresAt)}.
          {err && <span className="ps-field-err" style={{ display: 'block', marginTop: 10 }}>{err}</span>}
        </>
      }
      action={
        <div className="row">
          <button className="btn primary" disabled={busy} onClick={() => void accept(inv)}>{busy && <Spinner />} Join {inv.workspaceName}</button>
          <Link className="btn" to="/">Not now</Link>
        </div>
      }
    />,
  )
}
