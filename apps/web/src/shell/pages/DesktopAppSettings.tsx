// Settings → This computer (desktop app only): the bundled tools' health (D-13).
import type { ToolCheck, ToolHealth } from '@producer/core'
import clsx from 'clsx'
import { AlertTriangle, CheckCircle2, RefreshCw, XCircle } from 'lucide-react'
import { useState } from 'react'
import { announce } from '../../lib/announce'
import { HttpError } from '../../lib/api'
import { sysFetch } from '../system'
import { Spinner, useAsync } from '../ui'

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

/** The "This computer" section of Settings in the desktop app. */
export function DesktopAppSettings() {
  return <ToolHealthPanel />
}
