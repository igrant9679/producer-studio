// /welcome: right after signing up in the app. Three ways on: a membership from the membership website for this space
// (the server's AI and a team's seats; the person comes back here signed in, through the claim the website carries
// through its checkout), their own AI key, or free for now. The first shows only where memberships are set up.
import { ArrowRight, KeyRound, Sparkles } from 'lucide-react'
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '../../lib/api'
import { useSession } from '../../lib/session'
import { toastError } from '../../lib/toast'
import { Spinner, useAsync, usePageTitle } from '../ui'

export default function WelcomePage() {
  usePageTitle('Welcome')
  const navigate = useNavigate()
  const user = useSession((s) => s.user)
  const workspaceId = useSession((s) => s.workspaceId)
  const m = useAsync(() => (workspaceId ? api.membership(workspaceId) : Promise.resolve(undefined)), [workspaceId])
  // accounts come through the membership website (28 Nov 2026): no "continue free" from here
  const opts = useAsync(() => api.authOptions(), [])
  const free = opts.data ? opts.data.signup === 'open' : false
  const [busy, setBusy] = useState(false)
  const canJoin = !!m.data?.canClaim
  const join = async () => {
    if (!workspaceId) return
    setBusy(true)
    try {
      const r = await api.claimMembership(workspaceId)
      window.location.assign(r.url)
    } catch (e) {
      toastError(e)
      setBusy(false)
    }
  }
  const first = user?.name?.split(/\s+/)[0]
  return (
    <div className="ps-page narrow">
      <div className="ps-page-head" style={{ marginBottom: 18 }}>
        <h1 className="ps-h1">Welcome{first ? `, ${first}` : ''}</h1>
        <p className="muted" style={{ margin: '6px 0 0' }}>
          Your space is ready. Editing, recording, uploads, exports, free stock footage and photos, and the music and sound libraries all work now.
          Producer, the assistant, and AI pictures and clips need AI: choose how.
        </p>
      </div>
      {m.loading && !m.data ? (
        <Spinner size={18} />
      ) : (
        <div style={{ display: 'grid', gap: 12 }} role="list" aria-label="How to go on">
          {canJoin && (
            <section className="card ps-brand-sec" role="listitem" aria-label="Get a membership">
              <div className="ps-brand-sec-head">
                <Sparkles size={16} /> <strong>Get a membership</strong>
                <span className="muted">Recommended</span>
              </div>
              <p className="muted" style={{ fontSize: '0.875rem', margin: '0 0 12px' }}>
                The server’s AI for this space, and seats for a team. You choose a plan on the membership website and come back here signed in.
              </p>
              <button className="btn primary" disabled={busy} onClick={() => void join()}>
                {busy ? <Spinner size={13} /> : <Sparkles size={14} />} Choose a plan
              </button>
            </section>
          )}
          <section className="card ps-brand-sec" role="listitem" aria-label="Use my own AI key">
            <div className="ps-brand-sec-head">
              <KeyRound size={16} /> <strong>Use my own AI key</strong>
            </div>
            <p className="muted" style={{ fontSize: '0.875rem', margin: '0 0 12px' }}>
              Bring an Anthropic, Gemini, OpenAI or OpenRouter key. It is used for this space only, and billed to your own account.
            </p>
            <button className="btn" onClick={() => navigate('/settings#ai')}>
              <KeyRound size={14} /> Add a key
            </button>
          </section>
          {free && (
          <section className="card ps-brand-sec" role="listitem" aria-label="Continue free">
            <div className="ps-brand-sec-head">
              <ArrowRight size={16} /> <strong>Continue free for now</strong>
            </div>
            <p className="muted" style={{ fontSize: '0.875rem', margin: '0 0 12px' }}>
              {canJoin ? 'You can get a membership any time from the Members page.' : 'You can add a key any time in Settings → AI.'}
            </p>
            <button className="btn ghost" onClick={() => navigate('/', { replace: true })}>
              Go to my space <ArrowRight size={14} />
            </button>
          </section>
          )}
        </div>
      )}
    </div>
  )
}
