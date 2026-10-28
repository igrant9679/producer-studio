// Version history (E-3): the project's saved versions (server-side, P-15) in a panel beside the canvas. Preview one
// read-only on the canvas, restore it (a new save; what's on screen is kept as "before restore"), or name one so it
// is kept for good. Opened from the clock button in the top bar.
import type { ProjectVersionSummary } from '@producer/core'
import clsx from 'clsx'
import { Eye, History, Loader2, RotateCcw, Tag, X } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../lib/api'
import { tipProps } from '../lib/tooltip'
import { toast, toastError } from '../lib/toast'
import { ConfirmDialog, useEditGate, useEscapeLayer } from '../shell/ui'
import { endPreview, nameCurrentVersion, previewVersion, restoreVersion } from './persistence'
import { useEditor } from './store'
import './versions.css'

const KIND: Record<ProjectVersionSummary['label'], string> = { autosave: 'Saved', named: 'Named', 'before-restore': 'Before restore', 'before-ai': 'Before AI' }

/** "14:02" today, "3 May, 14:02" this year, else with the year. */
export function versionTime(at: number, now = Date.now()): string {
  const d = new Date(at)
  const n = new Date(now)
  const time = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
  if (d.toDateString() === n.toDateString()) return time
  const date = d.toLocaleDateString(undefined, d.getFullYear() === n.getFullYear() ? { day: 'numeric', month: 'short' } : { day: 'numeric', month: 'short', year: 'numeric' })
  return `${date}, ${time}`
}

const size = (n: number) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`)

/** How a version is called in buttons and the preview banner. */
export function versionTitle(v: ProjectVersionSummary): string {
  return v.name ? `“${v.name}”` : `the version from ${versionTime(v.createdAt)}`
}

let lastButton: HTMLButtonElement | null = null

export function VersionsButton() {
  const open = useEditor((s) => s.versionsOpen)
  return (
    <button
      ref={(el) => {
        if (el) lastButton = el
      }}
      type="button"
      className={clsx('ed-tbtn', open && 'on')}
      {...tipProps('Version history', 'Saved versions of this project: look at one, bring it back, or name it so it’s kept.')}
      aria-pressed={open}
      onClick={() => useEditor.setState({ versionsOpen: !open })}
    >
      <History size={16} />
    </button>
  )
}

function close() {
  endPreview()
  useEditor.setState({ versionsOpen: false })
  lastButton?.focus()
}

export function VersionsPanel() {
  const projectId = useEditor((s) => s.projectId)
  const version = useEditor((s) => s.version)
  const preview = useEditor((s) => s.versionPreview?.id)
  const gate = useEditGate()
  const [list, setList] = useState<ProjectVersionSummary[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [confirm, setConfirm] = useState<ProjectVersionSummary | null>(null)
  const [naming, setNaming] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const ref = useRef<HTMLElement>(null)

  const load = useCallback(async () => {
    try {
      setList(await api.versions(projectId))
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [projectId])
  // new saves land in the list (not on every keystroke's autosave: a moment after the last one)
  useEffect(() => {
    const t = setTimeout(() => void load(), list ? 2000 : 0)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load, version])
  useEffect(() => {
    ref.current?.querySelector<HTMLElement>('.ed-versions-head button, .ed-versions button')?.focus()
  }, [])
  // Escape ends a preview first, then closes the panel
  useEscapeLayer(() => (useEditor.getState().versionPreview ? endPreview() : close()), !confirm)

  const run = async (key: string, fn: () => Promise<void>) => {
    setBusy(key)
    try {
      await fn()
    } catch (e) {
      toastError(e)
    } finally {
      setBusy(null)
    }
  }
  const show = (v: ProjectVersionSummary) => run(`p:${v.id}`, () => (preview === v.id ? Promise.resolve(endPreview()) : previewVersion(v.id, versionTitle(v))))
  const saveName = (v: ProjectVersionSummary | 'current') =>
    run('name', async () => {
      const name = draft.trim()
      if (v === 'current') await nameCurrentVersion(name)
      else await api.nameVersion(projectId, v.id, name || null)
      setNaming(null)
      setDraft('')
      toast(name ? `Named “${name}”: it’s kept for good` : 'Name removed')
      await load()
    })

  return (
    <aside ref={ref} className="ed-versions" aria-label="Version history">
      <div className="ed-versions-head">
        <h2>Version history</h2>
        <button type="button" className="btn ghost icon sm" aria-label="Close version history" onClick={close}>
          <X size={15} />
        </button>
      </div>
      <p className="ed-versions-note">Every save is kept for a while: the latest ones, one every 10 minutes for a day, one an hour for a week, one a day for a month. Named versions are kept for good.</p>
      {naming === 'current' ? (
        <NameForm value={draft} onChange={setDraft} busy={busy === 'name'} onSave={() => saveName('current')} onCancel={() => setNaming(null)} label="Name for what’s on screen now" />
      ) : (
        <button type="button" className="btn sm ed-versions-namecur" disabled={!gate.canEdit} data-tip={gate.tip} onClick={() => (setNaming('current'), setDraft(''))}>
          <Tag size={13} /> Name the current version…
        </button>
      )}
      {error && <p className="ed-versions-error" role="alert">Couldn’t load the history: {error}</p>}
      {!list && !error && (
        <p className="muted ed-versions-loading" role="status">
          <Loader2 size={14} className="spin" /> Loading versions…
        </p>
      )}
      {list && !list.length && <p className="muted ed-versions-loading">No saved versions yet: they appear here as you work.</p>}
      {list && list.length > 0 && (
        <ul className="ed-versions-list">
          {list.map((v) => (
            <li key={v.id} className={clsx(preview === v.id && 'on', v.current && 'current')}>
              <div className="ed-versions-row">
                <div className="ed-versions-what">
                  <b>{v.name ?? versionTime(v.createdAt)}</b>
                  <span className="muted">
                    {v.name ? `${versionTime(v.createdAt)} · ` : ''}
                    {v.authorName ?? 'Someone'} · {size(v.sizeBytes)}
                  </span>
                  <span className="ed-versions-tags">
                    {v.current && <span className="ed-versions-tag cur">Current</span>}
                    {v.label !== 'autosave' && v.label !== 'named' && <span className="ed-versions-tag">{KIND[v.label]}</span>}
                    {v.note && <span className="muted">{v.note}</span>}
                  </span>
                </div>
              </div>
              {naming === v.id ? (
                <NameForm value={draft} onChange={setDraft} busy={busy === 'name'} onSave={() => saveName(v)} onCancel={() => setNaming(null)} label={`Name for ${versionTitle(v)}`} />
              ) : (
                <div className="ed-versions-actions">
                  {!v.current && (
                    <button type="button" className="btn sm" aria-pressed={preview === v.id} aria-label={`${preview === v.id ? 'Stop previewing' : 'Preview'} ${versionTitle(v)}`} disabled={busy === `p:${v.id}`} onClick={() => void show(v)}>
                      <Eye size={13} /> {preview === v.id ? 'Previewing' : 'Preview'}
                    </button>
                  )}
                  {!v.current && (
                    <button type="button" className="btn sm" aria-label={`Restore ${versionTitle(v)}`} disabled={!gate.canEdit || !!busy} data-tip={gate.tip} onClick={() => setConfirm(v)}>
                      <RotateCcw size={13} /> Restore
                    </button>
                  )}
                  <button type="button" className="btn sm ghost" aria-label={`${v.name ? 'Rename' : 'Name'} ${versionTitle(v)}`} disabled={!gate.canEdit} data-tip={gate.tip} onClick={() => (setNaming(v.id), setDraft(v.name ?? ''))}>
                    <Tag size={13} /> {v.name ? 'Rename' : 'Name'}
                  </button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      {confirm && (
        <ConfirmDialog
          title={`Restore ${versionTitle(confirm)}?`}
          body="It becomes the current version. What’s on screen now is saved first and kept in the history as “before restore”, so you can come back to it."
          confirmLabel="Restore"
          danger={false}
          busy={busy === 'restore'}
          onClose={() => setConfirm(null)}
          onConfirm={() =>
            void run('restore', async () => {
              await restoreVersion(confirm.id)
              setConfirm(null)
              toast(`Restored ${versionTitle(confirm)}`)
              await load()
            })
          }
        />
      )}
    </aside>
  )
}

function NameForm({ value, onChange, onSave, onCancel, busy, label }: { value: string; onChange: (v: string) => void; onSave: () => void; onCancel: () => void; busy: boolean; label: string }) {
  return (
    <form
      className="ed-versions-name"
      onSubmit={(e) => {
        e.preventDefault()
        onSave()
      }}
    >
      <input
        autoFocus
        className="input sm"
        aria-label={label}
        placeholder="e.g. Sent to client"
        value={value}
        maxLength={120}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.stopPropagation()
            onCancel()
          }
        }}
      />
      <button type="submit" className="btn sm primary" disabled={busy}>Save</button>
      <button type="button" className="btn sm ghost" onClick={onCancel}>Cancel</button>
    </form>
  )
}

/** Over the canvas while a saved version is on show: it's read-only, with the way back and the way to keep it. */
export function VersionPreviewBanner() {
  const preview = useEditor((s) => s.versionPreview)
  const gate = useEditGate()
  const [busy, setBusy] = useState(false)
  if (!preview) return null
  return (
    <div className="ed-banner ed-banner-info" role="status">
      <Eye size={15} />
      <span>Previewing {preview.label} (read-only). Your current version is unchanged.</span>
      <div className="spacer" />
      <button
        className="btn sm primary"
        disabled={busy || !gate.canEdit}
        data-tip={gate.tip}
        onClick={async () => {
          setBusy(true)
          try {
            await restoreVersion(preview.id)
            toast(`Restored ${preview.label}`)
          } catch (e) {
            toastError(e)
          } finally {
            setBusy(false)
          }
        }}
      >
        Restore this version
      </button>
      <button className="btn sm" onClick={endPreview}>Back to current</button>
    </div>
  )
}
