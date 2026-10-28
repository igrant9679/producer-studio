// Text-to-speech script tools (A-20): pause and emphasis markup, the space's pronunciation dictionary, batch voiceovers
// from a CSV, and the same line in several voices side by side.
import type { AssetRecord, Pronunciation, Voice } from '@producer/core'
import { BATCH_MAX_ROWS, PREVIEW_CHARS, PRONUNCIATIONS_MAX, parseVoiceCsv, type CsvVoiceRow } from '@producer/core'
import { Check, Columns3, FileSpreadsheet, Pause, Play, Plus, Square, Trash2, Upload, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { api, waitForJob } from '../../lib/api'
import { useSession } from '../../lib/session'
import { voiceApi } from '../../lib/studioApi'
import { toast, toastError } from '../../lib/toast'
import { isCustomVoice, useVoicesVersion } from '../components/VoiceCard'
import { useJobs } from '../stores'
import { Modal, Spinner, useEditGate, useFilePicker } from '../ui'

// ---------- markup ----------

/** Insert a pause at the cursor, or put the selected words in *emphasis*. */
export function applyMarkup(text: string, start: number, end: number, kind: 'pause' | 'emphasis'): { text: string; cursor: number } {
  if (kind === 'pause') {
    const before = text.slice(0, start)
    const ins = `${before && !/\s$/.test(before) ? ' ' : ''}[pause]${text.slice(end).startsWith(' ') ? '' : ' '}`
    return { text: before + ins + text.slice(end), cursor: start + ins.length }
  }
  if (end <= start) return { text, cursor: start }
  const word = text.slice(start, end)
  const lead = word.match(/^\s*/)![0]
  const trail = word.match(/\s*$/)![0]
  const core = word.trim()
  if (!core) return { text, cursor: end }
  const wrapped = `${lead}*${core}*${trail}`
  return { text: text.slice(0, start) + wrapped + text.slice(end), cursor: start + wrapped.length }
}

export function MarkupButtons({ taRef, text, setText, disabled }: { taRef: React.RefObject<HTMLTextAreaElement>; text: string; setText: (t: string) => void; disabled?: boolean }) {
  const apply = (kind: 'pause' | 'emphasis') => {
    const ta = taRef.current
    const start = ta?.selectionStart ?? text.length
    const end = ta?.selectionEnd ?? text.length
    if (kind === 'emphasis' && end <= start) return toast('Select the words to stress first')
    const r = applyMarkup(text, start, end, kind)
    setText(r.text)
    requestAnimationFrame(() => {
      taRef.current?.focus()
      taRef.current?.setSelectionRange(r.cursor, r.cursor)
    })
  }
  return (
    <>
      <button type="button" className="btn ghost sm" onClick={() => apply('pause')} disabled={disabled} title="Insert a pause at the cursor: [pause], or [pause 2s]">
        <Pause size={13} /> Pause
      </button>
      <button type="button" className="btn ghost sm" onClick={() => apply('emphasis')} disabled={disabled} title="Stress the selected words: *like this*">
        <strong style={{ fontStyle: 'italic' }}>B</strong> Emphasis
      </button>
    </>
  )
}

// ---------- pronunciation dictionary ----------

export function PronunciationsModal({ onClose }: { onClose: () => void }) {
  const workspaceId = useSession((s) => s.workspaceId)
  const gate = useEditGate()
  const [rows, setRows] = useState<Pronunciation[]>()
  const [error, setError] = useState<string>()
  const [saving, setSaving] = useState(false)
  useEffect(() => {
    if (!workspaceId) return
    voiceApi
      .settings(workspaceId)
      .then((s) => setRows(s.pronunciations.length ? s.pronunciations : [{ word: '', say: '' }]))
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
  }, [workspaceId])
  const set = (i: number, p: Partial<Pronunciation>) => setRows((r) => r?.map((x, j) => (j === i ? { ...x, ...p } : x)))
  async function save() {
    if (!workspaceId || !rows) return
    setSaving(true)
    try {
      const out = await voiceApi.saveSettings(workspaceId, { pronunciations: rows.filter((r) => r.word.trim() && r.say.trim()) })
      toast(`Pronunciations saved: ${out.pronunciations.length} word${out.pronunciations.length === 1 ? '' : 's'}`)
      onClose()
    } catch (e) {
      toastError(e)
    } finally {
      setSaving(false)
    }
  }
  return (
    <Modal
      title="Pronunciations"
      subtitle="How this space’s voices say brand names, acronyms and other words. Used by every voiceover here, Producer AI’s narration too."
      onClose={onClose}
      width={600}
      footer={
        <>
          <button className="btn ghost" onClick={onClose}>Cancel</button>
          <button className="btn primary" onClick={() => void save()} disabled={!rows || saving || !gate.canEdit} data-tip={gate.tip}>{saving ? <Spinner /> : <Check size={14} />} Save</button>
        </>
      }
    >
      {error ? (
        <div className="ps-alert" role="alert">Couldn’t load the pronunciations: {error}</div>
      ) : !rows ? (
        <Spinner />
      ) : (
        <>
          <div className="vs-dict" role="list" aria-label="Pronunciations">
            {rows.map((r, i) => (
              <div key={i} className="vs-dict-row" role="listitem">
                <input className="input" value={r.word} onChange={(e) => set(i, { word: e.target.value })} placeholder="Word, e.g. Kubernetes" aria-label={`Word ${i + 1}`} disabled={!gate.canEdit} maxLength={80} />
                <input className="input" value={r.say} onChange={(e) => set(i, { say: e.target.value })} placeholder="Say it as, e.g. koo-ber-net-eez" aria-label={`Say word ${i + 1} as`} disabled={!gate.canEdit} maxLength={160} />
                <button className="btn ghost sm icon" onClick={() => setRows((cur) => cur?.filter((_, j) => j !== i))} aria-label={`Remove word ${i + 1}`} disabled={!gate.canEdit}><Trash2 size={13} /></button>
              </div>
            ))}
          </div>
          <button className="btn sm" style={{ marginTop: 10 }} onClick={() => setRows((cur) => [...(cur ?? []), { word: '', say: '' }])} disabled={!gate.canEdit || rows.length >= PRONUNCIATIONS_MAX}><Plus size={13} /> Add a word</button>
        </>
      )}
    </Modal>
  )
}

// ---------- batch voiceovers from a CSV ----------

type RowState = { status: 'waiting' | 'running' | 'done' | 'failed' | 'skipped'; message?: string; asset?: AssetRecord }

const autoName = (text: string) => `${text.split(/\s+/).slice(0, 5).join(' ')}…`

function readText(f: Blob): Promise<string> {
  if (typeof f.text === 'function') return f.text()
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(String(r.result ?? ''))
    r.onerror = () => reject(r.error)
    r.readAsText(f)
  })
}

export function BatchCsvModal({ voices, defaultVoice, speed, onClose }: { voices: Voice[]; defaultVoice: string; speed: number; onClose: () => void }) {
  const workspaceId = useSession((s) => s.workspaceId)
  const gate = useEditGate()
  const [file, setFile] = useState<string>()
  const [rows, setRows] = useState<CsvVoiceRow[]>([])
  const [states, setStates] = useState<Record<number, RowState>>({})
  const [running, setRunning] = useState(false)
  const stop = useRef(false)
  const pick = useFilePicker('.csv,text/csv', false, async ([f]) => {
    if (!f) return
    const text = await readText(f)
    setFile(f.name)
    setStates({})
    setRows(parseVoiceCsv(text, new Set(voices.map((v) => v.id))))
  })
  const ok = rows.filter((r) => !r.error)
  const voiceName = (id: string) => voices.find((v) => v.id === id)?.name ?? id

  async function run() {
    if (!workspaceId) return
    stop.current = false
    setRunning(true)
    let made = 0
    for (const r of ok) {
      if (stop.current) {
        setStates((s) => ({ ...s, [r.line]: { status: 'skipped', message: 'Stopped' } }))
        continue
      }
      setStates((s) => ({ ...s, [r.line]: { status: 'running', message: 'Queued…' } }))
      try {
        const voice = r.voice ?? defaultVoice
        const job = await api.tts({ workspaceId, text: r.text, voice, speed: r.speed ?? speed, name: r.name || `${autoName(r.text)} — ${voiceName(voice)}` })
        const done = await waitForJob<{ asset: AssetRecord; duration: number }>(job.id, (j) => {
          useJobs.getState().upsert(j)
          setStates((s) => ({ ...s, [r.line]: { status: 'running', message: j.message || 'Generating…' } }))
        })
        made++
        setStates((s) => ({ ...s, [r.line]: { status: 'done', asset: done.result?.asset } }))
      } catch (e) {
        setStates((s) => ({ ...s, [r.line]: { status: 'failed', message: e instanceof Error ? e.message : String(e) } }))
      }
    }
    setRunning(false)
    toast(`${made} voiceover${made === 1 ? '' : 's'} made from ${file ?? 'the CSV'}: they’re in the History and the Library`)
  }

  return (
    <Modal
      title="Batch voiceovers from a CSV"
      subtitle={`One voiceover per row: a text column (or just one column of lines), with optional voice, name and speed columns. At most ${BATCH_MAX_ROWS} at a time.`}
      onClose={() => {
        if (running) stop.current = true
        onClose()
      }}
      width={760}
      footer={
        <>
          {running ? (
            <button className="btn" onClick={() => (stop.current = true)}><Square size={13} /> Stop after this one</button>
          ) : (
            <button className="btn ghost" onClick={onClose}>Close</button>
          )}
          <button className="btn primary" onClick={() => void run()} disabled={running || !ok.length || !gate.canEdit} data-tip={gate.tip}>
            {running ? <Spinner /> : <FileSpreadsheet size={14} />} Generate {ok.length} voiceover{ok.length === 1 ? '' : 's'}
          </button>
        </>
      }
    >
      <div className="row" style={{ gap: 10, marginBottom: 12, flexWrap: 'wrap' }}>
        <button className="btn" onClick={pick} disabled={running}><Upload size={14} /> {file ? 'Choose another CSV' : 'Choose a CSV file'}</button>
        {file && <span className="muted" style={{ fontSize: '0.8125rem' }}>{file}: {rows.length} row{rows.length === 1 ? '' : 's'}, {rows.length - ok.length} with a problem</span>}
        <span className="spacer" />
        <span className="muted" style={{ fontSize: '0.75rem' }}>Rows without a voice use {voiceName(defaultVoice)}.</span>
      </div>
      {rows.length > 0 && (
        <div className="vs-batch-wrap">
          <table className="vs-batch-table">
            <thead>
              <tr><th>Line</th><th>Name</th><th>Text</th><th>Voice</th><th>Status</th></tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const st = states[r.line]
                return (
                  <tr key={r.line}>
                    <td>{r.line}</td>
                    <td>{r.name ?? '—'}</td>
                    <td>{r.text.length > 90 ? `${r.text.slice(0, 90)}…` : r.text || '—'}</td>
                    <td>{voiceName(r.voice ?? defaultVoice)}{r.speed ? ` · ${r.speed}×` : ''}</td>
                    <td className={r.error || st?.status === 'failed' ? 'err' : undefined}>
                      {r.error ?? (st ? (st.status === 'done' ? 'Done' : st.status === 'running' ? st.message : st.status === 'failed' ? st.message : 'Stopped') : 'Ready')}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </Modal>
  )
}

// ---------- side-by-side comparison ----------

/** The line to compare voices with: the selected text, else the script's first sentence (≤ PREVIEW_CHARS). */
export function compareLine(text: string, selection = ''): string {
  const src = (selection.trim() || text.trim().split(/(?<=[.!?])\s+/)[0] || '').trim()
  return src.slice(0, PREVIEW_CHARS)
}

interface Take {
  voice: string
  url?: string
  busy?: boolean
  error?: string
}

export function CompareModal({ voices, initial, text, onUse, onClose }: { voices: Voice[]; initial: string[]; text: string; onUse: (voice: string) => void; onClose: () => void }) {
  const workspaceId = useSession((s) => s.workspaceId)
  const builtIn = voices.filter((v) => !isCustomVoice(v))
  const pickable = (id: string) => builtIn.some((v) => v.id === id)
  const [line, setLine] = useState(text || 'Hi, I’m your narrator. Let’s make something worth watching.')
  const [takes, setTakes] = useState<Take[]>(() => {
    const ids = [...new Set(initial.filter(pickable))]
    for (const v of builtIn) if (ids.length < 3 && !ids.includes(v.id)) ids.push(v.id)
    return ids.slice(0, 3).map((voice) => ({ voice }))
  })
  const [playing, setPlaying] = useState<number>()
  const audio = useRef<HTMLAudioElement | null>(null)
  const ctrl = useRef<AbortController>()
  const takesRef = useRef(takes)
  takesRef.current = takes
  useEffect(
    () => () => {
      ctrl.current?.abort()
      audio.current?.pause()
      for (const t of takesRef.current) if (t.url) URL.revokeObjectURL(t.url)
    },
    [],
  )

  const setTake = (i: number, p: Partial<Take>) => setTakes((cur) => cur.map((t, j) => (j === i ? { ...t, ...p } : t)))

  async function makeAll() {
    if (!workspaceId || !line.trim()) return
    ctrl.current?.abort()
    ctrl.current = new AbortController()
    const signal = ctrl.current.signal
    for (let i = 0; i < takesRef.current.length; i++) {
      const t = takesRef.current[i]
      if (t.url) URL.revokeObjectURL(t.url)
      setTake(i, { busy: true, error: undefined, url: undefined })
      try {
        const blob = await voiceApi.preview(workspaceId, { text: line.trim(), voice: t.voice }, signal)
        setTake(i, { busy: false, url: URL.createObjectURL(blob) })
      } catch (e) {
        if (signal.aborted) return
        setTake(i, { busy: false, error: e instanceof Error ? e.message : String(e) })
      }
    }
  }

  function play(i: number) {
    const t = takes[i]
    audio.current?.pause()
    if (playing === i || !t.url) return setPlaying(undefined)
    const a = new Audio(t.url)
    audio.current = a
    a.onended = () => setPlaying(undefined)
    void a.play().catch(() => setPlaying(undefined))
    setPlaying(i)
  }

  const nameOf = (id: string) => voices.find((v) => v.id === id)?.name ?? id
  return (
    <Modal title="Compare voices" subtitle="The same line in up to three voices, side by side. Nothing is saved until you pick one and generate." onClose={onClose} width={760}>
      <label className="label" htmlFor="vs-compare-line">Line</label>
      <textarea id="vs-compare-line" className="input" rows={2} maxLength={PREVIEW_CHARS} value={line} onChange={(e) => setLine(e.target.value)} />
      <div className="vs-compare" style={{ marginTop: 12 }}>
        {takes.map((t, i) => (
          <div key={i} className="vs-compare-col">
            <select className="input" value={t.voice} onChange={(e) => setTake(i, { voice: e.target.value, url: undefined, error: undefined })} aria-label={`Voice ${i + 1}`}>
              {builtIn.map((v) => <option key={v.id} value={v.id}>{v.name} — {v.style}</option>)}
            </select>
            <div className="row" style={{ gap: 6 }}>
              <button className="btn sm" onClick={() => play(i)} disabled={!t.url} aria-label={playing === i ? `Stop ${nameOf(t.voice)}` : `Play ${nameOf(t.voice)}`}>
                {t.busy ? <Spinner size={13} /> : playing === i ? <Square size={13} /> : <Play size={13} />} {playing === i ? 'Stop' : 'Play'}
              </button>
              <button className="btn sm primary" onClick={() => { onUse(t.voice); onClose() }}><Check size={13} /> Use {nameOf(t.voice)}</button>
              {takes.length > 2 && <button className="btn ghost sm icon" onClick={() => setTakes((cur) => cur.filter((_, j) => j !== i))} aria-label={`Remove voice ${i + 1}`}><X size={13} /></button>}
            </div>
            {t.error && <div className="ps-field-err" role="alert">{t.error}</div>}
          </div>
        ))}
      </div>
      <div className="row" style={{ marginTop: 12, gap: 8 }}>
        {takes.length < 3 && <button className="btn sm" onClick={() => setTakes((cur) => [...cur, { voice: builtIn.find((v) => !cur.some((c) => c.voice === v.id))?.id ?? builtIn[0].id }])}><Plus size={13} /> Add a voice</button>}
        <span className="spacer" />
        <button className="btn primary" onClick={() => void makeAll()} disabled={!line.trim() || takes.some((t) => t.busy)}><Columns3 size={14} /> Hear them</button>
      </div>
      <p className="muted" style={{ fontSize: '0.75rem', marginTop: 10 }}>Cloned and designed voices are made by the computer that holds them: compare those by generating a voiceover with each.</p>
    </Modal>
  )
}

/** While shown: re-read the voices every minute, so whether a linked desktop is online stays current. */
export function useVoiceRefresh(ms = 60_000) {
  useEffect(() => {
    const t = setInterval(() => document.visibilityState === 'visible' && useVoicesVersion.getState().bump(), ms)
    return () => clearInterval(t)
  }, [ms])
}
