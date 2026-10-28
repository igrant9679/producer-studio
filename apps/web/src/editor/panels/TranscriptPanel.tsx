// Transcript-based editing, Descript-style: words of the selected (or main-track) media; click or arrow to a word
// to jump to it, select + Delete to cut it (it stays, struck through) and R to restore it; filler words from an
// editable list; speaker labels; pauses; search.
import type { Item, Project, StruckWord, Transcript as TranscriptT, TranscriptWord } from '@producer/core'
import { assignSpeaker, cutNeighbour, cutSourceRanges, fillerKey, fillerList, findItem, isEditable, itemWords, mainTrack, matchFillers, removeSilences, renameSpeaker, restoreCut, setFillerWords, speakerAt, speakersOf, struckWords } from '@producer/core'
import clsx from 'clsx'
import { ChevronDown, Eraser, FileText, Loader2, Plus, RotateCcw, Scissors, Search, Timer, X } from 'lucide-react'
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { api, waitForJob } from '../../lib/api'
import { canEdit, useSession } from '../../lib/session'
import { toast, toastError } from '../../lib/toast'
import { viewOnlyTip } from '../../shell/ui'
import { LOCKED_NOTE, captionsAtLeastOneFrame } from '../actions'
import { Empty } from '../controls'
import { useEditor } from '../store'
import './captions.css'

type W = TranscriptWord & {
  srcStart: number
  srcEnd: number
  itemId: string
  assetId: string
  key: string
  pauseBefore: number
  /** Cut from the clip: shown struck through, restorable. */
  struck?: StruckWord
  speaker?: string
  /** The first word of a run by one speaker (the label goes before it). */
  speakerStart?: boolean
}

const isMedia = (i: Item | undefined): i is Item & { type: 'video' | 'audio'; assetId: string } => !!i && (i.type === 'video' || i.type === 'audio')

/** The piece before `id` on its track whose cut leads to it. */
function cutBefore(p: Project, id: string): string | null {
  const f = findItem(p, id)
  const prev = f?.track.items.find((i) => i.id !== id && Math.abs(i.start + i.duration - f.item.start) < 0.011 && cutNeighbour(p, i.id)?.id === id)
  return prev?.id ?? null
}

/** The clips whose words show: the selected ones (with the pieces a cut split them into), or the main track's. */
function targets(p: Project, selection: string[]): Item[] {
  const sel = selection.map((id) => findItem(p, id)?.item).filter(isMedia)
  if (!sel.length) return (mainTrack(p)?.items ?? []).filter((i) => i.type === 'video')
  const ids = new Set<string>()
  for (const it of sel) {
    ids.add(it.id)
    for (let id: string | null = it.id; id && (id = cutNeighbour(p, id)?.id ?? null) && !ids.has(id); ) ids.add(id)
    for (let id: string | null = it.id; id && (id = cutBefore(p, id)) && !ids.has(id); ) ids.add(id)
  }
  return [...ids].map((id) => findItem(p, id)!.item).sort((a, b) => a.start - b.start)
}

function wordsFor(p: Project, items: Item[]): W[] {
  const out: W[] = []
  const inView = new Set(items.map((i) => i.id))
  for (const it of items) {
    if (!isMedia(it)) continue
    let prevEnd: number | null = null
    const lo = it.in
    const hi = it.in + it.duration * it.speed
    const tr = p.assets[it.assetId]?.transcript
    for (const w of itemWords(p, it.id)) {
      // a word straddling a cut belongs to the piece holding its midpoint (no duplicates after a split)
      const mid = (w.srcStart + w.srcEnd) / 2
      if (mid < lo || mid >= hi) continue
      out.push({ ...w, itemId: it.id, assetId: it.assetId, key: `${it.id}:${w.srcStart}`, pauseBefore: prevEnd === null ? 0 : w.srcStart - prevEnd, speaker: tr && speakerAt(tr, w.srcStart) })
      prevEnd = w.srcEnd
    }
    // what was cut between this piece and the next stays in the transcript, struck through
    const next = cutNeighbour(p, it.id)
    if (next && inView.has(next.id))
      for (const s of struckWords(p, it.id)) out.push({ ...s, itemId: it.id, assetId: it.assetId, key: `x:${it.id}:${s.srcStart}`, pauseBefore: 0, struck: s, speaker: tr && speakerAt(tr, s.srcStart) })
  }
  out.sort((a, b) => a.start - b.start || +!!b.struck - +!!a.struck || a.srcStart - b.srcStart)
  let last: string | undefined
  for (const w of out) {
    if (w.speaker && w.speaker !== last) w.speakerStart = true
    last = w.speaker
  }
  return out
}

/** `list` itself while its elements are the same objects as last time (edits elsewhere leave them alone). */
function useStableList<T>(list: T[]): T[] {
  const ref = useRef(list)
  if (ref.current.length !== list.length || ref.current.some((x, i) => x !== list[i])) ref.current = list
  return ref.current
}

/** Index of the word playing at t (words are in time order; struck ones never play), or -1. */
function wordAt(words: W[], t: number): number {
  let lo = 0
  let hi = words.length - 1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (words[mid].start > t) hi = mid - 1
    else if (words[mid].end <= t) lo = mid + 1
    else return mid
  }
  return -1
}

/** Whether the signed-in person may change this project's media records (owner or editor of its space). */
function useCanEdit(): { can: boolean; tip?: string } {
  const wsId = useEditor((s) => s.workspaceId)
  const ws = useSession((s) => s.workspaces.find((w) => w.id === wsId))
  return !ws || canEdit(ws) ? { can: true } : { can: false, tip: viewOnlyTip(ws) }
}

/** A speaker label before their words: click to rename (Enter saves, Escape keeps the name). */
function SpeakerLabel({ name, editing, disabled, tip, onEdit, onRename }: { name: string; editing: boolean; disabled: boolean; tip?: string; onEdit: () => void; onRename: (to: string | null) => void }) {
  const [text, setText] = useState(name)
  useEffect(() => setText(name), [name, editing])
  if (editing)
    return (
      <input
        className="ed-input tr-spk-input"
        aria-label={`Rename ${name}`}
        value={text}
        autoFocus
        onMouseDown={(e) => e.stopPropagation()}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          e.stopPropagation()
          if (e.key === 'Enter') onRename(text)
          else if (e.key === 'Escape') onRename(null)
        }}
        onBlur={() => onRename(null)}
      />
    )
  return (
    <button type="button" className="tr-spk" onMouseDown={(e) => e.stopPropagation()} onClick={onEdit} disabled={disabled} data-tip={tip ?? 'Rename this speaker'} aria-label={`Speaker: ${name}. Rename`}>
      {name}
    </button>
  )
}

/** The words. Renders when they or the selection change, never with the playhead. */
const WordList = memo(function WordList({
  words,
  sel,
  matchSet,
  fillerSet,
  speaker,
  onDown,
  onEnter,
}: {
  words: W[]
  sel: Set<string>
  matchSet: Set<string>
  fillerSet: Set<string>
  speaker: { editing: number | null; disabled: boolean; tip?: string; onEdit: (i: number) => void; onRename: (i: number, to: string | null) => void }
  onDown: (e: React.MouseEvent, i: number) => void
  onEnter: (i: number) => void
}) {
  return (
    <>
      {words.map((w, i) => {
        const cls = clsx('w', sel.has(w.key) && 'sel', matchSet.has(w.key) && 'match', fillerSet.has(w.key) && 'filler', w.struck && 'struck')
        const props = { className: cls, 'data-wi': i, onMouseDown: (e: React.MouseEvent) => onDown(e, i), onMouseEnter: () => onEnter(i) }
        return (
          <span key={w.key}>
            {w.speakerStart && (
              <span className="tr-spk-row">
                <SpeakerLabel name={w.speaker!} editing={speaker.editing === i} disabled={speaker.disabled} tip={speaker.tip} onEdit={() => speaker.onEdit(i)} onRename={(to) => speaker.onRename(i, to)} />
              </span>
            )}
            {w.pauseBefore >= 0.6 && <span className="pause" title="Pause">{w.pauseBefore.toFixed(1)}s</span>}
            {w.struck ? <del {...props} title="Cut: select and press R to restore">{w.w}</del> : <span {...props}>{w.w}</span>}{' '}
          </span>
        )
      })}
    </>
  )
})

/** The filler list: switch a word or phrase on (marked and removed) or off, add your own, take one off the list. */
function FillerList({ counts }: { counts: Map<string, number> }) {
  const project = useEditor((s) => s.project)
  const list = fillerList(project)
  const [text, setText] = useState('')
  const save = (next: typeof list, label: string) => useEditor.getState().commit(setFillerWords(useEditor.getState().project, next), label)
  const add = () => {
    const w = text.trim()
    if (!w) return
    const k = fillerKey(w)
    if (list.some((f) => fillerKey(f.w) === k)) save(list.map((f) => (fillerKey(f.w) === k ? { ...f, on: true } : f)), 'Filler words')
    else save([...list, { w, on: true }], `Add filler “${w}”`)
    setText('')
  }
  return (
    <div className="tr-fillers" role="group" aria-label="Filler words">
      <div className="tr-fillers-list">
        {list.map((f) => (
          <span key={f.w} className={clsx('tr-filler', f.on && 'on')}>
            <button type="button" aria-pressed={f.on} onClick={() => save(list.map((x) => (x === f ? { ...x, on: !x.on } : x)), `Filler “${f.w}” ${f.on ? 'off' : 'on'}`)} data-tip={f.on ? 'Marked and removed: click to leave it' : 'Left alone: click to mark and remove it'}>
              {f.w}
              {counts.get(fillerKey(f.w)) ? <small>{counts.get(fillerKey(f.w))}</small> : null}
            </button>
            <button type="button" className="x" aria-label={`Take “${f.w}” off the list`} onClick={() => save(list.filter((x) => x !== f), `Remove filler “${f.w}”`)}>
              <X size={11} />
            </button>
          </span>
        ))}
      </div>
      <div className="row" style={{ gap: 6, marginTop: 6 }}>
        <input
          className="ed-input"
          placeholder="Add a word or phrase"
          aria-label="Add a filler word or phrase"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              add()
            }
          }}
        />
        <button type="button" className="btn sm" onClick={add} disabled={!text.trim()}>
          <Plus size={13} /> Add
        </button>
      </div>
    </div>
  )
}

export function TranscriptPanel() {
  const project = useEditor((s) => s.project)
  const selection = useEditor((s) => s.selection)
  const demo = useEditor((s) => s.demo)
  const gate = useCanEdit()
  // the words change only with these clips or their transcripts, not with every edit to the project
  const items = useStableList(useMemo(() => targets(project, selection), [project, selection]))
  const records = useStableList(items.map((i) => ('assetId' in i ? project.assets[i.assetId] : undefined)))
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const words = useMemo(() => wordsFor(project, items), [items, records])
  const [sel, setSel] = useState<Set<string>>(new Set())
  const [anchor, setAnchor] = useState<number | null>(null)
  const [caret, setCaret] = useState<number | null>(null)
  const [query, setQuery] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [showFillers, setShowFillers] = useState(false)
  const [editingSpeaker, setEditingSpeaker] = useState<number | null>(null)
  const boxRef = useRef<HTMLDivElement>(null)
  const dragging = useRef<number | null>(null)

  useEffect(() => {
    // drop selections that no longer exist after an edit
    const keys = new Set(words.map((w) => w.key))
    setSel((s) => new Set([...s].filter((k) => keys.has(k))))
    setCaret((c) => (c !== null && c >= words.length ? null : c))
  }, [words])

  const q = query.trim().toLowerCase()
  const matches = q ? words.filter((w) => !w.struck && w.w.toLowerCase().replace(/[^\p{L}\p{N}']/gu, '').includes(q.replace(/[^\p{L}\p{N}']/gu, ''))) : []
  const matchKey = matches.map((m) => m.key).join('|')
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const matchSet = useMemo(() => new Set(matches.map((m) => m.key)), [matchKey])

  // filler words of the list that are on, in the words still in the clips (a phrase never runs across a cut)
  const fillersOn = useMemo(() => fillerList(project).filter((f) => f.on).map((f) => f.w), [project.fillerWords]) // eslint-disable-line react-hooks/exhaustive-deps
  const allFillers = useMemo(() => fillerList(project).map((f) => f.w), [project.fillerWords]) // eslint-disable-line react-hooks/exhaustive-deps
  const runs = useMemo(() => {
    const byItem = new Map<string, W[]>()
    for (const w of words) if (!w.struck) byItem.set(w.itemId, [...(byItem.get(w.itemId) ?? []), w])
    return [...byItem.values()]
  }, [words])
  const { fillerSet, fillerRanges, counts } = useMemo(() => {
    const set = new Set<string>()
    const ranges: W[][] = []
    const n = new Map<string, number>()
    for (const run of runs) {
      for (const [a, b] of matchFillers(run, fillersOn)) {
        const hit = run.slice(a, b + 1)
        ranges.push(hit)
        for (const w of hit) set.add(w.key)
      }
      for (const [a, b] of matchFillers(run, allFillers)) {
        const k = fillerKey(run.slice(a, b + 1).map((w) => w.w).join(' '))
        n.set(k, (n.get(k) ?? 0) + 1)
      }
    }
    return { fillerSet: set, fillerRanges: ranges, counts: n }
  }, [runs, fillersOn, allFillers])

  const pauses = words.filter((w) => w.pauseBefore >= 0.6).length
  const missingIds = [...new Set(items.filter((i) => 'assetId' in i && !project.assets[i.assetId]?.transcript).map((i) => (i as { assetId: string }).assetId))]
  const selLive = words.filter((w) => sel.has(w.key) && !w.struck)
  const selStruck = words.filter((w) => sel.has(w.key) && w.struck)
  const speakers = useMemo(() => [...new Set(items.flatMap((i) => (isMedia(i) && project.assets[i.assetId]?.transcript ? speakersOf(project.assets[i.assetId].transcript!) : [])))], [items, records]) // eslint-disable-line react-hooks/exhaustive-deps

  /** Cut words (live ones; struck ones are already out) from their clips. */
  const cutWords = (picked: W[], label: string, pad = 0) => {
    // words in a locked clip stay, so they aren't counted as removed
    const chosen = picked.filter((w) => !w.struck && isEditable(useEditor.getState().project, w.itemId))
    if (picked.length && !chosen.length) return toast(LOCKED_NOTE)
    if (!chosen.length) return
    // merge words next to each other per item into ranges (swallow the small gaps between them, never a word)
    const at = new Map(words.map((w, i) => [w.key, i]))
    const byItem = new Map<string, Array<{ start: number; end: number; i: number }>>()
    for (const w of [...chosen].sort((a, b) => at.get(a.key)! - at.get(b.key)!)) {
      const list = byItem.get(w.itemId) ?? []
      const last = list[list.length - 1]
      const i = at.get(w.key)!
      if (last && last.i === i - 1 && w.srcStart - last.end < 0.35) {
        last.end = w.srcEnd + pad
        last.i = i
      } else list.push({ start: w.srcStart - pad, end: w.srcEnd + pad, i })
      byItem.set(w.itemId, list)
    }
    let p = useEditor.getState().project
    for (const [id, ranges] of byItem) p = cutSourceRanges(p, id, ranges)
    useEditor.getState().commit(captionsAtLeastOneFrame(p), label)
    setSel(new Set())
    toast(`${label}: removed ${chosen.length} word${chosen.length > 1 ? 's' : ''}`)
  }

  /** Bring struck words back into their clips: each run of them selected together is one stretch of the recording. */
  const restoreWords = (picked: W[]) => {
    const struck = picked.filter((w) => w.struck)
    if (!struck.length) return
    const start = useEditor.getState().project
    let p = start
    let n = 0
    for (const leftId of [...new Set(struck.map((w) => w.struck!.leftId))]) {
      const all = words.filter((w) => w.struck?.leftId === leftId)
      const chosen = new Set(struck.filter((w) => w.struck!.leftId === leftId).map((w) => w.key))
      const groups: W[][] = []
      all.forEach((w, i) => {
        if (!chosen.has(w.key)) return
        if (i > 0 && chosen.has(all[i - 1].key)) groups[groups.length - 1].push(w)
        else groups.push([w])
      })
      // right to left: the piece before the cut and the earlier source times stay as they were
      for (const g of groups.reverse()) {
        const gap = g[0].struck!.gap
        const range = { start: g[0] === all[0] ? gap.start : g[0].srcStart, end: g[g.length - 1] === all[all.length - 1] ? gap.end : g[g.length - 1].srcEnd }
        const next = restoreCut(p, leftId, range)
        if (next !== p) n += g.length
        p = next
      }
    }
    if (p === start) return toast(LOCKED_NOTE)
    useEditor.getState().commit(captionsAtLeastOneFrame(p), 'Restore words')
    setSel(new Set())
    toast(`Restored ${n} word${n === 1 ? '' : 's'}`)
  }

  const removeFillers = () => {
    if (!fillerRanges.length) return toast(fillersOn.length ? 'No filler words found' : 'Switch on a filler word in the list first')
    cutWords(fillerRanges.flat(), 'Remove filler words', 0.03)
  }

  const removePauses = () => {
    let p = useEditor.getState().project
    for (const it of items) p = removeSilences(p, it.id, 0.6, 0.12)
    if (p === useEditor.getState().project) return toast('No pauses longer than 0.6 s')
    useEditor.getState().commit(captionsAtLeastOneFrame(p), 'Remove pauses')
    toast('Removed pauses')
  }

  /** A changed transcript (speaker labels): on the clip for every project that uses it, outside undo. */
  const saveTranscript = (assetId: string, tr: TranscriptT) => {
    useEditor.getState().updateMedia({ id: assetId, transcript: tr })
    if (!demo) api.setTranscript(assetId, tr).catch(toastError)
  }

  const renameAt = (i: number, to: string | null) => {
    setEditingSpeaker(null)
    requestAnimationFrame(() => boxRef.current?.querySelector(`[data-wi="${i}"]`)?.parentElement?.querySelector<HTMLElement>('.tr-spk')?.focus())
    const w = words[i]
    const name = to?.trim()
    if (!w?.speaker || !name || name === w.speaker || !gate.can) return
    // every clip shown that names this speaker
    for (const id of new Set(words.filter((x) => x.speaker === w.speaker).map((x) => x.assetId))) {
      const tr = useEditor.getState().project.assets[id]?.transcript
      if (tr) saveTranscript(id, renameSpeaker(tr, w.speaker, name))
    }
    toast(`Renamed ${w.speaker} to ${name}`)
  }

  const assign = (who: string) => {
    const picked = [...selLive, ...selStruck]
    if (!picked.length || !gate.can) return
    const name = who === '__new' ? `Speaker ${speakers.length + 1}` : who
    for (const assetId of new Set(picked.map((w) => w.assetId))) {
      let tr = useEditor.getState().project.assets[assetId]?.transcript
      if (!tr) continue
      const mine = picked.filter((w) => w.assetId === assetId).sort((a, b) => a.srcStart - b.srcStart)
      // each run of words next to each other in the recording, one range
      const ranges: Array<{ start: number; end: number }> = []
      const all = tr.segments.flatMap((s) => s.words)
      for (const w of mine) {
        const last = ranges[ranges.length - 1]
        const between = last ? all.filter((x) => x.start > last.end && x.start < w.srcStart).length : 1
        if (last && !between) last.end = w.srcEnd
        else ranges.push({ start: w.srcStart, end: w.srcEnd })
      }
      for (const r of ranges) tr = assignSpeaker(tr, r.start, r.end, name === '__none' ? '' : name)
      saveTranscript(assetId, tr)
    }
    toast(name === '__none' ? 'Speaker label taken off' : `${picked.length} word${picked.length > 1 ? 's' : ''} for ${name}`)
  }

  const transcribe = async () => {
    if (demo) return toast('Sign in to transcribe your own media — the demo clips already have transcripts.')
    try {
      for (let i = 0; i < missingIds.length; i++) {
        setBusy(`Transcribing ${i + 1}/${missingIds.length}…`)
        const job = await api.transcribe(missingIds[i])
        const done = await waitForJob<{ assetId: string; transcript: TranscriptT }>(job.id)
        // a media record, not an edit: undo never takes it away again
        if (done.result?.transcript) useEditor.getState().updateMedia({ id: missingIds[i], transcript: done.result.transcript })
      }
    } catch (e) {
      toastError(e)
    } finally {
      setBusy(null)
    }
  }

  /** Jump the playhead to a word (a struck one: to where it was cut). */
  const seekTo = (w: W) => {
    useEditor.getState().setPlaying(false)
    useEditor.getState().setPlayhead(w.start + (w.struck ? 0 : 0.001))
  }

  const onWordDown = useCallback((e: React.MouseEvent, i: number) => {
    e.preventDefault()
    boxRef.current?.focus()
    const w = words[i]
    setCaret(i)
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
      seekTo(w)
    }
  }, [words, sel, anchor]) // eslint-disable-line react-hooks/exhaustive-deps
  const onWordEnter = useCallback((i: number) => {
    if (dragging.current === null) return
    const a = Math.min(dragging.current, i)
    const b = Math.max(dragging.current, i)
    setSel(new Set(words.slice(a, b + 1).map((x) => x.key)))
  }, [words])

  // the word being spoken is marked straight in the page as the playhead moves, without re-rendering the words
  useLayoutEffect(() => {
    let cur: Element | null = null
    const mark = (t: number) => {
      const i = wordAt(words, t)
      const el = i >= 0 && !words[i].struck ? boxRef.current?.querySelector(`[data-wi="${i}"]`) ?? null : null
      if (el === cur) return
      cur?.classList.remove('cur')
      el?.classList.add('cur')
      cur = el
    }
    mark(useEditor.getState().playhead)
    const unsub = useEditor.subscribe((s, prev) => s.playhead !== prev.playhead && mark(s.playhead))
    return () => {
      unsub()
      cur?.classList.remove('cur')
    }
  }, [words, sel, matchSet, fillerSet])
  useEffect(() => {
    const up = () => (dragging.current = null)
    window.addEventListener('mouseup', up)
    return () => window.removeEventListener('mouseup', up)
  }, [])
  // the caret word stays in view as the arrows move it
  useEffect(() => {
    if (caret === null) return
    const el = boxRef.current?.querySelector<HTMLElement>(`[data-wi="${caret}"]`)
    el?.scrollIntoView?.({ block: 'nearest' })
    boxRef.current?.querySelectorAll('.caret').forEach((x) => x.classList.remove('caret'))
    el?.classList.add('caret')
  }, [caret, words, sel])

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.target !== boxRef.current) return
    const mod = e.ctrlKey || e.metaKey
    if (e.key === 'Delete' || e.key === 'Backspace') {
      // the transcript's own key, words selected or not: never the timeline's "delete clip"
      e.preventDefault()
      e.stopPropagation()
      if (selLive.length) cutWords(selLive, 'Delete words')
      else if (selStruck.length) toast('Those words are already cut. Press R to restore them.')
    } else if (!mod && !e.altKey && e.key.toLowerCase() === 'r') {
      e.preventDefault()
      e.stopPropagation()
      if (selStruck.length) restoreWords(selStruck)
      else if (sel.size) toast('Select struck-through words to restore them')
    } else if (!mod && (e.key === 'ArrowRight' || e.key === 'ArrowLeft' || e.key === 'Home' || e.key === 'End')) {
      // a caret word moves through the transcript; Shift extends the selection from where it started
      e.preventDefault()
      e.stopPropagation()
      if (!words.length) return
      const from = caret ?? (e.key === 'ArrowLeft' || e.key === 'End' ? words.length : -1)
      const i = e.key === 'Home' ? 0 : e.key === 'End' ? words.length - 1 : Math.max(0, Math.min(words.length - 1, from + (e.key === 'ArrowRight' ? 1 : -1)))
      setCaret(i)
      if (e.shiftKey) {
        const a = anchor ?? from
        const [lo, hi] = [Math.min(a, i), Math.max(a, i)]
        if (anchor === null) setAnchor(Math.max(0, Math.min(words.length - 1, a)))
        setSel(new Set(words.slice(Math.max(0, lo), hi + 1).map((x) => x.key)))
      } else {
        setAnchor(i)
        setSel(new Set([words[i].key]))
        seekTo(words[i])
      }
    } else if (mod && e.key.toLowerCase() === 'a') {
      e.preventDefault()
      e.stopPropagation()
      setSel(new Set(words.map((w) => w.key)))
    } else if (e.key === 'Escape') {
      e.stopPropagation()
      setSel(new Set())
    }
  }

  const speakerProps = useMemo(
    () => ({ editing: editingSpeaker, disabled: !gate.can, tip: gate.tip, onEdit: (i: number) => setEditingSpeaker(i), onRename: renameAt }),
    [editingSpeaker, gate.can, gate.tip, words], // eslint-disable-line react-hooks/exhaustive-deps
  )

  if (!items.length) return <Empty icon={<FileText size={22} />} title="No clip to transcribe">Select a video or audio clip, or add video to the main track.</Empty>

  return (
    <div className="ed-transcript">
      <p className="ed-note" style={{ marginTop: 0 }}>
        {selection.length ? 'Editing the selected clip.' : 'Editing the main track.'} Click a word (or move with <span className="kbd">←</span> <span className="kbd">→</span>) to jump to it; drag or Shift to select, then <span className="kbd">Delete</span> cuts it from the video. Cut words stay struck through: select them and press <span className="kbd">R</span> to restore.
      </p>
      {missingIds.length > 0 && (
        <button className="btn sm" style={{ width: '100%', marginBottom: 10 }} onClick={transcribe} disabled={!!busy}>
          {busy ? <Loader2 size={13} className="spin" /> : <FileText size={13} />} {busy ?? `Transcribe ${missingIds.length} clip${missingIds.length > 1 ? 's' : ''}`}
        </button>
      )}
      <div className="ed-search">
        <Search size={13} />
        <input placeholder="Search transcript" aria-label="Search transcript" value={query} onChange={(e) => setQuery(e.target.value)} />
        {q && <span className="muted">{matches.length}</span>}
        {q && matches.length > 0 && (
          <button className="btn sm ghost" onClick={() => setSel(new Set(matches.map((m) => m.key)))}>Select</button>
        )}
      </div>
      <div className="row" style={{ gap: 6, margin: '8px 0 6px', flexWrap: 'wrap' }}>
        <span className="tr-split">
          <button className="btn sm" onClick={removeFillers} data-tip={fillersOn.length ? `Removes: ${fillersOn.join(', ')}` : 'No filler word is switched on'}>
            <Eraser size={13} /> Filler words{fillerRanges.length ? ` (${fillerRanges.length})` : ''}
          </button>
          <button className="btn sm" aria-expanded={showFillers} aria-label="Edit the filler word list" onClick={() => setShowFillers((v) => !v)}>
            <ChevronDown size={13} style={{ transform: showFillers ? 'rotate(180deg)' : undefined }} />
          </button>
        </span>
        <button className="btn sm" onClick={removePauses}><Timer size={13} /> Pauses{pauses ? ` (${pauses})` : ''}</button>
        <button className="btn sm primary" disabled={!selLive.length} onClick={() => cutWords(selLive, 'Delete words')}><Scissors size={13} /> Cut {selLive.length || ''}</button>
        {selStruck.length > 0 && (
          <button className="btn sm" onClick={() => restoreWords(selStruck)} data-tip="R">
            <RotateCcw size={13} /> Restore {selStruck.length}
          </button>
        )}
      </div>
      {showFillers && <FillerList counts={counts} />}
      {sel.size > 0 && (
        <div className="row tr-assign">
          <label className="muted" htmlFor="tr-speaker">Speaker</label>
          <select
            id="tr-speaker"
            className="ed-select"
            value=""
            disabled={!gate.can}
            data-tip={gate.tip}
            onChange={(e) => {
              if (e.target.value) assign(e.target.value)
            }}
          >
            <option value="">Give the selected words to…</option>
            {speakers.map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
            <option value="__new">{`New speaker (Speaker ${speakers.length + 1})`}</option>
            {speakers.length > 0 && <option value="__none">No speaker</option>}
          </select>
        </div>
      )}
      {!words.length ? (
        <Empty icon={<FileText size={22} />} title="No transcript yet">{missingIds.length ? 'Transcribe the clip to edit it by text.' : 'No speech in this range.'}</Empty>
      ) : (
        <div className="ed-words" ref={boxRef} tabIndex={0} onKeyDown={onKeyDown} data-local-keys aria-label="Transcript words">
          <WordList words={words} sel={sel} matchSet={matchSet} fillerSet={fillerSet} speaker={speakerProps} onDown={onWordDown} onEnter={onWordEnter} />
        </div>
      )}
      <p className="ed-sr" aria-live="polite">
        {sel.size ? `${sel.size} word${sel.size > 1 ? 's' : ''} selected${selStruck.length ? `, ${selStruck.length} of them cut` : ''}` : ''}
      </p>
    </div>
  )
}
