// Audio tools added with VoiceStudio 0.5.8 (desktop): sound effects from a description (the MOSS-SoundEffect sidecar,
// /api/sfx/*) and the voice changer (/convert), which keeps the speaker's timing and intonation and, for a video, its
// picture. Both results come into the library through /api/voicestudio/import.
import type { AssetRecord, Job, VoiceProfile } from '@producer/core'
import { Download, Film, Library, Mic2, Sparkles, Upload, Volume2 } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { api, mediaUrl, waitForJob } from '../../lib/api'
import { useSession } from '../../lib/session'
import { toast, toastError } from '../../lib/toast'
import { useJobs } from '../stores'
import { sysFetch } from '../system'
import { Progress, Spinner, useAsync } from '../ui'
import { formatDuration } from '../util'
import { fmtBytes, useElapsed } from './shared'
import { type ConvertTake, type SfxTake, vsApi, vsFetch, vsGet, vsUrl } from './vsApi'

/** Sound-effect ideas for an empty prompt (what VoiceStudio's own panel suggests is similar). */
export const SFX_EXAMPLES = ['A heavy wooden door creaks open in an old house', 'Rain on a tin roof with distant thunder', 'A crowd cheering in a stadium', 'Footsteps on gravel, walking slowly']

interface SidecarJob {
  job: null | { state: 'running' | 'succeeded' | 'failed'; error?: string | null; weights_progress?: { pct?: number } | null }
}

/** Bring a VoiceStudio output (/audio/…) into the space's library. */
async function addToLibrary(workspaceId: string, source: string, name: string, kind: 'audio' | 'video') {
  const job = await vsApi.importOutput({ workspaceId, source, name, kind, origin: 'voicestudio' })
  await waitForJob(job.id, (j) => useJobs.getState().upsert(j))
}

export function SoundEffects() {
  const workspaceId = useSession((s) => s.workspaceId)!
  const [rev, setRev] = useState(0)
  const status = useAsync(() => vsApi.sfxStatus(), [rev])
  const [prompt, setPrompt] = useState('')
  const [seconds, setSeconds] = useState<number>()
  const [busy, setBusy] = useState(false)
  const [take, setTake] = useState<SfxTake & { prompt: string }>()
  const [install, setInstall] = useState<SidecarJob['job']>()
  const [adding, setAdding] = useState(false)
  const elapsed = useElapsed(busy)
  const s = status.data
  const len = seconds ?? s?.default_seconds ?? 10

  // the install runs in VoiceStudio: follow it until it ends
  useEffect(() => {
    if (install?.state !== 'running') return
    const t = setTimeout(async () => {
      try {
        const st = await vsGet<SidecarJob>('/engines/sidecar/moss-soundeffect/install/status')
        setInstall(st.job)
        if (st.job?.state !== 'running') setRev((n) => n + 1)
      } catch {
        /* keep following */
      }
    }, 2000)
    return () => clearTimeout(t)
  }, [install])

  const startInstall = async () => {
    try {
      await vsFetch('/engines/sidecar/moss-soundeffect/install', { method: 'POST' })
      setInstall({ state: 'running' })
    } catch (e) {
      toastError(e)
    }
  }
  const generate = async () => {
    const p = prompt.trim()
    if (!p) return
    setBusy(true)
    try {
      setTake({ ...(await vsApi.sfxGenerate({ prompt: p, duration: len })), prompt: p })
    } catch (e) {
      toastError(e)
    } finally {
      setBusy(false)
    }
  }
  return (
    <section className="card vs-engine-card">
      <div className="row" style={{ gap: 8 }}>
        <Volume2 size={15} /> <strong>Sound effects</strong>
      </div>
      <p className="muted" style={{ fontSize: '0.8125rem', margin: '6px 0 12px' }}>
        Describe a sound and VoiceStudio makes it (1–30 seconds), with MOSS-SoundEffect (Apache-2.0). It runs on this computer’s NVIDIA graphics card.
      </p>
      {status.loading && !s && <Spinner size={14} />}
      {!!status.error && <div className="muted" style={{ fontSize: '0.8125rem' }}>Sound effects need VoiceStudio 0.5.8: update it in the Engine tab.</div>}
      {s && !s.supported && <div className="ps-alert">{s.reason || 'This computer can’t make sound effects (they need an NVIDIA graphics card).'}</div>}
      {s && s.supported && !s.available && (
        <div>
          {install?.state === 'running' ? (
            <div>
              <div className="muted" style={{ fontSize: '0.8125rem', marginBottom: 6 }}>Installing sound effects…</div>
              <Progress value={install.weights_progress?.pct != null ? install.weights_progress.pct / 100 : -1} />
            </div>
          ) : (
            <>
              {install?.state === 'failed' && <div className="ps-alert" style={{ marginBottom: 8 }}>{install.error || 'The install failed.'}</div>}
              <button className="btn sm" onClick={() => void startInstall()}>
                <Download size={13} /> Install sound effects{s.download_bytes ? ` (${fmtBytes(s.download_bytes)})` : ''}
              </button>
            </>
          )}
        </div>
      )}
      {s?.available && (
        <>
          <textarea
            className="input"
            rows={2}
            maxLength={s.max_prompt_chars}
            placeholder={SFX_EXAMPLES[0]}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            aria-label="Describe the sound"
          />
          <div className="row" style={{ gap: 6, flexWrap: 'wrap', marginTop: 6 }}>
            {!prompt &&
              SFX_EXAMPLES.map((x) => (
                <button key={x} className="btn ghost sm" onClick={() => setPrompt(x)}>
                  {x}
                </button>
              ))}
          </div>
          <div className="row" style={{ gap: 10, marginTop: 10, flexWrap: 'wrap', alignItems: 'center' }}>
            <label className="label" htmlFor="vs-sfx-len" style={{ margin: 0 }}>Length</label>
            <input id="vs-sfx-len" type="range" min={s.min_seconds} max={s.max_seconds} step={1} value={len} onChange={(e) => setSeconds(Number(e.target.value))} className="ps-range" style={{ width: 160 }} />
            <span className="kbd">{len} s</span>
            <button className="btn primary sm" disabled={!prompt.trim() || busy} onClick={() => void generate()}>
              {busy ? <><Spinner size={13} /> Making it… {elapsed}s</> : <><Sparkles size={13} /> Make the sound</>}
            </button>
          </div>
          {take && (
            <div className="row" style={{ gap: 8, marginTop: 12, flexWrap: 'wrap', alignItems: 'center' }}>
              <audio src={vsUrl(take.audio_url)} controls style={{ height: 32 }} />
              <span className="muted" style={{ fontSize: '0.8125rem' }}>{formatDuration(take.duration_s)}</span>
              <button
                className="btn sm"
                disabled={adding}
                onClick={async () => {
                  setAdding(true)
                  try {
                    await addToLibrary(workspaceId, take.audio_url, `Sound effect · ${take.prompt.slice(0, 60)}`, 'audio')
                    toast('Added the sound effect to the library')
                  } catch (e) {
                    toastError(e)
                  } finally {
                    setAdding(false)
                  }
                }}
              >
                {adding ? <Spinner size={13} /> : <Library size={13} />} Add to library
              </button>
            </div>
          )}
        </>
      )}
    </section>
  )
}

type Source = { file?: File; asset?: AssetRecord; label: string; video: boolean }
const VIDEO = /\.(mp4|mov|m4v|mkv)$/i

export function VoiceChanger() {
  const workspaceId = useSession((s) => s.workspaceId)!
  const profiles = useAsync(() => vsApi.profiles(workspaceId), [workspaceId])
  const voices = (profiles.data ?? []).filter((p): p is VoiceProfile & { vsProfileId: string } => !!p.local && !!p.vsProfileId)
  const [voice, setVoice] = useState('')
  const [src, setSrc] = useState<Source>()
  const [keep, setKeep] = useState(true)
  const [picking, setPicking] = useState(false)
  const [busy, setBusy] = useState(false)
  const [take, setTake] = useState<ConvertTake>()
  const [adding, setAdding] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)
  const elapsed = useElapsed(busy)
  const lib = useAsync(async () => (picking ? (await api.assets(workspaceId)).filter((a) => (a.asset.kind === 'audio' || a.asset.kind === 'video') && a.status === 'ready') : []), [workspaceId, picking])
  const chosen = voices.find((v) => v.id === voice) ?? voices[0]
  // a video always keeps its delivery (re-speaking a transcript couldn't stay in sync with the picture)
  const keeps = keep || !!src?.video

  const run = async () => {
    if (!src || !chosen) return
    setBusy(true)
    setTake(undefined)
    try {
      const fields = { profile_id: chosen.vsProfileId, keep_delivery: keeps ? 'true' : 'false' }
      let res: Response
      if (src.asset) res = await vsApi.assetTo('convert', src.asset.asset.id, fields)
      else {
        const f = new FormData()
        f.set('audio', src.file!, src.file!.name)
        for (const [k, v] of Object.entries(fields)) f.set(k, v)
        res = await vsFetch('/convert', { body: f })
      }
      const t = (await res.json()) as ConvertTake
      setTake(t)
      if (t.message) toast(t.message)
    } catch (e) {
      toastError(e)
    } finally {
      setBusy(false)
    }
  }
  const base = `${src?.label.replace(/\.[^.]+$/, '') ?? 'Recording'} — ${chosen?.name ?? 'new voice'}`
  return (
    <section className="card vs-engine-card">
      <div className="row" style={{ gap: 8 }}>
        <Mic2 size={15} /> <strong>Voice changer</strong>
      </div>
      <p className="muted" style={{ fontSize: '0.8125rem', margin: '6px 0 12px' }}>
        The same recording in one of your voices. Keeping the delivery changes only the voice, so the timing, rhythm and intonation stay and lip-sync
        survives (it needs CosyVoice 3 from the Engine tab). A video (MP4, MOV, M4V, MKV) comes back with its picture and its voice changed.
      </p>
      {!voices.length && !profiles.loading ? (
        <div className="muted" style={{ fontSize: '0.8125rem' }}>Clone or design a voice in My voices first.</div>
      ) : (
        <>
          <div className="row" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            <select className="input" style={{ width: 'auto' }} value={chosen?.id ?? ''} onChange={(e) => setVoice(e.target.value)} aria-label="Voice to change to">
              {voices.map((v) => (
                <option key={v.id} value={v.id}>{v.name}</option>
              ))}
            </select>
            <button className="btn sm" onClick={() => fileRef.current?.click()}><Upload size={13} /> Choose a file</button>
            <button className="btn sm" onClick={() => setPicking((v) => !v)}><Library size={13} /> From the library</button>
            {src && <span className="vs-chip">{src.video ? <Film size={11} /> : <Mic2 size={11} />} {src.label}</span>}
            <input
              ref={fileRef}
              type="file"
              accept="audio/*,.mp4,.mov,.m4v,.mkv"
              hidden
              onChange={(e) => {
                const f = e.target.files?.[0]
                if (f) setSrc({ file: f, label: f.name, video: VIDEO.test(f.name) })
                setTake(undefined)
                e.target.value = ''
              }}
            />
          </div>
          {picking && (
            <div className="vs-lib" style={{ marginTop: 8 }}>
              {lib.loading && !lib.data ? <span className="muted"><Spinner size={13} /> Loading…</span> : null}
              {(lib.data ?? []).slice(0, 40).map((a) => (
                <button
                  key={a.asset.id}
                  className={`vs-lib-row ${src?.asset?.asset.id === a.asset.id ? 'on' : ''}`}
                  onClick={() => {
                    setSrc({ asset: a, label: a.asset.name, video: a.asset.kind === 'video' })
                    setTake(undefined)
                    setPicking(false)
                  }}
                >
                  {a.asset.kind === 'video' ? <Film size={14} /> : <Mic2 size={14} />} <span className="ellipsis">{a.asset.name}</span>
                  <span className="muted">{a.asset.duration ? formatDuration(a.asset.duration) : ''}</span>
                </button>
              ))}
              {lib.data && !lib.data.length && <span className="muted">No audio or video in this space.</span>}
            </div>
          )}
          <label className="row" style={{ gap: 8, marginTop: 10, fontSize: '0.875rem' }}>
            <input type="checkbox" checked={keeps} disabled={!!src?.video} onChange={(e) => setKeep(e.target.checked)} />
            <span>Keep my delivery (timing and intonation){src?.video ? ': always, for a video' : ''}</span>
          </label>
          <div className="row" style={{ gap: 8, marginTop: 10, flexWrap: 'wrap', alignItems: 'center' }}>
            <button className="btn primary sm" disabled={!src || !chosen || busy} onClick={() => void run()}>
              {busy ? <><Spinner size={13} /> Changing the voice… {elapsed}s</> : <><Mic2 size={13} /> Change the voice</>}
            </button>
          </div>
          {take && (
            <div className="row" style={{ gap: 8, marginTop: 12, flexWrap: 'wrap', alignItems: 'center' }}>
              {take.video_url ? <video src={vsUrl(take.video_url)} controls style={{ maxWidth: 320, borderRadius: 6 }} /> : <audio src={vsUrl(take.audio_url)} controls style={{ height: 32 }} />}
              <button
                className="btn sm"
                disabled={adding}
                onClick={async () => {
                  setAdding(true)
                  try {
                    await addToLibrary(workspaceId, take.video_url || take.audio_url, base, take.video_url ? 'video' : 'audio')
                    toast(take.video_url ? 'Added the video to the library' : 'Added the recording to the library')
                  } catch (e) {
                    toastError(e)
                  } finally {
                    setAdding(false)
                  }
                }}
              >
                {adding ? <Spinner size={13} /> : <Library size={13} />} Add to library
              </button>
            </div>
          )}
        </>
      )}
    </section>
  )
}

/** The website: a sound effect made by the user's linked desktop (VoiceStudio's sound effects installed and running there). */
export function CloudSoundEffects() {
  const workspaceId = useSession((s) => s.workspaceId)!
  const [rev, setRev] = useState(0)
  const avail = useAsync(() => sysFetch<{ available: boolean; device?: string }>('GET', '/voice/sfx/available'), [rev])
  const [prompt, setPrompt] = useState('')
  const [len, setLen] = useState(10)
  const [gen, setGen] = useState<{ progress: number; message: string }>()
  const [made, setMade] = useState<AssetRecord>()
  const make = async () => {
    const p = prompt.trim()
    if (!p) return
    setGen({ progress: -1, message: 'Queued…' })
    setMade(undefined)
    try {
      const job = await sysFetch<Job>('POST', '/voice/sfx', { workspaceId, prompt: p, duration: len })
      const done = await waitForJob<{ asset: AssetRecord }>(job.id, (j) => {
        useJobs.getState().upsert(j)
        setGen({ progress: j.progress, message: j.message || 'Making it…' })
      })
      if (done.result?.asset) setMade(done.result.asset)
      toast('The sound effect is in the library')
    } catch (e) {
      toastError(e)
    } finally {
      setGen(undefined)
    }
  }
  return (
    <section className="card vs-engine-card" style={{ textAlign: 'left', marginTop: 18 }}>
      <div className="row" style={{ gap: 8 }}>
        <Volume2 size={15} /> <strong>Sound effects, from your linked desktop</strong>
      </div>
      {avail.loading && !avail.data ? (
        <Spinner size={14} />
      ) : !avail.data?.available ? (
        <p className="muted" style={{ fontSize: '0.8125rem', margin: '6px 0 0' }}>
          Describe a sound and your desktop makes it. This needs Producer Studio open on a linked computer with an NVIDIA graphics card, with sound effects
          installed in its Voice Studio → Audio tools.{' '}
          <button className="btn ghost sm" onClick={() => setRev((n) => n + 1)}>Check again</button>
        </p>
      ) : (
        <>
          <p className="muted" style={{ fontSize: '0.8125rem', margin: '6px 0 10px' }}>Made on {avail.data.device} and added to this space’s library.</p>
          <textarea className="input" rows={2} maxLength={500} placeholder={SFX_EXAMPLES[1]} value={prompt} onChange={(e) => setPrompt(e.target.value)} aria-label="Describe the sound" />
          <div className="row" style={{ gap: 10, marginTop: 10, flexWrap: 'wrap', alignItems: 'center' }}>
            <label className="label" htmlFor="vs-sfx-cloud-len" style={{ margin: 0 }}>Length</label>
            <input id="vs-sfx-cloud-len" type="range" min={1} max={30} step={1} value={len} onChange={(e) => setLen(Number(e.target.value))} className="ps-range" style={{ width: 160 }} />
            <span className="kbd">{len} s</span>
            <button className="btn primary sm" disabled={!prompt.trim() || !!gen} onClick={() => void make()}>
              {gen ? <><Spinner size={13} /> {gen.message}</> : <><Sparkles size={13} /> Make the sound</>}
            </button>
          </div>
          {made && <audio src={mediaUrl(made.asset.id, 'source')} controls style={{ height: 32, marginTop: 12 }} />}
        </>
      )}
    </section>
  )
}
