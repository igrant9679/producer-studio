// The command palette on Ctrl+K (A-10) with search across the space (A-11): new video, upload, switch space, open a
// project, jump to a page or a Settings section, change the theme, and whatever the space holds that matches (words
// said in a clip, a voiceover's text, a script's narration...). Keyboard first: type, arrows, Enter, Escape.
import type { SearchHit } from '@producer/core'
import { AudioLines, Clapperboard, Download, FileText, Film, FolderOpen, Home, Image as ImageIcon, LayoutTemplate, Mic, Monitor, Moon, Palette, Search, Send, Settings, Sparkles, Sun, Trash2, Upload, User, Users, Video, Activity } from 'lucide-react'
import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import { api, HttpError } from '../../lib/api'
import { useAppearance } from '../../lib/appearance'
import { canEdit, useSession } from '../../lib/session'
import { uploadFiles } from '../stores'
import { useSystem } from '../system'
import { Spinner, useEscapeLayer, useFilePicker } from '../ui'
import { formatDuration } from '../util'
import '../library/library.css'
import { HIT_GROUP, hitPath, rankCommands, settingsSections, type Command } from './paletteLogic'

interface Row {
  id: string
  group: string
  title: string
  detail?: string
  icon?: ReactNode
  run: () => void
}

const HIT_ICON: Record<SearchHit['kind'], ReactNode> = {
  project: <Film size={15} />,
  template: <LayoutTemplate size={15} />,
  media: <Video size={15} />,
  voice: <Mic size={15} />,
  export: <Send size={15} />,
  member: <User size={15} />,
}

/** Search results wait for a pause in typing this long. */
export const SEARCH_DELAY_MS = 200

export function CommandPalette({ onClose, onNewVideo }: { onClose: () => void; onNewVideo: () => void }) {
  const navigate = useNavigate()
  const workspaceId = useSession((s) => s.workspaceId)
  const workspaces = useSession((s) => s.workspaces)
  const setWorkspace = useSession((s) => s.setWorkspace)
  const current = workspaces.find((w) => w.id === workspaceId)
  const editor = !current || canEdit(current)
  const desktop = useSystem((s) => s.info?.mode === 'desktop')
  const setTheme = useAppearance((s) => s.update)
  const [q, setQ] = useState('')
  const [hi, setHi] = useState(0)
  const [hits, setHits] = useState<{ ws: string; q: string; hits: SearchHit[] }>()
  const [searching, setSearching] = useState(false)
  const [failed, setFailed] = useState<string>()
  const inputRef = useRef<HTMLInputElement>(null)
  const boxRef = useRef<HTMLDivElement>(null)
  const listId = useId()
  // focus goes back where it was when the palette closes
  const [restore] = useState(() => (typeof document !== 'undefined' ? (document.activeElement as HTMLElement | null) : null))
  useEffect(() => {
    inputRef.current?.focus()
    return () => {
      if (restore?.isConnected) restore.focus()
    }
  }, [restore])
  useEscapeLayer(onClose, true, boxRef)
  const pick = useFilePicker('video/*,audio/*,image/*', true, (files) => {
    if (!workspaceId) return
    void uploadFiles(workspaceId, files)
    navigate('/library?tab=assets')
  })

  // the space's search, after a pause in typing; a space switch starts it again for the new space
  const term = q.trim()
  useEffect(() => {
    setFailed(undefined)
    if (!workspaceId || term.length < 2) {
      setHits(undefined)
      setSearching(false)
      return
    }
    const ctl = new AbortController()
    setSearching(true)
    const t = setTimeout(() => {
      api
        .search(workspaceId, term, ctl.signal)
        .then((r) => !ctl.signal.aborted && setHits({ ws: workspaceId, q: term, hits: r.hits }))
        .catch((e) => {
          if (ctl.signal.aborted) return
          setHits(undefined)
          setFailed(e instanceof HttpError && e.status === 401 ? 'Your session ended. Sign in again to search.' : 'Search isn’t available right now.')
        })
        .finally(() => !ctl.signal.aborted && setSearching(false))
    }, SEARCH_DELAY_MS)
    return () => {
      clearTimeout(t)
      ctl.abort()
    }
  }, [workspaceId, term])

  const go = (path: string) => () => navigate(path)
  const commands = useMemo<Array<Command & { icon?: ReactNode }>>(() => {
    const list: Array<Command & { icon?: ReactNode }> = [
      { id: 'new-video', group: 'Create', title: 'New video', detail: 'Blank project: pick an aspect ratio', keywords: 'create project blank edit', write: true, icon: <Clapperboard size={15} />, run: onNewVideo },
      { id: 'new-producer', group: 'Create', title: 'New from recording', detail: 'Producer AI writes, narrates and cuts it', keywords: 'producer ai create', write: true, icon: <Sparkles size={15} />, run: go('/producer/new') },
      { id: 'upload', group: 'Create', title: 'Upload media', detail: 'Video, audio or images to this space', keywords: 'import file add', write: true, icon: <Upload size={15} />, run: pick },
      { id: 'voiceover', group: 'Create', title: 'New voiceover', detail: 'Text to speech in Voice Studio', keywords: 'tts voice narration', write: true, icon: <AudioLines size={15} />, run: go('/voice') },
      { id: 'go-home', group: 'Go to', title: 'Home', icon: <Home size={15} />, run: go('/') },
      { id: 'go-library', group: 'Go to', title: 'Library', detail: 'Projects', keywords: 'projects', icon: <FolderOpen size={15} />, run: go('/library') },
      { id: 'go-media', group: 'Go to', title: 'Media', detail: 'Library · Assets', keywords: 'assets clips uploads library', icon: <ImageIcon size={15} />, run: go('/library?tab=assets') },
      { id: 'go-trash', group: 'Go to', title: 'Trash', detail: 'Library · Trash', keywords: 'deleted restore', icon: <Trash2 size={15} />, run: go('/library?tab=trash') },
      { id: 'go-exports', group: 'Go to', title: 'Exports & sharing', keywords: 'renders finished share links download', icon: <Download size={15} />, run: go('/exports') },
      { id: 'go-templates', group: 'Go to', title: 'Templates', icon: <LayoutTemplate size={15} />, run: go('/templates') },
      { id: 'go-producer', group: 'Go to', title: 'Producer AI', icon: <Sparkles size={15} />, run: go('/producer') },
      { id: 'go-voice', group: 'Go to', title: 'Voice Studio', keywords: 'voices tts', icon: <AudioLines size={15} />, run: go('/voice') },
      { id: 'go-editor', group: 'Go to', title: 'Video Editor', icon: <Clapperboard size={15} />, run: go('/editor') },
      { id: 'go-activity', group: 'Go to', title: 'Activity', keywords: 'history feed', icon: <Activity size={15} />, run: go('/activity') },
      { id: 'go-members', group: 'Go to', title: 'Members', keywords: 'people team invite space', icon: <Users size={15} />, run: go('/space') },
      { id: 'go-brand', group: 'Go to', title: 'Brand kit', keywords: 'logo colours fonts', icon: <Palette size={15} />, run: go('/brand') },
      { id: 'go-settings', group: 'Go to', title: 'Settings', icon: <Settings size={15} />, run: go('/settings') },
      ...settingsSections(desktop).map((s) => ({ id: `set-${s.id}`, group: 'Settings', title: `Settings: ${s.title}`, keywords: s.keywords, icon: <Settings size={15} />, run: go(`/settings#${s.id}`) })),
      ...workspaces
        .filter((w) => w.id !== workspaceId)
        .map((w) => ({ id: `space-${w.id}`, group: 'Switch space', title: `Switch to ${w.name}`, detail: `${w.personal ? 'Personal' : `${w.memberCount} member${w.memberCount === 1 ? '' : 's'}`} · ${w.role}`, keywords: 'space workspace team', icon: <Users size={15} />, run: () => setWorkspace(w.id) })),
      { id: 'theme-light', group: 'Theme', title: 'Theme: Light', keywords: 'appearance', icon: <Sun size={15} />, run: () => setTheme({ theme: 'light' }) },
      { id: 'theme-dark', group: 'Theme', title: 'Theme: Dark', keywords: 'appearance', icon: <Moon size={15} />, run: () => setTheme({ theme: 'dark' }) },
      { id: 'theme-system', group: 'Theme', title: 'Theme: Match the system', keywords: 'appearance auto os', icon: <Monitor size={15} />, run: () => setTheme({ theme: 'system' }) },
    ]
    // a viewer gets no write actions (they would only be refused)
    return list.filter((c) => editor || !c.write)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaces, workspaceId, editor, desktop, onNewVideo, pick])

  const rows: Row[] = useMemo(() => {
    const cmd = rankCommands(commands, term, term ? 8 : 50).map((c): Row => ({ id: c.id, group: term ? 'Commands' : c.group, title: c.title, detail: c.detail, icon: c.icon, run: c.run }))
    const found = hits && hits.ws === workspaceId && hits.q === term ? hits.hits : []
    const res = found.map(
      (h): Row => ({
        id: `hit-${h.kind}-${h.id}`,
        group: HIT_GROUP[h.kind],
        title: h.title,
        detail: h.snippet ? `${h.at != null ? `${formatDuration(h.at)} · ` : ''}“${h.snippet}”` : h.detail,
        icon: h.snippet ? <FileText size={15} /> : HIT_ICON[h.kind],
        run: () => navigate(hitPath(h)),
      }),
    )
    return term ? [...res, ...cmd] : cmd
  }, [commands, term, hits, workspaceId, navigate])

  useEffect(() => setHi(0), [term, rows.length])
  useEffect(() => {
    document.getElementById(`${listId}-${hi}`)?.scrollIntoView?.({ block: 'nearest' })
  }, [hi, listId])

  const run = (i: number) => {
    const r = rows[i]
    if (!r) return
    onClose()
    r.run()
  }

  let lastGroup = ''
  return (
    <div className="ps-palette-scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={boxRef} className="ps-palette" role="dialog" aria-modal="true" aria-label="Command palette">
        <div className="ps-palette-head">
          {searching ? <Spinner size={16} /> : <Search size={16} />}
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search or jump to…"
            role="combobox"
            aria-expanded={rows.length > 0}
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={rows.length ? `${listId}-${hi}` : undefined}
            aria-label="Search projects, media, settings and commands"
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault()
                setHi((h) => (rows.length ? (h + 1) % rows.length : 0))
              } else if (e.key === 'ArrowUp') {
                e.preventDefault()
                setHi((h) => (rows.length ? (h - 1 + rows.length) % rows.length : 0))
              } else if (e.key === 'Enter') {
                e.preventDefault()
                run(hi)
              } else if (e.key === 'Tab') {
                // the field is the dialog's only stop: Tab stays in it
                e.preventDefault()
              }
            }}
          />
          <span className="kbd">Esc</span>
        </div>
        <div className="ps-palette-list" id={listId} role="listbox" aria-label="Results">
          {rows.map((r, i) => {
            const head = r.group !== lastGroup ? r.group : ''
            lastGroup = r.group
            return (
              <div key={r.id} role="presentation">
                {head && <div className="ps-palette-group" role="presentation">{head}</div>}
                <div
                  id={`${listId}-${i}`}
                  role="option"
                  aria-selected={i === hi}
                  className="ps-palette-item"
                  onMouseEnter={() => setHi(i)}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => run(i)}
                >
                  {r.icon}
                  <span className="t">
                    <strong>{r.title}</strong>
                    {r.detail && <span>{r.detail}</span>}
                  </span>
                </div>
              </div>
            )
          })}
          {term.length >= 2 && !searching && !rows.length && !failed && <div className="ps-palette-empty" role="status">Nothing matches “{term}” in this space.</div>}
          {failed && <div className="ps-palette-empty" role="alert">{failed}</div>}
        </div>
        <div className="ps-palette-foot" aria-hidden>
          <span><span className="kbd">↑</span> <span className="kbd">↓</span> move</span>
          <span><span className="kbd">Enter</span> open</span>
          <span><span className="kbd">Esc</span> close</span>
        </div>
      </div>
    </div>
  )
}

/** The top bar's search box: opens the palette (also on Ctrl+K / ⌘K from anywhere). */
export function GlobalSearch({ onNewVideo }: { onNewVideo: () => void }) {
  const [open, setOpen] = useState(false)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setOpen((o) => !o)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
  return (
    <>
      <button className="btn ghost icon ps-search-toggle" onClick={() => setOpen(true)} aria-label="Search or jump to (Ctrl+K)" aria-haspopup="dialog">
        <Search size={17} />
      </button>
      <div className="ps-search">
        <Search size={16} />
        <button type="button" className="input ps-search-open" onClick={() => setOpen(true)} aria-haspopup="dialog" aria-keyshortcuts="Control+K">
          Search or jump to…
        </button>
        <span className="kbd" aria-hidden>Ctrl K</span>
      </div>
      {open && <CommandPalette onClose={() => setOpen(false)} onNewVideo={onNewVideo} />}
    </>
  )
}
