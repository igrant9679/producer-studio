import type { AssetRecord, ProjectSummary } from '@producer/core'
import clsx from 'clsx'
import {
  Activity,
  AudioLines,
  Check,
  ChevronsUpDown,
  CircleHelp,
  Clapperboard,
  Film,
  FolderOpen,
  Home,
  Image as ImageIcon,
  LayoutGrid,
  LayoutTemplate,
  LogOut,
  Music,
  Palette,
  Plus,
  Search,
  Send,
  Settings,
  Sparkles,
  Upload,
  UserPlus,
  Users,
  Video,
  Wand2,
  X,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { NavLink, useLocation, useNavigate } from 'react-router-dom'
import { api, subscribeEvents } from '../lib/api'
import { useSession } from '../lib/session'
import { useCreateAndOpen } from './actions'
import { MOCK_ACTIVE } from './dev/installMock'
import { AspectPickerModal, CreateSpaceModal, HelpModal, InviteModal } from './modals'
import { AiChip, DesktopBadge, SyncIndicator } from './SystemChrome'
import { useSyncPolling, useSystem } from './system'
import { isActive, liveBus, uploadFiles, useJobs, useUploads } from './stores'
import { Avatar, Logo, MenuList, Popover, Progress, Spinner, spaceColor, useClickOutside, useFilePicker } from './ui'
import { JOB_LABELS, formatDuration, relativeTime } from './util'

type ModalKind = 'aspect' | 'space' | 'invite' | 'help' | undefined

function NavItem({ to, icon, label, end, badge }: { to: string; icon: ReactNode; label: string; end?: boolean; badge?: string }) {
  return (
    <NavLink to={to} end={end} className={({ isActive: a }) => clsx('ps-nav-link', a && 'active')} data-tip={label}>
      {icon}
      <span className="ps-nav-text">{label}</span>
      {badge && <span className="ps-nav-badge">{badge}</span>}
    </NavLink>
  )
}

function SpaceSwitcher({ openModal }: { openModal: (m: ModalKind) => void }) {
  const workspaces = useSession((s) => s.workspaces)
  const workspaceId = useSession((s) => s.workspaceId)
  const setWorkspace = useSession((s) => s.setWorkspace)
  const navigate = useNavigate()
  const current = workspaces.find((w) => w.id === workspaceId)
  return (
    <Popover
      className="ps-space-pop"
      style={{ width: 272, top: 'auto', bottom: 'calc(100% + 6px)' }}
      trigger={({ toggle, open }) => (
        <button className="ps-space-btn" onClick={toggle} aria-expanded={open} aria-label="Switch space" data-tip={current?.name ?? 'Space'}>
          <span className="ps-space-avatar" style={{ background: spaceColor(current?.id ?? '') }}>{(current?.name ?? '?').slice(0, 1).toUpperCase()}</span>
          <span className="ps-space-meta">
            <strong>{current?.name ?? 'No space'}</strong>
            <span>{current ? `${current.personal ? 'Personal' : `${current.memberCount} member${current.memberCount === 1 ? '' : 's'}`} · ${current.role}` : ''}</span>
          </span>
          <ChevronsUpDown size={15} className="ps-nav-caret" style={{ color: 'var(--text-3)' }} />
        </button>
      )}
    >
      {(close) => (
        <>
          <div className="ps-menu-label">Your spaces</div>
          {workspaces.map((w) => (
            <button
              key={w.id}
              className="ps-menu-item"
              onClick={() => {
                setWorkspace(w.id)
                close()
              }}
            >
              <span className="ps-space-avatar" style={{ background: spaceColor(w.id), width: 24, height: 24, fontSize: 11 }}>{w.name.slice(0, 1).toUpperCase()}</span>
              <span style={{ flex: 1, minWidth: 0 }}>
                <span style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{w.name}</span>
                <span className="ps-menu-sub">{w.personal ? 'Personal' : `${w.memberCount} members`} · {w.role}</span>
              </span>
              {w.id === workspaceId && <Check size={15} style={{ color: 'var(--cyan)' }} />}
            </button>
          ))}
          <div className="ps-menu-sep" />
          <MenuList
            close={close}
            items={[
              { label: 'Invite members', icon: <UserPlus size={15} />, onClick: () => openModal('invite') },
              { label: 'Manage members', icon: <Users size={15} />, onClick: () => navigate('/space') },
              { label: 'Create space', icon: <Plus size={15} />, onClick: () => openModal('space') },
            ]}
          />
        </>
      )}
    </Popover>
  )
}

function CreateMenu({ openModal }: { openModal: (m: ModalKind) => void }) {
  const navigate = useNavigate()
  const workspaceId = useSession((s) => s.workspaceId)
  const pick = useFilePicker('video/*,audio/*,image/*', true, (files) => {
    if (!workspaceId) return
    void uploadFiles(workspaceId, files)
    navigate('/library?tab=assets')
  })
  return (
    <Popover
      style={{ width: 290 }}
      trigger={({ toggle, open }) => (
        <button className="btn primary ps-create-btn" onClick={toggle} aria-expanded={open} aria-haspopup="menu" data-tip="Create new">
          <Plus size={18} />
          <span className="ps-nav-text" style={{ flex: 'none' }}>Create new</span>
        </button>
      )}
    >
      {(close) => (
        <MenuList
          close={close}
          items={[
            { label: 'New video', sub: 'Blank project — pick an aspect ratio', icon: <Clapperboard size={16} />, onClick: () => openModal('aspect') },
            { label: 'New from recording', sub: 'Producer AI writes, narrates & cuts it', icon: <Sparkles size={16} />, onClick: () => navigate('/producer/new') },
            { label: 'Voiceover', sub: 'Text to speech in Voice Studio', icon: <AudioLines size={16} />, onClick: () => navigate('/voice') },
            { sep: true, label: '' },
            { label: 'Upload media', sub: 'Video, audio or images to your library', icon: <Upload size={16} />, onClick: pick },
          ]}
        />
      )}
    </Popover>
  )
}

// ---------------- search ----------------
function GlobalSearch() {
  const navigate = useNavigate()
  const loc = useLocation()
  const workspaceId = useSession((s) => s.workspaceId)
  const [q, setQ] = useState('')
  const [open, setOpen] = useState(false)
  const [data, setData] = useState<{ ws: string; at: number; projects: ProjectSummary[]; assets: AssetRecord[] }>()
  const [loading, setLoading] = useState(false)
  // -1 = the "search the Library" row (default for Enter)
  const [hi, setHi] = useState(-1)
  const inputRef = useRef<HTMLInputElement>(null)
  const boxRef = useRef<HTMLDivElement>(null)
  useClickOutside(boxRef, () => setOpen(false), open)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        inputRef.current?.focus()
        inputRef.current?.select()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // Keep the box in sync with the Library's ?q=
  useEffect(() => {
    if (loc.pathname === '/library') setQ(new URLSearchParams(loc.search).get('q') ?? '')
  }, [loc.pathname, loc.search])

  const ensureData = useCallback(async () => {
    if (!workspaceId) return
    if (data && data.ws === workspaceId && Date.now() - data.at < 30_000) return
    setLoading(true)
    try {
      const [projects, assets] = await Promise.all([api.projects(workspaceId), api.assets(workspaceId).catch(() => [] as AssetRecord[])])
      setData({ ws: workspaceId, at: Date.now(), projects, assets })
    } catch {
      /* search is best-effort */
    } finally {
      setLoading(false)
    }
  }, [workspaceId, data])

  const term = q.trim().toLowerCase()
  const results = useMemo(() => {
    if (!data || !term) return { projects: [], assets: [] }
    return {
      projects: data.projects.filter((p) => p.name.toLowerCase().includes(term)).slice(0, 5),
      assets: data.assets.filter((a) => a.asset.name.toLowerCase().includes(term)).slice(0, 4),
    }
  }, [data, term])
  const flat: Array<{ go: () => void }> = [
    ...results.projects.map((p) => ({ go: () => navigate(`/edit/${p.id}`) })),
    ...results.assets.map((a) => ({ go: () => navigate(`/library?tab=assets&q=${encodeURIComponent(a.asset.name)}`) })),
  ]
  useEffect(() => setHi(-1), [term])

  function submit(idx = hi) {
    setOpen(false)
    inputRef.current?.blur()
    if (!term) return navigate('/library')
    if (idx < 0 || idx >= flat.length) return navigate(`/library?q=${encodeURIComponent(q.trim())}`)
    flat[idx].go()
  }

  return (
    <div className="ps-search" ref={boxRef}>
      <Search size={16} />
      <input
        ref={inputRef}
        className="input"
        placeholder="Search projects and media"
        value={q}
        aria-label="Search projects and media"
        onFocus={() => {
          setOpen(true)
          void ensureData()
        }}
        onChange={(e) => {
          setQ(e.target.value)
          setOpen(true)
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            submit()
          } else if (e.key === 'ArrowDown') {
            e.preventDefault()
            setHi((h) => (h + 1 >= flat.length ? -1 : h + 1))
          } else if (e.key === 'ArrowUp') {
            e.preventDefault()
            setHi((h) => (h < 0 ? flat.length - 1 : h - 1))
          } else if (e.key === 'Escape') {
            setOpen(false)
            inputRef.current?.blur()
          }
        }}
      />
      {q ? (
        <button className="btn ghost sm icon" style={{ position: 'absolute', right: 6, top: 5 }} onClick={() => setQ('')} aria-label="Clear search">
          <X size={14} />
        </button>
      ) : (
        <span className="kbd">Ctrl K</span>
      )}
      {open && term && (
        <div className="ps-pop ps-search-pop" role="listbox">
          {loading && !data && (
            <div className="row muted" style={{ padding: 10 }}>
              <Spinner /> Searching…
            </div>
          )}
          {results.projects.length > 0 && <div className="ps-menu-label">Projects</div>}
          {results.projects.map((p, i) => (
            <button key={p.id} className="ps-menu-item" style={hi === i ? { background: 'var(--surface-3)' } : undefined} onMouseEnter={() => setHi(i)} onClick={() => submit(i)}>
              {p.kind === 'producer' ? <Sparkles size={15} /> : <Film size={15} />}
              <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.name}</span>
              <span className="muted" style={{ fontSize: 11.5 }}>{relativeTime(p.updatedAt)}</span>
            </button>
          ))}
          {results.assets.length > 0 && <div className="ps-menu-label">Media</div>}
          {results.assets.map((a, j) => {
            const i = results.projects.length + j
            return (
              <button key={a.asset.id} className="ps-menu-item" style={hi === i ? { background: 'var(--surface-3)' } : undefined} onMouseEnter={() => setHi(i)} onClick={() => submit(i)}>
                {a.asset.kind === 'audio' ? <Music size={15} /> : a.asset.kind === 'image' ? <ImageIcon size={15} /> : <Video size={15} />}
                <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.asset.name}</span>
                {a.asset.duration ? <span className="muted" style={{ fontSize: 11.5 }}>{formatDuration(a.asset.duration)}</span> : null}
              </button>
            )
          })}
          {data && !results.projects.length && !results.assets.length && <div className="muted" style={{ padding: '10px 10px 4px', fontSize: 13 }}>No matches for “{q.trim()}”.</div>}
          <div className="ps-menu-sep" />
          <button className="ps-menu-item" style={hi < 0 ? { background: 'var(--surface-3)' } : undefined} onMouseEnter={() => setHi(-1)} onClick={() => submit(-1)}>
            <FolderOpen size={15} />
            <span style={{ flex: 1 }}>Search the Library for “{q.trim()}”</span>
            <span className="kbd">Enter</span>
          </button>
        </div>
      )}
    </div>
  )
}

// ---------------- background jobs ----------------
function useWorkspaceEvents(workspaceId: string | undefined) {
  const reset = useJobs((s) => s.reset)
  const upsert = useJobs((s) => s.upsert)
  useEffect(() => {
    if (!workspaceId) return
    let alive = true
    reset([])
    api
      .jobs({ workspaceId })
      .then((list) => {
        if (!alive) return
        const cutoff = Date.now() - 15 * 60_000
        for (const j of list) if (isActive(j) || j.updatedAt > cutoff) upsert(j)
      })
      .catch(() => undefined)
    let unsub: (() => void) | undefined
    try {
      unsub = subscribeEvents(workspaceId, {
        job: (j) => {
          upsert(j)
          liveBus.emitJob(j)
        },
        asset: (a) => liveBus.emitAsset(a),
        project: (p) => liveBus.emitProject(p),
      })
    } catch {
      /* EventSource unsupported */
    }
    return () => {
      alive = false
      unsub?.()
    }
  }, [workspaceId, reset, upsert])
}

function JobsIndicator() {
  const jobs = useJobs((s) => s.jobs)
  const dismiss = useJobs((s) => s.dismiss)
  const uploads = useUploads((s) => s.items)
  const clearUploads = useUploads((s) => s.clearFinished)
  const list = Object.values(jobs).sort((a, b) => Number(isActive(b)) - Number(isActive(a)) || b.updatedAt - a.updatedAt)
  const active = list.filter(isActive)
  const activeUploads = uploads.filter((u) => u.status === 'uploading')
  const count = active.length + activeUploads.length
  const recent = list.filter((j) => !isActive(j)).slice(0, 6)
  return (
    <Popover
      align="right"
      className="ps-jobs-pop"
      style={{ top: 46 }}
      trigger={({ toggle, open }) => (
        <button className="btn ghost icon ps-jobs-btn" onClick={toggle} aria-expanded={open} aria-label={`Background jobs${count ? ` (${count} running)` : ''}`} title="Background jobs">
          {count ? <Spinner size={17} /> : <Activity size={17} />}
          {count > 0 && <span className="ps-jobs-dot">{count}</span>}
        </button>
      )}
    >
      <div className="row" style={{ padding: '6px 10px 8px' }}>
        <strong style={{ fontFamily: 'var(--font-display)' }}>Background jobs</strong>
        <span className="spacer" />
        <span className="muted" style={{ fontSize: 12 }}>{count ? `${count} running` : 'All quiet'}</span>
      </div>
      <div style={{ maxHeight: 420, overflowY: 'auto' }}>
        {uploads.map((u) => (
          <div key={u.id} className="ps-job">
            <div className="ps-job-title">
              <Upload size={14} style={{ color: 'var(--cyan)' }} />
              <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{u.name}</span>
              <span className="muted" style={{ fontSize: 11.5 }}>{u.status === 'uploading' ? `${Math.round(u.progress * 100)}%` : u.status}</span>
            </div>
            <div className="ps-job-msg">{u.status === 'error' ? u.error : u.status === 'uploading' ? 'Uploading' : u.status === 'processing' ? 'Processing on the server' : 'Ready in your library'}</div>
            {(u.status === 'uploading' || u.status === 'processing') && <Progress value={u.status === 'processing' ? -1 : u.progress} />}
          </div>
        ))}
        {active.map((j) => (
          <div key={j.id} className="ps-job">
            <div className="ps-job-title">
              <Spinner size={14} />
              <span style={{ flex: 1 }}>{JOB_LABELS[j.kind] ?? j.kind}</span>
              <span className="muted" style={{ fontSize: 11.5 }}>{j.progress >= 0 ? `${Math.round(j.progress * 100)}%` : j.status}</span>
              <button className="btn ghost sm" onClick={() => api.cancelJob(j.id).then((r) => useJobs.getState().upsert(r)).catch(() => undefined)}>Cancel</button>
            </div>
            <div className="ps-job-msg">{j.message || (j.status === 'queued' ? 'Waiting in queue' : 'Working…')}</div>
            <Progress value={j.status === 'queued' ? -1 : j.progress} />
          </div>
        ))}
        {!count && !uploads.length && !recent.length && (
          <div className="muted" style={{ padding: '18px 10px', textAlign: 'center', fontSize: 13 }}>
            Transcriptions, voiceovers and renders you start will show up here.
          </div>
        )}
        {recent.length > 0 && <div className="ps-menu-label" style={{ paddingTop: 12 }}>Recently finished</div>}
        {recent.map((j) => (
          <div key={j.id} className="ps-job" style={{ paddingTop: 8, paddingBottom: 8 }}>
            <div className="ps-job-title" style={{ fontWeight: 500 }}>
              {j.status === 'done' ? <Check size={14} style={{ color: 'var(--green)' }} /> : <X size={14} style={{ color: 'var(--danger)' }} />}
              <span style={{ flex: 1 }}>{JOB_LABELS[j.kind] ?? j.kind}</span>
              <span className="muted" style={{ fontSize: 11.5 }}>{j.status === 'done' ? relativeTime(j.updatedAt) : j.status}</span>
              <button className="btn ghost sm icon" aria-label="Dismiss" onClick={() => dismiss(j.id)}><X size={12} /></button>
            </div>
            {j.status === 'error' && j.error && <div className="ps-job-msg" style={{ marginBottom: 0 }}>{j.error}</div>}
          </div>
        ))}
      </div>
      {uploads.some((u) => u.status === 'ready' || u.status === 'error') && (
        <div style={{ padding: '6px 6px 2px', textAlign: 'right' }}>
          <button className="btn ghost sm" onClick={clearUploads}>Clear finished uploads</button>
        </div>
      )}
    </Popover>
  )
}

function AvatarMenu({ openModal }: { openModal: (m: ModalKind) => void }) {
  const user = useSession((s) => s.user)
  const logout = useSession((s) => s.logout)
  const navigate = useNavigate()
  return (
    <Popover
      align="right"
      style={{ width: 260, top: 46 }}
      trigger={({ toggle, open }) => (
        <button className="btn ghost" style={{ padding: 4, height: 40, borderRadius: 999 }} onClick={toggle} aria-expanded={open} aria-label="Account menu">
          <Avatar name={user?.name} color={user?.avatarColor} />
        </button>
      )}
    >
      {(close) => (
        <>
          <div className="row" style={{ padding: '8px 10px 10px', gap: 12 }}>
            <Avatar name={user?.name} color={user?.avatarColor} size={38} />
            <div style={{ minWidth: 0 }}>
              <div style={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{user?.name}</div>
              <div className="muted" style={{ fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{user?.email}</div>
            </div>
          </div>
          <div className="ps-menu-sep" />
          <MenuList
            close={close}
            items={[
              { label: 'Brand kit', icon: <Palette size={15} />, onClick: () => navigate('/brand') },
              { label: 'Space members', icon: <Users size={15} />, onClick: () => navigate('/space') },
              { label: 'Settings', icon: <Settings size={15} />, onClick: () => navigate('/settings') },
              { label: 'Help & shortcuts', icon: <CircleHelp size={15} />, onClick: () => openModal('help') },
              { sep: true, label: '' },
              {
                label: 'Sign out',
                icon: <LogOut size={15} />,
                onClick: async () => {
                  await logout()
                  navigate('/login', { replace: true })
                },
              },
            ]}
          />
        </>
      )}
    </Popover>
  )
}

export function Layout({ children }: { children: ReactNode }) {
  const workspaceId = useSession((s) => s.workspaceId)
  const [modal, setModal] = useState<ModalKind>()
  const [create, creating] = useCreateAndOpen()
  const loc = useLocation()
  const contentRef = useRef<HTMLDivElement>(null)
  useWorkspaceEvents(workspaceId)
  useSyncPolling(workspaceId)
  const loadSystem = useSystem((s) => s.load)
  // the AI chip reflects the current workspace's AI settings (cloud)
  useEffect(() => {
    void loadSystem()
  }, [loadSystem, workspaceId])

  useEffect(() => {
    contentRef.current?.scrollTo({ top: 0 })
  }, [loc.pathname])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement
      if (e.key === '?' && !/INPUT|TEXTAREA|SELECT/.test(t.tagName) && !t.isContentEditable) setModal('help')
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const close = useCallback(() => setModal(undefined), [])

  return (
    <div className="ps-app">
      <nav className="ps-nav" aria-label="Main">
        <div className="ps-nav-head">
          <NavLink to="/" aria-label="Producer Studio home">
            <Logo />
          </NavLink>
          <DesktopBadge />
        </div>
        <div className="ps-nav-scroll">
          <CreateMenu openModal={setModal} />
          <div style={{ marginTop: 14 }}>
            <NavItem to="/" end icon={<Home size={18} />} label="Home" />
          </div>
          <div className="ps-nav-section">
            <span className="eyebrow">Create with AI</span>
            <NavItem to="/producer" icon={<Sparkles size={18} />} label="Producer AI" badge="AI" />
            <NavItem to="/voice" icon={<AudioLines size={18} />} label="Voice Studio" />
            <NavItem to="/editor" icon={<Clapperboard size={18} />} label="Video Editor" />
            <NavItem to="/tools" icon={<LayoutGrid size={18} />} label="All tools" />
          </div>
          <div className="ps-nav-section">
            <span className="eyebrow">Templates &amp; projects</span>
            <NavItem to="/templates" icon={<LayoutTemplate size={18} />} label="Templates" />
            <NavItem to="/library" icon={<FolderOpen size={18} />} label="Library" />
            <NavItem to="/exports" icon={<Send size={18} />} label="Exports & sharing" />
          </div>
          <div className="ps-nav-section">
            <span className="eyebrow">Spaces</span>
            <SpaceSwitcher openModal={setModal} />
            <div style={{ marginTop: 6 }}>
              <NavItem to="/space" icon={<Users size={18} />} label="Members" />
              <button className="ps-nav-link" onClick={() => setModal('invite')} data-tip="Invite members">
                <UserPlus size={18} />
                <span className="ps-nav-text">Invite members</span>
              </button>
              <NavItem to="/brand" icon={<Palette size={18} />} label="Brand kit" />
            </div>
          </div>
        </div>
        <div className="ps-nav-foot">
          <NavItem to="/settings" icon={<Settings size={18} />} label="Settings" />
          <button className="ps-nav-link" onClick={() => setModal('help')} data-tip="Help & shortcuts">
            <CircleHelp size={18} />
            <span className="ps-nav-text">Help &amp; shortcuts</span>
          </button>
        </div>
      </nav>

      <div className="ps-main">
        <header className="ps-topbar">
          <GlobalSearch />
          <span className="spacer" />
          {MOCK_ACTIVE && <span className="ps-mock-badge" title="Dev mock API active (localStorage.psMock)">MOCK API</span>}
          <AiChip />
          <SyncIndicator />
          <button className="btn sm" onClick={() => setModal('aspect')} disabled={creating}>
            <Wand2 size={14} /> New video
          </button>
          <JobsIndicator />
          <button className="btn ghost icon" onClick={() => setModal('help')} aria-label="Help" title="Help & shortcuts (?)">
            <CircleHelp size={17} />
          </button>
          <AvatarMenu openModal={setModal} />
        </header>
        <main className="ps-content" ref={contentRef}>
          {children}
        </main>
      </div>

      {modal === 'aspect' && <AspectPickerModal onClose={close} busy={creating} onPick={(a) => void create({ width: a.width, height: a.height, name: a.name })} />}
      {modal === 'space' && <CreateSpaceModal onClose={close} />}
      {modal === 'invite' && <InviteModal onClose={close} />}
      {modal === 'help' && <HelpModal onClose={close} />}
    </div>
  )
}
