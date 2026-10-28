// The job history (A-8): the space's finished, failed and cancelled jobs, newest first, each linked to its project,
// with Retry for failed and cancelled ones (editors). Jobs that finish while the page is open join the list.
import type { Job } from '@producer/core'
import { Ban, Check, History, RotateCcw, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../../lib/api'
import { currentWorkspace, useSession } from '../../lib/session'
import { toast, toastError } from '../../lib/toast'
import { type HistoryStatus, usageApi } from '../../lib/usageApi'
import { liveBus, useJobs } from '../stores'
import { EmptyState, Spinner, useEditGate, usePageTitle } from '../ui'
import { JOB_LABELS, relativeTime } from '../util'
import './usage.css'

const FILTERS: Array<{ id: HistoryStatus | 'all'; label: string }> = [
  { id: 'all', label: 'Everything' },
  { id: 'error', label: 'Failed' },
  { id: 'cancelled', label: 'Cancelled' },
  { id: 'done', label: 'Finished' },
]

const finished = (j: Job) => j.status === 'done' || j.status === 'error' || j.status === 'cancelled'
const label = (j: Job) => JOB_LABELS[j.kind] ?? j.kind

/** "took 3 min" from when the run started to when it ended. */
export function tookWords(j: Job): string | undefined {
  if (!j.startedAt || j.updatedAt < j.startedAt) return undefined
  const s = Math.round((j.updatedAt - j.startedAt) / 1000)
  if (s < 60) return `took ${s} s`
  const m = Math.round(s / 60)
  return m < 90 ? `took ${m} min` : `took ${Math.round(m / 6) / 10} h`
}

/** Whether Retry applies: failed or cancelled, and not a desktop Voice Studio task. */
export const canRetry = (j: Job) => (j.status === 'error' || j.status === 'cancelled') && !j.kind.startsWith('voicestudio.')

const ICON = { done: <Check size={15} />, error: <X size={15} />, cancelled: <Ban size={15} /> } as const

export default function JobsPage() {
  usePageTitle('Job history')
  const ws = useSession(currentWorkspace)
  const gate = useEditGate()
  const [filter, setFilter] = useState<HistoryStatus | 'all'>('all')
  const [items, setItems] = useState<Job[]>()
  const [next, setNext] = useState<string>()
  const [error, setError] = useState<string>()
  const [more, setMore] = useState(false)
  const [busy, setBusy] = useState<string>()

  useEffect(() => {
    if (!ws) return
    let alive = true
    setItems(undefined)
    setError(undefined)
    usageApi
      .history(ws.id, filter === 'all' ? {} : { status: filter })
      .then((p) => {
        if (!alive) return
        setItems(p.items)
        setNext(p.nextCursor)
      })
      .catch((e) => alive && setError(e instanceof Error ? e.message : String(e)))
    // a job that finishes now joins the top of the list
    const off = liveBus.onJob((j) => {
      if (j.workspaceId !== ws.id || !finished(j) || (filter !== 'all' && j.status !== filter)) return
      setItems((cur) => (cur ? [{ ...j, result: undefined }, ...cur.filter((x) => x.id !== j.id)] : cur))
    })
    return () => {
      alive = false
      off()
    }
  }, [ws, filter])

  async function loadMore() {
    if (!ws || !next) return
    setMore(true)
    try {
      const p = await usageApi.history(ws.id, { ...(filter === 'all' ? {} : { status: filter }), cursor: next })
      setItems((cur) => [...(cur ?? []), ...p.items])
      setNext(p.nextCursor)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setMore(false)
    }
  }

  async function retry(j: Job) {
    setBusy(j.id)
    try {
      if (j.kind === 'asset.process' && j.assetId) {
        // a clip is retried through its own route, which checks the file reached storage first
        await api.retryAsset(j.assetId)
        toast('Processing the clip again')
      } else {
        const r = await usageApi.retryJob(j.id)
        useJobs.getState().upsert(r)
        toast(`${label(j)}: queued again`)
      }
    } catch (e) {
      toastError(e, `Couldn’t retry ${label(j).toLowerCase()}`)
    } finally {
      setBusy(undefined)
    }
  }

  return (
    <div className="ps-page narrow">
      <div className="ps-page-head">
        <div>
          <span className="eyebrow">{ws?.name ?? 'Space'}</span>
          <h1>Job history</h1>
          <p>Exports, voiceovers, transcriptions and processing that finished, failed or were cancelled in this space. Failed ones can be tried again.</p>
        </div>
      </div>
      <div className="row ps-usage-periods" role="group" aria-label="Show">
        {FILTERS.map((f) => (
          <button key={f.id} type="button" className={`chip${filter === f.id ? ' active' : ''}`} aria-pressed={filter === f.id} onClick={() => setFilter(f.id)}>
            {f.label}
          </button>
        ))}
      </div>
      {error ? (
        <div className="ps-alert" role="alert">Couldn’t load the job history: {error}</div>
      ) : !items ? (
        <Spinner size={20} />
      ) : !items.length ? (
        <EmptyState icon={<History size={24} />} title={filter === 'all' ? 'No finished jobs yet' : 'None of that kind'} body="Exports, voiceovers and transcriptions show here once they end." />
      ) : (
        <ol className="ps-jobs-history" aria-label="Finished jobs, newest first">
          {items.map((j) => (
            <li key={j.id} className="ps-jobs-item">
              <span className={`ps-jobs-item-icon ${j.status}`} aria-hidden="true">{ICON[j.status as keyof typeof ICON]}</span>
              <div className="ps-jobs-item-body">
                <div>
                  <strong>{label(j)}</strong> <span className="muted">· {j.status === 'done' ? 'Finished' : j.status === 'error' ? 'Failed' : 'Cancelled'}</span>
                </div>
                <div className="muted">
                  <time dateTime={new Date(j.updatedAt).toISOString()} title={new Date(j.updatedAt).toLocaleString()}>{relativeTime(j.updatedAt)}</time>
                  {tookWords(j) && ` · ${tookWords(j)}`}
                </div>
                {j.status === 'error' && j.error && <div className="ps-jobs-item-error">{j.error}</div>}
              </div>
              <div className="ps-jobs-item-actions">
                {j.projectId && (
                  <Link className="btn ghost sm" to={`/edit/${j.projectId}`} aria-label={`Open the project of ${label(j).toLowerCase()}`}>Open project</Link>
                )}
                {canRetry(j) && (
                  <button type="button" className="btn sm" onClick={() => void retry(j)} disabled={busy === j.id || !gate.canEdit} data-tip={gate.tip} aria-label={`Retry ${label(j).toLowerCase()}`}>
                    {busy === j.id ? <Spinner size={13} /> : <RotateCcw size={13} />} Retry
                  </button>
                )}
              </div>
            </li>
          ))}
        </ol>
      )}
      {next && items && (
        <div className="row" style={{ justifyContent: 'center', marginTop: 12 }}>
          <button className="btn" onClick={() => void loadMore()} disabled={more}>{more && <Spinner size={13} />} Show older</button>
        </div>
      )}
    </div>
  )
}
