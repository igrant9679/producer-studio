import { ASPECT_RATIOS, presetCanvasSize, setAspect, updateProject } from '@producer/core'
import clsx from 'clsx'
import type { ThemePreference } from '@producer/core'
import { ArrowLeft, Check, ChevronDown, CloudOff, Hand, History, Keyboard, Loader2, Monitor, Moon, MousePointer2, Redo2, Share2, Sun, TriangleAlert, Undo2, Upload } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { themeLabel, useAppearance } from '../lib/appearance'
import { tipProps } from '../lib/tooltip'
import { toast, toastError } from '../lib/toast'
import { useEditGate } from '../shell/ui'
import * as A from './actions'
import { Menu, MenuItem } from './controls'
import { discardJournal, flush, restoreJournal } from './persistence'
import { VersionsButton } from './VersionsPanel'
import { PROJECT_NAME_MAX, redoLabel, undoLabel, useEditor } from './store'
import { useEditorGate, ViewOnlyBadge } from './viewer'
import { ShareLinksDialog } from '../shell/components/ShareLinks'
import { PresenceAvatars } from './collab/presence'

export function TopBar() {
  const nav = useNavigate()
  const name = useEditor((s) => s.project.name)
  const demo = useEditor((s) => s.demo)
  const canUndo = useEditor((s) => s.history.past.length > 0)
  const canRedo = useEditor((s) => s.history.future.length > 0)
  const uLabel = useEditor(undoLabel)
  const rLabel = useEditor(redoLabel)
  const tool = useEditor((s) => s.canvasTool)
  const gate = useEditorGate()
  const [draft, setDraft] = useState(name)
  useEffect(() => setDraft(name), [name])

  // an ordinary edit: the autosave carries the name with the document's base version, so it can't race itself
  const rename = () => {
    const v = draft.trim().slice(0, PROJECT_NAME_MAX) || 'Untitled project'
    if (v === name) return setDraft(v)
    const s = useEditor.getState()
    s.commit(updateProject(s.project, { name: v }), 'Rename project')
  }

  // review links: this project's, each with its own settings (A-16)
  const [shareOpen, setShareOpen] = useState(false)
  const share = () => {
    if (A.demoBlocked('sharing')) return
    void flush().catch(() => undefined)
    setShareOpen(true)
  }

  return (
    <header className="ed-top">
      <div className="row ed-top-l">
        <button className="ed-tbtn" {...tipProps('Back to home', 'Your projects. This project is saved as you go.')} onClick={() => nav('/')}>
          <ArrowLeft size={16} />
        </button>
        <div className="ed-logo" title="Producer Studio">
          <img src="/favicon.svg" width={22} height={22} alt="" style={{ borderRadius: 6, display: 'block' }} />
        </div>
        <input
          className="ed-title"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={rename}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
            if (e.key === 'Escape') {
              setDraft(name)
              ;(e.target as HTMLInputElement).blur()
            }
          }}
          spellCheck={false}
          maxLength={PROJECT_NAME_MAX}
          aria-label="Project name"
          readOnly={!gate.canEdit}
          data-tip={gate.tip}
        />
        <SaveStatus demo={demo} />
        {!demo && <VersionsButton />}
        <ViewOnlyBadge />
      </div>
      <div className="row ed-top-c">
        <button className="ed-tbtn" {...tipProps(canUndo ? `Undo ${uLabel}` : 'Nothing to undo', undefined, 'Ctrl+Z')} {...gate.props} disabled={!canUndo || !gate.canEdit} onClick={() => useEditor.getState().undo()}>
          <Undo2 size={16} />
        </button>
        <button className="ed-tbtn" {...tipProps(canRedo ? `Redo ${rLabel}` : 'Nothing to redo', undefined, 'Ctrl+Shift+Z')} {...gate.props} disabled={!canRedo || !gate.canEdit} onClick={() => useEditor.getState().redo()}>
          <Redo2 size={16} />
        </button>
        <div className="ed-tsep" />
        <div className="ed-seg sm">
          <button className={clsx(tool === 'select' && 'on')} {...tipProps('Select', 'Click things on the canvas to select, move, resize or rotate them.', 'V')} onClick={() => useEditor.setState({ canvasTool: 'select' })}>
            <MousePointer2 size={14} />
          </button>
          <button className={clsx(tool === 'hand' && 'on')} {...tipProps('Hand', 'Drag to pan around the canvas.', 'H')} onClick={() => useEditor.setState({ canvasTool: 'hand' })}>
            <Hand size={14} />
          </button>
        </div>
        <ZoomMenu />
        <RatioMenu />
      </div>
      <div className="row ed-top-r">
        <PresenceAvatars />
        <ThemeMenu />
        <button className="ed-tbtn ed-top-wide" {...tipProps('Keyboard shortcuts', 'Every shortcut in the editor.', '?')} onClick={() => useEditor.setState({ shortcutsOpen: true })}>
          <Keyboard size={16} />
        </button>
        <button className="btn sm" onClick={share} {...tipProps('Share', 'Review links to this project: make one, copy it, and set its expiry, password, downloads and comments.')}>
          <Share2 size={14} /> <span className="ed-top-lbl">Share</span>
        </button>
        <button className="btn sm primary" onClick={() => useEditor.setState({ exportOpen: true, playing: false })} {...tipProps('Export', 'Render the video or a part of it (MP4, WebM or GIF, 720p to 4K), or just its sound (MP3, WAV). It renders in the background while you keep working.')} {...gate.props}>
          <Upload size={14} /> <span className="ed-top-lbl">Export</span>
        </button>
      </div>
      {shareOpen && (
        <ShareLinksDialog
          projectId={useEditor.getState().projectId}
          gate={gate}
          onClose={() => setShareOpen(false)}
          onExportFirst={() => {
            setShareOpen(false)
            useEditor.setState({ exportOpen: true, playing: false })
          }}
        />
      )}
    </header>
  )
}

/** Seconds until `at`, ticking once a second while there is one. */
function useCountdown(at: number | undefined): number | undefined {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!at) return
    setNow(Date.now())
    const iv = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(iv)
  }, [at])
  return at ? Math.max(0, Math.ceil((at - now) / 1000)) : undefined
}

const signInAgain = () => window.open('/login', '_blank')

/**
 * Where saving stands, in the top bar: Saved, Saving…, Offline (and when it tries again, only while a retry is
 * really scheduled), Sign in again, Too large, Failed (with Retry), Conflict. The ones with a way out are buttons.
 */
function SaveStatus({ demo }: { demo: boolean }) {
  const st = useEditor((s) => s.saveState)
  const err = useEditor((s) => s.saveError)
  const secs = useCountdown(useEditor((s) => s.saveRetryAt))
  const retryNow = () => void flush()
  const again = secs === undefined ? undefined : secs > 0 ? `retrying in ${secs} s` : 'retrying…'
  if (st === 'conflict')
    return (
      <span className="ed-save conflict"><TriangleAlert size={13} /> Conflict</span>
    )
  if (st === 'error' && err?.status === 401)
    return (
      <button type="button" className="ed-save conflict" aria-label="Sign in again to save" title={`${err.message} Opens sign-in in a new tab; this tab keeps your changes.`} onClick={signInAgain}>
        <TriangleAlert size={13} /> Sign in again
      </button>
    )
  if (st === 'error' && err?.status === 413)
    return (
      <span className="ed-save conflict" title={err.message}><TriangleAlert size={13} /> Too large</span>
    )
  if (st === 'error')
    return (
      <button type="button" className="ed-save conflict" title={`${err?.message ?? 'The server refused your latest changes.'} Click to try again now.`} onClick={retryNow}>
        <TriangleAlert size={13} /> {again ? `Failed · ${again}` : 'Failed · Retry'}
      </button>
    )
  if (st === 'offline')
    return (
      <button
        type="button"
        className="ed-save offline"
        title={`Can’t reach the server. Your changes are kept in this browser${again ? ' and saving tries again on its own' : ''}. Click to try now.`}
        onClick={retryNow}
      >
        <CloudOff size={13} /> {again ? `Offline · ${again}` : 'Offline · Retry'}
      </button>
    )
  if (st === 'saving' || st === 'dirty')
    return (
      <span className="ed-save saving"><Loader2 size={13} className="spin" /> Saving…</span>
    )
  return (
    <span className="ed-save saved" title={demo ? 'Saved in this browser' : 'All changes saved'}><Check size={13} /> {demo ? 'Saved locally' : 'Saved'}</span>
  )
}

/**
 * A save the server refused: why, and the way out. "Sign in again" opens sign-in in another tab so this one keeps
 * the edits; coming back here (or signing in) saves them.
 */
export function SaveErrorBanner() {
  const err = useEditor((s) => (s.saveState === 'error' ? s.saveError : undefined))
  if (!err) return null
  return (
    <div className="ed-banner" role="alert">
      <TriangleAlert size={15} />
      <span>{err.message}</span>
      <div className="spacer" />
      {err.status === 401 && (
        <button className="btn sm primary" onClick={signInAgain} title="Opens sign-in in a new tab; this tab keeps your changes">
          Sign in again
        </button>
      )}
      <button className="btn sm" onClick={() => void flush()}>Try again</button>
    </div>
  )
}

/** Changes this browser kept from an earlier visit (the tab closed or crashed before they were saved). */
export function JournalBanner() {
  const offer = useEditor((s) => s.journalOffer)
  const gate = useEditGate()
  const [busy, setBusy] = useState(false)
  if (!offer) return null
  const when = new Date(offer.savedAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
  return (
    <div className="ed-banner ed-banner-info" role="alert">
      <History size={15} />
      <span>This browser kept changes to this project that never reached the server (last edited {when}).</span>
      <div className="spacer" />
      <button
        className="btn sm primary"
        disabled={busy || !gate.canEdit}
        data-tip={gate.tip}
        onClick={async () => {
          setBusy(true)
          try {
            await restoreJournal()
          } catch (e) {
            toastError(e)
          } finally {
            setBusy(false)
          }
        }}
      >
        Restore unsaved changes
      </button>
      <button className="btn sm" disabled={busy} onClick={discardJournal}>Discard</button>
    </div>
  )
}

const THEME_ICON: Record<ThemePreference, JSX.Element> = { system: <Monitor size={14} />, dark: <Moon size={14} />, light: <Sun size={14} /> }

/** Theme picker (System / Dark / Light); the full appearance settings live in Settings. */
function ThemeMenu() {
  const theme = useAppearance((s) => s.prefs.theme)
  const resolved = useAppearance((s) => s.resolved)
  const update = useAppearance((s) => s.update)
  const nav = useNavigate()
  const [open, setOpen] = useState(false)
  const pick = (t: ThemePreference) => {
    update({ theme: t })
    setOpen(false)
  }
  return (
    <div className="ed-dd ed-dd-right ed-top-wide">
      <button className="ed-tbtn" {...tipProps(`Theme: ${themeLabel(theme)}`, 'Light, dark or follow your system.', 'Ctrl+Shift+L')} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}>
        {resolved === 'light' ? <Sun size={16} /> : <Moon size={16} />}
      </button>
      <Menu open={open} onClose={() => setOpen(false)}>
        {(['system', 'dark', 'light'] as const).map((t) => (
          <MenuItem key={t} icon={THEME_ICON[t]} label={themeLabel(t)} active={theme === t} kbd={theme === t ? '✓' : undefined} onClick={() => pick(t)} />
        ))}
        <div className="ed-menu-sep" />
        <MenuItem label="Appearance settings…" onClick={() => nav('/settings#appearance')} />
      </Menu>
    </div>
  )
}

function ZoomMenu() {
  const z = useEditor((s) => s.canvasZoom)
  const [open, setOpen] = useState(false)
  const fit = useEditor((s) => s.canvasFit)
  const pct = Math.round((z === 'fit' ? fit : z) * 100)
  const set = (v: 'fit' | number) => {
    useEditor.setState({ canvasZoom: v })
    setOpen(false)
  }
  return (
    <div className="ed-dd">
      <button className="ed-ddbtn" onClick={() => setOpen(!open)} {...tipProps('Canvas zoom', 'How large the preview is drawn. Ctrl + mouse wheel on the canvas also zooms.')}>
        <span className="mono">{pct}%</span> <ChevronDown size={13} />
      </button>
      <Menu open={open} onClose={() => setOpen(false)}>
        <MenuItem label="Fit to screen" kbd="Shift F" active={z === 'fit'} onClick={() => set('fit')} />
        <div className="ed-menu-sep" />
        {[0.25, 0.5, 0.75, 1, 1.5, 2].map((v) => (
          <MenuItem key={v} label={`${v * 100}%`} kbd={CANVAS_ZOOM_KEYS[v]} active={z === v} onClick={() => set(v)} />
        ))}
      </Menu>
    </div>
  )
}

/** Shift+0, 1 and 2 set these canvas zooms (shortcuts.ts). */
const CANVAS_ZOOM_KEYS: Record<number, string | undefined> = { 0.5: 'Shift 0', 1: 'Shift 1', 2: 'Shift 2' }

function RatioMenu() {
  const w = useEditor((s) => s.project.width)
  const h = useEditor((s) => s.project.height)
  const [open, setOpen] = useState(false)
  const cur = ASPECT_RATIOS.find((a) => Math.abs(a.width / a.height - w / h) < 0.001)
  const gate = useEditorGate()
  return (
    <div className="ed-dd">
      <button className="ed-ddbtn" onClick={() => setOpen(!open)} {...tipProps('Aspect ratio', 'The shape of the video: 16:9 for YouTube, 9:16 for TikTok, Reels and Shorts, 1:1 for Instagram posts.')} {...gate.props}>
        <span className="ed-ratioicon" style={{ aspectRatio: `${w}/${h}` }} />
        {cur?.name ?? `${w}×${h}`} <ChevronDown size={13} />
      </button>
      <Menu open={open} onClose={() => setOpen(false)} className="ed-ratiomenu">
        {ASPECT_RATIOS.map((a) => (
          <MenuItem
            key={a.id}
            active={cur?.id === a.id}
            icon={<span className="ed-ratioicon" style={{ aspectRatio: `${a.width}/${a.height}` }} />}
            label={
              <span>
                <b>{a.name}</b> <span className="muted">{a.hint}</span>
              </span>
            }
            kbd={(() => {
              const z = presetCanvasSize(a.id, Math.min(w, h))
              return `${z.width}×${z.height}`
            })()}
            onClick={() => {
              const s = useEditor.getState()
              // keep the current resolution (short side) when changing shape
              const z = presetCanvasSize(a.id, Math.min(s.project.width, s.project.height))
              s.commit(setAspect(s.project, z.width, z.height), `Ratio ${a.name}`)
              useEditor.setState({ canvasZoom: 'fit' })
              setOpen(false)
            }}
          />
        ))}
      </Menu>
    </div>
  )
}
