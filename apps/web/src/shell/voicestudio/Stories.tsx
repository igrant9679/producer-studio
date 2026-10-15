// Stories (desktop): a multi-voice script with a cast. Each line is generated once with VoiceStudio, laid out on one
// timeline, and exported as a mixdown plus timeline-aligned stems (one per character, same length, silent where
// others speak) — into the library or straight into a new project with one audio track per character. A mastered
// single-file render goes through VoiceStudio's long-form renderer (/longform/render).
import type { AssetRecord, VoiceProfile } from '@producer/core'
import { addAsset, addItem, createAudioItem, updateTrack } from '@producer/core'
import { BookOpen, Clapperboard, Download, Layers, Library, Pause, Play, Square, Users, Wand2 } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '../../lib/api'
import { useSession } from '../../lib/session'
import { NARRATOR, buildStems, castOf, decodeMono, encodeWav, layoutStory, parseStory, safeFileName, type StoryLine } from '../../lib/storyStems'
import { toast, toastError } from '../../lib/toast'
import { useJobs, waitForAssetReady } from '../stores'
import { Progress, Spinner, useAsync, useAudioPreview } from '../ui'
import { formatDuration } from '../util'
import { DesktopOnly, EngineGate, LANGUAGES, saveBlob, useEngine } from './shared'
import { readSse, vsApi, vsFetch, vsUrl } from './vsApi'

const RATE = 48000
const SAMPLE = `# The Lighthouse
The storm reached the island just after midnight.
[Maya] Did you hear that? Something hit the rocks.
TOM: It's only the wind. Go back to sleep.
Maya pulled on her coat and climbed the stairs to the lamp room.
[Maya] Tom. There's a boat out there.`

type Built = { mix: Float32Array; stems: Map<string, Float32Array>; seconds: number }

export default function Stories({ onOpenEngine }: { onOpenEngine: () => void }) {
  const { desktop, status, running } = useEngine()
  if (!desktop) return <DesktopOnly feature="Stories and stems" />
  return (
    <EngineGate status={status} onOpenEngine={onOpenEngine}>
      {running && <StoryStudio />}
    </EngineGate>
  )
}

function StoryStudio() {
  const workspaceId = useSession((s) => s.workspaceId)!
  const navigate = useNavigate()
  const profiles = useAsync(() => vsApi.profiles(workspaceId), [workspaceId])
  const voices = (profiles.data ?? []).filter((p): p is VoiceProfile & { vsProfileId: string } => !!p.local && !!p.vsProfileId)
  const [title, setTitle] = useState('')
  const [script, setScript] = useState('')
  const [lines, setLines] = useState<StoryLine[]>([])
  const [cast, setCast] = useState<Record<string, string>>({})
  const [language, setLanguage] = useState('English')
  const [speed, setSpeed] = useState(1)
  const [gapMs, setGapMs] = useState(350)
  const [progress, setProgress] = useState<{ done: number; total: number; label: string }>()
  const [built, setBuilt] = useState<Built>()
  const [busy, setBusy] = useState<string>()
  const [render, setRender] = useState<{ phase: string; pct: number; output?: string; error?: string }>()
  const cache = useRef(new Map<string, Float32Array>())
  const stop = useRef(false)
  const preview = useAudioPreview((s) => s.toggle)
  const playing = useAudioPreview((s) => s.playing)

  const characters = useMemo(() => castOf(lines), [lines])
  // default every new character to the first voice (narrator) so the story renders out of the box
  useEffect(() => {
    if (!voices.length) return
    setCast((cur) => {
      const next = { ...cur }
      for (const c of characters) if (!next[c]) next[c] = voices[0].vsProfileId
      return next
    })
  }, [characters, voices])

  const parse = () => {
    const l = parseStory(script)
    setLines(l)
    setBuilt(undefined)
    if (!l.length) toast('Write or paste a script first')
  }

  const voiceFor = (l: StoryLine) => cast[l.character || NARRATOR] || voices[0]?.vsProfileId
  const keyFor = (l: StoryLine) => `${voiceFor(l)}|${speed}|${language}|${l.text}`

  async function renderLine(l: StoryLine): Promise<Float32Array> {
    const k = keyFor(l)
    const hit = cache.current.get(k)
    if (hit) return hit
    const f = new FormData()
    f.set('text', l.text)
    const v = voiceFor(l)
    if (v) f.set('profile_id', v)
    f.set('speed', String(speed))
    if (language !== 'Auto') f.set('language', language)
    const res = await vsFetch('/generate', { body: f })
    const s = await decodeMono(await res.arrayBuffer(), RATE)
    cache.current.set(k, s)
    return s
  }

  async function playLine(l: StoryLine) {
    try {
      setBusy(`line:${l.id}`)
      const s = await renderLine(l)
      preview(`story:${l.id}`, URL.createObjectURL(new Blob([encodeWav(s, RATE)], { type: 'audio/wav' })))
    } catch (e) {
      toastError(e)
    } finally {
      setBusy(undefined)
    }
  }

  async function buildAll() {
    const todo = lines.filter((l) => l.kind === 'line')
    if (!todo.length) return
    stop.current = false
    setBuilt(undefined)
    const rendered = new Map<string, Float32Array>()
    let failed = 0
    for (let i = 0; i < todo.length; i++) {
      if (stop.current) break
      const l = todo[i]
      setProgress({ done: i, total: todo.length, label: `${l.character || NARRATOR}: “${l.text.slice(0, 60)}”` })
      try {
        rendered.set(l.id, await renderLine(l))
      } catch (e) {
        failed++
        toastError(new Error(`Line ${i + 1}: ${e instanceof Error ? e.message : String(e)}`))
      }
    }
    setProgress(undefined)
    if (stop.current) return
    const layout = layoutStory(lines, rendered, RATE, gapMs)
    const { mix, stems } = buildStems(layout)
    setBuilt({ mix, stems, seconds: layout.length / RATE })
    toast(failed ? `Built with ${failed} line${failed === 1 ? '' : 's'} missing` : 'Mix and stems ready')
  }

  const wavFile = (samples: Float32Array, name: string) => new File([encodeWav(samples, RATE)], `${safeFileName(name)}.wav`, { type: 'audio/wav' })
  const storyName = title.trim() || 'Story'

  /** Upload mix + stems; returns records in [mix, ...stems] order with their character names. */
  async function uploadAll(): Promise<Array<{ name: string; rec: AssetRecord }>> {
    if (!built) return []
    const files: Array<{ name: string; file: File }> = [{ name: 'Mix', file: wavFile(built.mix, `${storyName} - mix`) }, ...[...built.stems].map(([c, s]) => ({ name: c, file: wavFile(s, `${storyName} - ${c}`) }))]
    const out: Array<{ name: string; rec: AssetRecord }> = []
    for (const f of files) out.push({ name: f.name, rec: await api.upload(workspaceId, f.file) })
    return out
  }

  async function toLibrary() {
    setBusy('library')
    try {
      const n = (await uploadAll()).length
      toast(`Added the mix and ${n - 1} stem${n === 2 ? '' : 's'} to the library`)
    } catch (e) {
      toastError(e)
    } finally {
      setBusy(undefined)
    }
  }

  async function toProject() {
    setBusy('project')
    try {
      const ups = await uploadAll()
      const stems = ups.slice(1)
      const ready = await Promise.all(stems.map((u) => waitForAssetReady(u.rec.asset.id)))
      const res = await api.createProject({ workspaceId, name: storyName })
      let p = res.project
      ready.forEach((rec, i) => {
        p = addAsset(p, rec.asset)
        const item = createAudioItem(rec.asset, 0, { name: stems[i].name })
        p = addItem(p, item)
        const track = p.tracks.find((t) => t.items.some((x) => x.id === item.id))
        if (track) p = updateTrack(p, track.id, { name: stems[i].name })
      })
      await api.saveProject(res.summary.id, p, res.version)
      navigate(`/edit/${res.summary.id}?tab=audio`)
    } catch (e) {
      toastError(e)
      setBusy(undefined)
    }
  }

  async function renderMastered(format: 'm4b' | 'mp3') {
    // chapters from headings; spans carry each line's voice
    const chapters: Array<{ title: string; spans: Array<{ voice_id?: string; text: string; pause_ms_after?: number; speed?: number }> }> = []
    for (const l of lines) {
      if (l.kind === 'heading') chapters.push({ title: l.text, spans: [] })
      else {
        if (!chapters.length) chapters.push({ title: '', spans: [] })
        chapters[chapters.length - 1].spans.push({ voice_id: voiceFor(l), text: l.text, pause_ms_after: gapMs, speed })
      }
    }
    setRender({ phase: 'Starting', pct: -1 })
    try {
      const res = await vsFetch('/longform/render', { body: { chapters: chapters.filter((c) => c.spans.length), default_voice: voices[0]?.vsProfileId, language: language === 'Auto' ? undefined : language, format, loudness: 'podcast', metadata: { title: storyName } } })
      for await (const ev of readSse(res)) {
        const d = ev.data ?? {}
        if (d.type === 'chapter') setRender({ phase: `Chapter ${d.index + 1} of ${d.total}`, pct: (d.index + 1) / d.total })
        else if (d.type === 'assembling') setRender({ phase: 'Assembling', pct: -1 })
        else if (d.type === 'mastering') setRender({ phase: 'Mastering loudness', pct: -1 })
        else if (d.type === 'error') throw new Error(d.error || d.reason || 'Render failed')
        else if (d.type === 'done') {
          setRender({ phase: 'Done', pct: 1, output: d.output })
          return
        }
      }
      throw new Error('The render stopped before it finished')
    } catch (e) {
      setRender({ phase: 'Failed', pct: 0, error: e instanceof Error ? e.message : String(e) })
    }
  }

  const blobUrl = useMemo(() => (built ? URL.createObjectURL(new Blob([encodeWav(built.mix, RATE)], { type: 'audio/wav' })) : undefined), [built])
  useEffect(() => () => {
    if (blobUrl) URL.revokeObjectURL(blobUrl)
  }, [blobUrl])

  return (
    <div className="ps-vs">
      <div className="ps-vs-main">
        <div className="ps-vs-editor">
          <input className="ps-vs-name" placeholder="Story title" value={title} onChange={(e) => setTitle(e.target.value)} aria-label="Story title" />
          <textarea className="ps-vs-text" style={{ minHeight: 220 }} value={script} onChange={(e) => setScript(e.target.value)} aria-label="Story script" placeholder={'One line per sentence or speech.\n# Chapter title starts a chapter · [Maya] or MAYA: for a character · anything else is the narrator.'} />
          <div className="ps-vs-bar">
            {!script && <button className="chip" onClick={() => setScript(SAMPLE)}>Try a sample</button>}
            <span className="spacer" />
            <button className="btn sm primary" onClick={parse} disabled={!script.trim()}><Users size={13} /> Read the script</button>
          </div>
        </div>

        {lines.length > 0 && (
          <div className="ps-section" style={{ marginTop: 20 }}>
            <div className="ps-section-head"><h2 className="ps-h2">Lines</h2><span className="muted" style={{ fontSize: '0.75rem' }}>{lines.filter((l) => l.kind === 'line').length} lines · {characters.length} voices</span></div>
            <div className="vs-seg-wrap">
              <table className="vs-seg-table">
                <thead><tr><th style={{ width: 150 }}>Character</th><th>Line</th><th style={{ width: 44 }} /></tr></thead>
                <tbody>
                  {lines.map((l, i) =>
                    l.kind === 'heading' ? (
                      <tr key={l.id}><td colSpan={3}><strong># {l.text}</strong></td></tr>
                    ) : (
                      <tr key={l.id}>
                        <td>
                          <select className="input" value={l.character || NARRATOR} onChange={(e) => setLines((cur) => cur.map((x, j) => (j === i ? { ...x, character: e.target.value === NARRATOR ? '' : e.target.value } : x)))}>
                            {characters.map((c) => <option key={c}>{c}</option>)}
                          </select>
                        </td>
                        <td><textarea className="input" value={l.text} onChange={(e) => setLines((cur) => cur.map((x, j) => (j === i ? { ...x, text: e.target.value } : x)))} /></td>
                        <td>
                          <button className="btn ghost icon sm" disabled={!!busy} onClick={() => void playLine(l)} aria-label="Preview line">
                            {busy === `line:${l.id}` ? <Spinner size={12} /> : playing === `story:${l.id}` ? <Pause size={13} /> : <Play size={13} />}
                          </button>
                        </td>
                      </tr>
                    ),
                  )}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {built && (
          <div className="ps-section" style={{ marginTop: 20 }}>
            <div className="ps-section-head"><Layers size={16} /><h2 className="ps-h2">Mix and stems</h2><span className="muted" style={{ fontSize: '0.75rem' }}>{formatDuration(built.seconds)} · every stem is the same length, so they line up</span></div>
            <div className="vs-engine-list">
              <div className="vs-engine-row">
                <strong style={{ width: 120 }}>Mix</strong>
                {blobUrl && <audio src={blobUrl} controls style={{ flex: 1, height: 34 }} />}
                <button className="btn ghost sm icon" onClick={() => saveBlob(new Blob([encodeWav(built.mix, RATE)], { type: 'audio/wav' }), `${safeFileName(storyName)} - mix.wav`)} aria-label="Download mix"><Download size={13} /></button>
              </div>
              {[...built.stems].map(([c, s]) => (
                <div key={c} className="vs-engine-row">
                  <strong style={{ width: 120 }} className="ellipsis">{c}</strong>
                  <span className="muted" style={{ flex: 1, fontSize: '0.75rem' }}>{voices.find((v) => v.vsProfileId === cast[c])?.name ?? 'default voice'}</span>
                  <button className="btn ghost sm icon" onClick={() => saveBlob(new Blob([encodeWav(s, RATE)], { type: 'audio/wav' }), `${safeFileName(storyName)} - ${safeFileName(c)}.wav`)} aria-label={`Download ${c} stem`}><Download size={13} /></button>
                </div>
              ))}
            </div>
            <div className="vs-outputs" style={{ marginTop: 12 }}>
              <button className="btn primary" disabled={!!busy} onClick={toProject}>{busy === 'project' ? <Spinner size={13} /> : <Clapperboard size={14} />} Open as a project (one track per voice)</button>
              <button className="btn" disabled={!!busy} onClick={toLibrary}>{busy === 'library' ? <Spinner size={13} /> : <Library size={14} />} Add mix + stems to library</button>
            </div>
          </div>
        )}
      </div>

      <aside className="ps-vs-side">
        <div className="ps-vs-panel">
          <strong style={{ fontFamily: 'var(--font-display)' }}>Cast</strong>
          {!voices.length && <div className="ps-alert info" style={{ marginTop: 8 }}>Add voices in My voices (clone, design or a preset) to cast your story.</div>}
          {characters.map((c) => (
            <div key={c} style={{ marginTop: 10 }}>
              <label className="label">{c}</label>
              <select className="input" value={cast[c] ?? ''} onChange={(e) => {
                setCast((cur) => ({ ...cur, [c]: e.target.value }))
                setBuilt(undefined)
              }}>
                {voices.map((v) => <option key={v.id} value={v.vsProfileId}>{v.name}</option>)}
              </select>
            </div>
          ))}
          {!characters.length && <div className="muted" style={{ fontSize: '0.75rem', marginTop: 8 }}>Read the script to list its characters.</div>}

          <div className="vs-form-grid" style={{ marginTop: 14 }}>
            <div>
              <label className="label">Language</label>
              <select className="input" value={language} onChange={(e) => setLanguage(e.target.value)}>{LANGUAGES.map((l) => <option key={l}>{l}</option>)}</select>
            </div>
            <div>
              <label className="label">Pause between lines</label>
              <select className="input" value={gapMs} onChange={(e) => setGapMs(Number(e.target.value))}>
                {[150, 250, 350, 500, 750, 1000].map((v) => <option key={v} value={v}>{v} ms</option>)}
              </select>
            </div>
          </div>
          <div className="ps-vs-speed">
            <div className="row"><label className="label" style={{ margin: 0 }}>Speed</label><span className="spacer" /><span className="kbd">{speed.toFixed(2)}×</span></div>
            <input type="range" className="ps-range" min={0.7} max={1.4} step={0.05} value={speed} onChange={(e) => setSpeed(Number(e.target.value))} />
          </div>

          {progress ? (
            <div className="ps-vs-gen">
              <div className="row" style={{ fontSize: '0.7812rem' }}><Spinner size={13} /> Line {progress.done + 1} of {progress.total}</div>
              <Progress value={progress.done / progress.total} />
              <div className="muted ellipsis" style={{ fontSize: '0.7188rem' }}>{progress.label}</div>
              <button className="btn ghost sm" onClick={() => (stop.current = true)}><Square size={12} /> Stop</button>
            </div>
          ) : (
            <button className="btn primary ps-vs-go" disabled={!lines.some((l) => l.kind === 'line') || !voices.length} onClick={buildAll}><Layers size={16} /> Build mix and stems</button>
          )}

          <div style={{ marginTop: 14, paddingTop: 12, borderTop: '1px solid var(--border)' }}>
            <strong style={{ fontSize: '0.8125rem' }}><BookOpen size={13} style={{ verticalAlign: -2 }} /> Mastered single file</strong>
            <div className="muted" style={{ fontSize: '0.7188rem', margin: '4px 0 8px' }}>One loudness-mastered file with chapters, rendered by VoiceStudio.</div>
            {render && render.phase !== 'Done' && render.phase !== 'Failed' ? (
              <><div className="row" style={{ fontSize: '0.75rem' }}><Spinner size={12} /> {render.phase}</div><Progress value={render.pct} /></>
            ) : (
              <div className="row" style={{ gap: 6 }}>
                <button className="btn sm" disabled={!lines.length || !voices.length} onClick={() => void renderMastered('m4b')}><Wand2 size={12} /> M4B</button>
                <button className="btn sm" disabled={!lines.length || !voices.length} onClick={() => void renderMastered('mp3')}><Wand2 size={12} /> MP3</button>
              </div>
            )}
            {render?.error && <div className="ps-alert" style={{ marginTop: 8 }}>{render.error}</div>}
            {render?.output && (
              <div style={{ marginTop: 8 }}>
                <audio src={vsUrl(`/audio/${render.output}`)} controls style={{ width: '100%' }} />
                <button className="btn sm" style={{ marginTop: 6 }} onClick={async () => {
                  try {
                    const j = await vsApi.importOutput({ workspaceId, source: `/audio/${encodeURIComponent(render.output!)}`, name: storyName, kind: 'audio', ext: render.output!.endsWith('.mp3') ? '.mp3' : '.m4b' })
                    useJobs.getState().upsert(j)
                    toast('Adding to the library')
                  } catch (e) {
                    toastError(e)
                  }
                }}><Library size={12} /> Add to library</button>
              </div>
            )}
          </div>
        </div>
      </aside>
    </div>
  )
}
