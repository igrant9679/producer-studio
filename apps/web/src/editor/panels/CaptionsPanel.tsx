// Captions: auto captions (transcribe media lacking a transcript, then generateCaptions), manual captions, caption
// tracks (one per language: which one shows and is burned in), subtitle files in and out (SRT, WebVTT, ASS, LRC),
// style presets / mode / position / colours, and the line editor (retime, split, merge, karaoke word timings).
import type { CaptionFormat, CaptionItem, Item, Project, Track, Transcript } from '@producer/core'
import {
  CAPTION_FORMATS,
  addCaptionTrack,
  captionStyleFromPreset,
  captionTrack,
  captionTrackLabel,
  captionTracks,
  captionsToText,
  clone,
  createCaptionItem,
  deleteItems,
  findItem,
  generateCaptions,
  importCaptions,
  insertTrack,
  itemEnd,
  mergeCaptions,
  retimeCaption,
  setCaptionLanguage,
  setCaptionText,
  setCaptionWord,
  showOnlyCaptionTrack,
  speechTrack,
  splitCaption,
  spreadCaptionWords,
  updateTrack,
} from '@producer/core'
import clsx from 'clsx'
import { Combine, Download, FileUp, Loader2, Plus, Replace, Scissors, Subtitles, Timer, Trash2, Wand2 } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { api, waitForJob } from '../../lib/api'
import { toast, toastError } from '../../lib/toast'
import { captionsAtLeastOneFrame } from '../actions'
import { Empty, NumberInput, Toggle } from '../controls'
import { CaptionStyleEditor } from '../PropertiesPanel'
import { useEditor } from '../store'
import './captions.css'

const FILES = '.srt,.vtt,.ass,.ssa,.lrc,text/vtt,text/plain'
const LANGUAGES = ['en', 'es', 'fr', 'de', 'it', 'pt', 'pt-BR', 'nl', 'pl', 'sv', 'ja', 'ko', 'zh', 'ar', 'hi', 'tr', 'ru', 'uk']

function speechItems(p: Project): Item[] {
  return p.tracks.flatMap((t) => (t.muted ? [] : t.items)).filter((i) => (i.type === 'video' || i.type === 'audio') && !i.muted)
}

/** Caption lines that didn't come from a transcript (imported, typed or edited: they carry no word timings). */
export function handMadeCaptions(p: Project, trackId?: string): number {
  return p.tracks.filter((t) => t.kind === 'caption' && (!trackId || t.id === trackId)).flatMap((t) => t.items).filter((i) => i.type === 'caption' && !i.words?.length).length
}

const live = (id: string) => findItem(useEditor.getState().project, id)?.item as CaptionItem | undefined

/** One caption line's editor: times, text, split / merge / delete, and its karaoke word timings. */
function LineEditor({ line, hasNext }: { line: CaptionItem; hasNext: boolean }) {
  const fps = useEditor((s) => s.project.fps)
  const [text, setText] = useState(line.text)
  const area = useRef<HTMLTextAreaElement>(null)
  useEffect(() => setText(line.text), [line.text, line.id])
  const commit = (p: Project, label: string, key?: string, selection?: string[]) => useEditor.getState().commit(p, label, { ...(key ? { coalesce: `${key}:${line.id}` } : {}), ...(selection ? { selection } : {}) })
  const p = () => useEditor.getState().project
  const split = () => {
    const at = area.current?.selectionStart ?? text.length
    const before = text.slice(0, at).split(/\s+/).filter(Boolean).length
    const { project, rightId } = splitCaption(p(), line.id, before)
    if (!rightId) return toast('Put the cursor between two words to split the line there')
    commit(captionsAtLeastOneFrame(project), 'Split caption', undefined, [line.id])
  }
  const merge = () => {
    const next = mergeCaptions(p(), line.id)
    if (next === p()) return
    commit(next, 'Merge captions')
  }
  const remove = () => useEditor.getState().commit(deleteItems(p(), [line.id]), 'Delete caption', { selection: [] })
  return (
    <div className="cap-edit" role="group" aria-label="Edit caption line">
      <div className="cap-times">
        <label>Start <NumberInput label="Start (seconds)" value={line.start} step={0.01} min={0} suffix="s" width={72} onChange={(v) => commit(retimeCaption(p(), line.id, { start: v }), 'Retime caption', 'cst')} /></label>
        <label>End <NumberInput label="End (seconds)" value={itemEnd(line)} step={0.01} min={0} suffix="s" width={72} onChange={(v) => commit(retimeCaption(p(), line.id, { end: v }), 'Retime caption', 'cen')} /></label>
        <span>{(line.duration * fps).toFixed(0)} frames</span>
      </div>
      <textarea
        ref={area}
        className="ed-textarea"
        rows={2}
        aria-label="Caption text"
        value={text}
        onChange={(e) => {
          setText(e.target.value)
          // a typo fix keeps the word timings; a different number of words drops them
          commit(setCaptionText(p(), line.id, e.target.value), 'Edit caption', 'cap')
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault()
            useEditor.getState().endCoalesce()
            split()
          }
        }}
        onBlur={() => useEditor.getState().endCoalesce()}
      />
      <div className="cap-actions">
        <button type="button" className="btn sm" onClick={split} data-tip="Ctrl Enter in the text"><Scissors size={13} /> Split at cursor</button>
        <button type="button" className="btn sm" onClick={merge} disabled={!hasNext}><Combine size={13} /> Merge with next</button>
        <button type="button" className="btn sm ghost" onClick={remove}><Trash2 size={13} /> Delete line</button>
      </div>
      {line.words?.length ? (
        <WordTimings line={line} />
      ) : (
        <button type="button" className="btn sm" onClick={() => commit(spreadCaptionWords(p(), line.id), 'Time caption words')} data-tip="Spreads the words over the line, for karaoke; then adjust them">
          <Timer size={13} /> Time the words
        </button>
      )}
    </div>
  )
}

/**
 * Karaoke word timings: each word sits on a strip as long as the line; its edges drag (or take the arrow keys:
 * 10 ms, Shift 100 ms) and the picked word's start, end and spelling can be typed.
 */
function WordTimings({ line }: { line: CaptionItem }) {
  const words = line.words!
  const [pick, setPick] = useState(0)
  const strip = useRef<HTMLDivElement>(null)
  const i = Math.min(pick, words.length - 1)
  const w = words[i]
  const pct = (t: number) => `${(Math.max(0, Math.min(line.duration, t)) / line.duration) * 100}%`
  const set = (k: number, patch: { start?: number; end?: number; w?: string }, key: string) => {
    const s = useEditor.getState()
    s.commit(setCaptionWord(s.project, line.id, k, patch), 'Caption word timing', { coalesce: `${key}:${line.id}:${k}` })
  }
  const drag = (k: number, edge: 'start' | 'end') => (e: React.PointerEvent) => {
    const el = strip.current
    if (!el) return
    e.preventDefault()
    ;(e.target as Element).setPointerCapture?.(e.pointerId)
    const box = el.getBoundingClientRect()
    const move = (ev: PointerEvent) => {
      if (!box.width) return
      const t = ((ev.clientX - box.left) / box.width) * line.duration
      set(k, { [edge]: t }, `cw${edge}`)
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      useEditor.getState().endCoalesce()
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }
  const keys = (k: number, edge: 'start' | 'end') => (e: React.KeyboardEvent) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
    e.preventDefault()
    e.stopPropagation()
    const cur = live(line.id)?.words?.[k]
    if (!cur) return
    const by = (e.key === 'ArrowRight' ? 1 : -1) * (e.shiftKey ? 0.1 : 0.01)
    set(k, { [edge]: cur[edge] + by }, `cwk${edge}`)
  }
  return (
    <div>
      <div className="cap-words" ref={strip} role="group" aria-label="Word timings">
        {words.map((x, k) => (
          <button key={k} type="button" className={clsx('cap-word', k === i && 'on')} style={{ left: pct(x.start), width: `calc(${pct(x.end)} - ${pct(x.start)})` }} onClick={() => setPick(k)} aria-pressed={k === i} aria-label={`Word ${k + 1}: ${x.w}`}>
            {x.w}
          </button>
        ))}
        {words.map((x, k) =>
          (['start', 'end'] as const).map((edge) => (
            <span
              key={`${k}${edge}`}
              className="cap-edge"
              style={{ left: pct(x[edge]) }}
              role="slider"
              tabIndex={k === i ? 0 : -1}
              aria-label={`${edge === 'start' ? 'Start' : 'End'} of “${x.w}”`}
              aria-valuemin={0}
              aria-valuemax={Math.round(line.duration * 1000) / 1000}
              aria-valuenow={Math.round(x[edge] * 1000) / 1000}
              aria-valuetext={`${x[edge].toFixed(2)} s into the line`}
              onPointerDown={drag(k, edge)}
              onKeyDown={keys(k, edge)}
              onFocus={() => setPick(k)}
            />
          )),
        )}
      </div>
      <div className="cap-wordfields" style={{ marginTop: 6 }}>
        <span>“{w.w}”</span>
        <label>From <NumberInput label={`Start of “${w.w}” (seconds into the line)`} value={w.start} step={0.01} min={0} suffix="s" width={64} onChange={(v) => set(i, { start: v }, 'cws')} /></label>
        <label>to <NumberInput label={`End of “${w.w}” (seconds into the line)`} value={w.end} step={0.01} min={0} suffix="s" width={64} onChange={(v) => set(i, { end: v }, 'cwe')} /></label>
      </div>
    </div>
  )
}

export function CaptionsPanel() {
  const project = useEditor((s) => s.project)
  const demo = useEditor((s) => s.demo)
  const selection = useEditor((s) => s.selection)
  const [busy, setBusy] = useState<string | null>(null)
  const [trackId, setTrackId] = useState<string | undefined>()
  const [format, setFormat] = useState<CaptionFormat>('srt')
  const [karaoke, setKaraoke] = useState(false)
  const file = useRef<HTMLInputElement>(null)
  const replaceFile = useRef<HTMLInputElement>(null)
  const tracks = captionTracks(project)
  // the track shown here: the selected line's, else the one picked, else the one in the video
  const selLine = selection.length === 1 ? findItem(project, selection[0]) : null
  const track: Track | undefined = (selLine?.track.kind === 'caption' ? selLine.track : undefined) ?? (trackId ? tracks.find((t) => t.id === trackId) : undefined) ?? captionTrack(project)
  const lines = (track?.items ?? []).filter((i): i is CaptionItem => i.type === 'caption').sort((a, b) => a.start - b.start)
  const active = selLine?.item.type === 'caption' && selLine.track === track ? (selLine.item as CaptionItem) : undefined
  const items = speechItems(project)
  const withTranscript = items.filter((i) => 'assetId' in i && project.assets[i.assetId]?.transcript)
  const missing = [...new Set(items.filter((i) => 'assetId' in i && !project.assets[i.assetId]?.transcript && project.assets[i.assetId]?.hasAudio !== false).map((i) => (i as { assetId: string }).assetId))]
  const fmt = CAPTION_FORMATS.find((f) => f.id === format)!

  /** The track captions from speech go on: an empty one picked here, else the one already made from speech. */
  const speechTarget = (p: Project) => {
    const t = track && p.tracks.find((x) => x.id === track.id)
    return t && !t.items.length ? t.id : speechTrack(p)?.id
  }

  const auto = async () => {
    const session = useEditor.getState().session
    // regenerating replaces the speech track; imported, typed and edited lines on it (no word timings) can't be remade
    const target = speechTarget(useEditor.getState().project)
    const kept = target ? handMadeCaptions(useEditor.getState().project, target) : 0
    if (kept && !window.confirm(`Regenerating replaces these captions, including ${kept} imported or edited line${kept === 1 ? '' : 's'} that can't be made again from the transcript. Continue?`)) return
    try {
      if (missing.length && !demo) {
        for (let i = 0; i < missing.length; i++) {
          const id = missing[i]
          setBusy(`Transcribing ${i + 1} of ${missing.length}…`)
          const job = await api.transcribe(id)
          const done = await waitForJob<{ assetId: string; transcript: Transcript }>(job.id, (j) => setBusy(`Transcribing ${i + 1} of ${missing.length}… ${j.progress > 0 ? Math.round(j.progress * 100) + '%' : ''}`))
          const tr = done.result?.transcript
          // a media record: it joins the project as it is now, outside undo
          if (tr) useEditor.getState().updateMedia({ id, transcript: tr })
        }
      } else if (missing.length && demo && !withTranscript.length) {
        toast('Sign in to transcribe your own media — the demo clips already have transcripts.')
        return
      }
      // you may have opened another project while it transcribed
      if (useEditor.getState().session !== session) return
      setBusy('Building captions…')
      // from the project as it is after the wait, so edits made meanwhile are kept
      const p = useEditor.getState().project
      const into = speechTarget(p)
      const style = (into ? p.tracks.find((t) => t.id === into)?.captionStyle : undefined) ?? captionStyleFromPreset('clean', p)
      const next = captionsAtLeastOneFrame(generateCaptions(p, { style, trackId: into }))
      const made = into ? next.tracks.find((t) => t.id === into) : speechTrack(next)
      const n = made?.items.length ?? 0
      if (!n) {
        toast('No speech found to caption')
        return
      }
      useEditor.getState().commit(next, 'Auto captions')
      if (made) setTrackId(made.id)
      toast(`Created ${n} caption lines`)
    } catch (e) {
      toastError(e)
    } finally {
      setBusy(null)
    }
  }

  const addManual = () => {
    const s = useEditor.getState()
    const p = clone(s.project)
    let t = track ? p.tracks.find((x) => x.id === track.id) : undefined
    if (!t) t = insertTrack(p, 'caption')
    const c = createCaptionItem(s.playhead, 2, 'New caption')
    if (t.items.some((i) => i.start < c.start + c.duration && i.start + i.duration > c.start)) {
      toast('There is already a caption at the playhead')
      return
    }
    t.items.push(c)
    t.items.sort((a, b) => a.start - b.start)
    setTrackId(t.id)
    s.commit(p, 'Add caption', { selection: [c.id] })
  }

  const onFile = async (f: File, replace: boolean) => {
    const text = await f.text()
    const s = useEditor.getState()
    const r = importCaptions(s.project, text, { fileName: f.name, trackId: replace ? track?.id : undefined, style: track?.captionStyle })
    if (!r.count) return toast(`No captions found in ${f.name}`)
    s.commit(captionsAtLeastOneFrame(r.project), replace ? 'Replace captions' : 'Import captions', { selection: [] })
    setTrackId(r.trackId)
    const t = r.project.tracks.find((x) => x.id === r.trackId)
    toast(`Imported ${r.count} caption${r.count === 1 ? '' : 's'}${t ? ` into ${captionTrackLabel(t)}` : ''}`)
  }

  const download = () => {
    if (!track) return
    const text = captionsToText(project, format, { trackId: track.id, karaoke: karaoke && format !== 'srt' })
    if (!text) return toast('No captions to export')
    const url = URL.createObjectURL(new Blob([text], { type: fmt.mime }))
    const a = document.createElement('a')
    a.href = url
    a.download = `${project.name || 'captions'}${track.language ? `.${track.language}` : ''}.${fmt.ext}`
    a.click()
    setTimeout(() => URL.revokeObjectURL(url), 2000)
  }

  const newTrack = () => {
    const s = useEditor.getState()
    const { project: p, trackId: id } = addCaptionTrack(s.project, { style: track?.captionStyle, name: `Captions ${tracks.length + 1}` })
    s.commit(p, 'Add caption track', { selection: [] })
    setTrackId(id)
  }

  const show = (on: boolean) => {
    if (!track) return
    const s = useEditor.getState()
    s.commit(on ? showOnlyCaptionTrack(s.project, track.id) : updateTrack(s.project, track.id, { hidden: true }), on ? 'Show caption track' : 'Hide caption track')
  }

  const pickLine = (c: CaptionItem) => {
    useEditor.getState().select([c.id])
    useEditor.getState().setPlayhead(c.start + 0.01)
  }

  const fileInput = (ref: React.RefObject<HTMLInputElement>, replace: boolean) => (
    <input
      ref={ref}
      type="file"
      accept={FILES}
      hidden
      onChange={(e) => {
        const f = e.target.files?.[0]
        if (f) void onFile(f, replace)
        e.target.value = ''
      }}
    />
  )

  return (
    <>
      <div className="ed-hero">
        <div className="row" style={{ gap: 8 }}>
          <Wand2 size={16} color="var(--accent)" />
          <b>Auto captions</b>
        </div>
        <p className="ed-note">
          Turns speech in your clips into timed captions.{' '}
          {missing.length > 0 && !demo ? `${missing.length} clip${missing.length > 1 ? 's' : ''} will be transcribed first.` : `${withTranscript.length} clip${withTranscript.length === 1 ? '' : 's'} with transcripts.`}
        </p>
        <button className="btn primary sm" style={{ width: '100%' }} onClick={auto} disabled={!!busy}>
          {busy ? <Loader2 size={14} className="spin" /> : <Subtitles size={14} />}
          {busy ?? (speechTrack(project)?.items.length ? 'Regenerate captions' : 'Generate captions')}
        </button>
      </div>
      <div className="ed-btnrow">
        <button className="btn sm" onClick={addManual} title="Add a caption at the playhead"><Plus size={13} /> Manual</button>
        <button className="btn sm" onClick={() => file.current?.click()} data-tip="Import an .srt, .vtt, .ass or .lrc file as a new caption track"><FileUp size={13} /> Import</button>
        <button className="btn sm" onClick={newTrack} data-tip="An empty caption track, e.g. for another language"><Plus size={13} /> Track</button>
      </div>
      {fileInput(file, false)}
      {fileInput(replaceFile, true)}
      {track ? (
        <>
          <div className="ed-group">
            <div className="cap-tracks">
              <select className="ed-select" aria-label="Caption track" value={track.id} onChange={(e) => {
                setTrackId(e.target.value)
                useEditor.getState().select([])
              }}>
                {tracks.map((t) => (
                  <option key={t.id} value={t.id}>{captionTrackLabel(t)}{t.hidden ? ' (hidden)' : ''}</option>
                ))}
              </select>
              <button className="btn sm ghost" aria-label="Remove this caption track" data-tip="Remove this caption track" onClick={() => {
                const s = useEditor.getState()
                const p = clone(s.project)
                p.tracks = p.tracks.filter((t) => t.id !== track.id)
                s.commit(p, 'Remove captions')
                setTrackId(undefined)
              }}>
                <Trash2 size={13} />
              </button>
            </div>
            <div className="cap-trackrow">
              <label htmlFor="cap-lang" className="muted">Language</label>
              <input
                id="cap-lang"
                key={track.id}
                className="ed-input"
                list="cap-langs"
                placeholder="e.g. en"
                defaultValue={track.language ?? ''}
                onBlur={(e) => {
                  const s = useEditor.getState()
                  if ((track.language ?? '') !== e.target.value.trim()) s.commit(setCaptionLanguage(s.project, track.id, e.target.value), 'Caption language')
                }}
                onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
              />
              <Toggle checked={!track.hidden} onChange={show} label="In the video" />
            </div>
            <datalist id="cap-langs">
              {LANGUAGES.map((l) => (
                <option key={l} value={l} />
              ))}
            </datalist>
            <p className="ed-note" style={{ marginTop: 0 }}>The caption track shown in the video is the one exports burn in.</p>
            <div className="cap-io">
              <div className="row">
                <select className="ed-select" aria-label="Caption file format" value={format} onChange={(e) => setFormat(e.target.value as CaptionFormat)}>
                  {CAPTION_FORMATS.map((f) => (
                    <option key={f.id} value={f.id}>{f.name}</option>
                  ))}
                </select>
              </div>
              <div className="row">
                <button className="btn sm" style={{ flex: 1 }} onClick={download} disabled={!lines.length} data-tip={`Download this track as .${fmt.ext}`}><Download size={13} /> Export</button>
                <button className="btn sm" onClick={() => replaceFile.current?.click()} aria-label="Replace this track’s lines from a file" data-tip="Replace this track’s lines from a file"><Replace size={13} /></button>
              </div>
            </div>
            {format !== 'srt' && <Toggle checked={karaoke} onChange={setKaraoke} label="Include word timings (karaoke)" />}
          </div>
          <CaptionStyleEditor track={track} />
          <div className="ed-group">
            <div className="row">
              <span className="eyebrow">Lines ({lines.length})</span>
              <div className="spacer" />
            </div>
            <div className="cap-lines" role="list" aria-label="Caption lines">
              {lines.slice(0, 200).concat(active && lines.indexOf(active) >= 200 ? [active] : []).map((c) => (
                <div key={c.id} role="listitem" className={clsx('cap-line', active?.id === c.id && 'on')}>
                  <button type="button" className="cap-pick" aria-expanded={active?.id === c.id} onClick={() => pickLine(c)}>
                    <span className="t">{c.start.toFixed(1)}s</span>
                    <span className="x">{c.text}</span>
                  </button>
                  {active?.id === c.id && <LineEditor line={c} hasNext={lines.indexOf(c) < lines.length - 1} />}
                </div>
              ))}
            </div>
          </div>
        </>
      ) : (
        <Empty icon={<Subtitles size={22} />} title="No captions yet">Generate them from speech, add one manually, or import an .srt, .vtt, .ass or .lrc file.</Empty>
      )}
    </>
  )
}
