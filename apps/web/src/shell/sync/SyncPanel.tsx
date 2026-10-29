// The desktop's sync panel (D-1): why sync can't carry on, what's going up now with bytes, each conflict side by side
// with Keep this computer's / Keep the cloud's / Keep both, and every item still to sync with its reason, Retry and Skip.
import type { SyncConflictPreview, SyncItem, SyncItems, SyncSideSummary, SyncStatus } from '@producer/core'
import clsx from 'clsx'
import { AlertTriangle, Cloud, Copy, HardDrive, RefreshCw } from 'lucide-react'
import { useEffect, useState } from 'react'
import { toast, toastError } from '../../lib/toast'
import { syncSummary } from '../SystemChrome'
import { systemApi, useSystem } from '../system'
import { Modal, Spinner } from '../ui'
import { formatBytes, formatDuration, relativeTime } from '../util'
import './sync.css'

const KIND: Record<SyncItem['kind'], string> = { project: 'Project', asset: 'Clip', brand: 'Brand kit', kit: 'Brand kit', font: 'Font', voice: 'Voice' }
const STATE: Record<SyncItem['state'], string> = { failed: 'Couldn’t sync', uploading: 'Uploading', waiting: 'Waiting', skipped: 'Skipped' }

function Side({ title, s }: { title: string; s: SyncSideSummary | null }) {
  return (
    <div className="ps-syncp-side">
      <strong>{title}</strong>
      {s ? (
        <dl>
          <dt>Name</dt>
          <dd>{s.name}</dd>
          <dt>Saved</dt>
          <dd>{relativeTime(s.updatedAt)} · v{s.version}</dd>
          <dt>Length</dt>
          <dd>{formatDuration(s.duration)}</dd>
          <dt>Timeline</dt>
          <dd>
            {s.tracks} track{s.tracks === 1 ? '' : 's'}, {s.items} item{s.items === 1 ? '' : 's'}, {s.clips} clip{s.clips === 1 ? '' : 's'}
          </dd>
          {s.trashed && (
            <>
              <dt>Trash</dt>
              <dd>In the trash</dd>
            </>
          )}
        </dl>
      ) : (
        <p className="muted">Deleted in the cloud</p>
      )}
    </div>
  )
}

function Conflict({ c, busy, run }: { c: SyncStatus['conflicts'][number]; busy?: string; run: (key: string, fn: () => Promise<SyncStatus>, ok?: string) => Promise<void> }) {
  const [preview, setPreview] = useState<SyncConflictPreview>()
  const [open, setOpen] = useState(false)
  const [err, setErr] = useState<string>()
  async function compare() {
    setOpen((o) => !o)
    if (preview || open) return
    try {
      setPreview(await systemApi.conflictPreview(c.projectId))
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    }
  }
  return (
    <li className="ps-syncp-item">
      <div className="ps-syncp-row">
        <div className="ps-syncp-name">
          <strong>{c.name}</strong>
          <span>Edited here (v{c.localVersion}) and in the cloud (v{c.cloudVersion})</span>
        </div>
        <button className="btn ghost sm" aria-expanded={open} onClick={compare}>
          Compare
        </button>
      </div>
      {open && (
        <div className="ps-syncp-compare" aria-label={`${c.name}: the two copies`} role="group">
          {err ? <div className="ps-alert">{err}</div> : !preview ? <Spinner size={14} /> : (
            <>
              <div className="ps-syncp-sides">
                <Side title="This computer" s={preview.local} />
                <Side title="Cloud" s={preview.cloud} />
              </div>
              <ul className="ps-syncp-changes">
                {preview.changes.map((x) => (
                  <li key={x}>{x}</li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}
      <div className="row" style={{ gap: 4, marginTop: 6 }}>
        <button className="btn sm" disabled={!!busy} onClick={() => run(`${c.projectId}:l`, () => systemApi.resolve(c.projectId, 'keep-local'), 'Kept this computer’s version')}>
          {busy === `${c.projectId}:l` ? <Spinner size={12} /> : <HardDrive size={12} />} Keep this computer’s
        </button>
        <button className="btn sm" disabled={!!busy} onClick={() => run(`${c.projectId}:c`, () => systemApi.resolve(c.projectId, 'keep-cloud'), 'Kept the cloud version')}>
          {busy === `${c.projectId}:c` ? <Spinner size={12} /> : <Cloud size={12} />} Keep the cloud’s
        </button>
        <button className="btn sm" disabled={!!busy} onClick={() => run(`${c.projectId}:b`, () => systemApi.resolve(c.projectId, 'keep-both'), 'Kept both: this computer’s copy is now a separate project')}>
          {busy === `${c.projectId}:b` ? <Spinner size={12} /> : <Copy size={12} />} Keep both
        </button>
      </div>
    </li>
  )
}

export function SyncPanel({ onClose }: { onClose: () => void }) {
  const sync = useSystem((s) => s.sync)
  const setSync = useSystem((s) => s.setSync)
  const [items, setItems] = useState<SyncItems>()
  const [loadErr, setLoadErr] = useState<string>()
  const [busy, setBusy] = useState<string>()
  // what's waiting changes with every sync: reload it when the status moves on
  const key = sync ? `${sync.state}|${sync.lastSyncAt}|${sync.pending}|${sync.failures?.length}|${sync.conflicts.length}|${sync.uploads?.length}` : ''
  useEffect(() => {
    let alive = true
    systemApi
      .syncItems()
      .then((x) => alive && (setItems(x), setLoadErr(undefined)))
      .catch((e) => alive && setLoadErr(e instanceof Error ? e.message : String(e)))
    return () => {
      alive = false
    }
  }, [key])

  async function run(k: string, fn: () => Promise<SyncStatus>, ok?: string) {
    setBusy(k)
    try {
      setSync(await fn())
      if (ok) toast(ok)
    } catch (e) {
      toastError(e)
    } finally {
      setBusy(undefined)
    }
  }

  if (!sync) return null
  const sum = syncSummary(sync)
  const uploads = sync.uploads ?? []
  const waiting = items?.items.filter((i) => i.state !== 'uploading') ?? []
  return (
    <Modal
      title="Sync details"
      subtitle={sync.linked ? `${sync.account ?? 'Linked'} · ${sum.label}${sync.lastSyncAt ? ` · last synced ${relativeTime(sync.lastSyncAt)}` : ''}` : 'This computer isn’t linked to a cloud account'}
      onClose={onClose}
      width={640}
      className="ps-syncp"
      footer={
        <>
          <span className="spacer" />
          {sync.linked && (
            <button className="btn primary" disabled={!!busy || sync.state === 'syncing'} onClick={() => run('now', systemApi.syncNow)}>
              {busy === 'now' || sync.state === 'syncing' ? <Spinner size={13} /> : <RefreshCw size={13} />} Sync now
            </button>
          )}
          <button className="btn" onClick={onClose}>
            Close
          </button>
        </>
      }
    >
      {sync.blocked && (
        <div className={clsx('ps-alert', sync.blocked.reason !== 'conflict' && sync.blocked.reason !== 'paused' ? '' : 'info')} role="status">
          <AlertTriangle size={15} style={{ flex: 'none' }} /> {sync.blocked.message}
        </div>
      )}
      {sync.error && !sync.blocked && <div className="ps-alert" role="status">{sync.error}</div>}

      {uploads.length > 0 && (
        <section aria-labelledby="syncp-up">
          <h3 id="syncp-up" className="ps-menu-label">Uploading</h3>
          <ul className="ps-syncp-list">
            {uploads.map((u) => (
              <li key={u.id} className="ps-syncp-item">
                <div className="ps-syncp-row">
                  <div className="ps-syncp-name">
                    <strong>{u.name}</strong>
                    <span>{u.startedAt ? `${formatBytes(u.sent)} of ${formatBytes(u.bytes)}` : `Waiting for a free lane · ${formatBytes(u.bytes)}`}</span>
                  </div>
                </div>
                <div className="ps-progress" role="progressbar" aria-label={`Uploading ${u.name}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={u.bytes ? Math.round((u.sent / u.bytes) * 100) : 0}>
                  <i style={{ width: `${Math.max(2, u.bytes ? (u.sent / u.bytes) * 100 : 0)}%` }} />
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      {sync.conflicts.length > 0 && (
        <section aria-labelledby="syncp-conf">
          <h3 id="syncp-conf" className="ps-menu-label">Needs your decision</h3>
          <ul className="ps-syncp-list">
            {sync.conflicts.map((c) => (
              <Conflict key={c.projectId} c={c} busy={busy} run={run} />
            ))}
          </ul>
        </section>
      )}

      <section aria-labelledby="syncp-items">
        <h3 id="syncp-items" className="ps-menu-label">
          Still to sync{items && items.uploadBytes > 0 ? ` · ${formatBytes(items.uploadBytes)} of clips to upload` : ''}
        </h3>
        {loadErr ? (
          <div className="ps-alert">Couldn’t load what’s waiting: {loadErr}</div>
        ) : !items ? (
          <Spinner size={14} />
        ) : !waiting.length ? (
          <p className="muted">Everything on this computer is in the cloud.</p>
        ) : (
          <ul className="ps-syncp-list">
            {waiting.map((i) => {
              const k = `${i.kind}:${i.id}`
              const failureKind = (i.workspaceId ? i.kind : `${i.kind}-delete`) as Parameters<typeof systemApi.syncFailure>[0]['kind']
              return (
                <li key={k} className="ps-syncp-item">
                  <div className="ps-syncp-row">
                    <div className="ps-syncp-name">
                      <strong>{i.name}</strong>
                      <span>
                        {KIND[i.kind]} · <span className={clsx('ps-syncp-state', i.state)}>{STATE[i.state]}</span>
                        {i.bytes ? ` · ${formatBytes(i.bytes)}` : ''}
                        {i.reason ? ` · ${i.reason}` : ''}
                      </span>
                    </div>
                    {(i.state === 'failed' || i.state === 'skipped') && (
                      <div className="row" style={{ gap: 4 }}>
                        <button className="btn sm" aria-label={`Retry ${i.name}`} disabled={!!busy} onClick={() => run(`${k}:r`, () => systemApi.syncFailure({ kind: failureKind, id: i.id }, 'retry'))}>
                          {busy === `${k}:r` ? <Spinner size={12} /> : <RefreshCw size={12} />} Retry
                        </button>
                        {i.state === 'failed' && (
                          <button className="btn sm" aria-label={`Skip ${i.name}`} disabled={!!busy} onClick={() => run(`${k}:s`, () => systemApi.syncFailure({ kind: failureKind, id: i.id }, 'skip'), 'Skipped: it stays on this computer')}>
                            {busy === `${k}:s` ? <Spinner size={12} /> : <HardDrive size={12} />} Skip
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                </li>
              )
            })}
          </ul>
        )}
      </section>
    </Modal>
  )
}
