import type { TemplateSummary } from '@producer/core'
import clsx from 'clsx'
import { ChevronLeft, ChevronRight, Clock, Film, Image as ImageIcon, LayoutTemplate, Ratio, Search, Type, Users } from 'lucide-react'
import { useMemo, useState } from 'react'
import { api } from '../../lib/api'
import { useSession } from '../../lib/session'
import { useCreateAndOpen } from '../actions'
import { CardSkeletons, EmptyState, Modal, Soon, Spinner, Thumb, useAsync, usePageTitle } from '../ui'
import { formatDuration } from '../util'

function aspectNum(a: string): number {
  const [w, h] = a.split(':').map(Number)
  return w && h ? w / h : 16 / 9
}

export function filterTemplates(list: TemplateSummary[], category: string, q: string): TemplateSummary[] {
  const term = q.trim().toLowerCase()
  return list.filter((t) => (category === 'All' || t.category === category) && (!term || `${t.name} ${t.category}`.toLowerCase().includes(term)))
}

function TemplateCard({ t, onOpen }: { t: TemplateSummary; onOpen: () => void }) {
  const [hover, setHover] = useState(false)
  return (
    <button className="ps-tcard" onClick={onOpen} onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)} onFocus={() => setHover(true)} onBlur={() => setHover(false)}>
      <Thumb src={t.thumbnailUrl} seed={t.id} aspect={aspectNum(t.aspect)} videoSrc={t.previewUrl} playing={hover}>
        <span className="ps-thumb-badge">{formatDuration(t.duration)}</span>
        <span className="ps-thumb-badge left">{t.aspect}</span>
      </Thumb>
      <span className="ps-tcard-name">{t.name}</span>
      <span className="ps-tcard-sub">{t.category} · {t.clipCount} clips</span>
    </button>
  )
}

function TemplateModal({ list, index, onIndex, onClose }: { list: TemplateSummary[]; index: number; onIndex: (i: number) => void; onClose: () => void }) {
  const t = list[index]
  const [create, busy] = useCreateAndOpen()
  const a = aspectNum(t.aspect)
  return (
    <Modal onClose={onClose} width={960} title={t.name} subtitle={`${t.builtIn ? 'Producer Studio look' : "Your team's template"} · ${t.category}`}>
      <div className="ps-tmodal">
        <div className="ps-tmodal-stage">
          <button className="btn icon ps-tmodal-nav" style={{ left: 8 }} disabled={index === 0} onClick={() => onIndex(index - 1)} aria-label="Previous template"><ChevronLeft size={18} /></button>
          <div className="ps-tmodal-player" style={{ aspectRatio: String(a), maxWidth: a < 1 ? 300 : '100%' }}>
            {t.previewUrl ? <video key={t.id} src={t.previewUrl} poster={t.thumbnailUrl} autoPlay loop muted playsInline controls /> : <Thumb src={t.thumbnailUrl} seed={t.id} aspect={a} />}
          </div>
          <button className="btn icon ps-tmodal-nav" style={{ right: 8 }} disabled={index === list.length - 1} onClick={() => onIndex(index + 1)} aria-label="Next template"><ChevronRight size={18} /></button>
        </div>
        <div className="ps-tmodal-side">
          <div className="ps-tstats">
            <div><Film size={15} /><strong>{t.clipCount}</strong><span>Clips</span></div>
            <div><Type size={15} /><strong>{t.textCount}</strong><span>Texts</span></div>
            <div><Clock size={15} /><strong>{formatDuration(t.duration)}</strong><span>Duration</span></div>
            <div><Ratio size={15} /><strong>{t.aspect}</strong><span>Aspect</span></div>
          </div>
          <p className="muted" style={{ fontSize: 13, lineHeight: 1.55 }}>
            Opens as a new project with placeholder clips and texts you can replace — drop in your footage, change the words, keep the timing and motion.
          </p>
          <button className="btn primary" style={{ width: '100%', height: 44 }} disabled={busy} onClick={() => void create({ templateId: t.id })}>
            {busy ? <Spinner /> : <LayoutTemplate size={16} />} Use this template
          </button>
        </div>
      </div>
    </Modal>
  )
}

export default function TemplatesPage() {
  usePageTitle('Templates')
  const workspaceId = useSession((s) => s.workspaceId)
  const { data, loading, error, reload } = useAsync(() => (workspaceId ? api.templates(workspaceId) : Promise.resolve([])), [workspaceId])
  const [type, setType] = useState<'video' | 'image'>('video')
  const [cat, setCat] = useState('All')
  const [q, setQ] = useState('')
  const [open, setOpen] = useState<{ list: TemplateSummary[]; i: number }>()
  const builtIn = useMemo(() => (data ?? []).filter((t) => t.builtIn), [data])
  const team = useMemo(() => (data ?? []).filter((t) => !t.builtIn), [data])
  const cats = useMemo(() => ['All', ...Array.from(new Set(builtIn.map((t) => t.category)))], [builtIn])
  const shown = filterTemplates(builtIn, cat, q)
  const teamShown = filterTemplates(team, 'All', q)

  return (
    <div className="ps-page">
      <section className="ps-thero">
        <span className="eyebrow">Templates</span>
        <h1>Start from a look that already works</h1>
        <p>Branded motion, titles and pacing — pick one, swap in your footage, ship.</p>
        <div className="ps-thero-search">
          <div className="ps-seg">
            <button className={type === 'video' ? 'on' : ''} onClick={() => setType('video')}><Film size={14} /> Video</button>
            <button className={type === 'image' ? 'on' : ''} onClick={() => setType('image')}><ImageIcon size={14} /> Image</button>
          </div>
          <div style={{ position: 'relative', flex: 1 }}>
            <Search size={16} style={{ position: 'absolute', left: 13, top: 13, color: 'var(--text-3)' }} />
            <input className="input" style={{ height: 42, paddingLeft: 38, borderRadius: 10 }} placeholder={type === 'video' ? 'Search video templates' : 'Search image templates'} value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search templates" />
          </div>
        </div>
      </section>

      {type === 'image' ? (
        <EmptyState icon={<ImageIcon size={24} />} title="Image templates are coming soon" body="Thumbnails, covers, carousels and social posts designed from your brand kit. For now, switch back to video templates." action={<button className="btn" onClick={() => setType('video')}>Browse video templates</button>} />
      ) : (
        <>
          <div className="row ps-chips-row" role="tablist" aria-label="Categories">
            {cats.map((c) => (
              <button key={c} role="tab" aria-selected={cat === c} className={clsx('chip', cat === c && 'active')} onClick={() => setCat(c)}>{c}</button>
            ))}
          </div>
          {error ? (
            <div className="ps-alert">Couldn’t load templates. <button className="btn sm" onClick={reload}>Retry</button></div>
          ) : loading && !data ? (
            <div className="ps-grid ps-tgrid"><CardSkeletons n={8} /></div>
          ) : shown.length ? (
            <div className="ps-grid ps-tgrid">
              {shown.map((t, i) => (
                <TemplateCard key={t.id} t={t} onOpen={() => setOpen({ list: shown, i })} />
              ))}
            </div>
          ) : (
            <EmptyState icon={<Search size={24} />} title="No templates match" body="Try another category or search term." action={<button className="btn" onClick={() => { setQ(''); setCat('All') }}>Clear filters</button>} />
          )}

          <section className="ps-section">
            <div className="ps-section-head">
              <Users size={17} style={{ color: 'var(--cyan)' }} />
              <h2 className="ps-h2">Your team’s templates</h2>
              <span className="spacer" />
              <Soon label="Community gallery soon" />
            </div>
            {loading && !data ? (
              <div className="ps-grid ps-tgrid"><CardSkeletons n={3} /></div>
            ) : teamShown.length ? (
              <div className="ps-grid ps-tgrid">
                {teamShown.map((t, i) => (
                  <TemplateCard key={t.id} t={t} onOpen={() => setOpen({ list: teamShown, i })} />
                ))}
              </div>
            ) : (
              <div className="ps-empty" style={{ padding: '32px 24px' }}>
                <p>Save any project as a template from the <b>Library</b> (••• → Save as template) and it shows up here for everyone in this space.</p>
              </div>
            )}
          </section>
        </>
      )}

      {open && <TemplateModal list={open.list} index={open.i} onIndex={(i) => setOpen({ ...open, i })} onClose={() => setOpen(undefined)} />}
    </div>
  )
}
