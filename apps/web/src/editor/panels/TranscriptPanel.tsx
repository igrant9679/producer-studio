// Transcript-based editing: words of the selected (or main-track) media, click to seek, select + Delete to cut,
// remove filler words / pauses, search.
import type { Item, Project, Transcript as TranscriptT, TranscriptWord } from '@producer/core'
import { clone, cutSourceRanges, fillerWordRanges, findItem, itemWords, mainTrack, removeSilences } from '@producer/core'
import clsx from 'clsx'
import { FileText, Loader2, Scissors, Search, Timer, Eraser } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { api, waitForJob } from '../../lib/api'
import { toast, toastError } from '../../lib/toast'
import { Empty, useThrottledPlayhead } from '../controls'
import { useEditor } from '../store'

type W = TranscriptWord & { srcStart: number; srcEnd: number; itemId: string; key: string; pauseBefore: number }

function targets(p: Project, selection: string[]): Item[] {
  const sel = selection.map((id) => findItem(p, id)?.item).filter((i): i is Item => !!i && (i.type === 'video' || i.type === 'audio'))
  if (sel.length) return sel
  return (mainTrack(p)?.items ?? []).filter((i) => i.type === 'video')
}

function wordsFor(p: Project, items: Item[]): W[] {
  const out: W[] = []
  for (const it of items) {
    let prevEnd: number | null = null
    if (it.type !== 'video' && it.type !== 'audio') continue
    const lo = it.in
    const hi = it.in + it.duration * it.speed
    for (const w of itemWords(p, it.id)) {
      // a word straddling a cut belongs to the piece holding its midpoint (no duplicates after a split)
      const mid = (w.srcStart + w.srcEnd) / 2
      if (mid < lo || mid >= hi) continue
      out.push({ ...w, itemId: it.id, key: `${it.id}:${w.srcStart}`, pauseBefore: prevEnd === null ? 0 : w.srcStart - prevEnd })
      prevEnd = w.srcEnd
    }
  }
  return out.sort((a, b) => a.start - b.start)
}

const FILLER = /^(um|uh|erm|er|ah|hmm|mm|uhm)[,.!?]*$/i

export function TranscriptPanel() {
  const project = useEditor((s) => s.project)
  const selection = useEditor((s) => s.selection)
  const demo = useEditor((s) => s.demo)
  const playhead = useThrottledPlayhead()
  const items = useMemo(() => targets(project, selection), [project, selection])
  const words = useMemo(() => wordsFor(project, items), [project, items])
  const [sel, setSel] = useState<Set<string>>(new Set())
  const [anchor, setAnchor] = useState<number | null>(null)
  const [query, setQuery] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const boxRef = useRef<HTMLDivElement>(null)
  const dragging = useRef<number | null>(null)

  useEffect(() => {
    // drop selections that no longer exist after an edit
    const keys = new Set(words.map((w) => w.key))
    setSel((s) => new Set([...s].filter((k) => keys.has(k))))
  }, [words])

  const q = query.trim().toLowerCase()
  const matches = q ? words.filter((w) => w.w.toLowerCase().replace(/[^\p{L}\p{N}']/gu, '').includes(q.replace(/[^\p{L}\p{N}']/gu, ''))) : []
  const matchSet = new Set(matches.map((m) => m.key))
  const current = words.find((w) => playhead >= w.start && playhead < w.end)
  const fillerCount = words.filter((w) => FILLER.test(w.w)).length
  const pauses = words.filter((w) => w.pauseBefore >= 0.6).length
  const missingIds = [...new Set(items.filter((i) => 'assetId' in i && !project.assets[i.assetId]?.transcript).map((i) => (i as { assetId: string }).assetId))]

  const cutKeys = (keys: Set<string>, label: string) => {
    const chosen = words.filter((w) => keys.has(w.key))
    if (!chosen.length) return
    // merge contiguous words per item into ranges (swallow the small gaps between them)
    const byItem = new Map<string, Array<{ start: number; end: number }>>()
    for (const w of chosen) {
      const list = byItem.get(w.itemId) ?? []
      const last = list[list.length - 1]
      if (last && w.srcStart - last.end < 0.35) last.end = w.srcEnd
      else list.push({ start: w.srcStart, end: w.srcEnd })
      byItem.set(w.itemId, list)
    }
    let p = useEditor.getState().project
    for (const [id, ranges] of byItem) p = cutSourceRanges(p, id, ranges)
    useEditor.getState().commit(p, label)
    setSel(new Set())
    toast(`${label}: removed ${chosen.length} word${chosen.length > 1 ? 's' : ''}`)
  }

  const removeFillers = () => {
    let p = useEditor.getState().project
    let n = 0
    for (const it of items) {
      if (it.type !== 'video' && it.type !== 'audio') continue
      const tr = p.assets[it.assetId]?.transcript
      const cur = findItem(p, it.id)?.item as typeof it | undefined
      if (!tr || !cur) continue
      const lo = cur.in
      const hi = cur.in + cur.duration * cur.speed
      const ranges = fillerWordRanges(tr).filter((r) => r.start >= lo - 0.01 && r.end <= hi + 0.01)
      n += ranges.length
      if (ranges.length) p = cutSourceRanges(p, it.id, ranges.map((r) => ({ start: r.start - 0.03, end: r.end + 0.03 })))
    }
    if (!n) return toast('No filler words found')
    useEditor.getState().commit(p, 'Remove filler words')
    toast(`Removed ${n} filler word${n > 1 ? 's' : ''}`)
  }

  const removePauses = () => {
    let p = useEditor.getState().project
    for (const it of items) p = removeSilences(p, it.id, 0.6, 0.12)
    if (p === useEditor.getState().project) return toast('No pauses longer than 0.6 s')
    useEditor.getState().commit(p, 'Remove pauses')
    toast('Removed pauses')
  }

  const transcribe = async () => {
    if (demo) return toast('Sign in to transcribe your own media — the demo clips already have transcripts.')
    try {
      let p = useEditor.getState().project
      for (let i = 0; i < missingIds.length; i++) {
        setBusy(`Transcribing ${i + 1}/${missingIds.length}…`)
        const job = await api.transcribe(missingIds[i])
        const done = await waitForJob<{ assetId: string; transcript: TranscriptT }>(job.id)
        if (done.result?.transcript) {
          p = clone(useEditor.getState().project)
          p.assets[missingIds[i]] = { ...p.assets[missingIds[i]], transcript: done.result.transcript }
          useEditor.getState().commit(p, 'Transcribe')
        }
      }
    } catch (e) {
      toastError(e)
    } finally {
      setBusy(null)
    }
  }

  const onWordDown = (e: React.MouseEvent, i: number) => {
    e.preventDefault()
    boxRef.current?.focus()
    const w = words[i]
    if (e.shiftKey && anchor !== null) {
      const [a, b] = [Math.min(anchor, i), Math.max(anchor, i)]
      setSel(new Set(words.slice(a, b + 1).map((x) => x.key)))
    } else if (e.ctrlKey || e.metaKey) {
      const n = new Set(sel)
      if (n.has(w.key)) n.delete(w.key)
      else n.add(w.key)
      setSel(n)
      setAnchor(i)
    } else {
      setSel(new Set([w.key]))
      setAnchor(i)
      dragging.current = i
      useEditor.getState().setPlaying(false)
      useEditor.getState().setPlayhead(w.start + 0.001)
    }
  }
  const onWordEnter = (i: number) => {
    if (dragging.current === null) return
    const a = Math.min(dragging.current, i)
    const b = Math.max(dragging.current, i)
    setSel(new Set(words.slice(a, b + 1).map((x) => x.key)))
  }
  useEffect(() => {
    const up = () => (dragging.current = null)
    window.addEventListener('mouseup', up)
    return () => window.removeEventListener('mouseup', up)
  }, [])

  const onKeyDown = (e: React.KeyboardEvent) => {
    if ((e.key === 'Delete' || e.key === 'Backspace') && sel.size) {
      e.preventDefault()
      e.stopPropagation()
      cutKeys(sel, 'Delete words')
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
      e.preventDefault()
      e.stopPropagation()
      setSel(new Set(words.map((w) => w.key)))
    } else if (e.key === 'Escape') {
      e.stopPropagation()
      setSel(new Set())
    }
  }

  if (!items.length) return <Empty icon={<FileText size={22} />} title="No clip to transcribe">Select a video or audio clip, or add video to the main track.</Empty>

  return (
    <div className="ed-transcript">
      <p className="ed-note" style={{ marginTop: 0 }}>
        {selection.length ? 'Editing the selected clip.' : 'Editing the main track.'} Click a word to jump to it; drag or Shift-click to select, then press <span className="kbd">Delete</span> to cut it from the video.
      </p>
      {missingIds.length > 0 && (
        <button className="btn sm" style={{ width: '100%', marginBottom: 10 }} onClick={transcribe} disabled={!!busy}>
          {busy ? <Loader2 size={13} className="spin" /> : <FileText size={13} />} {busy ?? `Transcribe ${missingIds.length} clip${missingIds.length > 1 ? 's' : ''}`}
        </button>
      )}
      <div className="ed-search">
        <Search size={13} />
        <input placeholder="Search transcript" value={query} onChange={(e) => setQuery(e.target.value)} />
        {q && <span className="muted">{matches.length}</span>}
        {q && matches.length > 0 && (
          <button className="btn sm ghost" onClick={() => setSel(new Set(matches.map((m) => m.key)))}>Select</button>
        )}
      </div>
      <div className="row" style={{ gap: 6, margin: '8px 0 10px', flexWrap: 'wrap' }}>
        <button className="btn sm" onClick={removeFillers} title="um, uh, erm…"><Eraser size={13} /> Filler words{fillerCount ? ` (${fillerCount})` : ''}</button>
        <button className="btn sm" onClick={removePauses}><Timer size={13} /> Pauses{pauses ? ` (${pauses})` : ''}</button>
        <button className="btn sm primary" disabled={!sel.size} onClick={() => cutKeys(sel, 'Delete words')}><Scissors size={13} /> Cut {sel.size || ''}</button>
      </div>
      {!words.length ? (
        <Empty icon={<FileText size={22} />} title="No transcript yet">{missingIds.length ? 'Transcribe the clip to edit it by text.' : 'No speech in this range.'}</Empty>
      ) : (
        <div className="ed-words" ref={boxRef} tabIndex={0} onKeyDown={onKeyDown} data-local-keys>
          {words.map((w, i) => (
            <span key={w.key}>
              {w.pauseBefore >= 0.6 && <span className="pause" title="Pause">{w.pauseBefore.toFixed(1)}s</span>}
              <span
                className={clsx('w', sel.has(w.key) && 'sel', current?.key === w.key && 'cur', matchSet.has(w.key) && 'match', FILLER.test(w.w) && 'filler')}
                onMouseDown={(e) => onWordDown(e, i)}
                onMouseEnter={() => onWordEnter(i)}
              >
                {w.w}
              </span>{' '}
            </span>
          ))}
        </div>
      )}
    </div>
  )
}
