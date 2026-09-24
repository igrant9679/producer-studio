import { ArrowRight, AudioLines, Check, Eye, EyeOff, FileText, Film, Sparkles, Upload } from 'lucide-react'
import { useEffect, useState, type FormEvent } from 'react'
import { Link, Navigate, useNavigate, useSearchParams } from 'react-router-dom'
import { HttpError } from '../lib/api'
import { useSession } from '../lib/session'
import './dev/installMock'
import './shell.css'
import './auth.css'
import { Logo, Spinner } from './ui'

export interface AuthErrors {
  name?: string
  email?: string
  password?: string
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/** Client-side validation for the auth form (exported for tests). */
export function validateAuth(mode: 'login' | 'signup', v: { name: string; email: string; password: string }): AuthErrors {
  const e: AuthErrors = {}
  if (mode === 'signup' && !v.name.trim()) e.name = 'Tell us what to call you'
  if (!v.email.trim()) e.email = 'Enter your email address'
  else if (!EMAIL_RE.test(v.email.trim())) e.email = 'That doesn’t look like an email address'
  if (!v.password) e.password = 'Enter your password'
  else if (mode === 'signup' && v.password.length < 8) e.password = 'Use at least 8 characters'
  return e
}

/** Only allow same-origin relative redirects. */
export function safeNext(next: string | null): string {
  if (!next || !next.startsWith('/') || next.startsWith('//') || next.startsWith('/login') || next.startsWith('/signup')) return '/'
  return next
}

function authErrorMessage(err: unknown, mode: 'login' | 'signup'): string {
  if (err instanceof HttpError) {
    if (err.status === 401) return 'Incorrect email or password.'
    if (err.status === 409) return 'An account with that email already exists. Try signing in instead.'
    if (err.status === 429) return 'Too many attempts. Wait a minute and try again.'
    if (err.status >= 500) return 'The server had a problem. Please try again in a moment.'
    return err.body?.error || err.message
  }
  if (err instanceof TypeError) return 'Can’t reach Producer Studio. Check your connection and try again.'
  return mode === 'login' ? 'Sign-in failed.' : 'Sign-up failed.'
}

export function AuthPage({ mode }: { mode: 'login' | 'signup' }) {
  const status = useSession((s) => s.status)
  const login = useSession((s) => s.login)
  const signup = useSession((s) => s.signup)
  const [params] = useSearchParams()
  const next = safeNext(params.get('next'))
  const navigate = useNavigate()
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [showPw, setShowPw] = useState(false)
  const [errors, setErrors] = useState<AuthErrors>({})
  const [touched, setTouched] = useState(false)
  const [serverError, setServerError] = useState<string>()
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    document.title = mode === 'login' ? 'Sign in · Producer Studio' : 'Create your account · Producer Studio'
    setErrors({})
    setServerError(undefined)
    setTouched(false)
  }, [mode])

  useEffect(() => {
    if (touched) setErrors(validateAuth(mode, { name, email, password }))
  }, [touched, mode, name, email, password])

  // If we landed here because the initial session check failed transiently (server restart, network blip),
  // re-check once: a still-valid cookie signs the user straight back in and redirects to ?next=.
  useEffect(() => {
    if (useSession.getState().status !== 'anon') return
    const t = setTimeout(() => {
      if (useSession.getState().status === 'anon') void useSession.getState().load()
    }, 700)
    return () => clearTimeout(t)
  }, [])

  if (status === 'ready') return <Navigate to={next} replace />

  async function submit(e: FormEvent) {
    e.preventDefault()
    setTouched(true)
    const errs = validateAuth(mode, { name, email, password })
    setErrors(errs)
    if (Object.keys(errs).length) return
    setBusy(true)
    setServerError(undefined)
    try {
      if (mode === 'login') await login(email.trim(), password)
      else await signup(email.trim(), password, name.trim())
      navigate(next, { replace: true })
    } catch (err) {
      setServerError(authErrorMessage(err, mode))
    } finally {
      setBusy(false)
    }
  }

  const strength = Math.min(4, (password.length >= 8 ? 1 : 0) + (/[A-Z]/.test(password) && /[a-z]/.test(password) ? 1 : 0) + (/\d/.test(password) ? 1 : 0) + (/[^A-Za-z0-9]/.test(password) || password.length >= 14 ? 1 : 0))
  const other = mode === 'login' ? '/signup' : '/login'
  const otherHref = params.get('next') ? `${other}?next=${encodeURIComponent(params.get('next')!)}` : other

  return (
    <div className="ps-auth">
      <div className="ps-auth-form">
        <Link to="/login" aria-label="Producer Studio">
          <Logo />
        </Link>
        <form onSubmit={submit} noValidate aria-label={mode === 'login' ? 'Sign in' : 'Create account'}>
          <span className="eyebrow">{mode === 'login' ? 'Welcome back' : 'Get started free'}</span>
          <h1>{mode === 'login' ? 'Sign in to your studio' : 'Create your account'}</h1>
          <p className="sub">{mode === 'login' ? 'Pick up where you left off — your projects, voices and brand kit are waiting.' : 'Turn your next screen recording into a finished, on-brand video.'}</p>

          {serverError && (
            <div className="ps-alert" role="alert" style={{ marginBottom: 16 }}>
              {serverError}
            </div>
          )}

          {mode === 'signup' && (
            <div className="ps-field">
              <label className="label" htmlFor="auth-name">Name</label>
              <input id="auth-name" className="input" autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Jordan Lee" aria-invalid={!!errors.name} autoFocus />
              {errors.name && <div className="ps-field-err">{errors.name}</div>}
            </div>
          )}
          <div className="ps-field">
            <label className="label" htmlFor="auth-email">Email</label>
            <input id="auth-email" className="input" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@company.com" aria-invalid={!!errors.email} autoFocus={mode === 'login'} />
            {errors.email && <div className="ps-field-err">{errors.email}</div>}
          </div>
          <div className="ps-field">
            <label className="label" htmlFor="auth-password">Password</label>
            <div className="ps-pw">
              <input
                id="auth-password"
                className="input"
                type={showPw ? 'text' : 'password'}
                autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={mode === 'signup' ? 'At least 8 characters' : '••••••••'}
                aria-invalid={!!errors.password}
              />
              <button type="button" className="btn ghost sm icon" onClick={() => setShowPw((s) => !s)} aria-label={showPw ? 'Hide password' : 'Show password'}>
                {showPw ? <EyeOff size={15} /> : <Eye size={15} />}
              </button>
            </div>
            {mode === 'signup' && password && (
              <div className="ps-pw-meter" aria-hidden>
                {[0, 1, 2, 3].map((i) => (
                  <i key={i} className={i < strength ? 'on' : ''} style={i < strength && strength < 2 ? { background: 'var(--amber)' } : undefined} />
                ))}
              </div>
            )}
            {errors.password && <div className="ps-field-err">{errors.password}</div>}
          </div>
          <button className="btn primary" type="submit" disabled={busy}>
            {busy ? <Spinner /> : null}
            {mode === 'login' ? 'Sign in' : 'Create account'}
            {!busy && <ArrowRight size={16} />}
          </button>
          <div className="ps-auth-switch">
            {mode === 'login' ? 'New to Producer Studio? ' : 'Already have an account? '}
            <Link to={otherHref}>{mode === 'login' ? 'Create an account' : 'Sign in'}</Link>
          </div>
        </form>
        <div className="ps-auth-foot">© {new Date().getFullYear()} Producer Studio</div>
      </div>

      <aside className="ps-auth-pitch" aria-label="About Producer Studio">
        <span className="eyebrow" style={{ color: 'var(--cyan)' }}>Producer AI · Video editor · Voice studio</span>
        <h2>
          From raw recording to <em>finished video</em> before your coffee cools.
        </h2>
        <p>Drop in a screen recording. Producer transcribes it, writes the script, narrates it and assembles a branded cut — then hands you a full timeline editor to make it yours.</p>
        <div className="ps-pipeline">
          {[
            { icon: <Upload size={18} />, t: 'Record', s: 'Upload any capture' },
            { icon: <FileText size={18} />, t: 'Transcript', s: 'Word-accurate' },
            { icon: <Sparkles size={18} />, t: 'Script', s: 'Written by Claude' },
            { icon: <AudioLines size={18} />, t: 'Narrate', s: '24 natural voices' },
            { icon: <Film size={18} />, t: 'Assemble', s: 'Branded, captioned' },
          ].map((s) => (
            <div key={s.t} className="ps-pipe-step">
              {s.icon}
              <strong>{s.t}</strong>
              <span>{s.s}</span>
            </div>
          ))}
        </div>
        <div className="ps-auth-bullets">
          <span><Check size={15} /> Multi-track editor in the browser</span>
          <span><Check size={15} /> Team spaces &amp; brand kits</span>
          <span><Check size={15} /> Export up to 4K</span>
        </div>
      </aside>
    </div>
  )
}
