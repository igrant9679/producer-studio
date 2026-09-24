import type { AssetRecord, ScriptScene, TemplateSummary } from '@producer/core'
import clsx from 'clsx'
import {
  AlertTriangle,
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Check,
  CheckCircle2,
  Circle,
  Clapperboard,
  FileVideo,
  FolderOpen,
  GripVertical,
  Library,
  Plus,
  RefreshCw,
  RotateCcw,
  Sparkles,
  Square,
  Trash2,
  Upload,
  Wand2,
  X,
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { api, mediaUrl } from '../../lib/api'
import { useSession } from '../../lib/session'
import { toastError } from '../../lib/toast'
import { filterVoices, useVoices, VoiceCard, VOICE_FILTERS, type VoiceFilter } from '../components/VoiceCard'
import { Modal, Popover, Progress, Spinner, Thumb, useAsync, useFilePicker, usePageTitle } from '../ui'
import { formatBytes, formatDuration, formatTime, ssGet } from '../util'
import { takeProducerHandoff } from './handoff'
import {
  canAdvance,
  initialState,
  insertScene,
  maxReachableStep,
  moveScene,
  narrationSeconds,
  newScene,
  readyAssetIds,
  removeScene,
  sanitizeForResume,
  sceneWords,
  stateFromProject,
  STEPS,
  storageKey,
  TONES,
  updateScene,
  validateBrief,
  type Brief,
  type StepId,
  type WizardState,
} from './wizardLogic'
import { addLibraryAssets, cancelRun, removeWizardAsset, resumeProcessingAssets, runAssemble, runGenerate, uploadToWizard, useWizard } from './wizardStore'
import './producer.css'

const ORDER: StepId[] = STEPS.map((s) => s.id)

function Stepper({ s, onJump }: { s: WizardState; onJump: (id: StepId) => void }) {
  const cur = ORDER.indexOf(s.step)
  const max = maxReachableStep(s)
  const running = s.run.status === 'running'
  return (
    <ol className="ps-stepper" aria-label="Steps">
      {STEPS.map((st, i) => {
        const done = i < cur || (st.id === 'assemble' && s.run.status === 'done' && s.run.phase === 'assemble')
        const reachable = !running && i <= max && st.id !== 'generate' && !(st.id === 'assemble' && !s.scenes.length)
        return (
          <li key={st.id} className={clsx(i === cur && 'on', done && 'done')}>
            <button disabled={!reachable || i === cur} onClick={() => onJump(st.id)} aria-current={i === cur ? 'step' : undefined}>
              <span className="ps-step-n">{done ? <Check size={13} strokeWidth={3} /> : i + 1}</span>
              <span className="ps-step-text">
                <strong>{st.label}</strong>
                <span>{st.hint}</span>
              </span>
            </button>
          </li>
        )
      })}
    </ol>
  )
}

// ---------------- ① upload ----------------
function LibraryPicker({ onClose, onPick }: { onClose: () => void; onPick: (recs: AssetRecord[]) => void }) {
  const workspaceId = useSession((s) => s.workspaceId)
  const { data, loading } = useAsync(() => (workspaceId ? api.assets(workspaceId, 'video') : Promise.resolve([])), [workspaceId])
  const [sel, setSel] = useState<Set<string>>(new Set())
  const list = (data ?? []).filter((a) => a.asset.kind === 'video' && a.status !== 'error')
  return (
    <Modal
      title="Choose from your library"
      subtitle="Pick recordings you've already uploaded to this space."
      onClose={onClose}
      width={760}
      footer={
        <>
          <button className="btn ghost" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={!sel.size} onClick={() => onPick(list.filter((a) => sel.has(a.asset.id)))}>Add {sel.size || ''} recording{sel.size === 1 ? '' : 's'}</button>
        </>
      }
    >
      {loading ? (
        <div className="ps-grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))' }}>
          {Array.from({ length: 6 }, (_, i) => <div key={i} className="skeleton" style={{ aspectRatio: '16/9' }} />)}
        </div>
      ) : !list.length ? (
        <div className="muted" style={{ padding: 30, textAlign: 'center' }}>No videos in this space yet — upload one instead.</div>
      ) : (
        <div className="ps-grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: 14 }}>
          {list.map((a) => {
            const on = sel.has(a.asset.id)
            return (
              <button
                key={a.asset.id}
                className={clsx('ps-pick', on && 'on')}
                onClick={() =>
                  setSel((cur) => {
                    const n = new Set(cur)
                    if (n.has(a.asset.id)) n.delete(a.asset.id)
                    else n.add(a.asset.id)
                    return n
                  })
                }
              >
                <Thumb src={mediaUrl(a.asset.id, 'thumb')} seed={a.asset.id}>
                  {a.asset.duration ? <span className="ps-thumb-badge">{formatDuration(a.asset.duration)}</span> : null}
                  {on && <span className="ps-pick-check"><Check size={14} strokeWidth={3} /></span>}
                </Thumb>
                <span className="ps-pick-name">{a.asset.name}</span>
              </button>
            )
          })}
        </div>
      )}
    </Modal>
  )
}

function UploadStep({ s, workspaceId }: { s: WizardState; workspaceId: string }) {
  const [drag, setDrag] = useState(false)
  const [lib, setLib] = useState(false)
  const pick = useFilePicker('video/*', true, (files) => void uploadToWizard(workspaceId, files))
  const locked = !!s.projectId && s.transcribed.length > 0
  return (
    <div className="ps-wz-body">
      <div className="ps-wz-intro">
        <h2>Add your recordings</h2>
        <p>Screen captures, demos, talking heads — Producer transcribes every file and picks the strongest moments for the script. Add one or several.</p>
      </div>
      <div
        className={clsx('ps-drop', drag && 'over')}
        onDragOver={(e) => {
          e.preventDefault()
          setDrag(true)
        }}
        onDragLeave={() => setDrag(false)}
        onDrop={(e) => {
          e.preventDefault()
          setDrag(false)
          const files = Array.from(e.dataTransfer.files).filter((f) => f.type.startsWith('video/'))
          if (files.length) void uploadToWizard(workspaceId, files)
        }}
      >
        <div className="ps-drop-icon"><Upload size={26} /></div>
        <strong>Drop video files here</strong>
        <span className="muted">MP4, MOV or WebM · up to a few GB each</span>
        <div className="row" style={{ marginTop: 10 }}>
          <button className="btn primary" onClick={pick}><Upload size={15} /> Choose files</button>
          <button className="btn" onClick={() => setLib(true)}><Library size={15} /> From library</button>
        </div>
      </div>

      {s.assets.length > 0 && (
        <div className="ps-files">
          {s.assets.map((a) => (
            <div key={a.localId} className={clsx('ps-file', a.status)}>
              <div className="ps-file-thumb">
                {a.assetId && a.status === 'ready' ? <Thumb src={mediaUrl(a.assetId, 'thumb')} seed={a.assetId} /> : <FileVideo size={20} />}
              </div>
              <div className="ps-file-meta">
                <strong title={a.name}>{a.name}</strong>
                <span>
                  {a.status === 'uploading' && `Uploading · ${Math.round(a.progress * 100)}%`}
                  {a.status === 'processing' && 'Processing — building preview & audio'}
                  {a.status === 'ready' && [a.duration ? formatDuration(a.duration) : null, a.size ? formatBytes(a.size) : null, s.transcribed.includes(a.assetId ?? '') ? 'Transcribed' : 'Ready'].filter(Boolean).join(' · ')}
                  {a.status === 'error' && <span style={{ color: 'var(--danger)' }}>{a.error ?? 'Failed'}</span>}
                </span>
                {(a.status === 'uploading' || a.status === 'processing') && <Progress value={a.status === 'processing' ? -1 : a.progress} />}
              </div>
              {a.status === 'ready' ? <CheckCircle2 size={18} style={{ color: 'var(--green)' }} /> : a.status === 'error' ? <AlertTriangle size={18} style={{ color: 'var(--danger)' }} /> : <Spinner />}
              <button className="btn ghost sm icon" disabled={locked && a.status === 'ready'} title={locked ? 'Already used in the script' : 'Remove'} aria-label={`Remove ${a.name}`} onClick={() => removeWizardAsset(a.localId)}>
                <X size={14} />
              </button>
            </div>
          ))}
        </div>
      )}
      {lib && (
        <LibraryPicker
          onClose={() => setLib(false)}
          onPick={(recs) => {
            addLibraryAssets(recs)
            setLib(false)
          }}
        />
      )}
    </div>
  )
}

// ---------------- ② brief ----------------
function BriefStep({ s, templates, tplLoading }: { s: WizardState; templates: TemplateSummary[]; tplLoading: boolean }) {
  const patch = useWizard((st) => st.patch)
  const b = s.brief
  const set = (p: Partial<Brief>) => patch((st) => ({ brief: { ...st.brief, ...p } }))
  const [touched, setTouched] = useState(false)
  const errs = touched ? validateBrief(b) : {}
  const voices = useVoices()
  const [vf, setVf] = useState<VoiceFilter>('All')
  const shown = filterVoices(voices, vf)
  const builtIn = templates.filter((t) => t.builtIn)
  const custom = !TONES.includes(b.tone)
  return (
    <div className="ps-wz-body">
      <div className="ps-wz-intro">
        <h2>Write the brief</h2>
        <p>Tell Producer who this is for and what it should achieve. The more specific, the sharper the script.</p>
      </div>
      <div className="ps-brief-grid">
        <div className="ps-field" style={{ gridColumn: '1 / -1' }}>
          <label className="label" htmlFor="b-title">Title</label>
          <input id="b-title" className="input ps-input-lg" value={b.title} onChange={(e) => set({ title: e.target.value })} onBlur={() => setTouched(true)} placeholder="e.g. Spring release — 90-second product tour" />
          {errs.title && <div className="ps-field-err">{errs.title}</div>}
        </div>
        <div className="ps-field">
          <label className="label" htmlFor="b-aud">Audience</label>
          <input id="b-aud" className="input" value={b.audience} onChange={(e) => set({ audience: e.target.value })} placeholder="Who is watching? e.g. Ops managers evaluating us" />
        </div>
        <div className="ps-field">
          <label className="label" htmlFor="b-goal">Goal</label>
          <input id="b-goal" className="input" value={b.goal} onChange={(e) => set({ goal: e.target.value })} placeholder="What should they do or understand afterwards?" />
        </div>
        <div className="ps-field" style={{ gridColumn: '1 / -1' }}>
          <span className="label">Tone</span>
          <div className="row" style={{ flexWrap: 'wrap' }}>
            {TONES.map((t) => (
              <button key={t} className={clsx('chip', b.tone === t && 'active')} onClick={() => set({ tone: t })}>{t}</button>
            ))}
            <input className="input" style={{ width: 220, height: 28, borderRadius: 999 }} placeholder="Or describe it…" value={custom ? b.tone : ''} onChange={(e) => set({ tone: e.target.value || 'Confident' })} aria-label="Custom tone" />
          </div>
        </div>
        <div className="ps-field" style={{ gridColumn: '1 / -1' }}>
          <span className="label">Aspect ratio</span>
          <div className="ps-seg">
            {(['16:9', '9:16', '1:1'] as const).map((a) => (
              <button key={a} className={b.aspect === a ? 'on' : ''} onClick={() => set({ aspect: a })} disabled={!!s.projectId && s.scenes.length > 0 && b.aspect !== a} title={s.projectId && s.scenes.length ? 'Fixed once the project is created' : undefined}>
                <i className={`ps-ar ps-ar-${a.replace(':', '-')}`} /> {a} <span className="muted" style={{ fontWeight: 500 }}>{a === '16:9' ? 'Landscape' : a === '9:16' ? 'Vertical' : 'Square'}</span>
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="ps-field">
        <span className="label">Template look</span>
        <div className="ps-looks">
          {tplLoading && !builtIn.length
            ? Array.from({ length: 5 }, (_, i) => <div key={i} className="skeleton" style={{ aspectRatio: '16/10' }} />)
            : builtIn.map((t) => (
                <button key={t.id} className={clsx('ps-look', b.template === t.id && 'on')} onClick={() => set({ template: t.id })} aria-pressed={b.template === t.id}>
                  <Thumb src={t.thumbnailUrl} seed={t.id} aspect={16 / 10} />
                  <span className="ps-look-name">{t.name}</span>
                  <span className="ps-look-cat">{t.category} · {t.aspect}</span>
                  {b.template === t.id && <span className="ps-pick-check"><Check size={13} strokeWidth={3} /></span>}
                </button>
              ))}
          {!tplLoading && !builtIn.length && <div className="muted">Template looks are unavailable right now — Producer will use its default look.</div>}
        </div>
      </div>

      <div className="ps-field">
        <div className="row" style={{ marginBottom: 8 }}>
          <span className="label" style={{ margin: 0 }}>Narration voice</span>
          <span className="spacer" />
          <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
            {VOICE_FILTERS.slice(0, 5).map((f) => (
              <button key={f} className={clsx('chip', vf === f && 'active')} onClick={() => setVf(f)}>{f}</button>
            ))}
          </div>
        </div>
        <div className="ps-voice-grid" role="radiogroup" aria-label="Narration voice">
          {shown.map((v) => (
            <VoiceCard key={v.id} v={v} compact selected={b.voice === v.id} onSelect={() => set({ voice: v.id })} />
          ))}
        </div>
        {errs.voice && <div className="ps-field-err">{errs.voice}</div>}
      </div>

      <div className="ps-field">
        <label className="label" htmlFor="b-notes">Notes for the writer (optional)</label>
        <textarea id="b-notes" className="input" rows={3} value={b.notes ?? ''} onChange={(e) => set({ notes: e.target.value })} placeholder="Must-mention features, words to avoid, call to action, target length…" />
      </div>
    </div>
  )
}

// ---------------- ③ generate ----------------
function PipelineRow({ label, state, detail }: { label: string; state: 'todo' | 'run' | 'done' | 'error'; detail?: string }) {
  return (
    <div className={clsx('ps-pipe-row', state)}>
      <span className="ps-pipe-dot">
        {state === 'done' ? <Check size={14} strokeWidth={3} /> : state === 'run' ? <Spinner size={14} /> : state === 'error' ? <X size={14} /> : <Circle size={10} />}
      </span>
      <div>
        <strong>{label}</strong>
        {detail && <span>{detail}</span>}
      </div>
    </div>
  )
}

function GenerateStep({ s, onRun }: { s: WizardState; onRun: () => void }) {
  const r = s.run
  const ids = readyAssetIds(s)
  const phases = ['create', 'transcribe', 'script'] as const
  const pi = r.phase ? phases.indexOf(r.phase as (typeof phases)[number]) : -1
  const stateOf = (i: number): 'todo' | 'run' | 'done' | 'error' => {
    if (r.status === 'done' || s.scenes.length) return 'done'
    if (i < pi) return 'done'
    if (i === pi) return r.status === 'error' ? 'error' : r.status === 'running' ? 'run' : 'todo'
    if (i === 0 && s.projectId) return 'done'
    if (i === 1 && ids.length && ids.every((id) => s.transcribed.includes(id))) return 'done'
    return 'todo'
  }
  return (
    <div className="ps-wz-body ps-gen">
      <div className="ps-gen-orb" aria-hidden>
        <Sparkles size={34} />
      </div>
      <h2>{r.status === 'error' ? 'Something went wrong' : r.status === 'running' ? 'Producing your script' : r.interrupted ? 'Pick up where you left off' : 'Ready to write'}</h2>
      <p className="ps-gen-line" aria-live="polite">{r.status === 'error' ? r.error : r.message ?? `Producer will transcribe ${ids.length} recording${ids.length === 1 ? '' : 's'} and write a script for “${s.brief.title}”.`}</p>
      {r.status === 'running' && (
        <div style={{ width: '100%', maxWidth: 440, margin: '4px auto 20px' }}>
          <Progress value={r.progress ?? -1} />
        </div>
      )}
      <div className="ps-pipe">
        <PipelineRow label="Create project" state={stateOf(0)} detail={s.projectId ? 'Saved to your library' : undefined} />
        <PipelineRow label="Transcribe recordings" state={stateOf(1)} detail={`${s.transcribed.filter((id) => ids.includes(id)).length} of ${ids.length} done`} />
        <PipelineRow label="Write script with Claude" state={stateOf(2)} detail="Scenes, headlines and narration from your brief" />
      </div>
      <div className="row" style={{ justifyContent: 'center', marginTop: 24 }}>
        {r.status === 'running' ? (
          <button className="btn" onClick={cancelRun}><Square size={13} /> Stop</button>
        ) : (
          <button className="btn primary" onClick={onRun}>
            {r.status === 'error' ? <><RotateCcw size={15} /> Try again</> : r.interrupted ? <><RefreshCw size={15} /> Resume</> : <><Sparkles size={15} /> Write the script</>}
          </button>
        )}
      </div>
    </div>
  )
}

// ---------------- ④ review ----------------
function RewriteButton({ scene, brief, onText, onBusy }: { scene: ScriptScene; brief: Brief; onText: (t: string) => void; onBusy: (b: boolean) => void }) {
  const [instr, setInstr] = useState('')
  const [busy, setBusy] = useState(false)
  const ctrl = useRef<AbortController>()
  useEffect(() => () => ctrl.current?.abort(), [])
  async function go(instruction: string, close: () => void) {
    close()
    const original = scene.narration
    setBusy(true)
    onBusy(true)
    ctrl.current = new AbortController()
    let acc = ''
    try {
      await api.write(
        {
          kind: 'rewrite',
          prompt: instruction || 'Rewrite this narration so it is clearer, tighter and more engaging. Keep the meaning and roughly the same length.',
          context: [`Video: ${brief.title}`, brief.audience && `Audience: ${brief.audience}`, brief.goal && `Goal: ${brief.goal}`, `Tone: ${brief.tone}`, `Scene: ${scene.title}`, scene.headline && `Headline: ${scene.headline}`, `Narration: ${original}`].filter(Boolean).join('\n'),
          maxWords: Math.max(20, Math.round(sceneWords(original) * 1.4)),
          workspaceId: useSession.getState().workspaceId,
        },
        (d) => {
          acc += d
          onText(acc.trimStart())
        },
        ctrl.current.signal,
      )
      if (!acc.trim()) onText(original)
    } catch (e) {
      onText(original)
      if (!(e instanceof DOMException && e.name === 'AbortError')) toastError(e)
    } finally {
      setBusy(false)
      onBusy(false)
    }
  }
  return (
    <Popover
      align="right"
      style={{ width: 320, padding: 12 }}
      trigger={({ toggle, open }) => (
        <button className="btn sm ps-ai-btn" onClick={toggle} aria-expanded={open} disabled={busy}>
          {busy ? <Spinner size={13} /> : <Wand2 size={13} />} {busy ? 'Rewriting…' : 'Rewrite with AI'}
        </button>
      )}
    >
      {(close) => (
        <div>
          <div className="eyebrow" style={{ marginBottom: 8 }}>Rewrite narration</div>
          <div className="row" style={{ flexWrap: 'wrap', gap: 6, marginBottom: 10 }}>
            {['Shorter', 'Punchier', 'Friendlier', 'Simpler words', 'More detail'].map((c) => (
              <button key={c} className="chip" onClick={() => go(`Rewrite this narration: ${c.toLowerCase()}.`, close)}>{c}</button>
            ))}
          </div>
          <form
            onSubmit={(e) => {
              e.preventDefault()
              void go(instr.trim(), close)
            }}
          >
            <input className="input" autoFocus placeholder="Or tell it what to change…" value={instr} onChange={(e) => setInstr(e.target.value)} />
            <button className="btn primary sm" style={{ marginTop: 8, width: '100%' }}><Sparkles size={13} /> Rewrite</button>
          </form>
        </div>
      )}
    </Popover>
  )
}

function SceneCard({ scene, index, total, s, onChange, onMove, onDelete, onAddAfter, dragProps }: {
  scene: ScriptScene
  index: number
  total: number
  s: WizardState
  onChange: (p: Partial<ScriptScene>) => void
  onMove: (to: number) => void
  onDelete: () => void
  onAddAfter: () => void
  dragProps: React.HTMLAttributes<HTMLDivElement> & { draggable: boolean }
}) {
  const [busy, setBusy] = useState(false)
  const [confirmDel, setConfirmDel] = useState(false)
  const assetName = (id: string) => s.assets.find((a) => a.assetId === id)?.name ?? 'Recording'
  const ready = s.assets.filter((a) => a.status === 'ready' && a.assetId)
  const secs = narrationSeconds(scene.narration)
  const footSecs = scene.footage.reduce((t, f) => t + Math.max(0, f.end - f.start), 0)
  const setWin = (i: number, p: Partial<ScriptScene['footage'][number]>) => onChange({ footage: scene.footage.map((f, j) => (j === i ? { ...f, ...p } : f)) })
  return (
    <div className="ps-scene" {...dragProps}>
      <div className="ps-scene-rail">
        <span className="ps-scene-grip" title="Drag to reorder"><GripVertical size={16} /></span>
        <span className="ps-scene-n">{String(index + 1).padStart(2, '0')}</span>
        <button className="btn ghost sm icon" disabled={index === 0} onClick={() => onMove(index - 1)} aria-label="Move up"><ArrowUp size={14} /></button>
        <button className="btn ghost sm icon" disabled={index === total - 1} onClick={() => onMove(index + 1)} aria-label="Move down"><ArrowDown size={14} /></button>
      </div>
      <div className="ps-scene-main">
        <div className="ps-scene-top">
          <input className="ps-scene-title" value={scene.title} onChange={(e) => onChange({ title: e.target.value })} aria-label={`Scene ${index + 1} title`} placeholder="Scene title" />
          <span className="spacer" />
          <RewriteButton scene={scene} brief={s.brief} onText={(t) => onChange({ narration: t })} onBusy={setBusy} />
          {confirmDel ? (
            <span className="row" style={{ gap: 6 }}>
              <button className="btn sm" style={{ borderColor: 'var(--danger)', color: 'var(--danger)' }} onClick={onDelete}>Delete scene</button>
              <button className="btn ghost sm" onClick={() => setConfirmDel(false)}>Keep</button>
            </span>
          ) : (
            <button className="btn ghost sm icon" onClick={() => setConfirmDel(true)} aria-label={`Delete scene ${index + 1}`} title="Delete scene"><Trash2 size={14} /></button>
          )}
        </div>
        <label className="label" htmlFor={`hl-${scene.id}`}>On-screen headline</label>
        <input id={`hl-${scene.id}`} className="input" value={scene.headline} onChange={(e) => onChange({ headline: e.target.value })} placeholder="Short title shown on screen" />
        <label className="label" htmlFor={`nar-${scene.id}`} style={{ marginTop: 12 }}>Narration</label>
        <textarea id={`nar-${scene.id}`} className={clsx('input ps-narration', busy && 'streaming')} rows={3} value={scene.narration} onChange={(e) => onChange({ narration: e.target.value })} readOnly={busy} placeholder="What the narrator says during this scene" />
        <div className="ps-scene-stats">
          <span>{sceneWords(scene.narration)} words</span>
          <span>≈ {formatDuration(secs)} spoken</span>
          <span className={footSecs && secs > footSecs + 1 ? 'warn' : ''}>{formatDuration(footSecs)} of footage{footSecs && secs > footSecs + 1 ? ' — narration runs longer; footage will be held/extended' : ''}</span>
        </div>
        <div className="ps-footage">
          {scene.footage.map((f, i) => (
            <div key={i} className="ps-win">
              <Thumb src={mediaUrl(f.assetId, 'thumb')} seed={f.assetId} className="ps-win-thumb" />
              <div className="ps-win-meta">
                <select className="input ps-win-asset" value={f.assetId} onChange={(e) => setWin(i, { assetId: e.target.value })} aria-label="Source recording">
                  {!ready.some((a) => a.assetId === f.assetId) && <option value={f.assetId}>{assetName(f.assetId)}</option>}
                  {ready.map((a) => (
                    <option key={a.assetId} value={a.assetId}>{a.name}</option>
                  ))}
                </select>
                <div className="ps-win-range">
                  <input type="number" className="input" min={0} step={0.1} value={Number(f.start.toFixed(1))} onChange={(e) => setWin(i, { start: Math.max(0, Number(e.target.value)) })} aria-label="Start (seconds)" />
                  <span className="muted">→</span>
                  <input type="number" className="input" min={0} step={0.1} value={Number(f.end.toFixed(1))} onChange={(e) => setWin(i, { end: Math.max(0, Number(e.target.value)) })} aria-label="End (seconds)" />
                  <span className={clsx('ps-win-label', !(f.end > f.start) && 'bad')}>{formatTime(f.start)} – {formatTime(f.end)}</span>
                </div>
              </div>
              <button className="btn ghost sm icon" onClick={() => onChange({ footage: scene.footage.filter((_, j) => j !== i) })} aria-label="Remove footage window"><X size={13} /></button>
            </div>
          ))}
          {ready.length > 0 && (
            <button
              className="ps-win-add"
              onClick={() => {
                const last = scene.footage[scene.footage.length - 1]
                const assetId = last?.assetId ?? ready[0].assetId!
                const start = last?.end ?? 0
                onChange({ footage: [...scene.footage, { assetId, start, end: start + 5 }] })
              }}
            >
              <Plus size={13} /> Add footage
            </button>
          )}
        </div>
      </div>
      <button className="ps-scene-insert" onClick={onAddAfter} aria-label={`Add scene after scene ${index + 1}`} title="Add a scene here"><Plus size={13} /></button>
    </div>
  )
}

function ReviewStep({ s }: { s: WizardState }) {
  const patch = useWizard((st) => st.patch)
  const [dragFrom, setDragFrom] = useState<number>()
  const [over, setOver] = useState<number>()
  const set = (scenes: ScriptScene[]) => patch({ scenes })
  const firstAsset = readyAssetIds(s)[0]
  const totalWords = s.scenes.reduce((t, sc) => t + sceneWords(sc.narration), 0)
  const totalSecs = s.scenes.reduce((t, sc) => t + Math.max(narrationSeconds(sc.narration), sc.footage.reduce((a, f) => a + Math.max(0, f.end - f.start), 0)), 0)
  return (
    <div className="ps-wz-body">
      <div className="ps-wz-intro row" style={{ alignItems: 'flex-end' }}>
        <div style={{ flex: 1 }}>
          <h2>Review the script</h2>
          <p>Edit anything — titles, on-screen headlines, narration and the footage each scene uses. Drag to reorder.</p>
        </div>
        <div className="ps-script-stats">
          <div><strong>{s.scenes.length}</strong><span>scenes</span></div>
          <div><strong>{totalWords}</strong><span>words</span></div>
          <div><strong>{formatDuration(totalSecs)}</strong><span>est. length</span></div>
        </div>
      </div>
      {s.run.message && s.run.phase === 'script' && s.run.status === 'done' && (
        <div className="ps-alert info" style={{ marginBottom: 14 }}><Sparkles size={15} /> {s.run.message}</div>
      )}
      <div className="ps-scenes">
        {s.scenes.map((sc, i) => (
          <div key={sc.id} className={clsx('ps-scene-wrap', over === i && dragFrom !== undefined && dragFrom !== i && 'drop', dragFrom === i && 'dragging')}>
            <SceneCard
              scene={sc}
              index={i}
              total={s.scenes.length}
              s={s}
              onChange={(p) => patch((st) => ({ scenes: updateScene(st.scenes, sc.id, p) }))}
              onMove={(to) => set(moveScene(s.scenes, i, to))}
              onDelete={() => set(removeScene(s.scenes, sc.id))}
              onAddAfter={() => set(insertScene(s.scenes, i + 1, newScene(sc.footage[sc.footage.length - 1]?.assetId ?? firstAsset, sc)))}
              dragProps={{
                draggable: true,
                onDragStart: (e) => {
                  const t = e.target as HTMLElement
                  if (/INPUT|TEXTAREA|SELECT|BUTTON/.test(t.tagName)) return e.preventDefault()
                  setDragFrom(i)
                  e.dataTransfer.effectAllowed = 'move'
                },
                onDragOver: (e) => {
                  if (dragFrom === undefined) return
                  e.preventDefault()
                  setOver(i)
                },
                onDrop: (e) => {
                  e.preventDefault()
                  if (dragFrom !== undefined) set(moveScene(s.scenes, dragFrom, i))
                  setDragFrom(undefined)
                  setOver(undefined)
                },
                onDragEnd: () => {
                  setDragFrom(undefined)
                  setOver(undefined)
                },
              }}
            />
          </div>
        ))}
      </div>
      <button className="ps-add-scene" onClick={() => set(insertScene(s.scenes, s.scenes.length, newScene(firstAsset, s.scenes[s.scenes.length - 1])))}>
        <Plus size={16} /> Add scene
      </button>
    </div>
  )
}

// ---------------- ⑤ assemble ----------------
function AssembleStep({ s, onRun }: { s: WizardState; onRun: () => void }) {
  const navigate = useNavigate()
  const r = s.run
  const done = r.status === 'done' && r.phase === 'assemble'
  return (
    <div className="ps-wz-body ps-gen">
      <div className={clsx('ps-gen-orb', done && 'done')} aria-hidden>
        {done ? <Check size={36} strokeWidth={3} /> : <Clapperboard size={32} />}
      </div>
      <h2>{done ? 'Your video is ready' : r.status === 'error' ? 'Assembly failed' : r.status === 'running' ? 'Assembling your video' : 'Assemble the video'}</h2>
      <p className="ps-gen-line" aria-live="polite">
        {done
          ? `${s.scenes.length} scenes narrated, cut to your footage and styled with the ${s.brief.template ? 'selected' : 'default'} look. Fine-tune anything in the editor.`
          : r.status === 'error'
            ? r.error
            : r.status === 'running'
              ? r.message
              : r.interrupted
                ? 'Assembly was interrupted — resume to finish.'
                : `Producer will narrate ${s.scenes.length} scenes, cut the footage and apply your template look and captions.`}
      </p>
      {r.status === 'running' && (
        <div style={{ width: '100%', maxWidth: 440, margin: '4px auto 20px' }}>
          <Progress value={r.progress ?? -1} />
          <div className="muted" style={{ textAlign: 'center', fontSize: '0.75rem', marginTop: 8 }}>{r.progress && r.progress > 0 ? `${Math.round(r.progress * 100)}%` : 'Starting…'}</div>
        </div>
      )}
      <div className="row" style={{ justifyContent: 'center', marginTop: 20 }}>
        {done ? (
          <>
            <button className="btn primary ps-open-editor" onClick={() => navigate(`/edit/${s.projectId}`)}>
              <Clapperboard size={16} /> Open in editor
            </button>
            <button className="btn" onClick={() => useWizard.getState().patch({ step: 'review' })}>Back to script</button>
          </>
        ) : r.status === 'running' ? (
          <button className="btn" onClick={cancelRun}><Square size={13} /> Stop</button>
        ) : (
          <button className="btn primary" onClick={onRun}>
            {r.status === 'error' ? <><RotateCcw size={15} /> Try again</> : <><Clapperboard size={15} /> {r.interrupted ? 'Resume' : 'Assemble video'}</>}
          </button>
        )}
      </div>
    </div>
  )
}

// ---------------- page ----------------
export default function ProducerWizard() {
  usePageTitle('Producer AI')
  const { projectId } = useParams()
  const navigate = useNavigate()
  const workspaceId = useSession((s) => s.workspaceId)
  const s = useWizard((st) => st.s)
  const patch = useWizard((st) => st.patch)
  const replace = useWizard((st) => st.replace)
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState<string>()
  const [confirmReset, setConfirmReset] = useState(false)
  const [confirmRegen, setConfirmRegen] = useState(false)
  const templates = useAsync(() => (workspaceId ? api.templates(workspaceId) : Promise.resolve([] as TemplateSummary[])), [workspaceId])

  // Load / resume wizard state for this URL.
  useEffect(() => {
    const cur = useWizard.getState().s
    setLoadError(undefined)
    if (projectId) {
      if (cur.projectId === projectId) return
      const saved = ssGet<WizardState>(storageKey(projectId))
      if (saved && saved.brief) {
        replace(sanitizeForResume(saved))
        resumeProcessingAssets()
        return
      }
      setLoading(true)
      api
        .project(projectId)
        .then((res) => {
          if (res.summary.kind !== 'producer' && !res.project.ai) {
            navigate(`/edit/${projectId}`, { replace: true })
            return
          }
          replace(stateFromProject(res))
        })
        .catch((e) => setLoadError(e instanceof Error ? e.message : String(e)))
        .finally(() => setLoading(false))
      return
    }
    const h = takeProducerHandoff()
    if (h) {
      replace(initialState({ prompt: h.prompt, aspect: h.aspect }))
      if (h.files.length && workspaceId) void uploadToWizard(workspaceId, h.files)
      return
    }
    if (!cur.projectId && (cur.assets.length || cur.brief.title)) return // in-memory draft
    const draft = ssGet<WizardState>(storageKey())
    replace(draft && draft.brief ? sanitizeForResume(draft) : initialState())
    resumeProcessingAssets()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId])

  // Brand defaults (voice) and first template look for fresh briefs.
  useEffect(() => {
    if (!workspaceId || s.projectId) return
    let alive = true
    api
      .brand(workspaceId)
      .then((b) => {
        if (alive && b.voice && useWizard.getState().s.brief.voice === 'af_heart' && !useWizard.getState().s.projectId) patch((st) => ({ brief: { ...st.brief, voice: b.voice! } }))
      })
      .catch(() => undefined)
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId])
  useEffect(() => {
    const first = templates.data?.find((t) => t.builtIn)
    if (first && !useWizard.getState().s.brief.template) patch((st) => ({ brief: { ...st.brief, template: first.id } }))
  }, [templates.data, patch])

  const adv = useMemo(() => canAdvance(s), [s])
  const idx = ORDER.indexOf(s.step)

  const onProjectCreated = (id: string) => navigate(`/producer/${id}`, { replace: true })
  const generate = () => workspaceId && void runGenerate(workspaceId, onProjectCreated)

  function next() {
    if (!adv.ok) return
    if (s.step === 'upload') patch({ step: 'brief' })
    else if (s.step === 'brief') {
      // Script already exists and nothing new to transcribe → go straight to review.
      if (s.scenes.length && readyAssetIds(s).every((id) => s.transcribed.includes(id))) patch({ step: 'review' })
      else {
        patch({ step: 'generate' })
        generate()
      }
    } else if (s.step === 'generate') patch({ step: 'review' })
    else if (s.step === 'review') {
      patch({ step: 'assemble' })
      void runAssemble()
    }
  }
  function back() {
    if (s.run.status === 'running') return
    const prev: Partial<Record<StepId, StepId>> = { brief: 'upload', generate: 'brief', review: 'brief', assemble: 'review' }
    const p = prev[s.step]
    if (p) patch({ step: p })
  }

  if (loading) {
    return (
      <div className="ps-page narrow">
        <div className="skeleton" style={{ height: 64, borderRadius: 14 }} />
        <div className="skeleton" style={{ height: 380, borderRadius: 18, marginTop: 20 }} />
      </div>
    )
  }
  if (loadError) {
    return (
      <div className="ps-page narrow">
        <div className="ps-alert" role="alert">Couldn’t open this Producer project: {loadError}</div>
        <button className="btn" style={{ marginTop: 14 }} onClick={() => navigate('/producer/new')}>Start a new one</button>
      </div>
    )
  }
  if (!workspaceId) return null

  const primaryLabel = s.step === 'upload' ? 'Continue to brief' : s.step === 'brief' ? (s.scenes.length && readyAssetIds(s).every((id) => s.transcribed.includes(id)) ? 'Back to script' : 'Write the script') : s.step === 'review' ? 'Assemble video' : null

  return (
    <div className="ps-page narrow ps-wizard">
      <div className="ps-wz-head">
        <div>
          <span className="eyebrow" style={{ color: 'var(--accent)' }}><Sparkles size={11} style={{ verticalAlign: -1 }} /> Producer AI</span>
          <h1>{s.brief.title || 'New video from a recording'}</h1>
        </div>
        <span className="spacer" />
        {s.projectId && (
          <button className="btn ghost sm" onClick={() => navigate('/library')} title="Your work is saved"><FolderOpen size={14} /> Saved in Library</button>
        )}
        {confirmReset ? (
          <span className="row" style={{ gap: 6 }}>
            <span className="muted" style={{ fontSize: '0.75rem' }}>Start a new video?</span>
            <button
              className="btn sm"
              onClick={() => {
                setConfirmReset(false)
                replace(initialState())
                navigate('/producer/new')
              }}
            >
              Yes, start over
            </button>
            <button className="btn ghost sm" onClick={() => setConfirmReset(false)}>Cancel</button>
          </span>
        ) : (
          (s.assets.length > 0 || s.projectId) && s.run.status !== 'running' && (
            <button className="btn ghost sm" onClick={() => setConfirmReset(true)}><RotateCcw size={14} /> Start over</button>
          )
        )}
      </div>
      <Stepper s={s} onJump={(id) => patch({ step: id })} />

      <div className="ps-wz-card">
        {s.step === 'upload' && <UploadStep s={s} workspaceId={workspaceId} />}
        {s.step === 'brief' && <BriefStep s={s} templates={templates.data ?? []} tplLoading={templates.loading} />}
        {s.step === 'generate' && <GenerateStep s={s} onRun={generate} />}
        {s.step === 'review' && <ReviewStep s={s} />}
        {s.step === 'assemble' && <AssembleStep s={s} onRun={() => void runAssemble()} />}

        {(primaryLabel || idx > 0) && s.step !== 'assemble' && !(s.step === 'generate' && s.run.status === 'running') && (
          <div className="ps-wz-foot">
            {idx > 0 && s.step !== 'generate' ? (
              <button className="btn ghost" onClick={back} disabled={s.run.status === 'running'}><ArrowLeft size={15} /> Back</button>
            ) : s.step === 'generate' && s.run.status !== 'running' ? (
              <button className="btn ghost" onClick={back}><ArrowLeft size={15} /> Edit brief</button>
            ) : (
              <span />
            )}
            <span className="spacer" />
            {!adv.ok && adv.reason && primaryLabel && <span className="muted" style={{ fontSize: '0.7812rem' }}>{adv.reason}</span>}
            {s.step === 'review' &&
              (confirmRegen ? (
                <span className="row" style={{ gap: 6 }}>
                  <span className="muted" style={{ fontSize: '0.7812rem' }}>Replace this script?</span>
                  <button
                    className="btn"
                    onClick={() => {
                      setConfirmRegen(false)
                      patch({ step: 'generate', scenes: [], run: { status: 'idle' } })
                      generate()
                    }}
                  >
                    Yes, rewrite
                  </button>
                  <button className="btn ghost" onClick={() => setConfirmRegen(false)}>Keep</button>
                </span>
              ) : (
                <button className="btn" onClick={() => setConfirmRegen(true)} title="Discard these edits and write a fresh script">
                  <RefreshCw size={14} /> Regenerate
                </button>
              ))}
            {primaryLabel && (
              <button className="btn primary" disabled={!adv.ok} onClick={next}>
                {primaryLabel} <ArrowRight size={15} />
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
