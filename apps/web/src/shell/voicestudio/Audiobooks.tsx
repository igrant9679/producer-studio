// Audiobooks (desktop): VoiceStudio's long-form renderer — manuscript (paste or import TXT/MD/EPUB/PDF) → chapters →
// narrated M4B/MP3 with a default voice, character voices and loudness mastering → added to the library.
import type { VoiceProfile } from '@producer/core'
import { BookOpen, Check, FileUp, Library, Play, Plus, Square, Trash2 } from 'lucide-react'
import { useRef, useState } from 'react'
import { create } from 'zustand'
import { useSession } from '../../lib/session'
import { toast, toastError } from '../../lib/toast'
import { useJobs } from '../stores'
import { Progress, Spinner, useAsync, useAudioPreview } from '../ui'
import { formatDuration } from '../util'
import { DesktopOnly, EngineGate, LANGUAGES, useEngine } from './shared'
import { readSse, vsApi, vsFetch, vsGet, vsUrl } from './vsApi'

interface Plan {
  chapters: Array<{ title: string; char_count: number; spans: Array<{ voice_id?: string; text: string }> }>
  chapter_count: number
  char_count: number
}

interface RenderState {
  running: boolean
  title?: string
  chapter?: number
  total?: number
  phase?: string
  output?: string
  duration?: number
  failed?: number[]
  error?: string
  ctrl?: AbortController
}

/** The render lives outside the component: switching tabs mustn't stop it (closing the stream stops VoiceStudio’s render). */
const useRender = create<RenderState & { set: (p: Partial<RenderState>) => void }>((set) => ({ running: false, set: (p) => set(p) }))

export default function Audiobooks({ onOpenEngine }: { onOpenEngine: () => void }) {
  const { desktop, status, running } = useEngine()
  if (!desktop) return <DesktopOnly feature="Audiobooks" />
  return (
    <EngineGate status={status} onOpenEngine={onOpenEngine}>
      {running && <AudiobookStudio />}
    </EngineGate>
  )
}

function AudiobookStudio() {
  const workspaceId = useSession((s) => s.workspaceId)!
  const userName = useSession((s) => s.user?.name ?? '')
  const profiles = useAsync(() => vsApi.profiles(workspaceId), [workspaceId])
  const voices = (profiles.data ?? []).filter((p): p is VoiceProfile & { vsProfileId: string } => !!p.local && !!p.vsProfileId)
  const [text, setText] = useState('')
  const [title, setTitle] = useState('')
  const [author, setAuthor] = useState(userName)
  const [voice, setVoice] = useState('')
  const [language, setLanguage] = useState('English')
  const [format, setFormat] = useState<'m4b' | 'mp3'>('m4b')
  const [loudness, setLoudness] = useState<'' | 'acx' | 'podcast'>('acx')
  const [cast, setCast] = useState<Array<{ name: string; voice: string }>>([])
  const [plan, setPlan] = useState<Plan>()
  const [busy, setBusy] = useState<string>()
  const fileRef = useRef<HTMLInputElement>(null)
  const r = useRender()
  const preview = useAudioPreview((s) => s.toggle)

  const voiceMap = () => Object.fromEntries(cast.filter((c) => c.name.trim() && c.voice).map((c) => [c.name.trim(), c.voice]))

  async function importFile(f: File) {
    setBusy('import')
    try {
      const form = new FormData()
      form.set('file', f, f.name)
      const j = (await (await vsFetch('/audiobook/import', { body: form })).json()) as { text: string }
      setText(j.text)
      if (!title) setTitle(f.name.replace(/\.[^.]+$/, ''))
      setPlan(undefined)
    } catch (e) {
      toastError(e)
    } finally {
      setBusy(undefined)
    }
  }

  async function makePlan() {
    setBusy('plan')
    try {
      setPlan(await vsGet<Plan>('/audiobook/plan', { method: 'POST', body: { text, default_voice: voice || undefined } }))
    } catch (e) {
      toastError(e)
    } finally {
      setBusy(undefined)
    }
  }

  async function previewChapter(i: number) {
    setBusy(`pv${i}`)
    try {
      const j = await vsGet<{ output: string; duration_s: number }>('/audiobook/preview', { method: 'POST', body: { text, chapter_index: i, default_voice: voice || undefined, language: language === 'Auto' ? undefined : language, voice_map: voiceMap() } })
      preview(`ab:${j.output}`, vsUrl(`/audio/${j.output.split('/').map(encodeURIComponent).join('/')}`))
    } catch (e) {
      toastError(e)
    } finally {
      setBusy(undefined)
    }
  }

  async function render() {
    const st = useRender.getState()
    if (st.running) return
    const ctrl = new AbortController()
    st.set({ running: true, title: title || 'Audiobook', chapter: 0, total: plan?.chapter_count, phase: 'Starting', output: undefined, error: undefined, failed: undefined, ctrl })
    try {
      const res = await vsFetch('/audiobook', {
        signal: ctrl.signal,
        body: {
          text,
          default_voice: voice || undefined,
          language: language === 'Auto' ? undefined : language,
          voice_map: voiceMap(),
          format,
          bitrate: '128k',
          loudness: loudness || null,
          metadata: { title: title || 'Audiobook', author: author || undefined },
        },
      })
      for await (const ev of readSse(res, ctrl.signal)) {
        const d = ev.data ?? {}
        const s = useRender.getState()
        if (d.type === 'started') s.set({ total: d.chapters, phase: 'Narrating' })
        else if (d.type === 'chapter') s.set({ chapter: d.index + 1, total: d.total, phase: `Chapter ${d.index + 1} of ${d.total}${d.title ? ` — ${d.title}` : ''}` })
        else if (d.type === 'chapter_error') s.set({ phase: `Chapter ${d.index + 1} failed; continuing` })
        else if (d.type === 'assembling') s.set({ phase: 'Assembling chapters' })
        else if (d.type === 'mastering') s.set({ phase: `Mastering loudness (${d.preset ?? ''})` })
        else if (d.type === 'error') throw new Error(d.error || d.reason || 'The render failed')
        else if (d.type === 'stopped') throw new Error('Stopped')
        else if (d.type === 'done') {
          s.set({ running: false, output: d.output, duration: d.duration_s, failed: d.failed_chapters, phase: 'Done' })
          toast('Audiobook ready')
          return
        }
      }
      throw new Error('The render stopped before it finished')
    } catch (e) {
      useRender.getState().set({ running: false, error: e instanceof Error ? e.message : String(e) })
    }
  }

  async function addToLibrary() {
    if (!r.output) return
    try {
      const j = await vsApi.importOutput({ workspaceId, source: `/audio/${r.output.split('/').map(encodeURIComponent).join('/')}`, name: r.title || 'Audiobook', kind: 'audio', ext: `.${format}` })
      useJobs.getState().upsert(j)
      toast('Adding the audiobook to the library')
    } catch (e) {
      toastError(e)
    }
  }

  const words = text.trim() ? text.trim().split(/\s+/).length : 0
  return (
    <div className="ps-vs">
      <div className="ps-vs-main">
        <div className="ps-vs-editor">
          <input className="ps-vs-name" placeholder="Book title" value={title} onChange={(e) => setTitle(e.target.value)} aria-label="Title" />
          <textarea
            className="ps-vs-text"
            style={{ minHeight: 380 }}
            value={text}
            onChange={(e) => {
              setText(e.target.value)
              setPlan(undefined)
            }}
            placeholder={'Paste your manuscript. Start each chapter with a Markdown heading:  # Chapter 1\nSwitch narrator mid-text with  [voice:Maya]  and map the names to voices on the right. Add a pause with  [pause 1s].'}
            aria-label="Manuscript"
          />
          <div className="ps-vs-bar">
            <button className="btn sm" disabled={!!busy} onClick={() => fileRef.current?.click()}>{busy === 'import' ? <Spinner size={13} /> : <FileUp size={13} />} Import TXT, Markdown, EPUB or PDF</button>
            <input ref={fileRef} type="file" accept=".txt,.md,.markdown,.epub,.pdf" hidden onChange={(e) => {
              const f = e.target.files?.[0]
              if (f) void importFile(f)
              e.target.value = ''
            }} />
            <span className="spacer" />
            <span className="muted" style={{ fontSize: '0.75rem', fontFamily: 'var(--font-mono)' }}>{words.toLocaleString()} words · ≈ {formatDuration((words / 150) * 60)}</span>
          </div>
        </div>

        {plan && (
          <div className="ps-section" style={{ marginTop: 20 }}>
            <div className="ps-section-head"><BookOpen size={16} /> <h2 className="ps-h2">{plan.chapter_count} chapter{plan.chapter_count === 1 ? '' : 's'}</h2></div>
            <div className="vs-engine-list">
              {plan.chapters.map((c, i) => (
                <div key={i} className="vs-engine-row">
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <strong className="ellipsis">{c.title || `Chapter ${i + 1}`}</strong>
                    <span className="muted" style={{ fontSize: '0.75rem' }}>{c.char_count.toLocaleString()} characters · {new Set(c.spans.map((s) => s.voice_id ?? 'narrator')).size} voice(s)</span>
                  </div>
                  <button className="btn sm" disabled={!!busy} onClick={() => previewChapter(i)}>{busy === `pv${i}` ? <Spinner size={12} /> : <Play size={13} />} Preview</button>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      <aside className="ps-vs-side">
        <div className="ps-vs-panel">
          <label className="label">Narrator</label>
          <select className="input" value={voice} onChange={(e) => setVoice(e.target.value)}>
            <option value="">VoiceStudio default voice</option>
            {voices.map((v) => <option key={v.id} value={v.vsProfileId}>{v.name}</option>)}
          </select>
          {!voices.length && <div className="muted" style={{ fontSize: '0.7188rem', marginTop: 4 }}>Clone or design a voice in My voices to narrate with it.</div>}

          <label className="label" style={{ marginTop: 12 }}>Character voices <span className="muted">([voice:Name] in the text)</span></label>
          {cast.map((c, i) => (
            <div key={i} className="row" style={{ gap: 6, marginBottom: 6 }}>
              <input className="input" placeholder="Name" value={c.name} onChange={(e) => setCast((cur) => cur.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} style={{ width: 100 }} />
              <select className="input" value={c.voice} onChange={(e) => setCast((cur) => cur.map((x, j) => (j === i ? { ...x, voice: e.target.value } : x)))}>
                <option value="">Choose a voice</option>
                {voices.map((v) => <option key={v.id} value={v.vsProfileId}>{v.name}</option>)}
              </select>
              <button className="btn ghost icon sm" aria-label="Remove" onClick={() => setCast((cur) => cur.filter((_, j) => j !== i))}><Trash2 size={13} /></button>
            </div>
          ))}
          <button className="btn ghost sm" onClick={() => setCast((cur) => [...cur, { name: '', voice: '' }])} disabled={!voices.length}><Plus size={13} /> Add a character</button>

          <div className="vs-form-grid" style={{ marginTop: 12 }}>
            <div>
              <label className="label">Language</label>
              <select className="input" value={language} onChange={(e) => setLanguage(e.target.value)}>{LANGUAGES.map((l) => <option key={l}>{l}</option>)}</select>
            </div>
            <div>
              <label className="label">Format</label>
              <select className="input" value={format} onChange={(e) => setFormat(e.target.value as 'm4b' | 'mp3')}>
                <option value="m4b">M4B (chapters)</option>
                <option value="mp3">MP3</option>
              </select>
            </div>
            <div>
              <label className="label">Mastering</label>
              <select className="input" value={loudness} onChange={(e) => setLoudness(e.target.value as '' | 'acx' | 'podcast')}>
                <option value="acx">ACX / Audible</option>
                <option value="podcast">Podcast</option>
                <option value="">None</option>
              </select>
            </div>
            <div>
              <label className="label">Author</label>
              <input className="input" value={author} onChange={(e) => setAuthor(e.target.value)} />
            </div>
          </div>

          <button className="btn" style={{ width: '100%', marginTop: 14 }} disabled={!text.trim() || !!busy} onClick={makePlan}>{busy === 'plan' ? <Spinner size={13} /> : <BookOpen size={14} />} Split into chapters &amp; preview</button>

          {r.running ? (
            <div className="ps-vs-gen" style={{ marginTop: 10 }}>
              <div className="row" style={{ fontSize: '0.7812rem' }}><Spinner size={13} /> {r.phase}</div>
              <Progress value={r.total ? (r.chapter ?? 0) / r.total : -1} />
              <div className="muted" style={{ fontSize: '0.7188rem' }}>Keep Producer Studio open until it finishes.</div>
              <button className="btn ghost sm" onClick={() => r.ctrl?.abort()}><Square size={12} /> Stop</button>
            </div>
          ) : (
            <button className="btn primary ps-vs-go" style={{ marginTop: 10 }} disabled={!text.trim()} onClick={render}><BookOpen size={16} /> Render audiobook</button>
          )}
          {r.error && <div className="ps-alert" style={{ marginTop: 10 }}>{r.error}</div>}
          {r.output && !r.running && (
            <div className="ps-vs-gen" style={{ marginTop: 10 }}>
              <div className="row" style={{ fontSize: '0.8125rem' }}><Check size={14} style={{ color: 'var(--green)' }} /> {r.title} · {formatDuration(r.duration ?? 0)}{r.failed?.length ? ` · ${r.failed.length} chapter(s) failed` : ''}</div>
              <audio src={vsUrl(`/audio/${r.output.split('/').map(encodeURIComponent).join('/')}`)} controls style={{ width: '100%' }} />
              <button className="btn sm" onClick={addToLibrary}><Library size={13} /> Add to library</button>
            </div>
          )}
        </div>
      </aside>
    </div>
  )
}
