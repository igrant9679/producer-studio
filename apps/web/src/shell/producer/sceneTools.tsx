// Producer review tools (A-7): the script's versions (from the project's version history), and a scene's own narrator
// (voice and speed) with "Narrate again" for one scene.
import type { ScriptScene, ScriptVersion, Voice } from '@producer/core'
import { History, Mic, RotateCcw } from 'lucide-react'
import { useState } from 'react'
import { req } from '../../lib/api'
import { toast } from '../../lib/toast'
import { Modal, Popover, Spinner, useAsync } from '../ui'
import { relativeTime } from '../util'

export const producerApi = {
  scriptVersions: (projectId: string) => req<ScriptVersion[]>('GET', `/ai/produce/${projectId}/script-versions`),
}

/** The script's saved versions; Restore puts one back in the wizard (where it saves again as the newest). */
export function ScriptVersionsButton({ projectId, onRestore }: { projectId: string; onRestore: (v: ScriptVersion) => void }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button className="btn sm" onClick={() => setOpen(true)}><History size={13} /> Versions</button>
      {open && <ScriptVersionsModal projectId={projectId} onClose={() => setOpen(false)} onRestore={(v) => { onRestore(v); setOpen(false) }} />}
    </>
  )
}

function ScriptVersionsModal({ projectId, onClose, onRestore }: { projectId: string; onClose: () => void; onRestore: (v: ScriptVersion) => void }) {
  const list = useAsync(() => producerApi.scriptVersions(projectId), [projectId])
  return (
    <Modal title="Script versions" subtitle="Every few minutes of editing is kept, with what Producer wrote and each assembly. Restore one to keep working from it: the script you have now stays in this list." onClose={onClose} width={620}>
      {list.error ? (
        <div className="ps-alert" role="alert">Couldn’t load the versions. <button className="btn sm" onClick={list.reload}>Retry</button></div>
      ) : !list.data ? (
        <Spinner />
      ) : !list.data.length ? (
        <p className="muted">No saved versions of the script yet.</p>
      ) : (
        <ol className="ps-sver" aria-label="Script versions">
          {list.data.map((v, i) => (
            <li key={v.versionId} className="ps-sver-row">
              <div className="ps-sver-meta">
                <strong>{v.name || (i === 0 ? 'Latest' : relativeTime(v.createdAt))}</strong>
                <span>
                  {i === 0 && !v.name ? `${relativeTime(v.createdAt)} · ` : ''}
                  {v.scenes.length} scene{v.scenes.length === 1 ? '' : 's'} · {v.words} words{v.authorName ? ` · ${v.authorName}` : ''}
                  {v.label === 'before-ai' ? ' · before an assembly' : ''}
                </span>
                <span className="ps-sver-line">“{v.scenes[0]?.narration.slice(0, 120)}{(v.scenes[0]?.narration.length ?? 0) > 120 ? '…' : ''}”</span>
              </div>
              {i > 0 && (
                <button className="btn sm" onClick={() => onRestore(v)} aria-label={`Restore the script from ${relativeTime(v.createdAt)}`}><RotateCcw size={13} /> Restore</button>
              )}
            </li>
          ))}
        </ol>
      )}
    </Modal>
  )
}

/**
 * A scene's narrator: the brief's voice unless the scene has its own, at its own speed; "Narrate again" makes a fresh
 * take of this scene only (the others keep theirs) when the video is assembled again.
 */
export function NarratorControl({ scene, voices, briefVoice, assembled, onChange, onRenarrate }: {
  scene: ScriptScene
  voices: Voice[]
  briefVoice: string
  assembled: boolean
  onChange: (n: ScriptScene['narrator']) => void
  onRenarrate: () => void
}) {
  const own = scene.narrator
  const voice = own?.voice ?? briefVoice
  const speed = own?.speed ?? 1
  const name = voices.find((v) => v.id === voice)?.name ?? voice
  const set = (p: { voice?: string; speed?: number }) => {
    const next = { ...(own ?? {}), ...p }
    if (next.voice === briefVoice || !next.voice) delete next.voice
    if (next.speed === 1) delete next.speed
    onChange(Object.keys(next).length ? next : undefined)
  }
  return (
    <Popover
      align="right"
      style={{ width: 280 }}
      trigger={({ toggle, open }) => (
        <button className="btn ghost sm" onClick={toggle} aria-expanded={open} aria-label={`Narrator of this scene: ${name}${speed !== 1 ? ` at ${speed}×` : ''}`} title="This scene’s voice and speed">
          <Mic size={13} /> {own ? `${name}${speed !== 1 ? ` · ${speed}×` : ''}` : 'Narrator'}
        </button>
      )}
    >
      {(close) => (
        <div className="ps-narrator" style={{ padding: 12 }}>
          <label className="label" htmlFor={`nv-${scene.id}`}>Voice for this scene</label>
          <select id={`nv-${scene.id}`} className="input" value={voice} onChange={(e) => set({ voice: e.target.value })}>
            {voices.map((v) => <option key={v.id} value={v.id}>{v.name}{v.id === briefVoice ? ' (the brief’s)' : ''}{v.available === false ? ' (desktop offline)' : ''}</option>)}
          </select>
          <label className="label" htmlFor={`ns-${scene.id}`} style={{ marginTop: 10 }}>Speed {speed.toFixed(2)}×</label>
          <input id={`ns-${scene.id}`} type="range" className="ps-range" min={0.5} max={2} step={0.05} value={speed} onChange={(e) => set({ speed: Number(e.target.value) })} />
          <div className="row" style={{ gap: 6, marginTop: 12, flexWrap: 'wrap' }}>
            {own && <button className="btn sm ghost" onClick={() => onChange(undefined)}>Use the brief’s</button>}
            <span className="spacer" />
            {assembled && (
              <button
                className="btn sm primary"
                onClick={() => {
                  close()
                  onRenarrate()
                  toast('Narrating this scene again; the others keep their voices')
                }}
              >
                <Mic size={13} /> Narrate again
              </button>
            )}
          </div>
        </div>
      )}
    </Popover>
  )
}
