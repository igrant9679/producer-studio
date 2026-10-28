import type { BrandKitSummary, Project, TemplateSummary } from '@producer/core'
import { DEFAULT_KIT_ID } from '@producer/core'
import clsx from 'clsx'
import { BookmarkPlus, ChevronLeft, ChevronRight, Clock, Film, Image as ImageIcon, LayoutTemplate, Link2, Pause, Play, Ratio, Search, Type, Users } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { api } from '../../lib/api'
import { brandApi, templateApi } from '../../lib/brandApi'
import { useSession } from '../../lib/session'
import { toast, toastError } from '../../lib/toast'
import { useCreateAndOpen } from '../actions'
import { LookPreview, prefersReducedMotion } from '../components/LookPreview'
import { CardSkeletons, EmptyState, Modal, Soon, Spinner, Thumb, useAsync, useEditGate, usePageTitle } from '../ui'
import { formatDuration } from '../util'

function aspectNum(a: string): number {
  const [w, h] = a.split(':').map(Number)
  return w && h ? w / h : 16 / 9
}

export const ASPECT_FILTERS = ['Any', '16:9', '9:16', '1:1'] as const
export type AspectFilter = (typeof ASPECT_FILTERS)[number]

export function filterTemplates(list: TemplateSummary[], category: string, q: string, aspect: AspectFilter = 'Any'): TemplateSummary[] {
  const term = q.trim().toLowerCase()
  // built-in looks are made in any aspect: the filter shows them in that one; a team template has its own
  return list.filter((t) => (category === 'All' || t.category === category) && (!term || `${t.name} ${t.category}`.toLowerCase().includes(term)) && (aspect === 'Any' || t.builtIn || t.aspect === aspect))
}

/** The aspect a template is shown and made in: the filter's for a built-in look, else its own. */
const shownAspect = (t: TemplateSummary, aspect: AspectFilter) => (t.builtIn && aspect !== 'Any' ? aspect : t.aspect)

/** A built-in look's starter project for the preview (null while loading or when it couldn't load). */
function useLookDoc(t: TemplateSummary | undefined, aspect: string, kitId?: string): Project | null {
  const workspaceId = useSession((s) => s.workspaceId)
  const [doc, setDoc] = useState<{ key: string; doc: Project | null }>()
  const key = t?.builtIn ? `${t.id}|${workspaceId}|${aspect}|${kitId}` : ''
  useEffect(() => {
    if (!t?.builtIn) return
    let alive = true
    templateApi
      .doc(t.id, { workspaceId, aspect, kitId: kitId && kitId !== DEFAULT_KIT_ID ? kitId : undefined })
      .then((d) => alive && setDoc({ key, doc: d }))
      .catch(() => alive && setDoc({ key, doc: null }))
    return () => {
      alive = false
    }
  }, [key]) // eslint-disable-line react-hooks/exhaustive-deps
  return doc?.key === key ? doc.doc : null
}

function TemplateCard({ t, aspect, onOpen }: { t: TemplateSummary; aspect: AspectFilter; onOpen: () => void }) {
  const [hover, setHover] = useState(false)
  const a = shownAspect(t, aspect)
  // a look without a stored picture shows itself, drawn by the renderer (playing while hovered or focused)
  const doc = useLookDoc(!t.thumbnailUrl || aspect !== 'Any' ? t : undefined, a)
  return (
    <button className="ps-tcard" onClick={onOpen} onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)} onFocus={() => setHover(true)} onBlur={() => setHover(false)} aria-label={`${t.name}, ${t.category}, ${a}`}>
      {doc ? (
        <div className="ps-thumb" style={{ aspectRatio: String(aspectNum(a)) }}>
          <LookPreview doc={doc} playing={hover} className="ps-look-preview" />
          <span className="ps-thumb-badge">{formatDuration(t.duration)}</span>
          <span className="ps-thumb-badge left">{a}</span>
        </div>
      ) : (
        <Thumb src={t.thumbnailUrl} seed={t.id} aspect={aspectNum(a)} videoSrc={t.previewUrl} playing={hover}>
          <span className="ps-thumb-badge">{formatDuration(t.duration)}</span>
          <span className="ps-thumb-badge left">{a}</span>
        </Thumb>
      )}
      <span className="ps-tcard-name">{t.name}</span>
      <span className="ps-tcard-sub">{t.category} · {t.clipCount} clips</span>
    </button>
  )
}

function TemplateModal({ list, index, aspect, onIndex, onClose, onTeamChanged }: { list: TemplateSummary[]; index: number; aspect: AspectFilter; onIndex: (i: number) => void; onClose: () => void; onTeamChanged: () => void }) {
  const t = list[index]
  const workspaceId = useSession((s) => s.workspaceId)
  const [create, busy] = useCreateAndOpen()
  const gate = useEditGate()
  const shown = shownAspect(t, aspect)
  const a = aspectNum(shown)
  const kits = useAsync(() => (workspaceId && t.builtIn ? brandApi.kits(workspaceId).then((l) => l.items) : Promise.resolve([] as BrandKitSummary[])), [workspaceId, t.builtIn])
  const [kitId, setKitId] = useState(DEFAULT_KIT_ID)
  const [playing, setPlaying] = useState(() => !prefersReducedMotion())
  const [saving, setSaving] = useState(false)
  const doc = useLookDoc(t, shown, kitId)
  const kitList = kits.data ?? []
  const kitName = kitList.find((k) => k.id === kitId)?.doc.name

  // ← → move through the templates (not while typing in a field or using a list)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey) return
      const el = e.target as HTMLElement | null
      if (el && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) return
      if (e.key === 'ArrowLeft' && index > 0) {
        e.preventDefault()
        onIndex(index - 1)
      } else if (e.key === 'ArrowRight' && index < list.length - 1) {
        e.preventDefault()
        onIndex(index + 1)
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [index, list.length, onIndex])

  async function copyLink() {
    const url = `${location.origin}/templates?t=${encodeURIComponent(t.id)}${aspect !== 'Any' ? `&aspect=${encodeURIComponent(aspect)}` : ''}`
    try {
      await navigator.clipboard.writeText(url)
      toast('Link to this template copied')
    } catch {
      toast(url)
    }
  }

  async function saveForTeam() {
    if (!workspaceId) return
    setSaving(true)
    try {
      const made = await templateApi.fromBrand({ workspaceId, lookId: t.id.slice(4), kitId: kitId !== DEFAULT_KIT_ID ? kitId : undefined, aspect: shown })
      toast(`“${made.name}” saved to your team’s templates`)
      onTeamChanged()
    } catch (e) {
      toastError(e)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal onClose={onClose} width={960} title={t.name} subtitle={`${t.builtIn ? 'Producer Studio look' : "Your team's template"} · ${t.category} · ${index + 1} of ${list.length}`}>
      <div className="ps-tmodal">
        <div className="ps-tmodal-stage">
          <button className="btn icon ps-tmodal-nav" style={{ left: 8 }} disabled={index === 0} onClick={() => onIndex(index - 1)} aria-label="Previous template" aria-keyshortcuts="ArrowLeft"><ChevronLeft size={18} /></button>
          <div className="ps-tmodal-player" style={{ aspectRatio: String(a), maxWidth: a < 1 ? 300 : '100%' }}>
            {t.builtIn && doc ? (
              <LookPreview key={`${t.id}|${shown}|${kitId}`} doc={doc} playing={playing} />
            ) : t.previewUrl ? (
              <video key={t.id} src={t.previewUrl} poster={t.thumbnailUrl} autoPlay={!prefersReducedMotion()} loop muted playsInline controls />
            ) : (
              <Thumb src={t.thumbnailUrl} seed={t.id} aspect={a} />
            )}
          </div>
          <button className="btn icon ps-tmodal-nav" style={{ right: 8 }} disabled={index === list.length - 1} onClick={() => onIndex(index + 1)} aria-label="Next template" aria-keyshortcuts="ArrowRight"><ChevronRight size={18} /></button>
        </div>
        <div className="ps-tmodal-side">
          <div className="ps-tstats">
            <div><Film size={15} /><strong>{t.clipCount}</strong><span>Clips</span></div>
            <div><Type size={15} /><strong>{t.textCount}</strong><span>Texts</span></div>
            <div><Clock size={15} /><strong>{formatDuration(t.duration)}</strong><span>Duration</span></div>
            <div><Ratio size={15} /><strong>{shown}</strong><span>Aspect</span></div>
          </div>
          {t.builtIn && (
            <>
              {kitList.length > 1 && (
                <>
                  <label className="label" htmlFor="tpl-kit">Brand kit</label>
                  <select id="tpl-kit" className="input" value={kitId} onChange={(e) => setKitId(e.target.value)}>
                    {kitList.map((k) => <option key={k.id} value={k.id}>{k.doc.name || 'Untitled kit'}{k.default ? ' (default)' : ''}</option>)}
                  </select>
                </>
              )}
              <div className="row" style={{ gap: 6, margin: '10px 0' }}>
                <button className="btn sm" onClick={() => setPlaying((p) => !p)} aria-pressed={playing}>{playing ? <><Pause size={13} /> Pause preview</> : <><Play size={13} /> Play preview</>}</button>
              </div>
            </>
          )}
          <p className="muted" style={{ fontSize: '0.8125rem', lineHeight: 1.55 }}>
            {t.builtIn
              ? `Opens as a new ${shown} project in ${kitName ? `the “${kitName}” kit’s` : 'your brand’s'} colours and fonts, with placeholder texts you can replace: drop in your footage, change the words, keep the timing and motion.`
              : 'Opens as a new project with placeholder clips and texts you can replace — drop in your footage, change the words, keep the timing and motion.'}
          </p>
          <button
            className="btn primary"
            style={{ width: '100%', height: 44 }}
            disabled={busy || !gate.canEdit}
            data-tip={gate.tip}
            onClick={() => void create({ templateId: t.id, ...(t.builtIn ? { aspect: shown, ...(kitId !== DEFAULT_KIT_ID ? { brandKitId: kitId } : {}) } : {}) })}
          >
            {busy ? <Spinner /> : <LayoutTemplate size={16} />} Use this template
          </button>
          {t.builtIn && (
            <button className="btn" style={{ width: '100%', marginTop: 8 }} disabled={saving || !gate.canEdit} data-tip={gate.tip} onClick={() => void saveForTeam()} title="Save this look, in this kit and aspect, as one of your team’s templates">
              {saving ? <Spinner /> : <BookmarkPlus size={15} />} Save as a team template
            </button>
          )}
          <button className="btn ghost sm" style={{ marginTop: 8 }} onClick={() => void copyLink()}><Link2 size={13} /> Copy link</button>
          <div className="muted" style={{ fontSize: '0.75rem', marginTop: 8 }}>Use ← and → to see the next one.</div>
        </div>
      </div>
    </Modal>
  )
}

export default function TemplatesPage() {
  usePageTitle('Templates')
  const workspaceId = useSession((s) => s.workspaceId)
  const { data, loading, error, reload } = useAsync(() => (workspaceId ? api.templates(workspaceId) : Promise.resolve([])), [workspaceId])
  const [params, setParams] = useSearchParams()
  const [type, setType] = useState<'video' | 'image'>('video')
  const [cat, setCat] = useState('All')
  const [q, setQ] = useState('')
  const aspect = (ASPECT_FILTERS as readonly string[]).includes(params.get('aspect') ?? '') ? (params.get('aspect') as AspectFilter) : 'Any'
  const builtIn = useMemo(() => (data ?? []).filter((t) => t.builtIn), [data])
  const team = useMemo(() => (data ?? []).filter((t) => !t.builtIn), [data])
  const cats = useMemo(() => ['All', ...Array.from(new Set(builtIn.map((t) => t.category)))], [builtIn])
  const shown = filterTemplates(builtIn, cat, q, aspect)
  const teamShown = filterTemplates(team, 'All', q, aspect)

  // the template open is in the address (?t=), so it can be linked to and Back closes it
  const openId = params.get('t')
  const open = useMemo(() => {
    if (!openId || !data) return undefined
    for (const list of [shown, teamShown, builtIn, team]) {
      const i = list.findIndex((x) => x.id === openId)
      if (i >= 0) return { list, i }
    }
    return undefined
  }, [openId, data, shown, teamShown, builtIn, team])
  const setParam = (k: string, v: string | null, replace = false) =>
    setParams(
      (p) => {
        const n = new URLSearchParams(p)
        if (v === null) n.delete(k)
        else n.set(k, v)
        return n
      },
      { replace },
    )
  // a link to a template this space can't see
  useEffect(() => {
    if (openId && data && !loading && !open) {
      toast('That template isn’t in this space')
      setParam('t', null, true)
    }
  }, [openId, data, loading, open]) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="ps-page">
      <section className="ps-thero">
        <span className="eyebrow">Templates</span>
        <h1>Start from a look that already works</h1>
        <p>Branded motion, titles and pacing — pick one, swap in your footage, ship.</p>
        <div className="ps-thero-search">
          <div className="ps-seg">
            <button className={type === 'video' ? 'on' : ''} aria-pressed={type === 'video'} onClick={() => setType('video')}><Film size={14} /> Video</button>
            <button className={type === 'image' ? 'on' : ''} aria-pressed={type === 'image'} onClick={() => setType('image')}><ImageIcon size={14} /> Image</button>
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
          <div className="row ps-chips-row" style={{ flexWrap: 'wrap', gap: 10 }}>
            <div className="row" role="group" aria-label="Categories" style={{ flexWrap: 'wrap', gap: 6 }}>
              {cats.map((c) => (
                <button key={c} aria-pressed={cat === c} className={clsx('chip', cat === c && 'active')} onClick={() => setCat(c)}>{c}</button>
              ))}
            </div>
            <span className="spacer" />
            <div className="ps-seg" role="group" aria-label="Aspect ratio">
              {ASPECT_FILTERS.map((a) => (
                <button key={a} className={aspect === a ? 'on' : ''} aria-pressed={aspect === a} onClick={() => setParam('aspect', a === 'Any' ? null : a, true)}>
                  {a === 'Any' ? 'Any aspect' : <><i className={`ps-ar ps-ar-${a.replace(':', '-')}`} /> {a}</>}
                </button>
              ))}
            </div>
          </div>
          {aspect !== 'Any' && <p className="muted" style={{ fontSize: '0.8125rem', margin: '0 0 12px' }}>Producer Studio looks are shown as {aspect}; your team’s templates in {aspect} only.</p>}
          {error ? (
            <div className="ps-alert">Couldn’t load templates. <button className="btn sm" onClick={reload}>Retry</button></div>
          ) : loading && !data ? (
            <div className="ps-grid ps-tgrid"><CardSkeletons n={8} /></div>
          ) : shown.length ? (
            <div className="ps-grid ps-tgrid">
              {shown.map((t) => (
                <TemplateCard key={t.id} t={t} aspect={aspect} onOpen={() => setParam('t', t.id)} />
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
            {error ? (
              <div className="ps-alert">Couldn’t load your team’s templates. <button className="btn sm" onClick={reload}>Retry</button></div>
            ) : loading && !data ? (
              <div className="ps-grid ps-tgrid"><CardSkeletons n={3} /></div>
            ) : teamShown.length ? (
              <div className="ps-grid ps-tgrid">
                {teamShown.map((t) => (
                  <TemplateCard key={t.id} t={t} aspect={aspect} onOpen={() => setParam('t', t.id)} />
                ))}
              </div>
            ) : (
              <div className="ps-empty" style={{ padding: '32px 24px' }}>
                <p>
                  {team.length && aspect !== 'Any' ? `None of your team’s templates are ${aspect}. ` : ''}
                  Save any project as a template from the <b>Library</b> (••• → Save as template), or open a look above and <b>Save as a team template</b> in your brand kit: it shows up here for everyone in this space.
                </p>
              </div>
            )}
          </section>
        </>
      )}

      {open && (
        <TemplateModal
          key={open.list === builtIn || open.list === shown ? 'builtin' : 'team'}
          list={open.list}
          index={open.i}
          aspect={aspect}
          onIndex={(i) => setParam('t', open.list[i].id, true)}
          onClose={() => setParam('t', null)}
          onTeamChanged={reload}
        />
      )}
    </div>
  )
}
