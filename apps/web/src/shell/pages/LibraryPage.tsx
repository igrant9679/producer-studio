import type { AssetRecord, ProjectSummary } from '@producer/core'
import clsx from 'clsx'
import {
  ArchiveRestore,
  AudioLines,
  Check,
  CheckSquare,
  Copy,
  Download,
  Eye,
  FolderOpen,
  Image as ImageIcon,
  LayoutGrid,
  LayoutTemplate,
  Link2,
  List,
  MoreHorizontal,
  Pencil,
  Search,
  Sparkles,
  Trash2,
  Upload,
  Video,
  X,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { api, mediaUrl } from '../../lib/api'
import { useSession } from '../../lib/session'
import { toast, toastError } from '../../lib/toast'
import { InlineRename, KindPill, ProjectCard, ProjectThumb } from '../components/ProjectCard'
import { liveBus, uploadFiles, useUploads } from '../stores'
import { SyncBadge } from '../SystemChrome'
import { projectSyncBadge, useIsDesktop, useSystem } from '../system'
import { CardSkeletons, EmptyState, MenuList, Modal, Popover, Progress, Spinner, Thumb, useAsync, useFilePicker, type MenuItemDef, usePageTitle } from '../ui'
import { absoluteUrl, aspectLabel, copyText, formatBytes, formatDuration, relativeTime } from '../util'
import { filterAssets, filterProjects, mergeProjects, ORIGIN_LABEL, PROJECT_FILTERS, SORTS, toggleInSet, type AssetFilter, type ProjectFilter, type SortKey } from './libraryLogic'

type Tab = 'projects' | 'assets' | 'trash'

function readView(): 'grid' | 'list' {
  try {
    return localStorage.getItem('ps.libraryView') === 'list' ? 'list' : 'grid'
  } catch {
    return 'grid'
  }
}

function ConfirmModal({ title, body, confirm, onConfirm, onClose, busy }: { title: string; body: string; confirm: string; onConfirm: () => void; onClose: () => void; busy?: boolean }) {
  return (
    <Modal
      title={title}
      subtitle={body}
      onClose={onClose}
      width={460}
      footer={
        <>
          <button className="btn ghost" onClick={onClose}>Cancel</button>
          <button className="btn danger" onClick={onConfirm} disabled={busy} autoFocus>
            {busy && <Spinner />} {confirm}
          </button>
        </>
      }
    >
      <span />
    </Modal>
  )
}

// ---------------- projects / trash ----------------
function ProjectsTab({ trash, q }: { trash: boolean; q: string }) {
  const navigate = useNavigate()
  const workspaceId = useSession((s) => s.workspaceId)
  const [filter, setFilter] = useState<ProjectFilter>('all')
  const [sort, setSort] = useState<SortKey>('updated')
  const [view, setViewState] = useState(readView)
  const [sel, setSel] = useState<Set<string>>(new Set())
  const [renaming, setRenaming] = useState<string>()
  const [confirm, setConfirm] = useState<{ ids: string[] }>()
  const [busy, setBusy] = useState(false)
  const desktop = useIsDesktop()
  const sync = useSystem((s) => s.sync)
  const { data, loading, error, reload, setData } = useAsync(async () => {
    if (!workspaceId) return []
    if (trash) return api.projects(workspaceId, { trashed: true })
    const [all, tpl] = await Promise.all([api.projects(workspaceId), api.projects(workspaceId, { templates: true }).catch(() => [] as ProjectSummary[])])
    return mergeProjects(all, tpl)
  }, [workspaceId, trash])

  useEffect(() => setSel(new Set()), [workspaceId, trash])
  useEffect(() => liveBus.onProject(() => reload()), [reload])

  const setView = (v: 'grid' | 'list') => {
    setViewState(v)
    try {
      localStorage.setItem('ps.libraryView', v)
    } catch {
      /* ignore */
    }
  }
  const list = useMemo(() => filterProjects(data ?? [], { filter: trash ? 'all' : filter, q, sort, trashed: trash }), [data, filter, q, sort, trash])
  const selecting = sel.size > 0
  const patchLocal = (id: string, p: Partial<ProjectSummary> | null) => setData((cur) => (cur ?? []).flatMap((x) => (x.id === id ? (p ? [{ ...x, ...p }] : []) : [x])))

  const act = useCallback(
    async (fn: () => Promise<unknown>, ok?: string) => {
      try {
        await fn()
        if (ok) toast(ok)
      } catch (e) {
        toastError(e)
        reload()
      }
    },
    [reload],
  )

  const trashIds = (ids: string[]) =>
    act(async () => {
      ids.forEach((id) => patchLocal(id, null))
      setSel(new Set())
      await Promise.all(ids.map((id) => api.patchProject(id, { trashed: true })))
    }, ids.length > 1 ? `${ids.length} projects moved to trash` : 'Moved to trash')
  const restoreIds = (ids: string[]) =>
    act(async () => {
      ids.forEach((id) => patchLocal(id, null))
      setSel(new Set())
      await Promise.all(ids.map((id) => api.patchProject(id, { trashed: false })))
    }, ids.length > 1 ? `${ids.length} projects restored` : 'Restored')
  async function deleteForever(ids: string[]) {
    setBusy(true)
    try {
      await Promise.all(ids.map((id) => api.deleteProject(id)))
      ids.forEach((id) => patchLocal(id, null))
      setSel(new Set())
      toast(ids.length > 1 ? `${ids.length} projects deleted` : 'Project deleted')
    } catch (e) {
      toastError(e)
      reload()
    } finally {
      setBusy(false)
      setConfirm(undefined)
    }
  }

  function menuFor(p: ProjectSummary): MenuItemDef[] {
    if (trash)
      return [
        { label: 'Restore', icon: <ArchiveRestore size={15} />, onClick: () => void restoreIds([p.id]) },
        { sep: true, label: '' },
        { label: 'Delete forever', icon: <Trash2 size={15} />, danger: true, onClick: () => setConfirm({ ids: [p.id] }) },
      ]
    return [
      { label: 'Open in editor', icon: <FolderOpen size={15} />, onClick: () => navigate(`/edit/${p.id}`) },
      ...(p.kind === 'producer' ? [{ label: 'Resume in Producer AI', icon: <Sparkles size={15} />, onClick: () => navigate(`/producer/${p.id}`) }] : []),
      { label: 'Rename', icon: <Pencil size={15} />, onClick: () => setRenaming(p.id) },
      {
        label: 'Duplicate',
        icon: <Copy size={15} />,
        onClick: () =>
          void act(async () => {
            const c = await api.duplicateProject(p.id)
            setData((cur) => [c, ...(cur ?? [])])
          }, 'Duplicated'),
      },
      {
        label: 'Copy share link',
        icon: <Link2 size={15} />,
        onClick: () =>
          void act(async () => {
            const r = await api.share(p.id)
            const ok = await copyText(absoluteUrl(r.url))
            toast(ok ? 'Share link copied' : absoluteUrl(r.url))
          }),
      },
      {
        label: p.isTemplate ? 'Remove from templates' : 'Save as template',
        icon: <LayoutTemplate size={15} />,
        onClick: () =>
          void act(async () => {
            patchLocal(p.id, { isTemplate: !p.isTemplate })
            await api.patchProject(p.id, { isTemplate: !p.isTemplate })
          }, p.isTemplate ? 'Removed from templates' : 'Saved as a team template'),
      },
      { label: 'Select', icon: <CheckSquare size={15} />, onClick: () => setSel((s) => toggleInSet(s, p.id)) },
      { sep: true, label: '' },
      { label: 'Move to trash', icon: <Trash2 size={15} />, danger: true, onClick: () => void trashIds([p.id]) },
    ]
  }

  const rename = (p: ProjectSummary) => (name: string) => {
    setRenaming(undefined)
    patchLocal(p.id, { name })
    void act(() => api.patchProject(p.id, { name }))
  }
  const open = (p: ProjectSummary) => (trash ? undefined : navigate(`/edit/${p.id}`))
  const allSelected = list.length > 0 && list.every((p) => sel.has(p.id))

  return (
    <>
      <div className="ps-lib-toolbar">
        {!trash && (
          <div className="row" style={{ gap: 6 }} role="tablist" aria-label="Project type">
            {PROJECT_FILTERS.map((f) => (
              <button key={f.id} role="tab" aria-selected={filter === f.id} className={clsx('chip', filter === f.id && 'active')} onClick={() => setFilter(f.id)}>{f.label}</button>
            ))}
          </div>
        )}
        {trash && <span className="muted" style={{ fontSize: '0.8125rem' }}>Projects in trash can be restored or deleted permanently.</span>}
        <span className="spacer" />
        <select className="input" style={{ width: 160, height: 32 }} value={sort} onChange={(e) => setSort(e.target.value as SortKey)} aria-label="Sort">
          {SORTS.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
        </select>
        <div className="ps-seg" aria-label="View">
          <button className={view === 'grid' ? 'on' : ''} onClick={() => setView('grid')} aria-label="Grid view" aria-pressed={view === 'grid'}><LayoutGrid size={14} /></button>
          <button className={view === 'list' ? 'on' : ''} onClick={() => setView('list')} aria-label="List view" aria-pressed={view === 'list'}><List size={14} /></button>
        </div>
      </div>

      {selecting && (
        <div className="ps-bulk" role="region" aria-label="Selection">
          <button className="btn ghost sm icon" onClick={() => setSel(new Set())} aria-label="Clear selection"><X size={14} /></button>
          <strong>{sel.size} selected</strong>
          <button className="btn ghost sm" onClick={() => setSel(allSelected ? new Set() : new Set(list.map((p) => p.id)))}>{allSelected ? 'Deselect all' : 'Select all'}</button>
          <span className="spacer" />
          {trash ? (
            <>
              <button className="btn sm" onClick={() => void restoreIds([...sel])}><ArchiveRestore size={14} /> Restore</button>
              <button className="btn sm" style={{ borderColor: 'var(--danger)', color: 'var(--danger)' }} onClick={() => setConfirm({ ids: [...sel] })}><Trash2 size={14} /> Delete forever</button>
            </>
          ) : (
            <button className="btn sm" onClick={() => void trashIds([...sel])}><Trash2 size={14} /> Move to trash</button>
          )}
        </div>
      )}

      {error ? (
        <div className="ps-alert">Couldn’t load projects. <button className="btn sm" onClick={reload}>Retry</button></div>
      ) : loading && !data ? (
        <div className="ps-grid"><CardSkeletons n={8} /></div>
      ) : !list.length ? (
        trash ? (
          <EmptyState icon={<Trash2 size={24} />} title="Trash is empty" body="Projects you move to trash land here so you can restore them." />
        ) : q || filter !== 'all' ? (
          <EmptyState icon={<Search size={24} />} title="Nothing matches" body={q ? `No projects match “${q}”.` : 'No projects of this type yet.'} action={<button className="btn" onClick={() => { setFilter('all'); navigate('/library') }}>Clear filters</button>} />
        ) : (
          <EmptyState icon={<FolderOpen size={24} />} title="No projects yet" body="Start a blank edit or let Producer AI build a first cut from a recording." action={<div className="row"><button className="btn primary" onClick={() => navigate('/producer/new')}><Sparkles size={15} /> New from recording</button><button className="btn" onClick={() => navigate('/editor')}>Blank project</button></div>} />
        )
      ) : view === 'grid' ? (
        <div className={clsx('ps-grid', selecting && 'selecting')}>
          {list.map((p) => (
            <ProjectCard
              key={p.id}
              p={p}
              onOpen={() => open(p)}
              menu={menuFor(p)}
              selectable
              selecting={selecting}
              selected={sel.has(p.id)}
              onToggleSelect={() => setSel((s) => toggleInSet(s, p.id))}
              renaming={renaming === p.id}
              onRename={rename(p)}
              onRenameCancel={() => setRenaming(undefined)}
              sub={trash ? `Trashed · edited ${relativeTime(p.updatedAt)}` : undefined}
              overlay={desktop && !trash ? <SyncBadge state={projectSyncBadge(p.id, sync)} /> : undefined}
            />
          ))}
        </div>
      ) : (
        <div className="ps-table-wrap">
          <table className="ps-table">
            <thead>
              <tr>
                <th style={{ width: 40 }}>
                  <button className={clsx('ps-check-sm', allSelected && 'on')} onClick={() => setSel(allSelected ? new Set() : new Set(list.map((p) => p.id)))} aria-label="Select all">{allSelected && <Check size={12} strokeWidth={3} />}</button>
                </th>
                <th>Name</th>
                <th>Type</th>
                <th>Aspect</th>
                <th>Duration</th>
                <th>{trash ? 'Trashed' : 'Edited'}</th>
                <th style={{ width: 48 }} />
              </tr>
            </thead>
            <tbody>
              {list.map((p) => (
                <tr key={p.id} className={clsx(sel.has(p.id) && 'on')} onClick={() => (selecting ? setSel((s) => toggleInSet(s, p.id)) : open(p))}>
                  <td onClick={(e) => e.stopPropagation()}>
                    <button className={clsx('ps-check-sm', sel.has(p.id) && 'on')} onClick={() => setSel((s) => toggleInSet(s, p.id))} aria-label={`Select ${p.name}`}>{sel.has(p.id) && <Check size={12} strokeWidth={3} />}</button>
                  </td>
                  <td>
                    <div className="row" style={{ gap: 12 }}>
                      <div style={{ width: 72, flex: 'none' }}><ProjectThumb p={{ ...p, duration: 0 }} /></div>
                      {renaming === p.id ? <InlineRename value={p.name} onSave={rename(p)} onCancel={() => setRenaming(undefined)} /> : <strong className="ps-cell-name">{p.name}</strong>}
                    </div>
                  </td>
                  <td><KindPill p={p} />{!p.isTemplate && p.kind === 'edit' && <span className="muted">Edit</span>}</td>
                  <td className="muted">{aspectLabel(p.width, p.height)}</td>
                  <td className="muted mono">{formatDuration(p.duration)}</td>
                  <td className="muted">{relativeTime(p.updatedAt)}</td>
                  <td onClick={(e) => e.stopPropagation()}>
                    <Popover align="right" style={{ width: 210 }} trigger={({ toggle, open: o }) => <button className="btn ghost sm icon" onClick={toggle} aria-expanded={o} aria-label={`More actions for ${p.name}`}><MoreHorizontal size={15} /></button>}>
                      {(close) => <MenuList items={menuFor(p)} close={close} />}
                    </Popover>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {confirm && (
        <ConfirmModal
          title={confirm.ids.length > 1 ? `Delete ${confirm.ids.length} projects forever?` : 'Delete this project forever?'}
          body="This permanently removes the project and its edit history. Media in your library is kept. This can’t be undone."
          confirm="Delete forever"
          busy={busy}
          onConfirm={() => void deleteForever(confirm.ids)}
          onClose={() => setConfirm(undefined)}
        />
      )}
    </>
  )
}

// ---------------- assets ----------------
function AssetPreview({ a, onClose }: { a: AssetRecord; onClose: () => void }) {
  const k = a.asset.kind
  return (
    <Modal title={a.asset.name} subtitle={`${ORIGIN_LABEL[a.origin] ?? a.origin} · ${formatBytes(a.asset.sizeBytes)}${a.asset.duration ? ` · ${formatDuration(a.asset.duration)}` : ''}${a.asset.width ? ` · ${a.asset.width}×${a.asset.height}` : ''}`} onClose={onClose} width={900}>
      <div className="ps-preview">
        {k === 'video' && <video src={mediaUrl(a.asset.id, 'proxy')} poster={mediaUrl(a.asset.id, 'thumb')} controls autoPlay playsInline onError={(e) => { const v = e.currentTarget; if (!v.dataset.fallback) { v.dataset.fallback = '1'; v.src = mediaUrl(a.asset.id, 'source') } }} />}
        {k === 'audio' && (
          <div className="ps-preview-audio">
            <AudioLines size={46} />
            <audio src={mediaUrl(a.asset.id, 'source')} controls autoPlay style={{ width: '100%' }} />
          </div>
        )}
        {k === 'image' && <img src={mediaUrl(a.asset.id, 'source')} alt={a.asset.name} />}
      </div>
      <div className="row" style={{ justifyContent: 'flex-end', marginTop: 14 }}>
        <a className="btn" href={mediaUrl(a.asset.id, 'source')} download={a.asset.name}><Download size={14} /> Download original</a>
      </div>
    </Modal>
  )
}

function AssetsTab({ q }: { q: string }) {
  const workspaceId = useSession((s) => s.workspaceId)
  const [filter, setFilter] = useState<AssetFilter>('all')
  const [sort, setSort] = useState<SortKey>('updated')
  const [drag, setDrag] = useState(false)
  const [preview, setPreview] = useState<AssetRecord>()
  const [renaming, setRenaming] = useState<string>()
  const [confirm, setConfirm] = useState<AssetRecord>()
  const [busy, setBusy] = useState(false)
  const uploads = useUploads((s) => s.items)
  const { data, loading, error, reload, setData } = useAsync(() => (workspaceId ? api.assets(workspaceId) : Promise.resolve([])), [workspaceId])
  const upsert = useCallback(
    (a: AssetRecord) => {
      if (a.workspaceId !== workspaceId) return
      setData((cur) => {
        const l = cur ?? []
        return l.some((x) => x.asset.id === a.asset.id) ? l.map((x) => (x.asset.id === a.asset.id ? a : x)) : [a, ...l]
      })
    },
    [workspaceId, setData],
  )
  useEffect(() => liveBus.onAsset(upsert), [upsert])
  const upload = (files: File[]) => workspaceId && files.length && void uploadFiles(workspaceId, files)
  const pick = useFilePicker('video/*,audio/*,image/*', true, upload)
  const list = useMemo(() => filterAssets(data ?? [], { filter, q, sort }), [data, filter, q, sort])
  const pending = uploads.filter((u) => u.status === 'uploading')

  async function remove(a: AssetRecord) {
    setBusy(true)
    try {
      await api.deleteAsset(a.asset.id)
      setData((cur) => (cur ?? []).filter((x) => x.asset.id !== a.asset.id))
      toast('Deleted')
    } catch (e) {
      toastError(e)
    } finally {
      setBusy(false)
      setConfirm(undefined)
    }
  }

  const filters: Array<{ id: AssetFilter; label: string; icon: React.ReactNode }> = [
    { id: 'all', label: 'All', icon: null },
    { id: 'video', label: 'Video', icon: <Video size={13} /> },
    { id: 'audio', label: 'Audio', icon: <AudioLines size={13} /> },
    { id: 'image', label: 'Images', icon: <ImageIcon size={13} /> },
    { id: 'generated', label: 'Generated', icon: <Sparkles size={13} /> },
  ]

  return (
    <div
      className={clsx('ps-assets', drag && 'dragging')}
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes('Files')) return
        e.preventDefault()
        setDrag(true)
      }}
      onDragLeave={(e) => {
        if (e.currentTarget.contains(e.relatedTarget as Node)) return
        setDrag(false)
      }}
      onDrop={(e) => {
        e.preventDefault()
        setDrag(false)
        upload(Array.from(e.dataTransfer.files).filter((f) => /^(video|audio|image)\//.test(f.type)))
      }}
    >
      <div className="ps-lib-toolbar">
        <div className="row" style={{ gap: 6 }}>
          {filters.map((f) => (
            <button key={f.id} className={clsx('chip', filter === f.id && 'active')} onClick={() => setFilter(f.id)}>{f.icon}{f.label}</button>
          ))}
        </div>
        <span className="spacer" />
        <select className="input" style={{ width: 160, height: 32 }} value={sort} onChange={(e) => setSort(e.target.value as SortKey)} aria-label="Sort media">
          <option value="updated">Newest first</option>
          <option value="name">Name A–Z</option>
          <option value="duration">Longest first</option>
        </select>
        <button className="btn primary sm" onClick={pick}><Upload size={14} /> Upload</button>
      </div>

      {drag && (
        <div className="ps-drop-overlay">
          <Upload size={30} />
          <strong>Drop to upload to this space</strong>
        </div>
      )}

      {error ? (
        <div className="ps-alert">Couldn’t load media. <button className="btn sm" onClick={reload}>Retry</button></div>
      ) : loading && !data ? (
        <div className="ps-grid"><CardSkeletons n={8} /></div>
      ) : !list.length && !pending.length ? (
        q || filter !== 'all' ? (
          <EmptyState icon={<Search size={24} />} title="No media matches" body="Try another type or search term." />
        ) : (
          <EmptyState icon={<Upload size={24} />} title="Drop files anywhere here" body="Upload recordings, music, voiceovers and images. Everything in this space’s library is available in the editor and to Producer AI." action={<button className="btn primary" onClick={pick}><Upload size={15} /> Upload media</button>} />
        )
      ) : (
        <div className="ps-grid">
          {pending.map((u) => (
            <div key={u.id} className="ps-acard">
              <div className="ps-thumb" style={{ display: 'grid', placeItems: 'center' }}>
                <div style={{ width: '70%' }}>
                  <div className="muted" style={{ fontSize: '0.75rem', marginBottom: 8, textAlign: 'center' }}>Uploading {Math.round(u.progress * 100)}%</div>
                  <Progress value={u.progress} />
                </div>
              </div>
              <div className="ps-pcard-meta"><div><div className="ps-pcard-name">{u.name}</div><div className="ps-pcard-sub">{formatBytes(u.size)}</div></div></div>
            </div>
          ))}
          {list.map((a) => (
            <div key={a.asset.id} className="ps-pcard" onClick={() => a.status === 'ready' && setPreview(a)} role="button" tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && a.status === 'ready' && setPreview(a)} aria-label={`Preview ${a.asset.name}`}>
              <Thumb src={a.asset.kind !== 'audio' && a.status === 'ready' ? mediaUrl(a.asset.id, 'thumb') : undefined} seed={a.asset.id} icon={a.asset.kind === 'audio' ? <AudioLines size={28} /> : a.asset.kind === 'image' ? <ImageIcon size={24} /> : <Video size={24} />}>
                {a.status !== 'ready' && (
                  <div className="ps-asset-status">
                    {a.status === 'error' ? <span style={{ color: 'var(--danger)' }}>Processing failed</span> : <><Spinner size={14} /> Processing…</>}
                  </div>
                )}
                {a.asset.duration ? <span className="ps-thumb-badge">{formatDuration(a.asset.duration)}</span> : null}
                <span className="ps-thumb-badge left">{ORIGIN_LABEL[a.origin] ?? a.origin}</span>
              </Thumb>
              <div className="ps-pcard-meta">
                <div>
                  {renaming === a.asset.id ? (
                    <InlineRename
                      value={a.asset.name}
                      onCancel={() => setRenaming(undefined)}
                      onSave={async (name) => {
                        setRenaming(undefined)
                        upsert({ ...a, asset: { ...a.asset, name } })
                        try {
                          upsert(await api.renameAsset(a.asset.id, name))
                        } catch (e) {
                          upsert(a)
                          toastError(e)
                        }
                      }}
                    />
                  ) : (
                    <div className="ps-pcard-name" title={a.asset.name}>{a.asset.name}</div>
                  )}
                  <div className="ps-pcard-sub">{a.asset.kind} · {formatBytes(a.asset.sizeBytes)} · {relativeTime(a.createdAt)}</div>
                </div>
                <Popover align="right" style={{ width: 190 }} trigger={({ toggle, open }) => <button className="btn ghost sm icon ps-pcard-menu" onClick={toggle} aria-expanded={open} aria-label={`More actions for ${a.asset.name}`}><MoreHorizontal size={16} /></button>}>
                  {(close) => (
                    <>
                      <MenuList close={close} items={[{ label: 'Preview', icon: <Eye size={15} />, disabled: a.status !== 'ready', onClick: () => setPreview(a) }, { label: 'Rename', icon: <Pencil size={15} />, onClick: () => setRenaming(a.asset.id) }]} />
                      <a className="ps-menu-item" href={mediaUrl(a.asset.id, 'source')} download={a.asset.name} onClick={close}><Download size={15} /> Download</a>
                      <div className="ps-menu-sep" />
                      <MenuList close={close} items={[{ label: 'Delete', icon: <Trash2 size={15} />, danger: true, onClick: () => setConfirm(a) }]} />
                    </>
                  )}
                </Popover>
              </div>
            </div>
          ))}
        </div>
      )}
      {preview && <AssetPreview a={preview} onClose={() => setPreview(undefined)} />}
      {confirm && <ConfirmModal title={`Delete “${confirm.asset.name}”?`} body="Projects that use this file will show it as missing. This can’t be undone." confirm="Delete" busy={busy} onConfirm={() => void remove(confirm)} onClose={() => setConfirm(undefined)} />}
    </div>
  )
}

export default function LibraryPage() {
  usePageTitle('Library')
  const [params, setParams] = useSearchParams()
  const tab = (['projects', 'assets', 'trash'].includes(params.get('tab') ?? '') ? params.get('tab') : 'projects') as Tab
  const q = params.get('q') ?? ''
  const ws = useSession((s) => s.workspaces.find((w) => w.id === s.workspaceId))
  const setTab = (t: Tab) => {
    const n = new URLSearchParams(params)
    if (t === 'projects') n.delete('tab')
    else n.set('tab', t)
    setParams(n)
  }
  const setQ = (v: string) => {
    const n = new URLSearchParams(params)
    if (v) n.set('q', v)
    else n.delete('q')
    setParams(n, { replace: true })
  }
  return (
    <div className="ps-page">
      <div className="ps-page-head">
        <div>
          <span className="eyebrow">{ws?.name ?? 'Library'}</span>
          <h1>Library</h1>
        </div>
        <span className="spacer" />
        <div style={{ position: 'relative', width: 300 }}>
          <Search size={15} style={{ position: 'absolute', left: 12, top: 11, color: 'var(--text-3)' }} />
          <input className="input" style={{ paddingLeft: 34 }} placeholder={tab === 'assets' ? 'Filter media' : 'Filter projects'} value={q} onChange={(e) => setQ(e.target.value)} aria-label="Filter library" />
          {q && <button className="btn ghost sm icon" style={{ position: 'absolute', right: 4, top: 4 }} onClick={() => setQ('')} aria-label="Clear filter"><X size={13} /></button>}
        </div>
      </div>
      <div className="ps-tabs" role="tablist">
        <button role="tab" aria-selected={tab === 'projects'} className={tab === 'projects' ? 'on' : ''} onClick={() => setTab('projects')}><FolderOpen size={15} /> Projects</button>
        <button role="tab" aria-selected={tab === 'assets'} className={tab === 'assets' ? 'on' : ''} onClick={() => setTab('assets')}><Video size={15} /> Assets</button>
        <button role="tab" aria-selected={tab === 'trash'} className={tab === 'trash' ? 'on' : ''} onClick={() => setTab('trash')}><Trash2 size={15} /> Trash</button>
      </div>
      {tab === 'assets' ? <AssetsTab q={q} /> : <ProjectsTab key={tab} trash={tab === 'trash'} q={q} />}
    </div>
  )
}
