import type { ExportRecord, ProjectSummary } from '@producer/core'
import { CalendarClock, Check, ChevronLeft, ChevronRight, Download, ExternalLink, Film, Link2, Send } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '../../lib/api'
import { useSession } from '../../lib/session'
import { toast, toastError } from '../../lib/toast'
import { EmptyState, Soon, Spinner, Thumb, useAsync, usePageTitle } from '../ui'
import { absoluteUrl, copyText, formatBytes, formatDuration, relativeTime } from '../util'

type Row = ExportRecord & { project: ProjectSummary }

function ScheduleCalendar() {
  const [offset, setOffset] = useState(0)
  const base = new Date()
  const month = new Date(base.getFullYear(), base.getMonth() + offset, 1)
  const startDay = (month.getDay() + 6) % 7 // Monday first
  const days = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate()
  const cells = Array.from({ length: Math.ceil((startDay + days) / 7) * 7 }, (_, i) => i - startDay + 1)
  const today = offset === 0 ? base.getDate() : -1
  return (
    <div className="ps-cal">
      <div className="ps-cal-head">
        <CalendarClock size={16} style={{ color: 'var(--cyan)' }} />
        <strong>Scheduling to social platforms</strong>
        <Soon />
        <span className="spacer" />
        <button className="btn ghost sm icon" onClick={() => setOffset((o) => o - 1)} aria-label="Previous month"><ChevronLeft size={15} /></button>
        <span style={{ minWidth: 120, textAlign: 'center', fontWeight: 600 }}>{month.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}</span>
        <button className="btn ghost sm icon" onClick={() => setOffset((o) => o + 1)} aria-label="Next month"><ChevronRight size={15} /></button>
      </div>
      <div className="ps-cal-grid" aria-hidden>
        {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d) => <span key={d} className="ps-cal-dow">{d}</span>)}
        {cells.map((d, i) => (
          <span key={i} className={`ps-cal-cell ${d < 1 || d > days ? 'out' : ''} ${d === today ? 'today' : ''}`}>
            {d >= 1 && d <= days ? d : ''}
            {offset === 0 && (d === today + 2 || d === today + 5) && d <= days && <i className="ps-cal-ghost" />}
          </span>
        ))}
      </div>
      <div className="ps-cal-veil">
        <strong>Plan and auto-publish to YouTube, TikTok, Instagram and LinkedIn</strong>
        <span>Connect your accounts, drop an export on a date, and Producer Studio posts it for you. Arriving in phase 2.</span>
      </div>
    </div>
  )
}

export default function ExportsPage() {
  usePageTitle('Exports & sharing')
  const navigate = useNavigate()
  const workspaceId = useSession((s) => s.workspaceId)
  const [copied, setCopied] = useState<string>()
  const [sharing, setSharing] = useState<string>()
  const { data, loading, error, reload } = useAsync(async () => {
    if (!workspaceId) return [] as Row[]
    const projects = (await api.projects(workspaceId)).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 24)
    const lists = await Promise.all(projects.map((p) => api.exports(p.id).then((l) => l.map((e) => ({ ...e, project: p }))).catch(() => [] as Row[])))
    return lists.flat().sort((a, b) => b.createdAt - a.createdAt)
  }, [workspaceId])
  const total = useMemo(() => (data ?? []).reduce((t, r) => t + (r.sizeBytes || 0), 0), [data])

  async function share(r: Row) {
    setSharing(r.exportId)
    try {
      const s = await api.share(r.projectId, r.exportId)
      const url = absoluteUrl(s.url)
      if (await copyText(url)) {
        setCopied(r.exportId)
        toast('Share link copied')
        setTimeout(() => setCopied((c) => (c === r.exportId ? undefined : c)), 2500)
      } else toast(url)
    } catch (e) {
      toastError(e)
    } finally {
      setSharing(undefined)
    }
  }

  return (
    <div className="ps-page">
      <div className="ps-page-head">
        <div>
          <span className="eyebrow">Exports &amp; sharing</span>
          <h1>Finished videos</h1>
          <p>Every render from this space’s recent projects. Download files or send a link anyone can watch — no sign-in needed.</p>
        </div>
        <span className="spacer" />
        {data?.length ? <span className="muted" style={{ fontSize: '0.8125rem' }}>{data.length} exports · {formatBytes(total)}</span> : null}
      </div>

      {error ? (
        <div className="ps-alert">Couldn’t load exports. <button className="btn sm" onClick={reload}>Retry</button></div>
      ) : loading && !data ? (
        <div className="ps-exports">{[0, 1, 2, 3].map((i) => <div key={i} className="skeleton" style={{ height: 76, borderRadius: 12 }} />)}</div>
      ) : !data?.length ? (
        <EmptyState icon={<Send size={24} />} title="No exports yet" body="Open a project and choose Export to render an MP4. It will appear here with a shareable link." action={<button className="btn primary" onClick={() => navigate('/library')}><Film size={15} /> Go to Library</button>} />
      ) : (
        <div className="ps-exports">
          {data.map((r) => (
            <div key={r.exportId} className="ps-export">
              <div style={{ width: 120, flex: 'none' }}>
                <Thumb src={r.project.thumbnailUrl} seed={r.projectId}>
                  <span className="ps-thumb-badge">{formatDuration(r.duration)}</span>
                </Thumb>
              </div>
              <div className="ps-export-meta">
                <strong title={r.name}>{r.name || r.project.name}</strong>
                <span>
                  <button className="ps-link" onClick={() => navigate(`/edit/${r.projectId}`)}>{r.project.name}</button> · {relativeTime(r.createdAt)}
                </span>
              </div>
              <div className="ps-export-tags">
                <span className="kbd">{r.resolution}</span>
                <span className="kbd">{r.fps} fps</span>
                <span className="kbd">{formatBytes(r.sizeBytes)}</span>
              </div>
              <div className="row" style={{ gap: 6 }}>
                <a className="btn sm" href={r.url} target="_blank" rel="noreferrer" title="Open"><ExternalLink size={13} /></a>
                <a className="btn sm" href={r.url} download={`${r.name || r.project.name}.mp4`}><Download size={13} /> Download</a>
                <button className="btn sm primary" onClick={() => share(r)} disabled={sharing === r.exportId}>
                  {sharing === r.exportId ? <Spinner size={13} /> : copied === r.exportId ? <Check size={13} /> : <Link2 size={13} />} {copied === r.exportId ? 'Copied' : 'Copy link'}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      <section className="ps-section">
        <ScheduleCalendar />
      </section>
    </div>
  )
}
