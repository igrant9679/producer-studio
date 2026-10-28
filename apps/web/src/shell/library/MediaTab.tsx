// The Library's media: the grid (filters and sort in the URL, bulk actions, a windowed grid for big libraries), the
// preview, safer deletes ("Used in N projects", into the trash with Undo), replacing a file in place, and the media
// trash with Empty trash (A-13, A-14, A-15).
import type { AssetRecord, AssetUsage } from '@producer/core'
import clsx from 'clsx'
import { ArchiveRestore, AudioLines, Check, Clapperboard, Copy, Download, Eye, FileUp, Image as ImageIcon, MoreHorizontal, Pencil, RotateCcw, Search, Sparkles, Trash2, Upload, Video, X } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { api, mediaUrl } from '../../lib/api'
import { useSession } from '../../lib/session'
import { toast, toastError } from '../../lib/toast'
import { InlineRename } from '../components/ProjectCard'
import { filterAssets, ORIGIN_LABEL, projectFromClip, type AssetFilter, type LibraryView, type SortKey } from '../pages/libraryLogic'
import { liveBus, uploadFiles, uploadsIn, useUploads } from '../stores'
import { useSystem } from '../system'
import { CardSkeletons, ConfirmDialog, EmptyState, MenuList, Popover, Progress, Spinner, Thumb, useAsync, useEditGate, useFilePicker } from '../ui'
import { downloadUrl, formatBytes, formatDuration, relativeTime } from '../util'
import { count, downloadAll, runAll, SpacePickerModal, useSelection } from './bulk'
import { MediaPreview } from './MediaPreview'
import { VirtualGrid } from './VirtualGrid'
import './library.css'

const FILTERS: Array<{ id: AssetFilter; label: string; icon: React.ReactNode }> = [
  { id: 'all', label: 'All', icon: null },
  { id: 'video', label: 'Video', icon: <Video size={13} /> },
  { id: 'audio', label: 'Audio', icon: <AudioLines size={13} /> },
  { id: 'image', label: 'Images', icon: <ImageIcon size={13} /> },
  { id: 'generated', label: 'Generated', icon: <Sparkles size={13} /> },
]

/** "Used in 2 projects: Launch, Teaser." */
export function usageLine(u: AssetUsage | undefined): string {
  if (!u) return ''
  const live = u.projects.filter((p) => !p.trashed)
  if (!live.length) return 'No project uses it.'
  const names = live.slice(0, 3).map((p) => `“${p.name}”`).join(', ')
  return `Used in ${count(live.length, 'project')}: ${names}${live.length > 3 ? ` and ${live.length - 3} more` : ''}.`
}

/** "Use in a new project": a project with the clip on its timeline, opened in the editor. */
export function useStartFromClip() {
  const navigate = useNavigate()
  const workspaceId = useSession((s) => s.workspaceId)
  return useCallback(
    async (a: AssetRecord) => {
      if (!workspaceId) return
      try {
        const res = await api.createProject({ workspaceId, project: projectFromClip(a.asset) })
        navigate(`/edit/${res.summary.id}`)
      } catch (e) {
        toastError(e, 'Couldn’t start a project')
      }
    },
    [workspaceId, navigate],
  )
}

export function MediaTab({ v, update }: { v: LibraryView; update: (p: Partial<LibraryView>, replace?: boolean) => void }) {
  const workspaceId = useSession((s) => s.workspaceId)
  const [drag, setDrag] = useState(false)
  const [preview, setPreview] = useState<{ a: AssetRecord; at?: number }>()
  const [renaming, setRenaming] = useState<string>()
  const [confirm, setConfirm] = useState<{ items: AssetRecord[]; usage?: AssetUsage[] }>()
  const [moving, setMoving] = useState<AssetRecord[]>()
  const [replacing, setReplacing] = useState<{ id: string; progress: number }>()
  const [busy, setBusy] = useState(false)
  const uploads = useUploads((s) => s.items)
  const gate = useEditGate()
  const startFrom = useStartFromClip()
  const { data, loading, error, reload, setData } = useAsync(() => (workspaceId ? api.assets(workspaceId, undefined, { onPage: (soFar) => setData(soFar) }) : Promise.resolve([])), [workspaceId])
  const upsert = useCallback(
    (a: AssetRecord) => {
      if (a.workspaceId !== workspaceId) return
      setData((cur) => {
        const l = cur ?? []
        // a clip put in the trash (here or elsewhere) leaves the library
        if (a.trashedAt) return l.filter((x) => x.asset.id !== a.asset.id)
        return l.some((x) => x.asset.id === a.asset.id) ? l.map((x) => (x.asset.id === a.asset.id ? a : x)) : [a, ...l]
      })
    },
    [workspaceId, setData],
  )
  useEffect(() => liveBus.onAsset(upsert), [upsert])
  useEffect(() => liveBus.onResync(() => reload()), [reload])
  // ?preview=<clip>&at=<seconds>: a search hit opens the clip where its words are said
  const [params, setParams] = useSearchParams()
  const want = params.get('preview')
  useEffect(() => {
    if (!want || !data) return
    const a = data.find((x) => x.asset.id === want)
    if (!a && loading) return
    if (a) setPreview({ a, at: Number(params.get('at')) || undefined })
    else toast('That clip isn’t in this space’s library any more.')
    const n = new URLSearchParams(params)
    n.delete('preview')
    n.delete('at')
    setParams(n, { replace: true })
  }, [want, data, loading, params, setParams])
  const upload = (files: File[]) => workspaceId && gate.canEdit && files.length && void uploadFiles(workspaceId, files)
  const pick = useFilePicker('video/*,audio/*,image/*', true, upload)
  const list = useMemo(() => filterAssets(data ?? [], { filter: v.media, q: v.q, sort: v.sort }), [data, v.media, v.q, v.sort])
  const order = useMemo(() => list.map((a) => a.asset.id), [list])
  const s = useSelection(order, workspaceId)
  const selecting = s.sel.size > 0
  const pending = uploadsIn(uploads, workspaceId).filter((u) => u.status === 'uploading')
  const byId = useMemo(() => new Map(list.map((a) => [a.asset.id, a])), [list])
  const selected = s.ids.map((id) => byId.get(id)!).filter(Boolean)

  // like the editor's media tiles: process a failed clip again (works when its file reached storage)
  async function retry(a: AssetRecord) {
    try {
      upsert(await api.retryAsset(a.asset.id))
      toast('Processing again…')
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      if (/not arrived/i.test(msg)) toast('This file never reached storage. Delete it and upload it again.')
      else toastError(e)
    }
  }

  // before a delete: which projects use each clip (P-23)
  async function askDelete(items: AssetRecord[]) {
    setConfirm({ items })
    const usage = await Promise.all(items.slice(0, 50).map((a) => api.assetUsage(a.asset.id).catch(() => undefined)))
    setConfirm((c) => (c && c.items === items ? { items, usage: usage.filter((u): u is AssetUsage => !!u) } : c))
  }

  async function trash(items: AssetRecord[]) {
    setBusy(true)
    const ids = new Set(items.map((a) => a.asset.id))
    const failed = await runAll(items, (a) => api.deleteAsset(a.asset.id))
    setBusy(false)
    setConfirm(undefined)
    const done = items.filter((a) => !failed.some((f) => f.item === a))
    setData((cur) => (cur ?? []).filter((x) => !ids.has(x.asset.id) || failed.some((f) => f.item.asset.id === x.asset.id)))
    s.clear()
    if (failed.length) toastError(failed[0].error, `${count(failed.length, 'clip')} couldn’t be moved to the trash`)
    if (done.length)
      toast(done.length > 1 ? `${done.length} clips moved to the trash` : 'Moved to the trash', {
        label: 'Undo',
        run: () =>
          void runAll(done, (a) => api.restoreAsset(a.asset.id).then(upsert)).then((f) => (f.length ? toastError(f[0].error, 'Couldn’t restore') : toast('Restored'))),
      })
  }

  async function copyTo(items: AssetRecord[], to: string, move: boolean) {
    const failed = await runAll(items, (a) => api.copyAsset(a.asset.id, { workspaceId: to, move }))
    const name = useSession.getState().workspaces.find((w) => w.id === to)?.name ?? 'the other space'
    const ok = items.length - failed.length
    if (move) setData((cur) => (cur ?? []).filter((x) => !items.some((a) => a.asset.id === x.asset.id) || failed.some((f) => f.item.asset.id === x.asset.id)))
    setMoving(undefined)
    s.clear()
    if (ok) toast(`${count(ok, 'clip')} ${move ? 'moved' : 'copied'} to “${name}”`)
    if (failed.length) toastError(failed[0].error, `${count(failed.length, 'clip')} couldn’t be ${move ? 'moved' : 'copied'}`)
  }

  // one picker for every kind (it opens inside the click); the server refuses a file of another kind, saying why
  const replaceTarget = useRef<AssetRecord>()
  const replacePick = useFilePicker('video/*,audio/*,image/*', false, (files) => {
    const a = replaceTarget.current
    if (!a || !files[0]) return
    if (!files[0].type.startsWith(`${a.asset.kind}/`)) return toast(`Pick ${a.asset.kind === 'image' ? 'an image' : `a${a.asset.kind === 'audio' ? 'n audio' : ' video'} file`}: projects use “${a.asset.name}” as one.`)
    setReplacing({ id: a.asset.id, progress: 0.01 })
    void api
      .replaceAsset(a.asset.id, files[0], (f) => setReplacing({ id: a.asset.id, progress: Math.max(0.01, f) }))
      .then((r) => {
        upsert(r)
        toast(`“${a.asset.name}” now uses ${files[0].name}. Every project using it follows.`)
      })
      .catch((e) => toastError(e, 'Couldn’t replace the file'))
      .finally(() => setReplacing(undefined))
  })
  const startReplace = (a: AssetRecord) => {
    replaceTarget.current = a
    replacePick()
  }

  const card = (a: AssetRecord) => {
    const on = s.sel.has(a.asset.id)
    const rep = replacing?.id === a.asset.id && replacing.progress > 0
    return (
      <div
        className={clsx('ps-pcard', on && 'selected', selecting && 'selecting')}
        onClick={(e) => (selecting || e.shiftKey || e.ctrlKey || e.metaKey ? s.toggle(a.asset.id, { shift: e.shiftKey }) : a.status === 'ready' && setPreview({ a }))}
        role="button"
        tabIndex={0}
        data-card={a.asset.id}
        // only Enter on the card itself: not on its rename field or menu (those would open the preview too)
        onKeyDown={(e) => {
          if (e.target !== e.currentTarget) return
          if (e.key === 'Enter' && a.status === 'ready') setPreview({ a })
          if (e.key === ' ') {
            e.preventDefault()
            s.toggle(a.asset.id, { shift: e.shiftKey })
          }
        }}
        aria-label={`Preview ${a.asset.name}`}
      >
        <button className={clsx('ps-check', on && 'on')} aria-label={`Select ${a.asset.name}`} aria-pressed={on} onClick={(e) => (e.stopPropagation(), s.toggle(a.asset.id, { shift: e.shiftKey }))}>
          {on && <Check size={14} strokeWidth={3} />}
        </button>
        <Thumb src={a.asset.kind !== 'audio' && a.status === 'ready' ? mediaUrl(a.asset.id, 'thumb') : undefined} seed={a.asset.id} icon={a.asset.kind === 'audio' ? <AudioLines size={28} /> : a.asset.kind === 'image' ? <ImageIcon size={24} /> : <Video size={24} />}>
          {rep ? (
            <div className="ps-asset-status"><span>Replacing {Math.round(replacing!.progress * 100)}%</span></div>
          ) : a.status !== 'ready' ? (
            <div className={clsx('ps-asset-status', a.status === 'error' && 'failed')}>
              {a.status === 'error' ? (
                <>
                  <span className="why" title={a.error}>{a.error || 'Processing failed'}</span>
                  <button className="btn sm" onClick={(e) => (e.stopPropagation(), void retry(a))} aria-label={`Retry processing ${a.asset.name}`}><RotateCcw size={13} /> Retry</button>
                </>
              ) : (
                <><Spinner size={14} /> Processing…</>
              )}
            </div>
          ) : null}
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
                    upsert(await api.renameAsset(a.asset.id, name, a.etag))
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
          <Popover align="right" style={{ width: 230 }} trigger={({ toggle, open }) => <button className="btn ghost sm icon ps-pcard-menu" onClick={toggle} aria-expanded={open} aria-label={`More actions for ${a.asset.name}`}><MoreHorizontal size={16} /></button>}>
            {(close) => (
              <>
                <MenuList
                  close={close}
                  items={[
                    { label: 'Preview', icon: <Eye size={15} />, disabled: a.status !== 'ready', onClick: () => setPreview({ a }) },
                    { label: 'Rename', icon: <Pencil size={15} />, disabled: !gate.canEdit, tip: gate.tip, onClick: () => setRenaming(a.asset.id) },
                    { label: 'Use in a new project', icon: <Clapperboard size={15} />, disabled: !gate.canEdit || a.status !== 'ready', tip: gate.tip, onClick: () => void startFrom(a) },
                    { label: 'Replace file…', sub: 'Every project using it follows', icon: <FileUp size={15} />, disabled: !gate.canEdit || a.status === 'processing' || a.status === 'uploading', tip: gate.tip, onClick: () => startReplace(a) },
                    { label: 'Copy or move to a space…', icon: <Copy size={15} />, disabled: !gate.canEdit || a.status !== 'ready', tip: gate.tip, onClick: () => setMoving([a]) },
                  ]}
                />
                <a className="ps-menu-item" href={downloadUrl(mediaUrl(a.asset.id, 'source'))} download onClick={close}><Download size={15} /> Download</a>
                <div className="ps-menu-sep" />
                <MenuList close={close} items={[{ label: 'Move to trash', icon: <Trash2 size={15} />, danger: true, disabled: !gate.canEdit, tip: gate.tip, onClick: () => void askDelete([a]) }]} />
              </>
            )}
          </Popover>
        </div>
      </div>
    )
  }

  const usedBy = confirm?.usage?.reduce((n, u) => n + u.projects.filter((p) => !p.trashed).length, 0) ?? 0
  return (
    <div
      className={clsx('ps-assets', drag && 'dragging')}
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes('Files') || !gate.canEdit) return
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
        <div className="row" style={{ gap: 6, flexWrap: 'wrap' }} role="group" aria-label="Media type">
          {FILTERS.map((f) => (
            <button key={f.id} aria-pressed={v.media === f.id} className={clsx('chip', v.media === f.id && 'active')} onClick={() => update({ media: f.id })}>{f.icon}{f.label}</button>
          ))}
        </div>
        <span className="spacer" />
        <select className="input" style={{ width: 160, height: 32 }} value={v.sort === 'created' ? 'updated' : v.sort} onChange={(e) => update({ sort: e.target.value as SortKey })} aria-label="Sort media">
          <option value="updated">Newest first</option>
          <option value="name">Name A–Z</option>
          <option value="duration">Longest first</option>
        </select>
        <button className="btn primary sm" {...gate.props} onClick={pick}><Upload size={14} /> Upload</button>
      </div>

      {selecting && (
        <div className="ps-bulk" role="region" aria-label="Selection">
          <button className="btn ghost sm icon" onClick={s.clear} aria-label="Clear selection"><X size={14} /></button>
          <strong aria-live="polite">{s.sel.size} selected</strong>
          <button className="btn ghost sm" onClick={() => (s.all ? s.clear() : s.selectAll())}>{s.all ? 'Deselect all' : 'Select all'}</button>
          <span className="spacer" />
          <button className="btn sm" onClick={() => downloadAll(selected.map((a) => downloadUrl(mediaUrl(a.asset.id, 'source'))))}><Download size={14} /> Download</button>
          <button className="btn sm" {...gate.props} onClick={() => setMoving(selected)}><Copy size={14} /> Copy or move…</button>
          <button className="btn sm" {...gate.props} onClick={() => void askDelete(selected)}><Trash2 size={14} /> Move to trash</button>
        </div>
      )}

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
        v.q || v.media !== 'all' ? (
          <EmptyState icon={<Search size={24} />} title="No media matches" body="Try another type or search term." action={<button className="btn" onClick={() => update({ media: 'all', q: '' })}>Clear filters</button>} />
        ) : (
          <EmptyState icon={<Upload size={24} />} title="Drop files anywhere here" body="Upload recordings, music, voiceovers and images. Everything in this space’s library is available in the editor and to Producer AI." action={<button className="btn primary" {...gate.props} onClick={pick}><Upload size={15} /> Upload media</button>} />
        )
      ) : (
        <>
          {pending.length > 0 && (
            <div className="ps-grid" style={{ marginBottom: 18 }}>
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
            </div>
          )}
          <VirtualGrid items={list} keyOf={(a) => a.asset.id} render={card} label="Media" className={clsx(selecting && 'selecting')} onKeyDown={(e) => s.onKeyDown(e)} />
          {loading && <div className="row muted ps-lib-more"><Spinner size={14} /> Loading more…</div>}
        </>
      )}
      {preview && (
        <MediaPreview
          a={preview.a}
          startAt={preview.at}
          list={list.filter((x) => x.status === 'ready')}
          onMove={(a) => setPreview({ a })}
          onClose={() => setPreview(undefined)}
          onUse={(a) => void startFrom(a)}
          canEdit={gate.canEdit}
        />
      )}
      {confirm && (
        <ConfirmDialog
          title={confirm.items.length > 1 ? `Move ${confirm.items.length} clips to the trash?` : `Move “${confirm.items[0].asset.name}” to the trash?`}
          body={
            !confirm.usage
              ? 'Checking which projects use it…'
              : confirm.items.length === 1
                ? `${usageLine(confirm.usage[0])} Projects keep playing it while it’s in the trash; it’s removed for good only when the trash is emptied.`
                : `${usedBy ? `They’re used ${usedBy} times in projects.` : 'No project uses them.'} Projects keep playing them while they’re in the trash; they’re removed for good only when the trash is emptied.`
          }
          confirmLabel="Move to trash"
          danger={false}
          busy={busy || !confirm.usage}
          onConfirm={() => void trash(confirm.items)}
          onClose={() => setConfirm(undefined)}
        />
      )}
      {moving && <SpacePickerModal what={moving.length > 1 ? count(moving.length, 'clip') : `“${moving[0].asset.name}”`} onClose={() => setMoving(undefined)} onPick={(to, move) => copyTo(moving, to, move)} />}
    </div>
  )
}

/** Trashed media (A-14): restore, or remove for good with Empty trash (all, or the selected ones). */
export function MediaTrash() {
  const workspaceId = useSession((s) => s.workspaceId)
  const gate = useEditGate()
  const days = useSystem((s) => s.info?.retention?.mediaTrashDays)
  const [usage, setUsage] = useState<Record<string, number>>({})
  const [confirm, setConfirm] = useState<{ ids?: string[] }>()
  const [busy, setBusy] = useState(false)
  const { data, loading, error, reload, setData } = useAsync(() => (workspaceId ? api.assets(workspaceId, undefined, { trashed: true }) : Promise.resolve([])), [workspaceId])
  const list = useMemo(() => (data ?? []).slice().sort((a, b) => (b.trashedAt ?? 0) - (a.trashedAt ?? 0)), [data])
  const order = useMemo(() => list.map((a) => a.asset.id), [list])
  const s = useSelection(order, workspaceId)
  useEffect(() => {
    let alive = true
    void Promise.all(list.slice(0, 200).map(async (a) => [a.asset.id, (await api.assetUsage(a.asset.id).catch(() => undefined))?.projects.filter((p) => !p.trashed).length ?? 0] as const)).then((pairs) => alive && setUsage(Object.fromEntries(pairs)))
    return () => {
      alive = false
    }
  }, [list])

  async function restore(ids: string[]) {
    const failed = await runAll(ids, (id) => api.restoreAsset(id))
    setData((cur) => (cur ?? []).filter((a) => !ids.includes(a.asset.id) || failed.some((f) => f.item === a.asset.id)))
    s.clear()
    if (failed.length) toastError(failed[0].error, 'Couldn’t restore')
    else toast(ids.length > 1 ? `${ids.length} clips restored` : 'Restored to the library')
  }

  async function empty(ids?: string[]) {
    if (!workspaceId) return
    setBusy(true)
    try {
      const r = await api.emptyTrash(workspaceId, ids)
      setData((cur) => (ids ? (cur ?? []).filter((a) => !ids.includes(a.asset.id)) : []))
      s.clear()
      toast(`${count(r.removed, 'clip')} deleted for good${r.exports ? ` (and ${count(r.exports, 'export')} made of them)` : ''}`)
    } catch (e) {
      toastError(e)
      reload()
    } finally {
      setBusy(false)
      setConfirm(undefined)
    }
  }

  const going = confirm ? (confirm.ids ?? order) : []
  const usedGoing = going.filter((id) => usage[id]).length
  return (
    <>
      <div className="ps-lib-toolbar">
        <span className="muted ps-trash-note" role="note">
          {days ? `Media in the trash is deleted for good after ${days} days.` : 'Media stays in the trash until you empty it.'} Projects keep playing a clip while it’s here.
        </span>
        <span className="spacer" />
        <button className="btn sm ps-danger-btn" {...gate.props} disabled={!gate.canEdit || !list.length} onClick={() => setConfirm({})}><Trash2 size={14} /> Empty trash</button>
      </div>
      {s.sel.size > 0 && (
        <div className="ps-bulk" role="region" aria-label="Selection">
          <button className="btn ghost sm icon" onClick={s.clear} aria-label="Clear selection"><X size={14} /></button>
          <strong aria-live="polite">{s.sel.size} selected</strong>
          <button className="btn ghost sm" onClick={() => (s.all ? s.clear() : s.selectAll())}>{s.all ? 'Deselect all' : 'Select all'}</button>
          <span className="spacer" />
          <button className="btn sm" {...gate.props} onClick={() => void restore(s.ids)}><ArchiveRestore size={14} /> Restore</button>
          <button className="btn sm ps-danger-btn" {...gate.props} onClick={() => setConfirm({ ids: s.ids })}><Trash2 size={14} /> Delete forever</button>
        </div>
      )}
      {error ? (
        <div className="ps-alert">Couldn’t load the trash. <button className="btn sm" onClick={reload}>Retry</button></div>
      ) : loading && !data ? (
        <div className="ps-grid"><CardSkeletons n={4} /></div>
      ) : !list.length ? (
        <EmptyState icon={<Trash2 size={24} />} title="No media in the trash" body="Clips you delete land here first, so a project that uses one never breaks by surprise." />
      ) : (
        <div className="ps-table-wrap" onKeyDown={s.onKeyDown}>
          <table className="ps-table" aria-label="Media in the trash">
            <thead>
              <tr>
                <th style={{ width: 40 }} aria-label="Selected" />
                <th>Name</th>
                <th>Used in</th>
                <th>Trashed</th>
                <th style={{ width: 120 }} />
              </tr>
            </thead>
            <tbody>
              {list.map((a) => (
                <tr key={a.asset.id} className={clsx(s.sel.has(a.asset.id) && 'on')}>
                  <td>
                    <button className={clsx('ps-check-sm', s.sel.has(a.asset.id) && 'on')} onClick={(e) => s.toggle(a.asset.id, { shift: e.shiftKey })} aria-label={`Select ${a.asset.name}`} aria-pressed={s.sel.has(a.asset.id)}>{s.sel.has(a.asset.id) && <Check size={12} strokeWidth={3} />}</button>
                  </td>
                  <td><strong className="ps-cell-name">{a.asset.name}</strong> <span className="muted">· {a.asset.kind} · {formatBytes(a.asset.sizeBytes)}</span></td>
                  <td className="muted">{usage[a.asset.id] === undefined ? '…' : usage[a.asset.id] ? count(usage[a.asset.id], 'project') : '—'}</td>
                  <td className="muted">{a.trashedAt ? relativeTime(a.trashedAt) : ''}</td>
                  <td><button className="btn sm ghost" {...gate.props} onClick={() => void restore([a.asset.id])} aria-label={`Restore ${a.asset.name}`}><ArchiveRestore size={14} /> Restore</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {confirm && (
        <ConfirmDialog
          title={confirm.ids ? `Delete ${count(going.length, 'clip')} for good?` : `Empty the trash (${count(going.length, 'clip')})?`}
          body={`This removes ${going.length === 1 ? 'the file' : 'the files'} permanently.${usedGoing ? ` ${count(usedGoing, 'clip')} ${usedGoing === 1 ? 'is' : 'are'} still used in projects, which will show ${usedGoing === 1 ? 'it' : 'them'} as missing.` : ''} Exports made of them, and their share links, stop working. This can’t be undone.`}
          confirmLabel={confirm.ids ? 'Delete forever' : 'Empty trash'}
          busy={busy}
          onConfirm={() => void empty(confirm.ids)}
          onClose={() => setConfirm(undefined)}
        />
      )}
    </>
  )
}
