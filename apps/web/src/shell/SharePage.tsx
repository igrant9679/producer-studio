import type { ProjectSummary } from '@producer/core'
import { ArrowRight, Film, LinkIcon } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import './dev/installMock'
import './shell.css'
import './share.css'
import { Logo, Spinner } from './ui'
import { formatDuration, relativeTime } from './util'

interface ShareData {
  project: ProjectSummary
  videoUrl?: string
}

export function SharePage() {
  const { token } = useParams()
  const [data, setData] = useState<ShareData>()
  const [error, setError] = useState<{ status: number; message: string }>()

  useEffect(() => {
    let alive = true
    setData(undefined)
    setError(undefined)
    fetch('/api/share/' + encodeURIComponent(token ?? ''), { credentials: 'omit' })
      .then(async (r) => {
        if (!r.ok) {
          let message = r.status === 404 ? 'This link has expired or doesn’t exist.' : 'Something went wrong loading this video.'
          try {
            const b = await r.json()
            if (b?.error && r.status !== 404) message = b.error
          } catch {
            /* ignore */
          }
          throw Object.assign(new Error(message), { status: r.status })
        }
        return (await r.json()) as ShareData
      })
      .then((d) => {
        if (!alive) return
        setData(d)
        document.title = `${d.project.name} · Producer Studio`
      })
      .catch((e: Error & { status?: number }) => alive && setError({ status: e.status ?? 0, message: e.status ? e.message : 'Can’t reach Producer Studio right now.' }))
    return () => {
      alive = false
    }
  }, [token])

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
        {error ? (
          <div className="ps-share-empty">
            <div className="ps-empty-icon"><LinkIcon size={24} /></div>
            <h1>{error.status === 404 ? 'Link not found' : 'Video unavailable'}</h1>
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
                <video src={data.videoUrl} poster={data.project.thumbnailUrl} controls playsInline autoPlay />
              ) : (
                <div className="ps-share-novideo">
                  <Film size={28} />
                  <strong>No finished video yet</strong>
                  <span>The creator hasn’t exported this project yet — check back soon.</span>
                </div>
              )}
            </div>
            <div className="ps-share-meta">
              <h1>{data.project.name}</h1>
              <span>{formatDuration(data.project.duration)} · Updated {relativeTime(data.project.updatedAt)}</span>
            </div>
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
