// Linking this computer to a cloud account (D-5): sign in, see what linking would do (each space here, its projects
// and clips and the bytes that would go up, where it would go; another account's spaces that would be set aside),
// choose per space, then link. Older desktops without the preview link straight away.
import type { LinkChoice, LinkPreview, LinkPreviewSpace } from '@producer/core'
import { Link2, X } from 'lucide-react'
import { useEffect, useRef, useState, type FormEvent } from 'react'
import { HttpError } from '../../lib/api'
import { useSession } from '../../lib/session'
import { toast } from '../../lib/toast'
import { systemApi, useSystem } from '../system'
import { Spinner } from '../ui'
import { formatBytes } from '../util'
import './sync.css'

const DEFAULT_CLOUD_URL = 'https://producerstudio.app'

function errText(e: unknown): string {
  if (e instanceof HttpError) {
    if (e.status === 401) return 'The cloud rejected that email or password.'
    return e.body?.error || e.message
  }
  if (e instanceof TypeError) return 'Couldn’t reach the cloud. Check the URL and your connection.'
  return e instanceof Error ? e.message : String(e)
}

const choiceKey = (c: LinkChoice) => (c.action === 'merge' ? `merge:${c.into}` : c.action)
const fromKey = (k: string): LinkChoice => (k.startsWith('merge:') ? { action: 'merge', into: k.slice(6) } : k === 'local' ? { action: 'local' } : { action: 'new' })

function plural(n: number, one: string) {
  return `${n} ${one}${n === 1 ? '' : 's'}`
}

function SpaceRow({ s, preview, value, onChange }: { s: LinkPreviewSpace; preview: LinkPreview; value: LinkChoice; onChange: (c: LinkChoice) => void }) {
  const what = [plural(s.projects, 'project'), plural(s.clips, 'clip'), s.voices ? plural(s.voices, 'voice') : ''].filter(Boolean).join(', ')
  const id = `linkp-${s.id}`
  return (
    <li className="ps-syncp-item ps-linkp-space">
      <div className="ps-syncp-name">
        <strong>{s.name}</strong>
        <span>
          {s.synced ? `Synced with this account before: ${what} to send` : what}
          {s.uploadBytes ? ` · ${formatBytes(s.uploadBytes)} to upload` : ''}
        </span>
      </div>
      {!s.synced && (
        <>
          <label className="label" htmlFor={id}>
            Where “{s.name}” goes
          </label>
          <select id={id} className="input" value={choiceKey(value)} onChange={(e) => onChange(fromKey(e.target.value))}>
            {preview.cloudSpaces
              .filter((w) => w.role !== 'viewer')
              .map((w) => (
                <option key={w.id} value={`merge:${w.id}`}>
                  Merge into “{w.name}”{w.personal ? ' (your personal space)' : ''}
                </option>
              ))}
            <option value="new">Create “{s.name}” in the cloud</option>
            <option value="local">Keep it on this computer only</option>
          </select>
        </>
      )}
    </li>
  )
}

/** Step two: what linking would do, a choice per space. */
export function LinkPreviewStep({ preview, onDone, onCancel }: { preview: LinkPreview; onDone: () => void; onCancel: () => void }) {
  const setSync = useSystem((s) => s.setSync)
  const [choices, setChoices] = useState<Record<string, LinkChoice>>(() => Object.fromEntries(preview.spaces.filter((s) => !s.synced).map((s) => [s.id, s.suggested])))
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string>()
  const heading = useRef<HTMLHeadingElement>(null)
  useEffect(() => heading.current?.focus(), [])
  const bytes = preview.spaces.filter((s) => s.synced || choices[s.id]?.action !== 'local').reduce((n, s) => n + s.uploadBytes, 0)
  async function link() {
    setBusy(true)
    setErr(undefined)
    try {
      setSync(await systemApi.linkAsPreviewed(preview.previewId, choices))
      await useSession.getState().load()
      toast('Linked — syncing your projects')
      onDone()
    } catch (e) {
      setErr(errText(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <section className="ps-set-form" aria-labelledby="linkp-title">
      <h3 id="linkp-title" ref={heading} tabIndex={-1} style={{ margin: '0 0 4px' }}>
        Before linking {preview.account}
      </h3>
      <p className="muted" style={{ margin: '0 0 12px', fontSize: '0.8125rem' }}>
        Nothing has changed yet. Your cloud spaces: {preview.cloudSpaces.map((w) => `“${w.name}”`).join(', ') || 'none'}; their projects come down to this computer, clips when you open them.
      </p>
      {preview.setAside && (
        <div className="ps-alert info" role="note" style={{ marginBottom: 12 }}>
          The spaces from {preview.setAside.account ?? 'the account linked before'} ({preview.setAside.spaces.map((n) => `“${n}”`).join(', ')}) stay on this computer but won’t sync with {preview.account}.
        </div>
      )}
      {preview.spaces.length ? (
        <ul className="ps-syncp-list" aria-label="This computer’s spaces">
          {preview.spaces.map((s) => (
            <SpaceRow key={s.id} s={s} preview={preview} value={choices[s.id] ?? s.suggested} onChange={(c) => setChoices((cur) => ({ ...cur, [s.id]: c }))} />
          ))}
        </ul>
      ) : (
        <p className="muted">There’s nothing on this computer to merge.</p>
      )}
      <p style={{ fontSize: '0.8125rem' }}>{bytes ? `${formatBytes(bytes)} of clips will upload in the background.` : 'No clips to upload.'}</p>
      {err && (
        <div className="ps-alert" role="alert" style={{ marginBottom: 12 }}>
          {err}
        </div>
      )}
      <div className="row" style={{ gap: 6 }}>
        <button className="btn primary" disabled={busy} onClick={link}>
          {busy ? <Spinner /> : <Link2 size={15} />} Link and sync
        </button>
        <button className="btn ghost" disabled={busy} onClick={onCancel}>
          <X size={15} /> Cancel
        </button>
      </div>
    </section>
  )
}

export function LinkForm() {
  const setSync = useSystem((s) => s.setSync)
  const [cloudUrl, setCloudUrl] = useState(DEFAULT_CLOUD_URL)
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string>()
  const [preview, setPreview] = useState<LinkPreview>()
  const submitRef = useRef<HTMLButtonElement>(null)
  async function submit(e: FormEvent) {
    e.preventDefault()
    if (!/^https?:\/\/.+/.test(cloudUrl.trim())) return setErr('Enter the full cloud URL, starting with https://')
    if (!email.trim() || !password) return setErr('Enter your cloud email and password')
    setBusy(true)
    setErr(undefined)
    const url = cloudUrl.trim().replace(/\/+$/, '')
    try {
      try {
        setPreview(await systemApi.linkPreview(url, email.trim(), password))
        setPassword('')
        return
      } catch (e2) {
        // an older desktop without the preview: link straight away, as before
        if (!(e2 instanceof HttpError && e2.status === 404)) throw e2
      }
      setSync(await systemApi.link(url, email.trim(), password))
      setPassword('')
      await useSession.getState().load()
      toast('Linked — syncing your projects')
    } catch (e2) {
      setErr(errText(e2))
    } finally {
      setBusy(false)
    }
  }
  if (preview)
    return (
      <LinkPreviewStep
        preview={preview}
        onDone={() => setPreview(undefined)}
        onCancel={() => {
          void systemApi.cancelLinkPreview(preview.previewId).catch(() => undefined)
          setPreview(undefined)
          requestAnimationFrame(() => submitRef.current?.focus())
        }}
      />
    )
  return (
    <form onSubmit={submit} className="ps-set-form" aria-label="Link a cloud account">
      <p className="muted" style={{ margin: '0 0 14px', fontSize: '0.8125rem' }}>Sign in with your Producer Studio cloud account. Your password is exchanged for a device token and isn’t stored on this computer. You’ll see what linking would do before anything changes.</p>
      <div className="ps-set-grid">
        <div className="ps-field" style={{ gridColumn: '1 / -1' }}>
          <label className="label" htmlFor="sync-url">Cloud URL</label>
          <input id="sync-url" className="input" value={cloudUrl} onChange={(e) => setCloudUrl(e.target.value)} spellCheck={false} />
        </div>
        <div className="ps-field">
          <label className="label" htmlFor="sync-email">Email</label>
          <input id="sync-email" className="input" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@company.com" />
        </div>
        <div className="ps-field">
          <label className="label" htmlFor="sync-pw">Password</label>
          <input id="sync-pw" className="input" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </div>
      </div>
      {err && <div className="ps-alert" role="alert" style={{ marginBottom: 12 }}>{err}</div>}
      <button ref={submitRef} className="btn primary" disabled={busy}>{busy ? <Spinner /> : <Link2 size={15} />} Continue</button>
    </form>
  )
}
