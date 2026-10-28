import type { ProjectSummary } from '@producer/core'
import clsx from 'clsx'
import {
  ArchiveRestore,
  Check,
  CheckSquare,
  Copy,
  Download,
  Film,
  FolderOpen,
  LayoutGrid,
  LayoutTemplate,
  Link2,
  List,
  MoreHorizontal,
  Pencil,
  Search,
  Sparkles,
  Tags,
  Trash2,
  User,
  Video,
  X,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { api, HttpError } from '../../lib/api'
import { useSession } from '../../lib/session'
import { toast, toastError } from '../../lib/toast'
import { projectPath } from '../actions'
import { InlineRename, KindPill, ProjectCard, ProjectThumb } from '../components/ProjectCard'
import { count, downloadAll, runAll, SpacePickerModal, TagsModal, useSelection } from '../library/bulk'
import { MediaTab, MediaTrash } from '../library/MediaTab'
import { VirtualGrid } from '../library/VirtualGrid'
import '../library/library.css'
import { liveBus } from '../stores'
import { SyncBadge } from '../SystemChrome'
import { projectSyncBadge, useIsDesktop, useSystem } from '../system'
import { CardSkeletons, ConfirmDialog, EmptyState, MenuList, Modal, Popover, TabPanel, Tabs, useAsync, useEditGate, type MenuItemDef, usePageTitle } from '../ui'
import { absoluteUrl, aspectLabel, copyText, downloadUrl, formatDuration, relativeTime } from '../util'
import { filterProjects, mergeProjects, PROJECT_FILTERS, readLibraryView, SORTS, tagCounts, writeLibraryView, type LibraryView, type SortKey, type ViewMode } from './libraryLogic'

function readStoredView(): ViewMode {
  try {
    return localStorage.getItem('ps.libraryView') === 'list' ? 'list' : 'grid'
  } catch {
    return 'grid'
  }
}

type Update = (p: Partial<LibraryView>, replace?: boolean) => void

// ---------------- projects / trash ----------------
function ProjectsTab({ trash, v, update }: { trash: boolean; v: LibraryView; update: Update }) {
  const navigate = useNavigate()
  const workspaceId = useSession((s) => s.workspaceId)
  const me = useSession((s) => s.user?.id)
  const [renaming, setRenaming] = useState<string>()
  const [confirm, setConfirm] = useState<{ ids: string[] }>()
  const [exportFirst, setExportFirst] = useState<ProjectSummary>()
  const [tagging, setTagging] = useState<ProjectSummary[]>()
  const [moving, setMoving] = useState<ProjectSummary[]>()
  const [busy, setBusy] = useState(false)
  const desktop = useIsDesktop()
  const sync = useSystem((s) => s.sync)
  const gate = useEditGate()
  // what a viewer can't do shows disabled, with who can
  const w = { disabled: !gate.canEdit, tip: gate.tip }
  const { data, loading, error, reload, setData } = useAsync(async () => {
    if (!workspaceId) return []
    if (trash) return api.projects(workspaceId, { trashed: true })
    // a big library shows its first page while the rest arrives (A-15)
    const [all, tpl] = await Promise.all([api.projects(workspaceId, { onPage: (soFar) => setData(soFar) }), api.projects(workspaceId, { templates: true }).catch(() => [] as ProjectSummary[])])
    return mergeProjects(all, tpl)
  }, [workspaceId, trash])

  useEffect(() => liveBus.onProject(() => reload()), [reload])
  useEffect(() => liveBus.onResync(() => reload()), [reload])

  const list = useMemo(
    () => filterProjects(data ?? [], { filter: trash ? 'all' : v.type, q: v.q, sort: v.sort, trashed: trash, createdBy: v.mine ? me : undefined, tag: trash ? undefined : v.tag }),
    [data, v.type, v.q, v.sort, trash, v.mine, me, v.tag],
  )
  const tags = useMemo(() => tagCounts((data ?? []).filter((p) => !p.trashed)), [data])
  const order = useMemo(() => list.map((p) => p.id), [list])
  const s = useSelection(order, `${workspaceId}:${trash}`)
  const selecting = s.sel.size > 0
  const byId = useMemo(() => new Map(list.map((p) => [p.id, p])), [list])
  const selected = s.ids.map((id) => byId.get(id)!).filter(Boolean)
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

  /** One action over many projects: what failed is said, the rest is done. */
  async function bulk(items: ProjectSummary[], fn: (p: ProjectSummary) => Promise<unknown>, done: (n: number) => string) {
    const failed = await runAll(items, fn)
    s.clear()
    if (items.length > failed.length) toast(done(items.length - failed.length))
    if (failed.length) {
      toastError(failed[0].error, `${count(failed.length, 'project')} couldn’t be changed`)
      reload()
    }
  }

  const trashIds = (ids: string[]) => {
    ids.forEach((id) => patchLocal(id, null))
    void bulk(ids.map((id) => byId.get(id)!).filter(Boolean), (p) => api.patchProject(p.id, { trashed: true }), (n) => (n > 1 ? `${n} projects moved to trash` : 'Moved to trash'))
  }
  const restoreIds = (ids: string[]) => {
    ids.forEach((id) => patchLocal(id, null))
    void bulk(ids.map((id) => byId.get(id)!).filter(Boolean), (p) => api.patchProject(p.id, { trashed: false }), (n) => (n > 1 ? `${n} projects restored` : 'Restored'))
  }
  const duplicate = (items: ProjectSummary[]) =>
    bulk(
      items,
      async (p) => {
        const c = await api.duplicateProject(p.id)
        setData((cur) => [c, ...(cur ?? [])])
      },
      (n) => (n > 1 ? `${n} projects duplicated` : 'Duplicated'),
    )
  const saveAsTemplates = (items: ProjectSummary[]) =>
    bulk(
      items.filter((p) => !p.isTemplate),
      async (p) => {
        patchLocal(p.id, { isTemplate: true })
        await api.patchProject(p.id, { isTemplate: true })
      },
      (n) => (n > 1 ? `${n} projects saved as team templates` : 'Saved as a team template'),
    )
  // each project's latest export (the ones not exported yet are said)
  async function download(items: ProjectSummary[]) {
    const urls: string[] = []
    let none = 0
    await runAll(items, async (p) => {
      const ex = (await api.exports(p.id))[0]
      if (ex) urls.push(downloadUrl(ex.url))
      else none++
    })
    if (urls.length) downloadAll(urls)
    if (none) toast(`${count(none, 'project')} ${none === 1 ? 'hasn’t' : 'haven’t'} been exported yet: export ${none === 1 ? 'it' : 'them'} first.`)
    s.clear()
  }
  async function copyTo(items: ProjectSummary[], to: string, move: boolean) {
    const name = useSession.getState().workspaces.find((x) => x.id === to)?.name ?? 'the other space'
    let missing = 0
    await bulk(
      items,
      async (p) => {
        const r = await api.copyProject(p.id, { workspaceId: to, move })
        missing += r.missingMedia
        if (move) patchLocal(p.id, null)
      },
      (n) => `${count(n, 'project')} ${move ? 'moved' : 'copied'} to “${name}”${missing ? ` (${count(missing, 'clip')} that weren’t ready stayed behind)` : ''}`,
    )
    setMoving(undefined)
  }
  async function saveTags(items: ProjectSummary[], next: string[]) {
    await bulk(
      items,
      async (p) => {
        const r = await api.patchProject(p.id, { tags: next })
        patchLocal(p.id, { tags: r.tags, version: r.version })
      },
      (n) => (n > 1 ? `Tags saved on ${n} projects` : 'Tags saved'),
    )
    setTagging(undefined)
  }

  // a share link shows a finished export: with none yet, offer to export instead of a link to "No finished video yet"
  async function copyShareLink(p: ProjectSummary) {
    try {
      const r = await api.share(p.id)
      const ok = await copyText(absoluteUrl(r.url))
      toast(ok ? 'Share link copied' : absoluteUrl(r.url))
    } catch (e) {
      if (e instanceof HttpError && e.status === 409) setExportFirst(p)
      else toastError(e)
    }
  }

  async function deleteForever(ids: string[]) {
    setBusy(true)
    try {
      await Promise.all(ids.map((id) => api.deleteProject(id)))
      ids.forEach((id) => patchLocal(id, null))
      s.clear()
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
        { label: 'Restore', icon: <ArchiveRestore size={15} />, ...w, onClick: () => restoreIds([p.id]) },
        { sep: true, label: '' },
        { label: 'Delete forever', icon: <Trash2 size={15} />, danger: true, ...w, onClick: () => setConfirm({ ids: [p.id] }) },
      ]
    return [
      { label: 'Open in editor', icon: <FolderOpen size={15} />, onClick: () => navigate(`/edit/${p.id}`) },
      ...(p.kind === 'producer' ? [{ label: 'Resume in Producer AI', icon: <Sparkles size={15} />, ...w, onClick: () => navigate(`/producer/${p.id}`) }] : []),
      { label: 'Rename', icon: <Pencil size={15} />, ...w, onClick: () => setRenaming(p.id) },
      { label: 'Duplicate', icon: <Copy size={15} />, ...w, onClick: () => void duplicate([p]) },
      { label: 'Copy share link', icon: <Link2 size={15} />, ...w, onClick: () => void copyShareLink(p) },
      {
        label: p.isTemplate ? 'Remove from templates' : 'Save as template',
        icon: <LayoutTemplate size={15} />,
        ...w,
        onClick: () =>
          void act(async () => {
            patchLocal(p.id, { isTemplate: !p.isTemplate })
            await api.patchProject(p.id, { isTemplate: !p.isTemplate })
          }, p.isTemplate ? 'Removed from templates' : 'Saved as a team template'),
      },
      { label: 'Tags…', icon: <Tags size={15} />, ...w, onClick: () => setTagging([p]) },
      { label: 'Copy or move to a space…', icon: <Copy size={15} />, ...w, onClick: () => setMoving([p]) },
      { label: 'Select', icon: <CheckSquare size={15} />, onClick: () => s.toggle(p.id) },
      { sep: true, label: '' },
      { label: 'Move to trash', icon: <Trash2 size={15} />, danger: true, ...w, onClick: () => trashIds([p.id]) },
    ]
  }

  const rename = (p: ProjectSummary) => (name: string) => {
    setRenaming(undefined)
    patchLocal(p.id, { name })
    // with the version this list showed: a save or rename made elsewhere since is refused, and the list reloads
    void act(() => api.patchProject(p.id, { name, baseVersion: p.version }))
  }
  const open = (p: ProjectSummary) => (trash ? undefined : navigate(projectPath(p)))
  const filtered = !!(v.q || v.type !== 'all' || v.mine || v.tag)

  return (
    <>
      <div className="ps-lib-toolbar">
        {!trash && (
          <div className="row" style={{ gap: 6, flexWrap: 'wrap' }} role="group" aria-label="Project type">
            {PROJECT_FILTERS.map((f) => (
              <button key={f.id} aria-pressed={v.type === f.id} className={clsx('chip', v.type === f.id && 'active')} onClick={() => update({ type: f.id })}>{f.label}</button>
            ))}
            <button aria-pressed={v.mine} className={clsx('chip', v.mine && 'active')} onClick={() => update({ mine: !v.mine })}><User size={13} /> Created by me</button>
            {tags.length > 0 && (
              <select className="input" style={{ width: 150, height: 32 }} value={v.tag ?? ''} onChange={(e) => update({ tag: e.target.value || undefined })} aria-label="Tag">
                <option value="">All tags</option>
                {tags.map((t) => <option key={t.tag} value={t.tag}>{t.tag} ({t.count})</option>)}
              </select>
            )}
          </div>
        )}
        <span className="spacer" />
        <select className="input" style={{ width: 160, height: 32 }} value={v.sort} onChange={(e) => update({ sort: e.target.value as SortKey })} aria-label="Sort">
          {SORTS.map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}
        </select>
        <div className="ps-seg" role="group" aria-label="View">
          <button className={v.view === 'grid' ? 'on' : ''} onClick={() => update({ view: 'grid' })} aria-label="Grid view" aria-pressed={v.view === 'grid'}><LayoutGrid size={14} /></button>
          <button className={v.view === 'list' ? 'on' : ''} onClick={() => update({ view: 'list' })} aria-label="List view" aria-pressed={v.view === 'list'}><List size={14} /></button>
        </div>
      </div>

      {selecting && (
        <div className="ps-bulk" role="region" aria-label="Selection">
          <button className="btn ghost sm icon" onClick={s.clear} aria-label="Clear selection"><X size={14} /></button>
          <strong aria-live="polite">{s.sel.size} selected</strong>
          <button className="btn ghost sm" onClick={() => (s.all ? s.clear() : s.selectAll())}>{s.all ? 'Deselect all' : 'Select all'}</button>
          <span className="spacer" />
          {trash ? (
            <>
              <button className="btn sm" {...gate.props} onClick={() => restoreIds(s.ids)}><ArchiveRestore size={14} /> Restore</button>
              <button className="btn sm ps-danger-btn" {...gate.props} onClick={() => setConfirm({ ids: s.ids })}><Trash2 size={14} /> Delete forever</button>
            </>
          ) : (
            <>
              <button className="btn sm" {...gate.props} onClick={() => void duplicate(selected)}><Copy size={14} /> Duplicate</button>
              <button className="btn sm" {...gate.props} onClick={() => void saveAsTemplates(selected)} disabled={!gate.canEdit || selected.every((p) => p.isTemplate)}><LayoutTemplate size={14} /> Save as template</button>
              <button className="btn sm" {...gate.props} onClick={() => setTagging(selected)}><Tags size={14} /> Tags…</button>
              <button className="btn sm" {...gate.props} onClick={() => setMoving(selected)}><Copy size={14} /> Copy or move…</button>
              <button className="btn sm" onClick={() => void download(selected)}><Download size={14} /> Download</button>
              <button className="btn sm" {...gate.props} onClick={() => trashIds(s.ids)}><Trash2 size={14} /> Move to trash</button>
            </>
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
        ) : filtered ? (
          <EmptyState icon={<Search size={24} />} title="Nothing matches" body={v.q ? `No projects match “${v.q}”.` : 'No projects match these filters.'} action={<button className="btn" onClick={() => update({ type: 'all', q: '', mine: false, tag: undefined })}>Clear filters</button>} />
        ) : (
          <EmptyState icon={<FolderOpen size={24} />} title="No projects yet" body="Start a blank edit or let Producer AI build a first cut from a recording." action={<div className="row"><button className="btn primary" {...gate.props} onClick={() => navigate('/producer/new')}><Sparkles size={15} /> New from recording</button><button className="btn" {...gate.props} onClick={() => navigate('/editor')}>Blank project</button></div>} />
        )
      ) : v.view === 'grid' ? (
        <>
          <VirtualGrid
            items={list}
            keyOf={(p) => p.id}
            label={trash ? 'Projects in the trash' : 'Projects'}
            className={clsx(selecting && 'selecting')}
            onKeyDown={(e) => s.onKeyDown(e)}
            render={(p) => (
              <ProjectCard
                p={p}
                onOpen={() => open(p)}
                menu={menuFor(p)}
                selectable
                selecting={selecting}
                selected={s.sel.has(p.id)}
                onToggleSelect={(how) => s.toggle(p.id, how)}
                renaming={renaming === p.id}
                onRename={rename(p)}
                onRenameCancel={() => setRenaming(undefined)}
                sub={trash ? `Trashed · edited ${relativeTime(p.updatedAt)}` : undefined}
                overlay={desktop && !trash ? <SyncBadge state={projectSyncBadge(p.id, sync)} /> : undefined}
              />
            )}
          />
          {loading && <div className="row muted ps-lib-more" role="status">Loading more projects…</div>}
        </>
      ) : (
        <div className="ps-table-wrap" onKeyDown={s.onKeyDown}>
          <table className="ps-table">
            <thead>
              <tr>
                <th style={{ width: 40 }}>
                  <button className={clsx('ps-check-sm', s.all && 'on')} onClick={() => (s.all ? s.clear() : s.selectAll())} aria-label="Select all" aria-pressed={s.all}>{s.all && <Check size={12} strokeWidth={3} />}</button>
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
                <tr key={p.id} className={clsx(s.sel.has(p.id) && 'on')} onClick={(e) => (selecting || e.shiftKey ? s.toggle(p.id, { shift: e.shiftKey }) : open(p))}>
                  <td onClick={(e) => e.stopPropagation()}>
                    <button className={clsx('ps-check-sm', s.sel.has(p.id) && 'on')} onClick={(e) => s.toggle(p.id, { shift: e.shiftKey })} aria-label={`Select ${p.name}`} aria-pressed={s.sel.has(p.id)}>{s.sel.has(p.id) && <Check size={12} strokeWidth={3} />}</button>
                  </td>
                  <td>
                    <div className="row" style={{ gap: 12 }}>
                      <div style={{ width: 72, flex: 'none' }}><ProjectThumb p={{ ...p, duration: 0 }} /></div>
                      {renaming === p.id ? (
                        <InlineRename value={p.name} onSave={rename(p)} onCancel={() => setRenaming(undefined)} />
                      ) : trash ? (
                        <strong className="ps-cell-name">{p.name}</strong>
                      ) : (
                        // the row opens on click; this is the same for the keyboard
                        <button
                          type="button"
                          className="ps-cell-name ps-text-btn"
                          onClick={(e) => {
                            e.stopPropagation()
                            if (selecting || e.shiftKey) s.toggle(p.id, { shift: e.shiftKey })
                            else open(p)
                          }}
                        >
                          {p.name}
                        </button>
                      )}
                      {p.tags?.length ? <span className="ps-pcard-tags" style={{ marginTop: 0 }}>{p.tags.slice(0, 2).map((t) => <span key={t} className="ps-tag">{t}</span>)}</span> : null}
                    </div>
                  </td>
                  <td><KindPill p={p} />{!p.isTemplate && p.kind === 'edit' && <span className="muted">Edit</span>}</td>
                  <td className="muted">{aspectLabel(p.width, p.height)}</td>
                  <td className="muted mono">{formatDuration(p.duration)}</td>
                  <td className="muted">{relativeTime(p.updatedAt)}</td>
                  <td onClick={(e) => e.stopPropagation()}>
                    <Popover align="right" style={{ width: 230 }} trigger={({ toggle, open: o }) => <button className="btn ghost sm icon" onClick={toggle} aria-expanded={o} aria-label={`More actions for ${p.name}`}><MoreHorizontal size={15} /></button>}>
                      {(close) => <MenuList items={menuFor(p)} close={close} />}
                    </Popover>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {exportFirst && (
        <Modal
          title="Export this project first"
          subtitle={`A share link shows a finished video, and “${exportFirst.name}” hasn’t been exported yet. Export it, then copy the link here or on the Exports page.`}
          onClose={() => setExportFirst(undefined)}
          width={460}
          footer={
            <>
              <button className="btn ghost" onClick={() => setExportFirst(undefined)}>Cancel</button>
              <button className="btn primary" autoFocus onClick={() => navigate(`/edit/${exportFirst.id}?export=1`)}><Film size={15} /> Open and export</button>
            </>
          }
        >
          <span />
        </Modal>
      )}

      {confirm && (
        <ConfirmDialog
          title={confirm.ids.length > 1 ? `Delete ${confirm.ids.length} projects forever?` : 'Delete this project forever?'}
          body="This permanently removes the project and its edit history. Media in your library is kept. This can’t be undone."
          confirmLabel="Delete forever"
          busy={busy}
          onConfirm={() => void deleteForever(confirm.ids)}
          onClose={() => setConfirm(undefined)}
        />
      )}
      {tagging && (
        <TagsModal
          initial={tagging.length === 1 ? tagging[0].tags ?? [] : []}
          suggestions={tags.map((t) => t.tag)}
          count={tagging.length}
          onClose={() => setTagging(undefined)}
          onSave={(next) => saveTags(tagging, next)}
        />
      )}
      {moving && <SpacePickerModal what={moving.length > 1 ? count(moving.length, 'project') : `“${moving[0].name}”`} onClose={() => setMoving(undefined)} onPick={(to, move) => copyTo(moving, to, move)} />}
    </>
  )
}

function TrashTab({ v, update }: { v: LibraryView; update: Update }) {
  return (
    <>
      <div className="row" style={{ gap: 6, marginBottom: 14 }} role="group" aria-label="What’s in the trash">
        <button aria-pressed={v.show === 'projects'} className={clsx('chip', v.show === 'projects' && 'active')} onClick={() => update({ show: 'projects' })}><FolderOpen size={13} /> Projects</button>
        <button aria-pressed={v.show === 'media'} className={clsx('chip', v.show === 'media' && 'active')} onClick={() => update({ show: 'media' })}><Video size={13} /> Media</button>
      </div>
      {v.show === 'media' ? <MediaTrash /> : <ProjectsTab trash v={v} update={update} />}
    </>
  )
}

export default function LibraryPage() {
  usePageTitle('Library')
  const [params, setParams] = useSearchParams()
  const v = readLibraryView(params, readStoredView())
  const ws = useSession((s) => s.workspaces.find((w) => w.id === s.workspaceId))
  // tab, filters, sort and view live in the URL (A-12): a link opens the same view, and a reload keeps it
  const update: Update = (patch, replace = false) => {
    if (patch.view) {
      try {
        localStorage.setItem('ps.libraryView', patch.view)
      } catch {
        /* ignore */
      }
    }
    setParams(writeLibraryView(params, patch), { replace })
  }
  return (
    <div className="ps-page">
      <div className="ps-page-head">
        <div>
          <span className="eyebrow">{ws?.name ?? 'Library'}</span>
          <h1>Library</h1>
        </div>
        <span className="spacer" />
        <div style={{ position: 'relative', width: 'min(300px, 100%)' }}>
          <Search size={15} style={{ position: 'absolute', left: 12, top: 11, color: 'var(--text-3)' }} />
          <input className="input" style={{ paddingLeft: 34 }} placeholder={v.tab === 'assets' ? 'Filter media' : 'Filter projects'} value={v.q} onChange={(e) => update({ q: e.target.value }, true)} aria-label="Filter library" />
          {v.q && <button className="btn ghost sm icon" style={{ position: 'absolute', right: 4, top: 4 }} onClick={() => update({ q: '' }, true)} aria-label="Clear filter"><X size={13} /></button>}
        </div>
      </div>
      <Tabs
        id="library"
        label="Library"
        value={v.tab}
        onChange={(t) => update({ tab: t })}
        tabs={[
          { id: 'projects', label: 'Projects', icon: <FolderOpen size={15} /> },
          { id: 'assets', label: 'Assets', icon: <Video size={15} /> },
          { id: 'trash', label: 'Trash', icon: <Trash2 size={15} /> },
        ]}
      />
      <TabPanel tabs="library" value={v.tab}>
        {v.tab === 'assets' ? <MediaTab v={v} update={update} /> : v.tab === 'trash' ? <TrashTab v={v} update={update} /> : <ProjectsTab key="projects" trash={false} v={v} update={update} />}
      </TabPanel>
    </div>
  )
}
