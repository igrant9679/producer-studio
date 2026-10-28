import type { SharedPage } from '@producer/core'
import { ArrowRight, Clock, Download, Film, KeyRound, LinkIcon } from 'lucide-react'
import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { HttpError } from '../lib/api'
import { shareApi } from '../lib/collabApi'
import './dev/installMock'
import './shell.css'
import './share.css'
import { ShareCommentPins, ShareComments } from './ShareComments'
import { Logo, Spinner } from './ui'
import { formatDuration, relativeTime } from './util'

type Failure = { status: number; message: string; password?: boolean }

const keyStore = (token: string) => `ps.share.key.${token}`
function readKey(token: string): string | undefined {
  try {
    return sessionStorage.getItem(keyStore(token)) ?? undefined
  } catch {
    return undefined
  }
}

/**
 * The public page behind a share link: the export, and what the link allows (a download, comments). An expired link
 * says so; a password-protected one asks for the password first and keeps the key for this browser tab.
 */
export function SharePage() {
  const { token = '' } = useParams()
  const [key, setKey] = useState(() => readKey(token))
  const [data, setData] = useState<SharedPage>()
  const [error, setError] = useState<Failure>()
  const video = useRef<HTMLVideoElement>(null)

  useEffect(() => {
    let alive = true
    setData(undefined)
    setError(undefined)
    shareApi
      .page(token, key)
      .then((d) => {
        if (!alive) return
        setData(d)
        document.title = `${d.project.name} · Producer Studio`
      })
      .catch((e: unknown) => {
        if (!alive) return
        if (e instanceof HttpError) {
          const password = e.status === 401 && !!(e.body.details as { password?: boolean } | undefined)?.password
          const message = e.status === 404 ? 'This link doesn’t exist or was revoked.' : e.status === 410 ? 'This link has expired. Ask whoever sent it for a new one.' : e.status >= 500 ? 'Something went wrong loading this video.' : e.message
          setError({ status: e.status, message, password })
        } else setError({ status: 0, message: 'Can’t reach Producer Studio right now.' })
      })
    return () => {
      alive = false
    }
  }, [token, key])

  const ratio = data ? data.project.width / data.project.height || 16 / 9 : 16 / 9

  return (
    <div className="ps-share">
      <header className="ps-share-top">
        <a href="/" aria-label="Producer Studio">
          <Logo />
        </a>
        <span className="spacer" />
        <Link to="/signup" className="btn sm">Make your own <ArrowRight size={14} /></Link>
      </header>

      <main className="ps-share-main">
        {error?.password ? (
          <Unlock
            token={token}
            onUnlocked={(k) => {
              try {
                sessionStorage.setItem(keyStore(token), k)
              } catch {
                /* this visit only */
              }
              setKey(k)
            }}
          />
        ) : error ? (
          <div className="ps-share-empty">
            <div className="ps-empty-icon">{error.status === 410 ? <Clock size={24} /> : <LinkIcon size={24} />}</div>
            <h1>{error.status === 404 ? 'Link not found' : error.status === 410 ? 'Link expired' : 'Video unavailable'}</h1>
            <p>{error.message}</p>
            <a className="btn" href="/">Go to Producer Studio</a>
          </div>
        ) : !data ? (
          <div className="ps-share-player skeleton" style={{ aspectRatio: '16 / 9', display: 'grid', placeItems: 'center' }}>
            <Spinner size={24} />
          </div>
        ) : (
          <div className="ps-share-stage" style={{ maxWidth: ratio < 1.2 ? `min(100%, calc(78vh * ${ratio}))` : undefined }}>
            <div className="ps-share-player" style={{ aspectRatio: String(ratio) }}>
              {data.videoUrl ? (
                <video ref={video} src={data.videoUrl} poster={data.posterUrl} controls playsInline autoPlay controlsList={data.allowDownload ? undefined : 'nodownload'} />
              ) : (
                <div className="ps-share-novideo">
                  <Film size={28} />
                  <strong>No finished video yet</strong>
                  <span>The creator hasn’t exported this project yet — check back soon.</span>
                </div>
              )}
              {data.allowComments && data.videoUrl && <ShareCommentPins video={video} />}
            </div>
            <div className="ps-share-meta">
              <div>
                <h1>{data.project.name}</h1>
                <span>{formatDuration(data.project.duration)} · Updated {relativeTime(data.project.updatedAt)}</span>
              </div>
              {data.downloadUrl && (
                <a className="btn" href={data.downloadUrl} download>
                  <Download size={15} /> Download
                </a>
              )}
            </div>
            {data.allowComments && data.videoUrl && <ShareComments token={token} shareKey={key} video={video} />}
          </div>
        )}
      </main>

      <footer className="ps-share-foot">
        <a href="/" className="ps-made">
          <img src="/favicon.svg" alt="" /> Made with <b>Producer Studio</b>
        </a>
      </footer>
    </div>
  )
}

function Unlock({ token, onUnlocked }: { token: string; onUnlocked: (key: string) => void }) {
  const id = useId()
  const [pw, setPw] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string>()
  const submit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault()
      if (!pw) return
      setBusy(true)
      setErr(undefined)
      try {
        onUnlocked((await shareApi.unlock(token, pw)).key)
      } catch (e2) {
        setErr(e2 instanceof Error ? e2.message : String(e2))
      } finally {
        setBusy(false)
      }
    },
    [pw, token, onUnlocked],
  )
  return (
    <form className="ps-share-empty ps-share-unlock" onSubmit={submit} aria-labelledby={`${id}-t`}>
      <div className="ps-empty-icon"><KeyRound size={24} /></div>
      <h1 id={`${id}-t`}>This video needs a password</h1>
      <p>Whoever sent you the link can tell you what it is.</p>
      <label className="label" htmlFor={`${id}-pw`}>Password</label>
      <input id={`${id}-pw`} className="input" type="password" autoComplete="current-password" autoFocus value={pw} onChange={(e) => setPw(e.target.value)} aria-invalid={!!err} aria-describedby={err ? `${id}-err` : undefined} />
      {err && <div id={`${id}-err`} className="ps-field-err" role="alert">{err}</div>}
      <button type="submit" className="btn primary" disabled={busy || !pw}>{busy && <Spinner size={13} />} Watch</button>
    </form>
  )
}
