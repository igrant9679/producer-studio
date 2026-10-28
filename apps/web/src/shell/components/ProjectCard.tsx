import type { ProjectSummary } from '@producer/core'
import clsx from 'clsx'
import { Check, MoreHorizontal, Sparkles } from 'lucide-react'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { MenuList, Popover, Thumb, type MenuItemDef } from '../ui'
import { aspectLabel, formatDuration, relativeTime } from '../util'

export function projectAspect(p: Pick<ProjectSummary, 'width' | 'height'>): number {
  return p.width && p.height ? p.width / p.height : 16 / 9
}

export function KindPill({ p }: { p: ProjectSummary }) {
  if (p.isTemplate) return <span className="ps-kind-pill is-tpl">Template</span>
  if (p.kind === 'producer')
    return (
      <span className="ps-kind-pill is-ai">
        <Sparkles size={9} /> Producer AI
      </span>
    )
  return null
}

/** Frame a project thumbnail in a 16:9 box, letterboxing portrait/square projects. */
export function ProjectThumb({ p, children }: { p: ProjectSummary; children?: ReactNode }) {
  const a = projectAspect(p)
  return (
    <Thumb seed={p.id} aspect={16 / 9}>
      {p.thumbnailUrl ? (
        <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center' }}>
          <Thumb src={p.thumbnailUrl} seed={p.id} aspect={a} className="ps-thumb-inner" />
        </div>
      ) : null}
      {p.duration > 0 && <span className="ps-thumb-badge">{formatDuration(p.duration)}</span>}
      <span className="ps-thumb-badge left">{aspectLabel(p.width, p.height)}</span>
      {children}
    </Thumb>
  )
}

export function InlineRename({ value, onSave, onCancel }: { value: string; onSave: (v: string) => void; onCancel: () => void }) {
  const [v, setV] = useState(value)
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => {
    ref.current?.focus()
    ref.current?.select()
  }, [])
  const commit = () => (v.trim() && v.trim() !== value ? onSave(v.trim()) : onCancel())
  return (
    <input
      ref={ref}
      className="input ps-inline-input"
      value={v}
      aria-label="Name"
      onChange={(e) => setV(e.target.value)}
      onClick={(e) => e.stopPropagation()}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') commit()
        if (e.key === 'Escape') onCancel()
      }}
    />
  )
}

export function ProjectCard({ p, onOpen, menu, selectable, selected, onToggleSelect, renaming, onRename, onRenameCancel, sub, selecting, overlay }: {
  p: ProjectSummary
  onOpen: () => void
  menu?: MenuItemDef[]
  selectable?: boolean
  selected?: boolean
  selecting?: boolean
  /** `shift`: select the range from the last one clicked (A-13). */
  onToggleSelect?: (how?: { shift: boolean }) => void
  renaming?: boolean
  onRename?: (name: string) => void
  onRenameCancel?: () => void
  sub?: ReactNode
  /** Extra badge drawn over the thumbnail (e.g. desktop sync state). */
  overlay?: ReactNode
}) {
  return (
    <div
      className={clsx('ps-pcard', selected && 'selected', selecting && 'selecting')}
      // a shift- or Ctrl-click selects, even before anything is selected
      onClick={(e) => (onToggleSelect && (selecting || e.shiftKey || e.ctrlKey || e.metaKey) ? onToggleSelect({ shift: e.shiftKey }) : onOpen())}
      role="button"
      tabIndex={0}
      data-card={p.id}
      aria-label={`Open ${p.name}`}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return
        if (e.key === 'Enter') onOpen()
        if (e.key === ' ' && onToggleSelect) {
          e.preventDefault()
          onToggleSelect({ shift: e.shiftKey })
        }
      }}
    >
      {selectable && (
        <button
          className={clsx('ps-check', selected && 'on')}
          aria-label={`Select ${p.name}`}
          aria-pressed={!!selected}
          onClick={(e) => {
            e.stopPropagation()
            onToggleSelect?.({ shift: e.shiftKey })
          }}
        >
          {selected && <Check size={14} strokeWidth={3} />}
        </button>
      )}
      <ProjectThumb p={p}>{overlay}</ProjectThumb>
      <div className="ps-pcard-meta">
        <div>
          {renaming && onRename ? (
            <InlineRename value={p.name} onSave={onRename} onCancel={() => onRenameCancel?.()} />
          ) : (
            <div className="ps-pcard-name" title={p.name}>{p.name}</div>
          )}
          <div className="ps-pcard-sub">
            <KindPill p={p} />
            <span>{sub ?? `Edited ${relativeTime(p.updatedAt)}`}</span>
          </div>
          {p.tags?.length ? (
            <div className="ps-pcard-tags" aria-label="Tags">
              {p.tags.slice(0, 3).map((t) => <span key={t} className="ps-tag">{t}</span>)}
              {p.tags.length > 3 && <span className="ps-tag">+{p.tags.length - 3}</span>}
            </div>
          ) : null}
        </div>
        {menu && (
          <Popover
            align="right"
            style={{ width: 210 }}
            trigger={({ toggle, open }) => (
              <button className="btn ghost sm icon ps-pcard-menu" aria-expanded={open} aria-label={`More actions for ${p.name}`} onClick={toggle}>
                <MoreHorizontal size={16} />
              </button>
            )}
          >
            {(close) => <MenuList items={menu} close={close} />}
          </Popover>
        )}
      </div>
    </div>
  )
}
