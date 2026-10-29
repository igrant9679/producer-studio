// Settings → This computer (desktop app only): keep running in the tray (D-2), update checks (D-4), database
// backups (D-10) and the bundled tools' health (D-13).
import type { ToolCheck, ToolHealth } from '@producer/core'
import clsx from 'clsx'
import { AlertTriangle, CheckCircle2, ExternalLink, FolderOpen, RefreshCw, XCircle } from 'lucide-react'
import { useEffect, useState } from 'react'
import { announce } from '../../lib/announce'
import { HttpError } from '../../lib/api'
import { sysFetch } from '../system'
import { Spinner, useAsync } from '../ui'
import { formatBytes, relativeTime } from '../util'

export const toolsApi = {
  health: (refresh = false) => sysFetch<ToolHealth>('GET', `/tools/health${refresh ? '?refresh=1' : ''}`),
}

function errText(e: unknown): string {
  if (e instanceof HttpError) return e.body?.error || e.message
  return e instanceof Error ? e.message : String(e)
}

const STATUS_LABEL: Record<ToolCheck['status'], string> = { ok: 'Working', warn: 'Works, with a note', error: 'Not working' }

/** One line per bundled tool, with what it's for and what's wrong; Check again re-runs the check. */
export function ToolHealthPanel() {
  const { data, error, loading, setData } = useAsync(() => toolsApi.health(), [])
  const [checking, setChecking] = useState(false)
  async function again() {
    setChecking(true)
    try {
      const h = await toolsApi.health(true)
      setData(h)
      const broken = h.tools.filter((t) => t.status === 'error')
      announce(broken.length ? `${broken.length} tool${broken.length > 1 ? 's' : ''} not working: ${broken.map((t) => t.name).join(', ')}` : 'All tools working')
    } catch (e) {
      announce(`Couldn’t check the tools: ${errText(e)}`)
    } finally {
      setChecking(false)
    }
  }
  return (
    <div>
      <div className="row" style={{ marginBottom: 10 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <strong style={{ fontSize: '0.875rem' }}>Bundled tools</strong>
          <div className="ps-hint">
            {data ? (data.ok ? 'Everything Producer Studio needs is installed.' : 'Something Producer Studio needs is missing or broken; the lines below say what and what to do.') : 'Checked when Producer Studio starts.'}
          </div>
        </div>
        <button className="btn sm" onClick={again} disabled={checking || loading}>
          {checking ? <Spinner size={13} /> : <RefreshCw size={13} />} Check again
        </button>
      </div>
      {error !== undefined && !data && <div className="ps-test bad" role="alert"><AlertTriangle size={14} /> Couldn’t check the tools: {errText(error)}</div>}
      {loading && !data && <div className="skeleton" style={{ height: 120 }} />}
      {data && (
        <ul className="ps-tools" aria-label="Bundled tools">
          {data.tools.map((t) => (
            <li key={t.id} className={clsx('ps-tool', t.status)}>
              {t.status === 'ok' ? <CheckCircle2 size={16} aria-hidden /> : t.status === 'warn' ? <AlertTriangle size={16} aria-hidden /> : <XCircle size={16} aria-hidden />}
              <div style={{ flex: 1, minWidth: 0 }}>
                <strong>{t.name}</strong> <span className="ps-tool-state">{STATUS_LABEL[t.status]}</span>
                <span className="ps-tool-need">For: {t.needed}</span>
                <span className="ps-tool-detail">{t.detail}</span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/** What the desktop app's preload offers for its own settings (desktop apps from release 4 on). */
export interface AppSettingsView {
  keepRunning: boolean
  updateCheck: boolean
  crashReports: boolean
  /** The app has a tray icon (some Linux desktops have none: closing the window then quits). */
  tray: boolean
  /** Database copies made before an update changed it (D-10), newest first. */
  backups?: { folder: string; items: Array<{ name: string; at: number; bytes: number }> }
  /** Update checks (D-4): offered on signed builds with a release feed. */
  updates?: { offered: boolean; reason?: string; version: string; state: UpdateState }
}

export type UpdateState =
  | { status: 'idle' }
  | { status: 'current'; checkedAt: number; latest: string }
  | { status: 'available'; checkedAt: number; update: { version: string; url: string; name?: string }; skipped: boolean }
  | { status: 'error'; checkedAt: number; error: string }

interface AppBridge {
  settings(): Promise<AppSettingsView | null>
  setSettings(patch: Partial<Pick<AppSettingsView, 'keepRunning' | 'updateCheck' | 'crashReports'>>): Promise<AppSettingsView | null>
  checkForUpdates?(): Promise<UpdateState | null>
}
export const appBridge = (): AppBridge | undefined => (typeof window !== 'undefined' ? (window as unknown as { producerDesktop?: { app?: AppBridge } }).producerDesktop?.app : undefined)

function Toggle({ on, onChange, label, disabled }: { on: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button type="button" role="switch" aria-checked={on} aria-label={label} className={clsx('ps-toggle', on && 'on')} onClick={() => onChange(!on)} disabled={disabled}>
      <i />
    </button>
  )
}

/** The tray: keep running when the window is closed (D-2). */
function RunningSettings({ view, onChange }: { view: AppSettingsView; onChange: (p: Partial<AppSettingsView>) => void }) {
  return (
    <div className="ps-set-row">
      <div>
        <strong>Keep running when the window is closed</strong>
        <span>
          {view.tray
            ? 'Producer Studio stays in the tray (notification area), so the dictation shortcut and voices the cloud asks this computer for keep working. Quit it from the tray icon or File → Quit.'
            : 'This desktop has no tray, so closing the window quits Producer Studio.'}
        </span>
      </div>
      <Toggle on={view.keepRunning && view.tray} disabled={!view.tray} onChange={(v) => onChange({ keepRunning: v })} label="Keep running when the window is closed" />
    </div>
  )
}

const openExternal = (url: string) => (window as unknown as { producerDesktop?: { openExternal?: (u: string) => Promise<boolean> } }).producerDesktop?.openExternal?.(url)

/** Look for new versions (D-4): only on signed builds with a release feed; it tells and links, never installs. */
function UpdateSettings({ updates, on, onChange, check }: { updates: NonNullable<AppSettingsView['updates']>; on: boolean; onChange: (v: boolean) => void; check?: () => Promise<UpdateState | null> }) {
  const [state, setState] = useState<UpdateState>(updates.state)
  const [checking, setChecking] = useState(false)
  async function now() {
    if (!check) return
    setChecking(true)
    try {
      const s = await check()
      if (s) {
        setState(s)
        announce(s.status === 'available' ? `Producer Studio ${s.update.version} is available` : s.status === 'current' ? 'Producer Studio is up to date' : s.status === 'error' ? `Couldn’t check for updates: ${s.error}` : '')
      }
    } finally {
      setChecking(false)
    }
  }
  return (
    <div className="ps-set-row">
      <div style={{ flex: 1, minWidth: 0 }}>
        <strong>Look for new versions</strong>
        <span>
          {updates.offered
            ? `At start and once a day, Producer Studio asks its release page whether a newer version than ${updates.version} exists, and tells you. Nothing is downloaded or installed by itself.`
            : updates.reason}
        </span>
        {updates.offered && state.status !== 'idle' && (
          <div className={clsx('ps-test', state.status === 'error' ? 'bad' : 'ok')} role="status" style={{ marginTop: 8 }}>
            {state.status === 'available' ? (
              <>
                <CheckCircle2 size={14} /> Producer Studio {state.update.version} is available{state.skipped ? ' (you chose to skip it)' : ''}.{' '}
                <button className="btn sm primary" onClick={() => void openExternal(state.update.url)}>
                  <ExternalLink size={13} /> Download
                </button>
              </>
            ) : state.status === 'current' ? (
              <>
                <CheckCircle2 size={14} /> You have the latest version ({state.latest}).
              </>
            ) : (
              <>
                <AlertTriangle size={14} /> {state.error}
              </>
            )}
          </div>
        )}
      </div>
      {updates.offered && check && (
        <button className="btn sm" onClick={() => void now()} disabled={checking}>
          {checking ? <Spinner size={13} /> : <RefreshCw size={13} />} Check now
        </button>
      )}
      <Toggle on={updates.offered && on} disabled={!updates.offered} onChange={onChange} label="Look for new versions" />
    </div>
  )
}

/** Copies of the database made before an update changed it, and how to go back to one (D-10). */
function BackupSettings({ backups }: { backups: NonNullable<AppSettingsView['backups']> }) {
  const newest = backups.items[0]
  const show = (window as unknown as { producerDesktop?: { showItemInFolder?: (p: string) => Promise<boolean> } }).producerDesktop?.showItemInFolder
  return (
    <div className="ps-set-row">
      <div>
        <strong>Database backups</strong>
        <span>
          {newest
            ? `${backups.items.length} kept · newest ${relativeTime(newest.at)} (${formatBytes(newest.bytes)}). `
            : 'None yet. '}
          Before an update changes the database, a copy of it is kept (the newest 3; media isn’t copied). To go back to one, quit Producer Studio, rename the
          data folder’s “pg” folder and copy the backup’s “pg” folder in its place.
        </span>
      </div>
      {newest && show && (
        <button className="btn sm" onClick={() => void show(backups.folder)}>
          <FolderOpen size={13} /> Show backups
        </button>
      )}
    </div>
  )
}

/** The "This computer" section of Settings in the desktop app. */
export function DesktopAppSettings() {
  const bridge = appBridge()
  const [view, setView] = useState<AppSettingsView | null>()
  const [error, setError] = useState<string>()
  useEffect(() => {
    if (!bridge) return
    let alive = true
    bridge.settings().then((v) => alive && setView(v), () => alive && setView(null))
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  async function change(p: Partial<AppSettingsView>) {
    if (!bridge) return
    setError(undefined)
    const next = await bridge.setSettings(p).catch(() => null)
    if (next) setView(next)
    else setError('Producer Studio couldn’t save that setting.')
  }
  return (
    <div>
      {view && <RunningSettings view={view} onChange={(p) => void change(p)} />}
      {view?.updates && <UpdateSettings updates={view.updates} on={view.updateCheck} onChange={(v) => void change({ updateCheck: v })} check={bridge?.checkForUpdates ? () => bridge.checkForUpdates!() : undefined} />}
      {view?.backups && <BackupSettings backups={view.backups} />}
      {error && <div className="ps-test bad" role="alert"><AlertTriangle size={14} /> {error}</div>}
      <div style={{ height: view ? 16 : 0 }} />
      <ToolHealthPanel />
    </div>
  )
}
