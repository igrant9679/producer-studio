// Mode-aware chrome: Desktop badge, AI provider chip and the desktop sync indicator/popover.
import type { SyncStatus } from '@producer/core'
import clsx from 'clsx'
import { AlertTriangle, Cloud, CloudOff, Copy, HardDrive, RefreshCw, Settings, Sparkles } from 'lucide-react'
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { toast, toastError } from '../lib/toast'
import { aiLabel, systemApi, useSystem } from './system'
import { Popover, Spinner } from './ui'
import { relativeTime } from './util'

export function DesktopBadge() {
  const desktop = useSystem((s) => s.info?.mode === 'desktop')
  if (!desktop) return null
  return (
    <span className="ps-desktop-badge" title="Producer Studio desktop — running on this computer">
      <HardDrive size={10} /> Desktop
    </span>
  )
}

export function AiChip() {
  const info = useSystem((s) => s.info)
  const navigate = useNavigate()
  if (!info) return null
  const ok = info.ai.available && info.ai.provider !== 'none'
  return (
    <button
      className={clsx('ps-ai-chip', !ok && 'warn')}
      title={info.ai.detail || aiLabel(info)}
      onClick={() => navigate('/settings#ai')}
      aria-label={`AI: ${aiLabel(info)}${ok ? '' : ' — unavailable'}`}
    >
      {ok ? <Sparkles size={12} /> : <AlertTriangle size={12} />}
      <span className="ps-ai-chip-text">{ok ? aiLabel(info) : info.ai.provider === 'none' ? 'AI not configured' : `${aiLabel(info)} unavailable`}</span>
    </button>
  )
}

function shortAgo(ts?: number): string {
  if (!ts) return 'never'
  const s = Math.round((Date.now() - ts) / 1000)
  if (s < 45) return 'just now'
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))}m ago`
  if (s < 86400) return `${Math.round(s / 3600)}h ago`
  return relativeTime(ts)
}

export function syncSummary(s: SyncStatus): { label: string; tone: 'ok' | 'busy' | 'warn' | 'bad' | 'muted' } {
  if (!s.linked || s.state === 'unlinked') return { label: 'Not synced', tone: 'muted' }
  if (s.state === 'syncing') return { label: 'Syncing…', tone: 'busy' }
  if (s.state === 'offline') return { label: 'Offline', tone: 'warn' }
  if (s.state === 'error') return { label: 'Sync error', tone: 'bad' }
  if (s.conflicts.length) return { label: `${s.conflicts.length} conflict${s.conflicts.length === 1 ? '' : 's'}`, tone: 'warn' }
  if (s.pending) return { label: `${s.pending} pending`, tone: 'busy' }
  return { label: `Synced ${shortAgo(s.lastSyncAt)}`, tone: 'ok' }
}

export function SyncIndicator() {
  const desktop = useSystem((s) => s.info?.mode === 'desktop')
  const sync = useSystem((s) => s.sync)
  const setSync = useSystem((s) => s.setSync)
  const navigate = useNavigate()
  const [busy, setBusy] = useState<string>()
  if (!desktop || !sync) return null
  const sum = syncSummary(sync)

  async function run(key: string, fn: () => Promise<SyncStatus>, ok?: string) {
    setBusy(key)
    try {
      setSync(await fn())
      if (ok) toast(ok)
    } catch (e) {
      toastError(e)
    } finally {
      setBusy(undefined)
    }
  }

  const icon =
    sum.tone === 'busy' && sync.state === 'syncing' ? <Spinner size={14} /> : !sync.linked || sync.state === 'offline' ? <CloudOff size={14} /> : sum.tone === 'bad' || sum.tone === 'warn' ? <AlertTriangle size={14} /> : <Cloud size={14} />

  return (
    <Popover
      align="right"
      className="ps-sync-pop"
      style={{ top: 46, width: 360 }}
      trigger={({ toggle, open }) => (
        <button className={clsx('ps-sync-btn', `tone-${sum.tone}`)} onClick={toggle} aria-expanded={open} aria-label={`Cloud sync: ${sum.label}`}>
          {icon}
          <span className="ps-sync-label">{sum.label}</span>
        </button>
      )}
    >
      {(close) => (
        <div>
          <div className="row" style={{ padding: '6px 8px 10px', alignItems: 'flex-start' }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <strong style={{ fontFamily: 'var(--font-display)' }}>Cloud sync</strong>
              <div className="muted" style={{ fontSize: 12, marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {sync.linked ? `${sync.account ?? 'Linked'} · ${sync.cloudUrl?.replace(/^https?:\/\//, '') ?? ''}` : 'This computer isn’t linked to a cloud account'}
              </div>
            </div>
            <span className={clsx('ps-sync-dot', `tone-${sum.tone}`)} />
          </div>

          {sync.linked ? (
            <div className="ps-sync-stats">
              <div><strong>{shortAgo(sync.lastSyncAt)}</strong><span>Last sync</span></div>
              <div><strong>{sync.pending}</strong><span>Pending</span></div>
              <div><strong className={sync.conflicts.length ? 'warn' : ''}>{sync.conflicts.length}</strong><span>Conflicts</span></div>
            </div>
          ) : (
            <p className="muted" style={{ fontSize: 13, margin: '0 8px 12px' }}>Link your Producer Studio account to back up projects and pick them up on any device. Everything keeps working offline.</p>
          )}
          {sync.error && <div className="ps-alert" style={{ margin: '0 4px 10px', fontSize: 12 }}>{sync.error}</div>}

          {sync.conflicts.length > 0 && (
            <div className="ps-conflicts">
              <div className="ps-menu-label">Needs your decision</div>
              {sync.conflicts.map((c) => (
                <div key={c.projectId} className="ps-conflict">
                  <div className="ps-conflict-name">
                    <strong title={c.name}>{c.name}</strong>
                    <span>Edited here (v{c.localVersion}) and in the cloud (v{c.cloudVersion})</span>
                  </div>
                  <div className="row" style={{ gap: 4 }}>
                    <button className="btn sm" disabled={!!busy} onClick={() => run(`${c.projectId}:l`, () => systemApi.resolve(c.projectId, 'keep-local'), 'Kept this computer’s version')}>
                      {busy === `${c.projectId}:l` ? <Spinner size={12} /> : <HardDrive size={12} />} Keep local
                    </button>
                    <button className="btn sm" disabled={!!busy} onClick={() => run(`${c.projectId}:c`, () => systemApi.resolve(c.projectId, 'keep-cloud'), 'Kept the cloud version')}>
                      {busy === `${c.projectId}:c` ? <Spinner size={12} /> : <Cloud size={12} />} Keep cloud
                    </button>
                    <button className="btn sm" disabled={!!busy} onClick={() => run(`${c.projectId}:b`, () => systemApi.resolve(c.projectId, 'keep-both'), 'Kept both — the cloud copy was duplicated')} title="Keep both as separate projects">
                      {busy === `${c.projectId}:b` ? <Spinner size={12} /> : <Copy size={12} />} Both
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}

          <div className="row" style={{ padding: '10px 4px 2px', gap: 6 }}>
            {sync.linked ? (
              <button className="btn primary sm" disabled={!!busy || sync.state === 'syncing'} onClick={() => run('now', systemApi.syncNow)}>
                {busy === 'now' || sync.state === 'syncing' ? <Spinner size={13} /> : <RefreshCw size={13} />} Sync now
              </button>
            ) : (
              <button
                className="btn primary sm"
                onClick={() => {
                  close()
                  navigate('/settings#account')
                }}
              >
                <Cloud size={13} /> Link account
              </button>
            )}
            <span className="spacer" />
            <button
              className="btn ghost sm"
              onClick={() => {
                close()
                navigate('/settings#account')
              }}
            >
              <Settings size={13} /> Sync settings
            </button>
          </div>
        </div>
      )}
    </Popover>
  )
}

export function SyncBadge({ state }: { state?: 'synced' | 'local' | 'conflict' }) {
  if (!state) return null
  const map = {
    synced: { icon: <Cloud size={11} />, label: 'Synced to cloud' },
    local: { icon: <HardDrive size={11} />, label: 'Only on this computer' },
    conflict: { icon: <AlertTriangle size={11} />, label: 'Sync conflict — open the sync menu to resolve' },
  } as const
  return (
    <span className={clsx('ps-sync-badge', state)} title={map[state].label} aria-label={map[state].label}>
      {map[state].icon}
    </span>
  )
}
