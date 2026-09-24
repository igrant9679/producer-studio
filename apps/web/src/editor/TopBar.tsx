import { ASPECT_RATIOS, presetCanvasSize, setAspect, updateProject } from '@producer/core'
import clsx from 'clsx'
import type { ThemePreference } from '@producer/core'
import { ArrowLeft, Check, ChevronDown, CloudOff, Hand, Keyboard, Loader2, Monitor, Moon, MousePointer2, Redo2, Share2, Sun, TriangleAlert, Undo2, Upload } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '../lib/api'
import { themeLabel, useAppearance } from '../lib/appearance'
import { toast, toastError } from '../lib/toast'
import * as A from './actions'
import { Menu, MenuItem } from './controls'
import { flush } from './persistence'
import { redoLabel, undoLabel, useEditor } from './store'

export function TopBar() {
  const nav = useNavigate()
  const name = useEditor((s) => s.project.name)
  const demo = useEditor((s) => s.demo)
  const canUndo = useEditor((s) => s.history.past.length > 0)
  const canRedo = useEditor((s) => s.history.future.length > 0)
  const uLabel = useEditor(undoLabel)
  const rLabel = useEditor(redoLabel)
  const tool = useEditor((s) => s.canvasTool)
  const [draft, setDraft] = useState(name)
  useEffect(() => setDraft(name), [name])

  const rename = () => {
    const v = draft.trim() || 'Untitled project'
    if (v === name) return setDraft(v)
    const s = useEditor.getState()
    s.commit(updateProject(s.project, { name: v }), 'Rename project')
    if (!s.demo) void api.patchProject(s.projectId, { name: v }).catch(() => undefined)
  }

  const share = async () => {
    if (A.demoBlocked('sharing')) return
    try {
      await flush()
      const r = await api.share(useEditor.getState().projectId)
      const url = r.url.startsWith('http') ? r.url : `${location.origin}${r.url}`
      await navigator.clipboard.writeText(url).catch(() => undefined)
      toast('Review link copied to clipboard')
    } catch (e) {
      toastError(e)
    }
  }

  return (
    <header className="ed-top">
      <div className="row ed-top-l">
        <button className="ed-tbtn" title="Back to home" onClick={() => nav('/')}>
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
          aria-label="Project name"
        />
        <SaveStatus demo={demo} />
      </div>
      <div className="row ed-top-c">
        <button className="ed-tbtn" title={canUndo ? `Undo ${uLabel} (Ctrl+Z)` : 'Nothing to undo'} disabled={!canUndo} onClick={() => useEditor.getState().undo()}>
          <Undo2 size={16} />
        </button>
        <button className="ed-tbtn" title={canRedo ? `Redo ${rLabel} (Ctrl+Shift+Z)` : 'Nothing to redo'} disabled={!canRedo} onClick={() => useEditor.getState().redo()}>
          <Redo2 size={16} />
        </button>
        <div className="ed-tsep" />
        <div className="ed-seg sm">
          <button className={clsx(tool === 'select' && 'on')} title="Select (V)" onClick={() => useEditor.setState({ canvasTool: 'select' })}>
            <MousePointer2 size={14} />
          </button>
          <button className={clsx(tool === 'hand' && 'on')} title="Hand (H)" onClick={() => useEditor.setState({ canvasTool: 'hand' })}>
            <Hand size={14} />
          </button>
        </div>
        <ZoomMenu />
        <RatioMenu />
      </div>
      <div className="row ed-top-r">
        <ThemeMenu />
        <button className="ed-tbtn" title="Keyboard shortcuts (?)" onClick={() => useEditor.setState({ shortcutsOpen: true })}>
          <Keyboard size={16} />
        </button>
        <button className="btn sm" onClick={share} title="Create a review link">
          <Share2 size={14} /> Share
        </button>
        <button className="btn sm primary" onClick={() => useEditor.setState({ exportOpen: true, playing: false })}>
          <Upload size={14} /> Export
        </button>
      </div>
    </header>
  )
}

function SaveStatus({ demo }: { demo: boolean }) {
  const st = useEditor((s) => s.saveState)
  if (st === 'conflict')
    return (
      <span className="ed-save conflict"><TriangleAlert size={13} /> Conflict</span>
    )
  if (st === 'offline')
    return (
      <span className="ed-save offline" title="Changes are kept locally and will retry"><CloudOff size={13} /> Offline</span>
    )
  if (st === 'saving' || st === 'dirty')
    return (
      <span className="ed-save saving"><Loader2 size={13} className="spin" /> Saving…</span>
    )
  return (
    <span className="ed-save saved" title={demo ? 'Saved in this browser' : 'All changes saved'}><Check size={13} /> {demo ? 'Saved locally' : 'Saved'}</span>
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
    <div className="ed-dd ed-dd-right">
      <button className="ed-tbtn" title={`Theme: ${themeLabel(theme)} (Ctrl+Shift+L)`} aria-label="Theme" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}>
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
      <button className="ed-ddbtn" onClick={() => setOpen(!open)} title="Canvas zoom (Ctrl+wheel on the canvas)">
        <span className="mono">{pct}%</span> <ChevronDown size={13} />
      </button>
      <Menu open={open} onClose={() => setOpen(false)}>
        <MenuItem label="Fit to screen" kbd="Shift F" active={z === 'fit'} onClick={() => set('fit')} />
        <div className="ed-menu-sep" />
        {[0.25, 0.5, 0.75, 1, 1.5, 2].map((v) => (
          <MenuItem key={v} label={`${v * 100}%`} active={z === v} onClick={() => set(v)} />
        ))}
      </Menu>
    </div>
  )
}

function RatioMenu() {
  const w = useEditor((s) => s.project.width)
  const h = useEditor((s) => s.project.height)
  const [open, setOpen] = useState(false)
  const cur = ASPECT_RATIOS.find((a) => Math.abs(a.width / a.height - w / h) < 0.001)
  return (
    <div className="ed-dd">
      <button className="ed-ddbtn" onClick={() => setOpen(!open)} title="Aspect ratio">
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
