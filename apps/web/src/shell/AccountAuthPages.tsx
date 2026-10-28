// Signed-out account pages (P-22, A-17): /forgot asks for a reset link, /reset/:token sets a new password, and
// /verify/:token confirms an address (a new account's, or a new one an account switches to).
import { ArrowLeft, Eye, EyeOff, MailCheck } from 'lucide-react'
import { useEffect, useState, type FormEvent, type ReactNode } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { HttpError } from '../lib/api'
import { accountApi } from '../lib/accountApi'
import { useSession } from '../lib/session'
import { toast } from '../lib/toast'
import './dev/installMock'
import './shell.css'
import './auth.css'
import { Logo, Spinner } from './ui'

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

function errText(e: unknown): string {
  if (e instanceof HttpError) return e.body?.error || e.message
  if (e instanceof TypeError) return 'Can’t reach Producer Studio. Check your connection and try again.'
  return e instanceof Error ? e.message : String(e)
}

function Frame({ title, eyebrow, children }: { title: string; eyebrow: string; children: ReactNode }) {
  useEffect(() => {
    document.title = `${title} · Producer Studio`
  }, [title])
  return (
    <div className="ps-auth single">
      <div className="ps-auth-form">
        <Link to="/login" aria-label="Producer Studio">
          <Logo />
        </Link>
        <div className="ps-auth-body">
          <span className="eyebrow">{eyebrow}</span>
          <h1>{title}</h1>
          {children}
        </div>
        <div className="ps-auth-foot">© {new Date().getFullYear()} Producer Studio</div>
      </div>
    </div>
  )
}

const BackToSignIn = () => (
  <div className="ps-auth-switch">
    <Link to="/login"><ArrowLeft size={13} style={{ verticalAlign: '-2px' }} /> Back to sign in</Link>
  </div>
)

export function ForgotPage() {
  const [email, setEmail] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string>()
  const [done, setDone] = useState<{ mail: boolean; email: string }>()
  async function submit(e: FormEvent) {
    e.preventDefault()
    if (!EMAIL_RE.test(email.trim())) return setErr('Enter the email you sign in with')
    setBusy(true)
    setErr(undefined)
    try {
      const r = await accountApi.forgot(email.trim())
      setDone({ mail: r.mail, email: email.trim() })
    } catch (e2) {
      setErr(errText(e2))
    } finally {
      setBusy(false)
    }
  }
  if (done)
    return (
      <Frame eyebrow="Forgot password" title={done.mail ? 'Check your inbox' : 'Email isn’t set up here'}>
        <p className="sub" role="status">
          {done.mail
            ? `If ${done.email} has an account, a link to choose a new password is on its way. It works once, for one hour.`
            : 'This Producer Studio server doesn’t send email, so it can’t send a reset link. Ask the person who runs it to reset your password.'}
        </p>
        <BackToSignIn />
      </Frame>
    )
  return (
    <Frame eyebrow="Forgot password" title="Reset your password">
      <form onSubmit={submit} noValidate aria-label="Reset your password">
        <p className="sub">Enter the email you sign in with and we’ll send you a link to choose a new password.</p>
        {err && <div className="ps-alert" role="alert" style={{ marginBottom: 16 }}>{err}</div>}
        <div className="ps-field">
          <label className="label" htmlFor="forgot-email">Email</label>
          <input id="forgot-email" className="input" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@company.com" autoFocus />
        </div>
        <button className="btn primary" type="submit" disabled={busy}>{busy && <Spinner />} Send reset link</button>
        <BackToSignIn />
      </form>
    </Frame>
  )
}

export function ResetPage() {
  const { token = '' } = useParams()
  const navigate = useNavigate()
  const [info, setInfo] = useState<{ email?: string; error?: string }>()
  const [password, setPassword] = useState('')
  const [show, setShow] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string>()
  useEffect(() => {
    let alive = true
    accountApi
      .resetInfo(token)
      .then((r) => alive && setInfo({ email: r.email }))
      .catch((e) => alive && setInfo({ error: errText(e) }))
    return () => {
      alive = false
    }
  }, [token])
  async function submit(e: FormEvent) {
    e.preventDefault()
    if (password.length < 8) return setErr('Use at least 8 characters')
    setBusy(true)
    setErr(undefined)
    try {
      await accountApi.reset(token, password)
      await useSession.getState().load()
      toast('Password changed. You’re signed in, and signed out everywhere else.')
      navigate('/', { replace: true })
    } catch (e2) {
      setErr(errText(e2))
    } finally {
      setBusy(false)
    }
  }
  if (!info) return <Frame eyebrow="Reset password" title="Choose a new password"><Spinner size={20} /></Frame>
  if (info.error)
    return (
      <Frame eyebrow="Reset password" title="This link doesn’t work">
        <p className="sub" role="alert">{info.error}</p>
        <Link className="btn primary" to="/forgot">Send a new link</Link>
        <BackToSignIn />
      </Frame>
    )
  return (
    <Frame eyebrow="Reset password" title="Choose a new password">
      <form onSubmit={submit} noValidate aria-label="Choose a new password">
        <p className="sub">For {info.email}. Setting it signs you out on every other browser and unlinks your desktop apps.</p>
        {err && <div className="ps-alert" role="alert" style={{ marginBottom: 16 }}>{err}</div>}
        <div className="ps-field">
          <label className="label" htmlFor="reset-password">New password</label>
          <div className="ps-pw">
            <input id="reset-password" className="input" type={show ? 'text' : 'password'} autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="At least 8 characters" autoFocus />
            <button type="button" className="btn ghost sm icon" onClick={() => setShow((s) => !s)} aria-label={show ? 'Hide password' : 'Show password'}>
              {show ? <EyeOff size={15} /> : <Eye size={15} />}
            </button>
          </div>
        </div>
        <button className="btn primary" type="submit" disabled={busy}>{busy && <Spinner />} Set new password</button>
      </form>
    </Frame>
  )
}

/** One try per link: a link is single use, and React may run the effect twice. */
const verifying = new Map<string, ReturnType<typeof accountApi.verify>>()

export function VerifyPage() {
  const { token = '' } = useParams()
  const status = useSession((s) => s.status)
  const [state, setState] = useState<{ ok?: { email: string; purpose: 'verify' | 'email' }; error?: string }>()
  useEffect(() => {
    let alive = true
    if (!verifying.has(token)) verifying.set(token, accountApi.verify(token))
    verifying
      .get(token)!
      .then((r) => {
        if (!alive) return
        setState({ ok: { email: r.email, purpose: r.purpose } })
        // a signed-in tab shows the new address straight away
        if (useSession.getState().status === 'ready') void useSession.getState().load()
      })
      .catch((e) => alive && setState({ error: errText(e) }))
    return () => {
      alive = false
    }
  }, [token])
  if (!state) return <Frame eyebrow="Email" title="Confirming your email"><Spinner size={20} /></Frame>
  const next = status === 'ready' ? '/account' : '/login'
  if (state.error)
    return (
      <Frame eyebrow="Email" title="This link doesn’t work">
        <p className="sub" role="alert">{state.error} You can send a new one from your account page.</p>
        <Link className="btn primary" to={next}>{status === 'ready' ? 'Open your account' : 'Sign in'}</Link>
      </Frame>
    )
  return (
    <Frame eyebrow="Email" title={state.ok!.purpose === 'email' ? 'Your email changed' : 'Email confirmed'}>
      <p className="sub" role="status">
        <MailCheck size={16} style={{ verticalAlign: '-3px', marginRight: 6, color: 'var(--green)' }} />
        {state.ok!.purpose === 'email' ? `You now sign in with ${state.ok!.email}.` : `${state.ok!.email} is confirmed. Password resets and notices will reach you there.`}
      </p>
      <Link className="btn primary" to={status === 'ready' ? '/' : '/login'}>{status === 'ready' ? 'Back to Producer Studio' : 'Sign in'}</Link>
    </Frame>
  )
}
