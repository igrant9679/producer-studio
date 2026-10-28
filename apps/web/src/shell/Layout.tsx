import type { AssetRecord, ProjectSummary } from '@producer/core'
import clsx from 'clsx'
import {
  Activity,
  AudioLines,
  Check,
  ChevronsUpDown,
  CircleHelp,
  Eye,
  Menu,
  MonitorDown,
  Clapperboard,
  Film,
  FolderOpen,
  Gauge,
  Home,
  Image as ImageIcon,
  LayoutGrid,
  LayoutTemplate,
  LogOut,
  Music,
  Palette,
  Pencil,
  Plus,
  Search,
  Send,
  Settings,
  Sparkles,
  Trash2,
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
import { toast, toastError } from '../lib/toast'
import { projectPath, useCreateAndOpen } from './actions'
import { MOCK_ACTIVE } from './dev/installMock'
import { AspectPickerModal, CreateSpaceModal, DeleteSpaceModal, HelpModal, InviteModal, ONLY_OWNERS_INVITE, RenameSpaceModal, canInvite, ownSpaceDeletes } from './modals'
import { AiChip, DesktopBadge, SyncIndicator } from './SystemChrome'
import { DictationController } from './voicestudio/Dictation'
import { ThemeSwitcher } from './pages/AppearanceSettings'
import { DESKTOP_DOWNLOAD_URL, useSyncPolling, useSystem } from './system'
import { isActive, liveBus, uploadFiles, uploadsIn, useJobs, useUploads } from './stores'
import { StorageBanner } from './StorageBanner'
import { GlobalSearch } from './palette/CommandPalette'
import { QueueNote } from './components/QueueNote'
import { Avatar, Logo, MenuList, Popover, Progress, SkipLink, Spinner, focusables, spaceColor, useClickOutside, useEditGate, useEscapeLayer, useFilePicker } from './ui'
import { JOB_LABELS, formatDuration, relativeTime } from './util'

type ModalKind = 'aspect' | 'space' | 'invite' | 'help' | 'rename-space' | 'delete-space' | undefined

function NavItem({ to, icon, label, end, badge }: { to: string; icon: ReactNode; label: string; end?: boolean; badge?: string }) {
  return (
    <NavLink to={to} end={end} className={({ isActive: a }) => clsx('ps-nav-link', a && 'active')} data-tip={label} data-tip-side="right" aria-label={label}>
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
        <button className="ps-space-btn" onClick={toggle} aria-expanded={open} aria-haspopup="menu" aria-label={`Switch space (now ${current?.name ?? 'none'})`} data-tip={current?.name ?? 'Space'}>
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
          <div className="ps-menu-label" id="ps-spaces-label">Your spaces</div>
          <div role="menu" aria-labelledby="ps-spaces-label">
          {workspaces.map((w) => (
            <button
              key={w.id}
              className="ps-menu-item"
              role="menuitemradio"
              aria-checked={w.id === workspaceId}
              autoFocus={w.id === workspaceId}
              onClick={() => {
                setWorkspace(w.id)
                close()
              }}
            >
              <span className="ps-space-avatar" style={{ background: spaceColor(w.id), width: 24, height: 24, fontSize: '0.6875rem' }}>{w.name.slice(0, 1).toUpperCase()}</span>
              <span style={{ flex: 1, minWidth: 0 }}>
                <span style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{w.name}</span>
                <span className="ps-menu-sub">{w.personal ? 'Personal' : `${w.memberCount} member${w.memberCount === 1 ? '' : 's'}`} · {w.role}</span>
              </span>
              {w.id === workspaceId && <Check size={15} style={{ color: 'var(--cyan)' }} />}
            </button>
          ))}
          </div>
          <div className="ps-menu-sep" />
          <MenuList
            close={close}
            label="Space"
            items={[
              ...(current && !current.personal ? [{ label: 'Invite members', icon: <UserPlus size={15} />, disabled: !canInvite(current), tip: ONLY_OWNERS_INVITE, onClick: () => openModal('invite') }] : []),
              { label: 'Manage members', icon: <Users size={15} />, onClick: () => navigate('/space') },
              ...(current?.role === 'owner' ? [{ label: 'Rename space', icon: <Pencil size={15} />, onClick: () => openModal('rename-space') }] : []),
              { label: 'Create space', icon: <Plus size={15} />, onClick: () => openModal('space') },
              ...(current?.role === 'owner' && !current.personal ? [{ label: 'Delete space…', icon: <Trash2 size={15} />, danger: true, onClick: () => openModal('delete-space') }] : []),
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
  const gate = useEditGate()
  const pick = useFilePicker('video/*,audio/*,image/*', true, (files) => {
    if (!workspaceId) return
    void uploadFiles(workspaceId, files)
    navigate('/library?tab=assets')
  })
  return (
    <Popover
      style={{ width: 290 }}
      trigger={({ toggle, open }) => (
        <button className="btn primary ps-create-btn" onClick={toggle} aria-expanded={open} aria-haspopup="menu" disabled={!gate.canEdit} data-tip={gate.tip ?? 'Create new'} data-tip-side="right" aria-label="Create new">
          <Plus size={18} />
          <span className="ps-nav-text" style={{ flex: 'none' }}>Create new</span>
        </button>
      )}
    >
      {(close) => (
        <MenuList
          close={close}
          label="Create new"
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

// ---------------- background jobs ----------------
function useWorkspaceEvents(workspaceId: string | undefined) {
  const reset = useJobs((s) => s.reset)
  const upsert = useJobs((s) => s.upsert)
  useEffect(() => {
    if (!workspaceId) return
    let alive = true
    reset([])
    const loadJobs = () =>
      api
        .jobs({ workspaceId })
        .then((list) => {
          if (!alive) return
          const cutoff = Date.now() - 15 * 60_000
          for (const j of list) if (isActive(j) || j.updatedAt > cutoff) upsert(j)
        })
        .catch(() => undefined)
    void loadJobs()
    let unsub: (() => void) | undefined
    try {
      unsub = subscribeEvents(workspaceId, {
        // back after missing events that can't be replayed: the jobs list and every page listening reload
        resync: () => {
          void loadJobs()
          liveBus.emitResync()
        },
        job: (j) => {
          upsert(j)
          liveBus.emitJob(j)
        },
        asset: (a) => liveBus.emitAsset(a),
        project: (p) => liveBus.emitProject(p),
        // renamed or deleted by another owner / tab / device
        workspace: (w) => {
          const { workspaces, refreshWorkspaces } = useSession.getState()
          const name = workspaces.find((x) => x.id === w.id)?.name
          void refreshWorkspaces()
            .then(() => {
              if (w.deleted && name && !ownSpaceDeletes.has(w.id)) toast(`“${name}” was deleted. Switched to another space.`)
            })
            .catch(() => undefined)
        },
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
  const workspaceId = useSession((s) => s.workspaceId)
  const allUploads = useUploads((s) => s.items)
  const uploads = useMemo(() => uploadsIn(allUploads, workspaceId), [allUploads, workspaceId])
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
        <span className="muted" style={{ fontSize: '0.75rem' }}>{count ? `${count} running` : 'All quiet'}</span>
      </div>
      <div style={{ maxHeight: 420, overflowY: 'auto' }}>
        {uploads.map((u) => (
          <div key={u.id} className="ps-job">
            <div className="ps-job-title">
              <Upload size={14} style={{ color: 'var(--cyan)' }} />
              <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{u.name}</span>
              <span className="muted" style={{ fontSize: '0.7188rem' }}>{u.status === 'uploading' ? `${Math.round(u.progress * 100)}%` : u.status}</span>
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
              <span className="muted" style={{ fontSize: '0.7188rem' }}>{j.progress >= 0 ? `${Math.round(j.progress * 100)}%` : j.status}</span>
              <button className="btn ghost sm" onClick={() => api.cancelJob(j.id).then((r) => useJobs.getState().upsert(r)).catch((e) => toastError(e, `Couldn’t cancel ${(JOB_LABELS[j.kind] ?? j.kind).toLowerCase()}`))} aria-label={`Cancel ${JOB_LABELS[j.kind] ?? j.kind}`}>Cancel</button>
            </div>
            <div className="ps-job-msg">{j.message || (j.status === 'queued' ? 'Waiting in queue' : 'Working…')}</div>
            {j.status === 'queued' && <QueueNote job={j} />}
            <Progress value={j.status === 'queued' ? -1 : j.progress} />
          </div>
        ))}
        {!count && !uploads.length && !recent.length && (
          <div className="muted" style={{ padding: '18px 10px', textAlign: 'center', fontSize: '0.8125rem' }}>
            Transcriptions, voiceovers and renders you start will show up here.
          </div>
        )}
        {recent.length > 0 && <div className="ps-menu-label" style={{ paddingTop: 12 }}>Recently finished</div>}
        {recent.map((j) => (
          <div key={j.id} className="ps-job" style={{ paddingTop: 8, paddingBottom: 8 }}>
            <div className="ps-job-title" style={{ fontWeight: 500 }}>
              {j.status === 'done' ? <Check size={14} style={{ color: 'var(--green)' }} /> : <X size={14} style={{ color: 'var(--danger)' }} />}
              <span style={{ flex: 1 }}>{JOB_LABELS[j.kind] ?? j.kind}</span>
              <span className="muted" style={{ fontSize: '0.7188rem' }}>{j.status === 'done' ? relativeTime(j.updatedAt) : j.status}</span>
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
      <div style={{ padding: '6px 6px 2px', textAlign: 'right' }}>
        <NavLink className="btn ghost sm" to="/jobs">Job history</NavLink>
      </div>
    </Popover>
  )
}

function AvatarMenu({ openModal }: { openModal: (m: ModalKind) => void }) {
  const user = useSession((s) => s.user)
  const logout = useSession((s) => s.logout)
  const navigate = useNavigate()
  const desktop = useSystem((s) => s.info?.mode === 'desktop')
  const gate = useEditGate()
  return (
    <Popover
      align="right"
      style={{ width: 260, top: 46 }}
      trigger={({ toggle, open }) => (
        <button className="btn ghost" style={{ padding: 4, height: 40, borderRadius: 999 }} onClick={toggle} aria-expanded={open} aria-haspopup="menu" aria-label="Account menu">
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
              <div className="muted" style={{ fontSize: '0.75rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{user?.email}</div>
            </div>
          </div>
          <div className="ps-menu-sep" />
          <div className="row ps-menu-theme">
            <span className="ps-menu-theme-label">Theme</span>
            <span className="spacer" />
            <ThemeSwitcher />
          </div>
          <div className="ps-menu-sep" />
          <MenuList
            close={close}
            label="Account"
            items={[
              // on a phone these live here instead of the top bar
              { label: 'New video', icon: <Wand2 size={15} />, className: 'ps-narrow-only', disabled: !gate.canEdit, tip: gate.tip, onClick: () => openModal('aspect') },
              { label: 'Brand kit', icon: <Palette size={15} />, onClick: () => navigate('/brand') },
              { label: 'Space members', icon: <Users size={15} />, onClick: () => navigate('/space') },
              { label: 'Settings', icon: <Settings size={15} />, onClick: () => navigate('/settings') },
              { label: 'Help & shortcuts', icon: <CircleHelp size={15} />, onClick: () => openModal('help') },
              ...(desktop ? [] : [{ label: 'Get the Windows app', icon: <MonitorDown size={15} />, onClick: () => window.open(DESKTOP_DOWNLOAD_URL, '_blank', 'noopener') }]),
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
  const currentWs = useSession((s) => s.workspaces.find((w) => w.id === s.workspaceId))
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

  const gate = useEditGate()
  // below 1000 px the sidebar is a drawer behind the menu button
  const [navOpen, setNavOpen] = useState(false)
  const navRef = useRef<HTMLElement>(null)
  const menuBtnRef = useRef<HTMLButtonElement>(null)
  const closeNav = useCallback(() => {
    setNavOpen(false)
    menuBtnRef.current?.focus()
  }, [])
  useEscapeLayer(closeNav, navOpen, navRef)
  useEffect(() => {
    if (navOpen) focusables(navRef.current)[0]?.focus()
  }, [navOpen])

  useEffect(() => {
    contentRef.current?.scrollTo?.({ top: 0 })
    setNavOpen(false)
  }, [loc.pathname])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement
      // not over another dialog, and not while typing
      if (e.key !== '?' || e.ctrlKey || e.metaKey || e.altKey || /INPUT|TEXTAREA|SELECT/.test(t.tagName) || t.isContentEditable) return
      if (document.querySelector('[aria-modal="true"]')) return
      setModal('help')
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const close = useCallback(() => setModal(undefined), [])
  const inviteTip = currentWs && !canInvite(currentWs) ? ONLY_OWNERS_INVITE : 'Invite members'

  return (
    <div className="ps-app">
      <SkipLink target="#ps-main-content" />
      {navOpen &&<div className="ps-nav-scrim" onClick={closeNav} aria-hidden />}
      <nav className={clsx('ps-nav', navOpen && 'open')} id="ps-nav" aria-label="Main" ref={navRef}>
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
              <NavItem to="/activity" icon={<Activity size={18} />} label="Activity" />
              <NavItem to="/usage" icon={<Gauge size={18} />} label="Usage" />
              {!currentWs?.personal && (
                <button className="ps-nav-link" onClick={() => setModal('invite')} disabled={!canInvite(currentWs)} data-tip={inviteTip} data-tip-side="right" aria-label="Invite members">
                  <UserPlus size={18} />
                  <span className="ps-nav-text">Invite members</span>
                </button>
              )}
              <NavItem to="/brand" icon={<Palette size={18} />} label="Brand kit" />
            </div>
          </div>
        </div>
        <div className="ps-nav-foot">
          <NavItem to="/settings" icon={<Settings size={18} />} label="Settings" />
          <button className="ps-nav-link" onClick={() => setModal('help')} data-tip="Help & shortcuts" data-tip-side="right" aria-label="Help & shortcuts">
            <CircleHelp size={18} />
            <span className="ps-nav-text">Help &amp; shortcuts</span>
          </button>
        </div>
      </nav>

      <div className="ps-main">
        <header className="ps-topbar">
          <button ref={menuBtnRef} className="btn ghost icon ps-menu-btn" onClick={() => (navOpen ? closeNav() : setNavOpen(true))} aria-expanded={navOpen} aria-controls="ps-nav" aria-label="Menu">
            <Menu size={18} />
          </button>
          <GlobalSearch onNewVideo={() => setModal('aspect')} />
          <span className="spacer" />
          {MOCK_ACTIVE && <span className="ps-mock-badge" title="Dev mock API active (localStorage.psMock)">MOCK API</span>}
          <AiChip />
          <SyncIndicator />
          <button className="btn sm ps-topbar-extra" onClick={() => setModal('aspect')} disabled={creating || !gate.canEdit} data-tip={gate.tip}>
            <Wand2 size={14} /> New video
          </button>
          <JobsIndicator />
          <button className="btn ghost icon ps-topbar-extra" onClick={() => setModal('help')} aria-label="Help" data-tip="Help & shortcuts" data-tip-kbd="?">
            <CircleHelp size={17} />
          </button>
          <AvatarMenu openModal={setModal} />
        </header>
        <main className="ps-content" ref={contentRef} id="ps-main-content" tabIndex={-1}>
          <StorageBanner />
          {!gate.canEdit && (
            <div className="ps-viewer-note" role="note">
              <Eye size={15} style={{ flex: 'none' }} />
              <span>You’re a viewer in “{currentWs?.name}”: you can open, play and download, but only its owners and editors can create or change things.</span>
            </div>
          )}
          {children}
        </main>
      </div>

      <DictationController />
      {modal === 'aspect' && <AspectPickerModal onClose={close} busy={creating} onPick={(a) => void create({ width: a.width, height: a.height, name: a.name })} />}
      {modal === 'space' && <CreateSpaceModal onClose={close} />}
      {modal === 'rename-space' && currentWs && <RenameSpaceModal ws={currentWs} onClose={close} />}
      {modal === 'delete-space' && currentWs && <DeleteSpaceModal ws={currentWs} onClose={close} />}
      {modal === 'invite' && <InviteModal onClose={close} />}
      {modal === 'help' && <HelpModal onClose={close} />}
    </div>
  )
}
