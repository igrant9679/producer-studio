// The Operator page (P-10): support without database access, for accounts named in OPERATOR_EMAILS. People (find,
// disable or enable, send a reset), Jobs (inspect, requeue, cancel), Storage (per space, orphaned files) and the full
// audit log. Everyone else sees a page that isn't there.
import type { AuditEntry, OperatorJob, OperatorUser, OperatorUserDetail, OrphanScan, StorageUsageRow } from '@producer/core'
import { Ban, Copy, HardDrive, ListChecks, RotateCcw, Search, ShieldCheck, Trash2, UserCheck, UserX, Users } from 'lucide-react'
import { useEffect, useState, type FormEvent } from 'react'
import { opsApi } from '../../lib/opsApi'
import { toast, toastError } from '../../lib/toast'
import { useSession } from '../../lib/session'
import { ConfirmDialog, EmptyState, Spinner, TabPanel, Tabs, usePageTitle } from '../ui'
import { formatBytes, relativeTime } from '../util'
import { AuditList } from './AuditPage'
import './activity.css'

type Tab = 'people' | 'jobs' | 'storage' | 'audit'
const TABS: Array<{ id: Tab; label: string; icon: JSX.Element }> = [
  { id: 'people', label: 'People', icon: <Users size={15} /> },
  { id: 'jobs', label: 'Jobs', icon: <ListChecks size={15} /> },
  { id: 'storage', label: 'Storage', icon: <HardDrive size={15} /> },
  { id: 'audit', label: 'Audit log', icon: <ShieldCheck size={15} /> },
]

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e))
const when = (t?: number) => (t ? relativeTime(t) : 'never')
const secs = (ms?: number) => (ms == null ? '–' : ms < 60_000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms / 60_000)} min`)

function SearchBox({ label, placeholder, onSearch }: { label: string; placeholder: string; onSearch: (q: string) => void }) {
  const [q, setQ] = useState('')
  const submit = (e: FormEvent) => {
    e.preventDefault()
    onSearch(q.trim())
  }
  return (
    <form className="row" role="search" aria-label={label} onSubmit={submit} style={{ gap: 8, marginBottom: 14 }}>
      <input className="input" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={placeholder} aria-label={label} style={{ flex: 1 }} />
      <button className="btn" type="submit"><Search size={14} /> Search</button>
    </form>
  )
}

function PersonDetail({ id, onChanged }: { id: string; onChanged: () => void }) {
  const [d, setD] = useState<OperatorUserDetail>()
  const [error, setError] = useState<string>()
  const [confirm, setConfirm] = useState(false)
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [link, setLink] = useState<string>()

  useEffect(() => {
    let alive = true
    setD(undefined)
    setLink(undefined)
    opsApi.user(id).then((x) => alive && setD(x), (e) => alive && setError(msg(e)))
    return () => {
      alive = false
    }
  }, [id])

  async function act(fn: () => Promise<OperatorUserDetail>, done: string) {
    setBusy(true)
    try {
      setD(await fn())
      toast(done)
      onChanged()
    } catch (e) {
      toastError(msg(e))
    } finally {
      setBusy(false)
      setConfirm(false)
    }
  }

  async function reset(mode: 'mail' | 'link') {
    setBusy(true)
    try {
      const r = await opsApi.reset(id, mode)
      if (mode === 'link') setLink(r.url)
      else toast('A reset mail is on its way')
    } catch (e) {
      toastError(msg(e))
    } finally {
      setBusy(false)
    }
  }

  if (error) return <div className="ps-alert" role="alert">Couldn’t load this person: {error}</div>
  if (!d) return <Spinner size={18} />
  return (
    <section className="card" aria-label={`${d.name}, ${d.email}`} style={{ padding: 16, marginTop: 12 }}>
      <h2 style={{ margin: 0, fontSize: '1rem' }}>{d.name} <span className="muted">· {d.email}</span></h2>
      <p className="muted" style={{ margin: '6px 0 10px' }}>
        {d.disabledAt ? <strong>Disabled {when(d.disabledAt)}</strong> : 'Active'} · joined {when(d.createdAt)} · last sign-in {when(d.lastSignInAt)} · {d.emailVerified ? 'email confirmed' : 'email not confirmed'} · {d.sessions} sessions · {d.devices} desktop apps
      </p>
      <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
        {d.disabledAt ? (
          <button className="btn" disabled={busy} onClick={() => void act(() => opsApi.enable(id), 'Enabled again')}><UserCheck size={14} /> Enable</button>
        ) : (
          <button className="btn danger" disabled={busy} onClick={() => setConfirm(true)}><UserX size={14} /> Disable…</button>
        )}
        <button className="btn" disabled={busy || Boolean(d.disabledAt)} onClick={() => void reset('mail')}>Mail a password reset</button>
        <button className="btn" disabled={busy || Boolean(d.disabledAt)} onClick={() => void reset('link')}>Make a one-time reset link</button>
      </div>
      {link && (
        <div style={{ marginTop: 10 }}>
          <label className="muted" htmlFor="ps-op-reset-link">One-time reset link (shown once; it works for an hour):</label>
          <div className="row" style={{ gap: 8 }}>
            <input id="ps-op-reset-link" className="input" readOnly value={link} style={{ flex: 1 }} onFocus={(e) => e.currentTarget.select()} />
            <button className="btn" onClick={() => void navigator.clipboard?.writeText(link).then(() => toast('Copied'))} aria-label="Copy the reset link"><Copy size={14} /></button>
          </div>
        </div>
      )}
      <h3 style={{ fontSize: '0.875rem', marginTop: 16 }}>Spaces</h3>
      <ul aria-label="Spaces">
        {d.memberships.map((m) => <li key={m.workspaceId}>{m.name} <span className="muted">· {m.role}{m.personal ? ' · personal' : ''}</span></li>)}
      </ul>
      {d.deviceList.length > 0 && (
        <>
          <h3 style={{ fontSize: '0.875rem' }}>Desktop apps</h3>
          <ul aria-label="Desktop apps">{d.deviceList.map((x) => <li key={x.id}>{x.name} <span className="muted">· linked {when(x.createdAt)} · last seen {when(x.lastSeenAt)}</span></li>)}</ul>
        </>
      )}
      <h3 style={{ fontSize: '0.875rem' }}>Recent</h3>
      {d.recent.length ? <AuditList items={d.recent} label="Recent audit entries" /> : <p className="muted">Nothing recorded yet.</p>}
      {confirm && (
        <ConfirmDialog
          title={`Disable ${d.email}?`}
          body="They are signed out everywhere, their desktop apps are unlinked, and they can’t sign in until you enable the account again. Their spaces and work stay."
          confirmLabel="Disable"
          busy={busy}
          onConfirm={() => void act(() => opsApi.disable(id, reason.trim() || undefined), 'Disabled')}
          onClose={() => setConfirm(false)}
        >
          <label htmlFor="ps-op-reason" className="muted">Reason (kept in the audit log)</label>
          <textarea id="ps-op-reason" className="input" rows={2} value={reason} onChange={(e) => setReason(e.target.value)} style={{ width: '100%' }} />
        </ConfirmDialog>
      )}
    </section>
  )
}

function People() {
  const [list, setList] = useState<OperatorUser[]>()
  const [error, setError] = useState<string>()
  const [open, setOpen] = useState<string>()
  const [q, setQ] = useState('')
  const load = (query: string) => {
    setQ(query)
    setError(undefined)
    opsApi.users(query).then(setList, (e) => setError(msg(e)))
  }
  useEffect(() => load(''), [])
  return (
    <>
      <SearchBox label="Find a person" placeholder="Email, name or id" onSearch={load} />
      {error ? (
        <div className="ps-alert" role="alert">{error}</div>
      ) : !list ? (
        <Spinner size={18} />
      ) : !list.length ? (
        <EmptyState icon={<Users size={24} />} title="Nobody matches" body={q ? `No account’s email or name contains “${q}”.` : undefined} />
      ) : (
        <ul className="ps-activity" aria-label="People">
          {list.map((u) => (
            <li key={u.id} className="ps-activity-item">
              <span className="ps-activity-text">
                <button className="ps-link" aria-expanded={open === u.id} onClick={() => setOpen(open === u.id ? undefined : u.id)}>{u.email}</button> <span className="muted">· {u.name}{u.disabledAt ? ' · disabled' : ''}</span>
                <span className="ps-audit-meta">{u.spaces} spaces · {u.sessions} sessions · {u.devices} apps · last sign-in {when(u.lastSignInAt)}</span>
                {open === u.id && <PersonDetail id={u.id} onChanged={() => load(q)} />}
              </span>
            </li>
          ))}
        </ul>
      )}
    </>
  )
}

function JobDetail({ id, onChanged }: { id: string; onChanged: (j: OperatorJob) => void }) {
  const [j, setJ] = useState<OperatorJob>()
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    let alive = true
    opsApi.job(id).then((x) => alive && setJ(x), (e) => toastError(msg(e)))
    return () => {
      alive = false
    }
  }, [id])
  async function act(fn: () => Promise<OperatorJob>, done: string) {
    setBusy(true)
    try {
      const x = await fn()
      setJ(x)
      onChanged(x)
      toast(done)
    } catch (e) {
      toastError(msg(e))
    } finally {
      setBusy(false)
    }
  }
  if (!j) return <Spinner size={16} />
  const canRequeue = j.status === 'error' || j.status === 'cancelled' || j.status === 'running'
  const canCancel = j.status === 'queued' || j.status === 'running'
  return (
    <div className="card" style={{ padding: 12, marginTop: 8 }}>
      <p className="ps-audit-meta">
        waited {secs(j.waitMs)} · ran {secs(j.runMs)} · peak memory {j.peakRssBytes != null ? formatBytes(j.peakRssBytes) : '–'} · attempts {j.attempts}
        {j.lockedBy && <> · worker {j.lockedBy}</>}
      </p>
      {j.error && <p><strong>People see:</strong> {j.error}</p>}
      {j.errorDetail && (
        <>
          <strong>Raw error</strong>
          <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', fontSize: '0.75rem', maxHeight: 240, overflow: 'auto' }} aria-label="Raw error">{j.errorDetail}</pre>
        </>
      )}
      {j.input && <details><summary>Input</summary><pre style={{ whiteSpace: 'pre-wrap', fontSize: '0.75rem' }}>{JSON.stringify(j.input, null, 2)}</pre></details>}
      <div className="row" style={{ gap: 8, marginTop: 8 }}>
        <button className="btn" disabled={busy || !canRequeue} onClick={() => void act(() => opsApi.requeue(j.id), 'Back in the queue')}><RotateCcw size={14} /> Requeue</button>
        <button className="btn danger" disabled={busy || !canCancel} onClick={() => void act(() => opsApi.cancelJob(j.id), 'Cancelled')}><Ban size={14} /> Cancel</button>
      </div>
    </div>
  )
}

function Jobs() {
  const [status, setStatus] = useState('')
  const [q, setQ] = useState('')
  const [items, setItems] = useState<OperatorJob[]>()
  const [next, setNext] = useState<string>()
  const [open, setOpen] = useState<string>()
  const [error, setError] = useState<string>()
  useEffect(() => {
    let alive = true
    setItems(undefined)
    setError(undefined)
    opsApi.jobs({ status: status || undefined, q: q || undefined }).then(
      (p) => {
        if (!alive) return
        setItems(p.items)
        setNext(p.nextCursor)
      },
      (e) => alive && setError(msg(e)),
    )
    return () => {
      alive = false
    }
  }, [status, q])
  async function more() {
    if (!next) return
    const p = await opsApi.jobs({ status: status || undefined, q: q || undefined, cursor: next })
    setItems((cur) => [...(cur ?? []), ...p.items])
    setNext(p.nextCursor)
  }
  return (
    <>
      <div className="row" style={{ gap: 8, alignItems: 'flex-start' }}>
        <label className="muted" htmlFor="ps-op-status" style={{ alignSelf: 'center' }}>Status</label>
        <select id="ps-op-status" className="input" value={status} onChange={(e) => setStatus(e.target.value)} style={{ width: 'auto' }}>
          <option value="">Any</option>
          {['queued', 'running', 'error', 'cancelled', 'done'].map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        <div style={{ flex: 1 }}><SearchBox label="Find a job" placeholder="Job id, user id, or words in its error" onSearch={setQ} /></div>
      </div>
      {error ? (
        <div className="ps-alert" role="alert">{error}</div>
      ) : !items ? (
        <Spinner size={18} />
      ) : !items.length ? (
        <EmptyState icon={<ListChecks size={24} />} title="No jobs match" />
      ) : (
        <ul className="ps-activity" aria-label="Jobs, newest first">
          {items.map((j) => (
            <li key={j.id} className="ps-activity-item">
              <span className="ps-activity-text">
                <button className="ps-link" aria-expanded={open === j.id} onClick={() => setOpen(open === j.id ? undefined : j.id)}>{j.kind}</button> <span className="muted">· {j.status} · {j.workspaceName ?? j.workspaceId} · {j.id}</span>
                {j.error && <span className="ps-audit-meta">{j.error}</span>}
                {open === j.id && <JobDetail id={j.id} onChanged={(x) => setItems((cur) => cur?.map((y) => (y.id === x.id ? { ...y, ...x } : y)))} />}
              </span>
              <time dateTime={new Date(j.createdAt).toISOString()}>{relativeTime(j.createdAt)}</time>
            </li>
          ))}
        </ul>
      )}
      {next && items && <div className="row" style={{ justifyContent: 'center', marginTop: 12 }}><button className="btn" onClick={() => void more()}>Show older</button></div>}
    </>
  )
}

function Storage() {
  const [rows, setRows] = useState<StorageUsageRow[]>()
  const [error, setError] = useState<string>()
  const [scan, setScan] = useState<OrphanScan>()
  const [scanning, setScanning] = useState(false)
  const [confirm, setConfirm] = useState(false)
  const load = (q: string) => opsApi.storage(q).then(setRows, (e) => setError(msg(e)))
  useEffect(() => void load(''), [])
  async function dryRun() {
    setScanning(true)
    try {
      setScan(await opsApi.orphans())
    } catch (e) {
      toastError(msg(e))
    } finally {
      setScanning(false)
    }
  }
  async function remove() {
    if (!scan) return
    setScanning(true)
    try {
      const r = await opsApi.orphans(scan.scanId)
      setScan(undefined)
      toast(`Removed ${r.removed ?? 0} orphaned files (${formatBytes(r.bytes)})`)
    } catch (e) {
      toastError(msg(e))
    } finally {
      setScanning(false)
      setConfirm(false)
    }
  }
  return (
    <>
      <SearchBox label="Find a space" placeholder="Space name or id" onSearch={(q) => void load(q)} />
      {error ? (
        <div className="ps-alert" role="alert">{error}</div>
      ) : !rows ? (
        <Spinner size={18} />
      ) : (
        <div className="ps-table-wrap">
        <table className="ps-table" aria-label="Storage per space, largest first">
          <thead><tr><th scope="col">Space</th><th scope="col">Owner</th><th scope="col">Files</th><th scope="col">Size</th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.workspaceId}><td>{r.name}{r.personal ? <span className="muted"> · personal</span> : null}</td><td>{r.owner ?? '–'}</td><td>{r.files}</td><td>{formatBytes(r.bytes)}</td></tr>
            ))}
          </tbody>
        </table>
        </div>
      )}
      <h2 style={{ fontSize: '1rem', marginTop: 24 }}>Orphaned files</h2>
      <p className="muted">Files whose space, clip, font or preview was deleted. Files changed in the last day are never listed. Look first, then remove.</p>
      <button className="btn" onClick={() => void dryRun()} disabled={scanning}>{scanning && !confirm ? <Spinner size={13} /> : <Search size={14} />} Look for orphaned files</button>
      {scan && (
        <div style={{ marginTop: 12 }} role="status">
          <p>{scan.count ? `${scan.count} orphaned files, ${formatBytes(scan.bytes)}, out of ${scan.scanned} looked at.` : `Nothing orphaned among ${scan.scanned} files.`}</p>
          {scan.count > 0 && (
            <>
              <ul aria-label="Orphaned files, largest first" className="ps-audit-meta">{scan.objects.map((o) => <li key={o.key}>{o.key} · {formatBytes(o.size)} · {o.reason}</li>)}</ul>
              <button className="btn danger" onClick={() => setConfirm(true)}><Trash2 size={14} /> Remove {scan.count} files…</button>
            </>
          )}
        </div>
      )}
      {confirm && scan && (
        <ConfirmDialog
          title={`Remove ${scan.count} orphaned files?`}
          body={`${formatBytes(scan.bytes)} go for good. Each file is checked again just before it goes; one that something uses again is kept.`}
          confirmLabel="Remove for good"
          busy={scanning}
          onConfirm={() => void remove()}
          onClose={() => setConfirm(false)}
        />
      )}
    </>
  )
}

function Audit() {
  const [q, setQ] = useState('')
  const [items, setItems] = useState<AuditEntry[]>()
  const [next, setNext] = useState<string>()
  const [error, setError] = useState<string>()
  useEffect(() => {
    let alive = true
    setItems(undefined)
    opsApi.audit({ q: q || undefined }).then(
      (p) => {
        if (!alive) return
        setItems(p.items)
        setNext(p.nextCursor)
      },
      (e) => alive && setError(msg(e)),
    )
    return () => {
      alive = false
    }
  }, [q])
  async function more() {
    if (!next) return
    const p = await opsApi.audit({ q: q || undefined, cursor: next })
    setItems((cur) => [...(cur ?? []), ...p.items])
    setNext(p.nextCursor)
  }
  return (
    <>
      <SearchBox label="Search the audit log" placeholder="Email, kind (signin.failed), IP or a request reference" onSearch={setQ} />
      {error ? <div className="ps-alert" role="alert">{error}</div> : !items ? <Spinner size={18} /> : !items.length ? <EmptyState icon={<ShieldCheck size={24} />} title="Nothing matches" /> : <AuditList items={items} label="Audit log, newest first" />}
      {next && items && <div className="row" style={{ justifyContent: 'center', marginTop: 12 }}><button className="btn" onClick={() => void more()}>Show older</button></div>}
    </>
  )
}

export default function OperatorPage() {
  usePageTitle('Operator')
  const operator = useSession((s) => s.operator === true)
  const [tab, setTab] = useState<Tab>('people')
  if (!operator)
    return (
      <div className="ps-page narrow" style={{ paddingTop: 70 }}>
        <EmptyState icon={<ShieldCheck size={24} />} title="This page isn’t here" body="The Operator page is only for the people who run this server." />
      </div>
    )
  return (
    <div className="ps-page">
      <div className="ps-page-head">
        <div>
          <span className="eyebrow">Server</span>
          <h1>Operator</h1>
          <p>Find and help people, look after jobs and storage, and read the audit log. Everything done here is written to the audit log.</p>
        </div>
      </div>
      <Tabs id="ps-operator" tabs={TABS} value={tab} onChange={setTab} label="Operator tools" />
      <TabPanel tabs="ps-operator" value={tab}>
        {tab === 'people' ? <People /> : tab === 'jobs' ? <Jobs /> : tab === 'storage' ? <Storage /> : <Audit />}
      </TabPanel>
    </div>
  )
}
