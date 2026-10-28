// /account (A-17): profile, email and password, sessions and desktop apps with "Sign out everywhere", notification
// choices (A-8), and deleting the account. On the desktop app only the profile and notifications are local; the rest
// is managed on the cloud.
import type { AccountInfo, AccountSession, Device, NotificationPrefs } from '@producer/core'
import clsx from 'clsx'
import { Bell, KeyRound, Laptop, LogOut, Mail, MailCheck, Monitor, Trash2, UserRound } from 'lucide-react'
import { useEffect, useState, type FormEvent, type ReactNode } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { api, HttpError } from '../../lib/api'
import { accountApi } from '../../lib/accountApi'
import { notificationsSupported, requestNotifications, setNotifyPrefs } from '../../lib/notify'
import { useSession } from '../../lib/session'
import { toast, toastError } from '../../lib/toast'
import { useSystem } from '../system'
import { Avatar, ConfirmDialog, Spinner, useAsync, usePageTitle } from '../ui'
import { relativeTime } from '../util'

/** The colours an avatar can have (the server accepts exactly these). */
export const AVATAR_COLORS = ['#ff5a5f', '#35e0ff', '#ffb020', '#7c5cff', '#2ecc71', '#ff7ac6', '#4fd1c5', '#ff8a3d']

const errText = (e: unknown) => (e instanceof HttpError ? e.body?.error || e.message : e instanceof Error ? e.message : String(e))

function Section({ id, icon, title, sub, children }: { id: string; icon: ReactNode; title: string; sub?: string; children: ReactNode }) {
  return (
    <section id={id} className="card ps-set-sec" aria-labelledby={`${id}-h`}>
      <div className="ps-set-head">
        <span className="ps-set-icon">{icon}</span>
        <div>
          <h2 id={`${id}-h`}>{title}</h2>
          {sub && <p>{sub}</p>}
        </div>
      </div>
      {children}
    </section>
  )
}

function Toggle({ on, onChange, label, disabled }: { on: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button type="button" role="switch" aria-checked={on} aria-label={label} className={clsx('ps-toggle', on && 'on')} onClick={() => onChange(!on)} disabled={disabled}>
      <i />
    </button>
  )
}

/** "Chrome on Windows" from a user agent, roughly; the raw string is in the tooltip. */
export function describeAgent(ua?: string): string {
  if (!ua) return 'Unknown browser'
  const browser = /Edg\//.test(ua) ? 'Edge' : /OPR\//.test(ua) ? 'Opera' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : /Electron|Producer/i.test(ua) ? 'Producer Studio app' : 'A browser'
  const os = /Windows/.test(ua) ? 'Windows' : /iPhone|iPad/.test(ua) ? 'iOS' : /Mac OS X/.test(ua) ? 'macOS' : /Android/.test(ua) ? 'Android' : /Linux/.test(ua) ? 'Linux' : ''
  return os ? `${browser} on ${os}` : browser
}

function Profile({ info, onInfo }: { info: AccountInfo; onInfo: (a: AccountInfo) => void }) {
  const [name, setName] = useState(info.user.name)
  const [busy, setBusy] = useState(false)
  async function save(p: { name?: string; avatarColor?: string }) {
    setBusy(true)
    try {
      const next = await accountApi.update(p)
      onInfo(next)
      useSession.setState({ user: next.user })
      toast('Profile saved')
    } catch (e) {
      toastError(e, 'Couldn’t save your profile')
    } finally {
      setBusy(false)
    }
  }
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        if (name.trim() && name.trim() !== info.user.name) void save({ name: name.trim() })
      }}
    >
      <div className="row" style={{ gap: 16, alignItems: 'center', flexWrap: 'wrap' }}>
        <Avatar name={name || info.user.name} color={info.user.avatarColor} size={52} />
        <div className="ps-field" style={{ flex: '1 1 220px', marginBottom: 0 }}>
          <label className="label" htmlFor="acct-name">Name</label>
          <div className="row">
            <input id="acct-name" className="input" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} autoComplete="name" />
            <button className="btn" disabled={busy || !name.trim() || name.trim() === info.user.name}>{busy && <Spinner />} Save</button>
          </div>
        </div>
      </div>
      <div className="label" id="acct-colour" style={{ marginTop: 14 }}>Avatar colour</div>
      <div className="row" role="radiogroup" aria-labelledby="acct-colour" style={{ gap: 8, flexWrap: 'wrap' }}>
        {AVATAR_COLORS.map((c, i) => (
          <button
            key={c}
            type="button"
            role="radio"
            aria-checked={info.user.avatarColor === c}
            aria-label={`Colour ${i + 1}`}
            tabIndex={info.user.avatarColor === c || (!AVATAR_COLORS.includes(info.user.avatarColor) && i === 0) ? 0 : -1}
            disabled={busy}
            onClick={() => info.user.avatarColor !== c && void save({ avatarColor: c })}
            onKeyDown={(e) => {
              const step = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0
              if (!step) return
              e.preventDefault()
              const next = AVATAR_COLORS[(i + step + AVATAR_COLORS.length) % AVATAR_COLORS.length]
              void save({ avatarColor: next })
              ;(e.currentTarget.parentElement?.children[(i + step + AVATAR_COLORS.length) % AVATAR_COLORS.length] as HTMLElement | undefined)?.focus()
            }}
            style={{ width: 28, height: 28, borderRadius: '50%', background: c, border: info.user.avatarColor === c ? '3px solid var(--text)' : '2px solid transparent', padding: 0, cursor: 'pointer' }}
          />
        ))}
      </div>
    </form>
  )
}

function EmailSection({ info, reload }: { info: AccountInfo; reload: () => void }) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string>()
  async function submit(e: FormEvent) {
    e.preventDefault()
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) return setErr('Enter a valid email address')
    if (!password) return setErr('Enter your password to change your email')
    setBusy(true)
    setErr(undefined)
    try {
      const r = await accountApi.changeEmail(email.trim(), password)
      setPassword('')
      setEmail('')
      if ('pending' in r) toast(`Check ${r.pending}: the change is made once you open the link in it`)
      else {
        toast(`You now sign in with ${r.email}`)
        await useSession.getState().load()
      }
      reload()
    } catch (e2) {
      setErr(errText(e2))
    } finally {
      setBusy(false)
    }
  }
  async function resend() {
    try {
      await accountApi.resendVerification()
      toast(`Confirmation sent to ${info.user.email}`)
    } catch (e) {
      toastError(e, 'Couldn’t send the confirmation')
    }
  }
  return (
    <>
      <div className="ps-set-row" style={{ borderTop: 0, marginTop: 0, paddingTop: 0 }}>
        <div>
          <strong>{info.user.email}</strong>
          <span>
            {info.emailVerified ? (
              <><MailCheck size={12} style={{ verticalAlign: '-2px', color: 'var(--green)' }} /> Confirmed</>
            ) : info.mail ? (
              'Not confirmed yet: confirm it so a password reset can reach you.'
            ) : (
              'This server doesn’t send email, so addresses aren’t confirmed.'
            )}
          </span>
          {info.pendingEmail && <span style={{ display: 'block' }}>Waiting for you to confirm {info.pendingEmail} from its inbox.</span>}
        </div>
        {!info.emailVerified && info.mail && <button className="btn sm" onClick={() => void resend()}>Send confirmation again</button>}
      </div>
      <form onSubmit={submit} className="ps-set-row" aria-label="Change email" noValidate>
        <div style={{ flex: '1 1 100%' }}>
          <strong>Change email</strong>
          <span>{info.mail ? 'We send a link to the new address; the change is made when you open it.' : 'The change is made at once.'}</span>
        </div>
        <input className="input" style={{ flex: '1 1 200px' }} type="email" autoComplete="email" placeholder="new@company.com" aria-label="New email" value={email} onChange={(e) => setEmail(e.target.value)} />
        <input className="input" style={{ flex: '1 1 160px' }} type="password" autoComplete="current-password" placeholder="Your password" aria-label="Your password" value={password} onChange={(e) => setPassword(e.target.value)} />
        <button className="btn" disabled={busy || !email}>{busy && <Spinner />} Change email</button>
        {err && <div className="ps-field-err" role="alert" style={{ flex: '1 1 100%' }}>{err}</div>}
      </form>
    </>
  )
}

function PasswordSection() {
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string>()
  async function submit(e: FormEvent) {
    e.preventDefault()
    if (next.length < 8) return setErr('Use at least 8 characters')
    setBusy(true)
    setErr(undefined)
    try {
      await accountApi.changePassword(current, next)
      setCurrent('')
      setNext('')
      toast('Password changed. Other browsers were signed out.')
    } catch (e2) {
      setErr(errText(e2))
    } finally {
      setBusy(false)
    }
  }
  return (
    <form onSubmit={submit} aria-label="Change password" noValidate>
      <div className="row" style={{ flexWrap: 'wrap' }}>
        <input className="input" style={{ flex: '1 1 180px' }} type="password" autoComplete="current-password" placeholder="Current password" aria-label="Current password" value={current} onChange={(e) => setCurrent(e.target.value)} />
        <input className="input" style={{ flex: '1 1 180px' }} type="password" autoComplete="new-password" placeholder="New password (8+ characters)" aria-label="New password" value={next} onChange={(e) => setNext(e.target.value)} />
        <button className="btn" disabled={busy || !current || !next}>{busy && <Spinner />} Change password</button>
      </div>
      {err && <div className="ps-field-err" role="alert">{err}</div>}
      <div className="muted" style={{ fontSize: '0.75rem', marginTop: 8 }}>
        Forgot it? <Link to="/forgot">Get a reset link</Link>.
      </div>
    </form>
  )
}

function Sessions() {
  const sessions = useAsync(() => accountApi.sessions(), [])
  const devices = useAsync(() => api.devices(), [])
  const [confirm, setConfirm] = useState(false)
  const [busy, setBusy] = useState<string>()
  async function end(s: AccountSession) {
    setBusy(s.id)
    try {
      await accountApi.endSession(s.id)
      sessions.setData((cur) => (cur ?? []).filter((x) => x.id !== s.id))
      toast('Signed out that browser')
    } catch (e) {
      toastError(e, 'Couldn’t sign it out')
    } finally {
      setBusy(undefined)
    }
  }
  async function revoke(d: Device) {
    setBusy(d.id)
    try {
      await api.revokeDevice(d.id)
      devices.setData((cur) => (cur ?? []).filter((x) => x.id !== d.id))
      toast(`Unlinked “${d.name}”`)
    } catch (e) {
      toastError(e, 'Couldn’t unlink it')
    } finally {
      setBusy(undefined)
    }
  }
  async function everywhere() {
    setBusy('all')
    try {
      const r = await accountApi.signOutEverywhere()
      setConfirm(false)
      sessions.reload()
      devices.reload()
      toast(`Signed out ${r.sessions} other browser${r.sessions === 1 ? '' : 's'} and unlinked ${r.devices} app${r.devices === 1 ? '' : 's'}`)
    } catch (e) {
      toastError(e, 'Couldn’t sign out everywhere')
    } finally {
      setBusy(undefined)
    }
  }
  if ((sessions.loading && !sessions.data) || (devices.loading && !devices.data)) return <div className="skeleton" style={{ height: 120 }} />
  if (sessions.error) return <div className="ps-alert">Couldn’t load your sessions. <button className="btn sm" onClick={sessions.reload}>Retry</button></div>
  const others = (sessions.data ?? []).filter((s) => !s.current).length + (devices.data?.length ?? 0)
  return (
    <>
      <ul className="ps-devices" aria-label="Signed-in browsers and apps" style={{ listStyle: 'none', padding: 0, margin: 0 }}>
        {(sessions.data ?? []).map((s) => (
          <li key={s.id} className="ps-device">
            <span className="ps-set-icon"><Monitor size={17} /></span>
            <div style={{ flex: 1, minWidth: 0 }} title={s.userAgent}>
              <strong>{describeAgent(s.userAgent)}{s.current && <span className="muted" style={{ fontWeight: 500 }}> · this browser</span>}</strong>
              <span>Signed in {relativeTime(s.createdAt)}{s.lastSeenAt && !s.current ? ` · last used ${relativeTime(s.lastSeenAt)}` : ''}</span>
            </div>
            {!s.current && (
              <button className="btn ghost sm" disabled={busy === s.id} onClick={() => void end(s)} aria-label={`Sign out ${describeAgent(s.userAgent)}, signed in ${relativeTime(s.createdAt)}`}>
                Sign out
              </button>
            )}
          </li>
        ))}
        {(devices.data ?? []).map((d) => (
          <li key={d.id} className="ps-device">
            <span className="ps-set-icon"><Laptop size={17} /></span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <strong>{d.name}</strong>
              <span>
                Desktop app · linked {relativeTime(d.createdAt)}
                {d.lastSeenAt ? ` · last synced ${relativeTime(d.lastSeenAt)}` : ''}
                {d.expiresAt ? ` · stops working if unused until ${new Date(d.expiresAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}` : ''}
              </span>
            </div>
            <button className="btn ghost sm" disabled={busy === d.id} onClick={() => void revoke(d)} aria-label={`Unlink ${d.name}`}>Unlink</button>
          </li>
        ))}
      </ul>
      <div className="ps-set-row">
        <div>
          <strong>Sign out everywhere else</strong>
          <span>Every other browser is signed out and every desktop app is unlinked. This browser stays signed in.</span>
        </div>
        <button className="btn ps-btn-danger-outline" disabled={!others} onClick={() => setConfirm(true)}><LogOut size={14} /> Sign out everywhere</button>
      </div>
      {confirm && (
        <ConfirmDialog
          title="Sign out everywhere else?"
          body="Other browsers go back to the sign-in page, and your desktop apps stop syncing until you link them again with your password."
          confirmLabel="Sign out everywhere"
          busy={busy === 'all'}
          onConfirm={() => void everywhere()}
          onClose={() => setConfirm(false)}
        />
      )}
    </>
  )
}

function Notifications({ info, onInfo }: { info: AccountInfo; onInfo: (a: AccountInfo) => void }) {
  const [permission, setPermission] = useState(() => (notificationsSupported() ? Notification.permission : undefined))
  async function set(p: Partial<NotificationPrefs>) {
    const prev = info.notifications
    onInfo({ ...info, notifications: { ...prev, ...p } })
    try {
      const next = await accountApi.notifications(p)
      setNotifyPrefs(next)
      onInfo({ ...info, notifications: next })
    } catch (e) {
      onInfo({ ...info, notifications: prev })
      toastError(e, 'Couldn’t save that')
    }
  }
  return (
    <>
      <div className="ps-set-row" style={{ borderTop: 0, marginTop: 0, paddingTop: 0 }}>
        <div>
          <strong>Browser notifications</strong>
          <span>
            When an export or long job finishes while you’re in another tab.{' '}
            {permission === 'denied' ? 'This browser blocks them: allow notifications for this site in its settings.' : permission === undefined ? 'This browser can’t show them.' : ''}
          </span>
        </div>
        {permission === 'default' && info.notifications.browser && (
          <button className="btn sm" onClick={() => void requestNotifications().then((p) => p && setPermission(p))}>Allow in this browser</button>
        )}
        <Toggle on={info.notifications.browser} onChange={(v) => void set({ browser: v })} label="Browser notifications" />
      </div>
      <div className="ps-set-row">
        <div>
          <strong>Email when a job finishes</strong>
          <span>{info.mail ? `An email to ${info.user.email} when an export or long job you started finishes or fails.` : 'This server doesn’t send email.'}</span>
        </div>
        <Toggle on={info.mail && info.notifications.emailJobs} onChange={(v) => void set({ emailJobs: v })} label="Email when a job finishes" disabled={!info.mail} />
      </div>
    </>
  )
}

function DeleteAccount({ info }: { info: AccountInfo }) {
  const navigate = useNavigate()
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string>()
  async function remove() {
    setBusy(true)
    setErr(undefined)
    try {
      await accountApi.deleteAccount(password)
      await useSession.getState().logout()
      navigate('/login', { replace: true })
    } catch (e) {
      setConfirm(false)
      setErr(errText(e))
    } finally {
      setBusy(false)
    }
  }
  if (info.soleOwnerOf.length)
    return (
      <div className="ps-alert" role="note">
        <span style={{ flex: 1 }}>
          You’re the only owner of {info.soleOwnerOf.map((s) => `“${s.name}”`).join(', ')}, which other people use. Make one of them an owner (Space members → Hand over), or remove them, before deleting your account.
        </span>
        <Link className="btn sm" to="/space">Space members</Link>
      </div>
    )
  return (
    <>
      <div className="ps-set-row" style={{ borderTop: 0, marginTop: 0, paddingTop: 0 }}>
        <div>
          <strong>Delete your account</strong>
          <span>Your personal space and any space only you are in are deleted with everything in them. In shared spaces your work stays.</span>
        </div>
        <input className="input" style={{ width: 200 }} type="password" autoComplete="current-password" placeholder="Your password" aria-label="Password to delete your account" value={password} onChange={(e) => setPassword(e.target.value)} />
        <button className="btn ps-btn-danger-outline" disabled={!password} onClick={() => setConfirm(true)}><Trash2 size={14} /> Delete account</button>
      </div>
      {err && <div className="ps-field-err" role="alert">{err}</div>}
      {confirm && (
        <ConfirmDialog
          title="Delete your account for good?"
          body={`${info.user.email} is removed with your personal space and its projects and media. This can’t be undone.`}
          confirmLabel="Delete my account"
          busy={busy}
          onConfirm={() => void remove()}
          onClose={() => setConfirm(false)}
        />
      )}
    </>
  )
}

export default function AccountPage() {
  usePageTitle('Your account')
  const desktop = useSystem((s) => s.info?.mode === 'desktop')
  const account = useAsync(() => accountApi.get(), [])
  const [info, setInfo] = useState<AccountInfo>()
  useEffect(() => {
    if (account.data) setInfo(account.data)
  }, [account.data])
  return (
    <div className="ps-page narrow">
      <div className="ps-page-head">
        <div>
          <span className="eyebrow">Settings</span>
          <h1>Your account</h1>
        </div>
      </div>
      {account.error ? (
        <div className="ps-alert">Couldn’t load your account. <button className="btn sm" onClick={account.reload}>Retry</button></div>
      ) : !info ? (
        <div className="ps-set">{[0, 1, 2].map((i) => <div key={i} className="skeleton" style={{ height: 160, borderRadius: 16 }} />)}</div>
      ) : (
        <div className="ps-set">
          <Section id="profile" icon={<UserRound size={18} />} title="Profile" sub="How you appear to the people in your spaces.">
            <Profile info={info} onInfo={setInfo} />
          </Section>
          {desktop ? (
            <div className="ps-alert info">Your email, password and sign-ins are managed on Producer Studio cloud: open it in a browser and go to Your account.</div>
          ) : (
            <>
              <Section id="email" icon={<Mail size={18} />} title="Email" sub="The address you sign in with.">
                <EmailSection info={info} reload={account.reload} />
              </Section>
              <Section id="password" icon={<KeyRound size={18} />} title="Password" sub="Changing it signs you out of every other browser.">
                <PasswordSection />
              </Section>
              <Section id="sessions" icon={<Monitor size={18} />} title="Where you’re signed in" sub="Browsers and desktop apps that can open your account.">
                <Sessions />
              </Section>
            </>
          )}
          <Section id="notifications" icon={<Bell size={18} />} title="Notifications" sub="Hear about exports and long jobs when they finish.">
            <Notifications info={info} onInfo={setInfo} />
          </Section>
          {!desktop && (
            <Section id="delete" icon={<Trash2 size={18} />} title="Delete account">
              <DeleteAccount info={info} />
            </Section>
          )}
        </div>
      )}
    </div>
  )
}
