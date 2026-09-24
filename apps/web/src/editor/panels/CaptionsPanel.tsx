// Captions: auto captions (transcribe media lacking a transcript, then generateCaptions), manual captions,
// style presets / mode / position / colours, SRT import and export.
import type { Item, Project, Transcript } from '@producer/core'
import { captionStyleFromPreset, createCaptionItem, exportSrt, generateCaptions, importSrt, insertTrack, clone } from '@producer/core'
import { Download, FileUp, Loader2, Plus, Subtitles, Trash2, Wand2 } from 'lucide-react'
import { useRef, useState } from 'react'
import { api, waitForJob } from '../../lib/api'
import { toast, toastError } from '../../lib/toast'
import { Empty } from '../controls'
import { CaptionStyleEditor } from '../PropertiesPanel'
import { useEditor } from '../store'

function speechItems(p: Project): Item[] {
  return p.tracks.flatMap((t) => (t.muted ? [] : t.items)).filter((i) => (i.type === 'video' || i.type === 'audio') && !i.muted)
}

export function CaptionsPanel() {
  const project = useEditor((s) => s.project)
  const demo = useEditor((s) => s.demo)
  const [busy, setBusy] = useState<string | null>(null)
  const file = useRef<HTMLInputElement>(null)
  const track = project.tracks.find((t) => t.kind === 'caption')
  const items = speechItems(project)
  const withTranscript = items.filter((i) => 'assetId' in i && project.assets[i.assetId]?.transcript)
  const missing = [...new Set(items.filter((i) => 'assetId' in i && !project.assets[i.assetId]?.transcript && project.assets[i.assetId]?.hasAudio !== false).map((i) => (i as { assetId: string }).assetId))]

  const auto = async () => {
    const s = useEditor.getState()
    let p = s.project
    try {
      if (missing.length && !demo) {
        for (let i = 0; i < missing.length; i++) {
          const id = missing[i]
          setBusy(`Transcribing ${i + 1} of ${missing.length}…`)
          const job = await api.transcribe(id)
          const done = await waitForJob<{ assetId: string; transcript: Transcript }>(job.id, (j) => setBusy(`Transcribing ${i + 1} of ${missing.length}… ${j.progress > 0 ? Math.round(j.progress * 100) + '%' : ''}`))
          const tr = done.result?.transcript
          if (tr) {
            p = clone(p)
            p.assets[id] = { ...p.assets[id], transcript: tr }
          }
        }
      } else if (missing.length && demo && !withTranscript.length) {
        toast('Sign in to transcribe your own media — the demo clips already have transcripts.')
        return
      }
      setBusy('Building captions…')
      const style = track?.captionStyle ?? captionStyleFromPreset('clean')
      const next = generateCaptions(p, { style })
      const n = next.tracks.find((t) => t.kind === 'caption')?.items.length ?? 0
      if (!n) {
        toast('No speech found to caption')
        return
      }
      useEditor.getState().commit(next, 'Auto captions')
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
    let t = p.tracks.find((x) => x.kind === 'caption')
    if (!t) t = insertTrack(p, 'caption')
    const c = createCaptionItem(s.playhead, 2, 'New caption')
    if (t.items.some((i) => i.start < c.start + c.duration && i.start + i.duration > c.start)) {
      toast('There is already a caption at the playhead')
      return
    }
    t.items.push(c)
    t.items.sort((a, b) => a.start - b.start)
    s.commit(p, 'Add caption', { selection: [c.id] })
  }

  const onSrt = async (f: File) => {
    const text = await f.text()
    const s = useEditor.getState()
    const style = track?.captionStyle
    let p = importSrt(s.project, text)
    if (style) {
      p = clone(p)
      const ct = p.tracks.find((t) => t.kind === 'caption')
      if (ct) ct.captionStyle = style
    }
    s.commit(p, 'Import SRT')
    toast(`Imported ${p.tracks.find((t) => t.kind === 'caption')?.items.length ?? 0} captions`)
  }

  const download = () => {
    const srt = exportSrt(project)
    if (!srt) return toast('No captions to export')
    const url = URL.createObjectURL(new Blob([srt], { type: 'application/x-subrip' }))
    const a = document.createElement('a')
    a.href = url
    a.download = `${project.name || 'captions'}.srt`
    a.click()
    setTimeout(() => URL.revokeObjectURL(url), 2000)
  }

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
          {busy ?? (track ? 'Regenerate captions' : 'Generate captions')}
        </button>
      </div>
      <div className="ed-btnrow">
        <button className="btn sm" onClick={addManual} title="Add a caption at the playhead"><Plus size={13} /> Manual</button>
        <button className="btn sm" onClick={() => file.current?.click()} title="Import an .srt file"><FileUp size={13} /> .srt</button>
        <button className="btn sm" onClick={download} disabled={!track} title="Download captions as .srt"><Download size={13} /> Export</button>
      </div>
      <input
        ref={file}
        type="file"
        accept=".srt,text/plain"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0]
          if (f) void onSrt(f)
          e.target.value = ''
        }}
      />
      {track ? (
        <>
          <CaptionStyleEditor track={track} />
          <div className="ed-group">
            <div className="row">
              <span className="eyebrow">Lines ({track.items.length})</span>
              <div className="spacer" />
              <button className="btn sm ghost" onClick={() => {
                const s = useEditor.getState()
                const p = clone(s.project)
                p.tracks = p.tracks.filter((t) => t.id !== track.id)
                s.commit(p, 'Remove captions')
              }}>
                <Trash2 size={13} /> Remove
              </button>
            </div>
            <div className="ed-caplines">
              {track.items.slice(0, 200).map((c) => (
                <button
                  key={c.id}
                  onClick={() => {
                    useEditor.getState().select([c.id])
                    useEditor.getState().setPlayhead(c.start + 0.01)
                  }}
                >
                  <span className="t">{c.start.toFixed(1)}s</span>
                  <span className="x">{c.type === 'caption' ? c.text : ''}</span>
                </button>
              ))}
            </div>
          </div>
        </>
      ) : (
        <Empty icon={<Subtitles size={22} />} title="No captions yet">Generate them from speech, add one manually, or import an .srt file.</Empty>
      )}
    </>
  )
}
