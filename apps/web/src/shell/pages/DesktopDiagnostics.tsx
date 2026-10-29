// Settings → This computer (desktop app): opt-in crash reports kept on this computer, and Copy diagnostics (D-14).
import clsx from 'clsx'
import { AlertTriangle, CheckCircle2, ClipboardCopy } from 'lucide-react'
import { useState } from 'react'
import { announce } from '../../lib/announce'
import { Spinner } from '../ui'

export interface CrashView {
  /** Crash reports are being kept this launch (the setting takes effect at start). */
  active: boolean
  /** How many are on this computer. */
  count: number
}

interface DiagBridge {
  copyDiagnostics?(): Promise<{ ok: boolean; chars?: number; error?: string } | null>
}
const diagBridge = (): DiagBridge | undefined => (typeof window !== 'undefined' ? (window as unknown as { producerDesktop?: { app?: DiagBridge } }).producerDesktop?.app : undefined)

export function CrashSettings({ on, crash, onChange }: { on: boolean; crash?: CrashView; onChange: (v: boolean) => void }) {
  const copy = diagBridge()?.copyDiagnostics
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<{ ok: boolean; text: string }>()
  async function copyNow() {
    if (!copy) return
    setBusy(true)
    setResult(undefined)
    try {
      const r = await copy()
      const next = r?.ok ? { ok: true, text: 'Diagnostics copied. Paste them into your support request.' } : { ok: false, text: `Couldn’t copy the diagnostics${r?.error ? `: ${r.error}` : '.'}` }
      setResult(next)
      announce(next.text)
    } finally {
      setBusy(false)
    }
  }
  const pending = crash && on !== crash.active
  return (
    <div className="ps-set-row">
      <div style={{ flex: 1, minWidth: 0 }}>
        <strong>Keep crash reports on this computer</strong>
        <span>
          Off by default. When on, a crash of Producer Studio leaves a report in its crash folder; nothing is sent anywhere. Copy diagnostics lists them, with
          versions, folders, the tool check and the last log lines (keys, tokens and email addresses taken out), for a support request.
          {pending ? ' Takes effect the next time Producer Studio starts.' : crash?.count ? ` ${crash.count} kept.` : ''}
        </span>
        {result && (
          <div className={clsx('ps-test', result.ok ? 'ok' : 'bad')} role="status" style={{ marginTop: 8 }}>
            {result.ok ? <CheckCircle2 size={14} /> : <AlertTriangle size={14} />} {result.text}
          </div>
        )}
      </div>
      {copy && (
        <button className="btn sm" onClick={() => void copyNow()} disabled={busy}>
          {busy ? <Spinner size={13} /> : <ClipboardCopy size={13} />} Copy diagnostics
        </button>
      )}
      <button type="button" role="switch" aria-checked={on} aria-label="Keep crash reports on this computer" className={clsx('ps-toggle', on && 'on')} onClick={() => onChange(!on)}>
        <i />
      </button>
    </div>
  )
}
