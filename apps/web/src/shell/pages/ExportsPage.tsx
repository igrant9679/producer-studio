import type { ExportRequest, SpaceExport } from '@producer/core'
import { CalendarClock, Check, ChevronLeft, ChevronRight, Download, ExternalLink, Film, Link2, Link2Off, RotateCcw, Search, Send, Trash2, X } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { api } from '../../lib/api'
import { collabApi } from '../../lib/collabApi'
import { useSession } from '../../lib/session'
import { toast, toastError } from '../../lib/toast'
import { SpaceShareLinks } from '../components/ShareLinks'
import '../library/library.css'
import { liveBus } from '../stores'
import { ConfirmDialog, EmptyState, Soon, Spinner, Thumb, useAsync, useEditGate, usePageTitle } from '../ui'
import { absoluteUrl, copyText, downloadUrl, formatBytes, formatDuration, relativeTime } from '../util'

type Row = SpaceExport & { shareToken?: string }

/** The format filter's choices (A-19). */
export const EXPORT_FORMAT_FILTERS: Array<{ id: string; label: string }> = [
  { id: '', label: 'All formats' },
  { id: 'mp4,webm', label: 'Video (MP4, WebM)' },
  { id: 'gif', label: 'GIF' },
  { id: 'mp3,wav', label: 'Audio (MP3, WAV)' },
]

const PAGE = 50

/** The export settings to render the same export again ("Re-render"): its size, frame rate, format and name. */
export function rerenderRequest(r: Pick<SpaceExport, 'resolution' | 'fps' | 'format' | 'name'>): ExportRequest {
  const resolution = (['720p', '1080p', '1440p', '4k'].includes(r.resolution) ? r.resolution : '1080p') as ExportRequest['resolution']
  const fps = ([24, 25, 30, 50, 60].includes(r.fps) ? r.fps : 30) as ExportRequest['fps']
  return { resolution, fps, quality: 'standard', format: r.format ?? 'mp4', name: r.name }
}

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
        <span>Connect your accounts, drop an export on a date, and Producer Studio posts it for you.</span>
      </div>
    </div>
  )
}

export default function ExportsPage() {
  usePageTitle('Exports & sharing')
  const navigate = useNavigate()
  const workspaceId = useSession((s) => s.workspaceId)
  const gate = useEditGate()
  const [copied, setCopied] = useState<string>()
  const [sharing, setSharing] = useState<string>()
  // ?q= (a search hit for an export) starts the list searched
  const [params] = useSearchParams()
  const [q, setQ] = useState(() => params.get('q') ?? '')
  const [term, setTerm] = useState(() => (params.get('q') ?? '').trim())
  const [format, setFormat] = useState('')
  const [more, setMore] = useState<string>()
  const [loadingMore, setLoadingMore] = useState(false)
  const [confirm, setConfirm] = useState<Row>()
  const [busy, setBusy] = useState(false)
  // the search waits for a pause in typing
  useEffect(() => {
    const t = setTimeout(() => setTerm(q.trim()), 250)
    return () => clearTimeout(t)
  }, [q])
  const { data, loading, error, reload, setData } = useAsync(async () => {
    if (!workspaceId) return [] as Row[]
    // every project's exports, newest first, a page at a time (A-19), with the link each one has
    const [page, links] = await Promise.all([api.spaceExports(workspaceId, { q: term, format, limit: PAGE }), collabApi.spaceShares(workspaceId).catch(() => [])])
    setMore(page.nextCursor)
    const byExport = new Map(links.map((l) => [l.exportId, l.token]))
    return page.items.map((e): Row => ({ ...e, shareToken: byExport.get(e.exportId) }))
  }, [workspaceId, term, format])
  // a render that finishes (a re-render, or one started elsewhere) shows up here
  useEffect(() => liveBus.onJob((j) => j.kind === 'export.render' && j.status === 'done' && reload()), [reload])
  const total = useMemo(() => (data ?? []).reduce((t, r) => t + (r.sizeBytes || 0), 0), [data])

  async function loadMore() {
    if (!workspaceId || !more) return
    setLoadingMore(true)
    try {
      const page = await api.spaceExports(workspaceId, { q: term, format, cursor: more, limit: PAGE })
      setMore(page.nextCursor)
      setData((cur) => [...(cur ?? []), ...page.items])
    } catch (e) {
      toastError(e, 'Couldn’t load more exports')
    } finally {
      setLoadingMore(false)
    }
  }

  async function share(r: Row) {
    setSharing(r.exportId)
    try {
      const s = await api.share(r.projectId, r.exportId)
      setData((cur) => (cur ?? []).map((x) => (x.exportId === r.exportId ? { ...x, shareToken: s.token } : x)))
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

  async function unshare(r: Row) {
    if (!r.shareToken) return
    setSharing(r.exportId)
    try {
      await api.unshare(r.shareToken)
      setData((cur) => (cur ?? []).map((x) => (x.exportId === r.exportId ? { ...x, shareToken: undefined } : x)))
      toast('Stopped sharing: that link no longer works')
    } catch (e) {
      toastError(e)
    } finally {
      setSharing(undefined)
    }
  }

  async function remove(r: Row) {
    setBusy(true)
    try {
      const res = await api.deleteExport(r.exportId)
      setData((cur) => (cur ?? []).filter((x) => x.exportId !== r.exportId))
      toast(res.keptFile ? 'Export deleted. Its video stays in Media: a project uses it.' : 'Export deleted')
    } catch (e) {
      toastError(e)
    } finally {
      setBusy(false)
      setConfirm(undefined)
    }
  }

  async function rerender(r: Row) {
    try {
      await api.exportProject(r.projectId, rerenderRequest(r))
      toast(`Rendering “${r.name || r.projectName}” again: it appears here when it’s done`)
    } catch (e) {
      toastError(e, 'Couldn’t start the render')
    }
  }

  const filtered = !!(term || format)
  return (
    <div className="ps-page">
      <div className="ps-page-head">
        <div>
          <span className="eyebrow">Exports &amp; sharing</span>
          <h1>Finished videos</h1>
          <p>Every render from this space’s projects. Download files or send a link anyone can watch — no sign-in needed.</p>
        </div>
        <span className="spacer" />
        {data?.length ? <span className="muted" style={{ fontSize: '0.8125rem' }}>{data.length}{more ? '+' : ''} exports · {formatBytes(total)}</span> : null}
      </div>

      <div className="ps-export-filters" role="search">
        <div style={{ position: 'relative', width: 'min(320px, 100%)' }}>
          <Search size={15} style={{ position: 'absolute', left: 12, top: 10, color: 'var(--text-3)' }} />
          <input className="input" style={{ paddingLeft: 34 }} placeholder="Search exports and projects" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search exports" />
          {q && <button className="btn ghost sm icon" style={{ position: 'absolute', right: 4, top: 3 }} onClick={() => setQ('')} aria-label="Clear search"><X size={13} /></button>}
        </div>
        <select className="input" style={{ width: 190 }} value={format} onChange={(e) => setFormat(e.target.value)} aria-label="Format">
          {EXPORT_FORMAT_FILTERS.map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}
        </select>
      </div>

      {error ? (
        <div className="ps-alert">Couldn’t load exports. <button className="btn sm" onClick={reload}>Retry</button></div>
      ) : loading && !data ? (
        <div className="ps-exports">{[0, 1, 2, 3].map((i) => <div key={i} className="skeleton" style={{ height: 76, borderRadius: 12 }} />)}</div>
      ) : !data?.length ? (
        filtered ? (
          <EmptyState icon={<Search size={24} />} title="No exports match" body="Try another word or format." action={<button className="btn" onClick={() => (setQ(''), setFormat(''))}>Clear filters</button>} />
        ) : (
          <EmptyState icon={<Send size={24} />} title="No exports yet" body="Open a project and choose Export to render an MP4. It will appear here with a shareable link." action={<button className="btn primary" onClick={() => navigate('/library')}><Film size={15} /> Go to Library</button>} />
        )
      ) : (
        <div className="ps-exports" role="list" aria-label="Exports">
          {data.map((r) => {
            const title = r.name || r.projectName
            const audio = r.format === 'mp3' || r.format === 'wav'
            return (
              <div key={r.exportId} className="ps-export" role="listitem">
                <div style={{ width: 120, flex: 'none' }}>
                  <Thumb src={r.projectThumbnailUrl} seed={r.projectId}>
                    <span className="ps-thumb-badge">{formatDuration(r.duration)}</span>
                  </Thumb>
                </div>
                <div className="ps-export-meta">
                  <strong title={title}>{title}</strong>
                  <span>
                    <button className="ps-link" onClick={() => navigate(`/edit/${r.projectId}`)}>{r.projectName}</button> · {relativeTime(r.createdAt)}
                  </span>
                </div>
                <div className="ps-export-tags">
                  <span className={`ps-format-badge${audio ? ' audio' : ''}`} aria-label={`Format ${(r.format ?? 'mp4').toUpperCase()}`}>{(r.format ?? 'mp4').toUpperCase()}</span>
                  {!audio && <span className="kbd">{r.resolution}</span>}
                  {!audio && <span className="kbd">{r.fps} fps</span>}
                  <span className="kbd">{formatBytes(r.sizeBytes)}</span>
                </div>
                <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
                  <a className="btn sm" href={r.url} target="_blank" rel="noreferrer" data-tip="Open in a new tab" aria-label={`Open ${title} in a new tab`}><ExternalLink size={13} /></a>
                  <a className="btn sm" href={downloadUrl(r.url)} download><Download size={13} /> Download</a>
                  <button className="btn sm primary" onClick={() => share(r)} disabled={sharing === r.exportId || !gate.canEdit} data-tip={gate.tip}>
                    {sharing === r.exportId ? <Spinner size={13} /> : copied === r.exportId ? <Check size={13} /> : <Link2 size={13} />} {copied === r.exportId ? 'Copied' : 'Copy link'}
                  </button>
                  {r.shareToken && (
                    <button className="btn sm ghost" onClick={() => void unshare(r)} disabled={sharing === r.exportId || !gate.canEdit} data-tip="Stop sharing" data-tip-desc="The link stops working for everyone who has it" aria-label="Stop sharing">
                      <Link2Off size={13} />
                    </button>
                  )}
                  <button className="btn sm ghost" {...gate.props} onClick={() => void rerender(r)} data-tip={gate.tip ?? 'Render again'} data-tip-desc="Same size, frame rate and format, from the project as it is now" aria-label={`Render ${title} again`}>
                    <RotateCcw size={13} />
                  </button>
                  <button className="btn sm ghost" {...gate.props} onClick={() => setConfirm(r)} data-tip={gate.tip ?? 'Delete export'} aria-label={`Delete ${title}`}>
                    <Trash2 size={13} />
                  </button>
                </div>
              </div>
            )
          })}
          {more && (
            <button className="btn" style={{ alignSelf: 'center' }} onClick={() => void loadMore()} disabled={loadingMore}>
              {loadingMore && <Spinner size={14} />} Show more exports
            </button>
          )}
        </div>
      )}

      {confirm && (
        <ConfirmDialog
          title={`Delete “${confirm.name || confirm.projectName}”?`}
          body={`The rendered file is removed${confirm.shares ? `, and ${confirm.shares === 1 ? 'its share link stops' : `its ${confirm.shares} share links stop`} working for everyone who has ${confirm.shares === 1 ? 'it' : 'them'}` : ''}. The project itself is kept: you can export it again. This can’t be undone.`}
          confirmLabel="Delete export"
          busy={busy}
          onConfirm={() => void remove(confirm)}
          onClose={() => setConfirm(undefined)}
        />
      )}

      {workspaceId && <SpaceShareLinks key={`${workspaceId}:${(data ?? []).map((r) => r.shareToken ?? '').join()}`} workspaceId={workspaceId} />}

      <section className="ps-section">
        <ScheduleCalendar />
      </section>
    </div>
  )
}
