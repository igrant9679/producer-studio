// Engine tab (desktop): install / start / stop the bundled VoiceStudio backend, pick the default TTS engine, manage
// models and licences, autostart, logs, and the AGPL notice for the unmodified VoiceStudio we run.
import { AlertTriangle, CheckCircle2, Cpu, Download, ExternalLink, HardDrive, Play, RefreshCw, ScrollText, Square, Trash2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import { toast, toastError } from '../../lib/toast'
import { systemApi } from '../system'
import { Modal, Progress, Spinner, useAsync } from '../ui'
import { LicenseChip, canDesign, engineName, fmtBytes, useTtsEngines, type TtsBackend } from './shared'
import { LICENSE_NOTES, useVsStatus, vsApi, vsFetch, vsGet, vsRunning } from './vsApi'

interface ModelRow {
  repo_id: string
  label?: string
  note?: string
  role?: string
  size_gb?: number
  size_on_disk_bytes?: number
  installed?: boolean
  incomplete?: boolean
  required?: boolean
  supported?: boolean
  curated?: boolean
  engine?: string
  engines?: string[]
}

export default function EnginePanel() {
  const status = useVsStatus(true)
  const running = vsRunning(status)
  const [confirmInstall, setConfirmInstall] = useState(false)
  const [busy, setBusy] = useState<string>()
  const [showLog, setShowLog] = useState(false)
  const settings = useAsync(() => systemApi.settings(), [])

  const act = async (what: string, fn: () => Promise<unknown>) => {
    setBusy(what)
    try {
      await fn()
    } catch (e) {
      toastError(e)
    } finally {
      setBusy(undefined)
    }
  }

  const s = status
  return (
    <div className="vs-engine">
      <section className="card vs-engine-card">
        <div className="row" style={{ gap: 12, alignItems: 'flex-start' }}>
          <span className={`vs-state-dot ${s?.state ?? 'not-installed'}`} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <strong style={{ fontSize: '1rem' }}>
              {!s ? 'Checking…' : s.state === 'running' ? 'VoiceStudio is running' : s.state === 'installing' ? 'Installing VoiceStudio' : s.state === 'starting' ? 'Starting VoiceStudio' : s.state === 'stopped' ? 'VoiceStudio is stopped' : s.state === 'error' ? 'VoiceStudio needs attention' : 'VoiceStudio isn’t installed'}
            </strong>
            <div className="muted" style={{ fontSize: '0.8125rem', marginTop: 2 }}>
              VoiceStudio {s?.version}
              {s?.device ? ` · ${s.device}` : ''}
              {s?.installedVersion === 'outdated' ? ' · an older build is installed — reinstall to update' : ''}
            </div>
            {s?.state === 'error' && s.error && <div className="ps-alert" style={{ marginTop: 10 }}><AlertTriangle size={15} /> {s.error}</div>}
            {(s?.state === 'installing' || s?.state === 'starting') && (
              <div style={{ marginTop: 12 }}>
                <div className="muted" style={{ fontSize: '0.8125rem', marginBottom: 6 }}>{s.message}</div>
                <Progress value={s.progress ?? -1} />
              </div>
            )}
          </div>
          <div className="row" style={{ gap: 8 }}>
            {s?.state === 'not-installed' || s?.installedVersion === 'outdated' ? (
              <button className="btn primary" onClick={() => setConfirmInstall(true)}><Download size={14} /> {s.installedVersion === 'outdated' ? 'Update' : 'Set up VoiceStudio'}</button>
            ) : s?.state === 'running' ? (
              <button className="btn" disabled={!!busy} onClick={() => act('stop', vsApi.stop)}>{busy === 'stop' ? <Spinner size={13} /> : <Square size={13} />} Stop</button>
            ) : s?.state === 'stopped' || s?.state === 'error' ? (
              <button className="btn primary" disabled={!!busy} onClick={() => act('start', vsApi.start)}>{busy === 'start' ? <Spinner size={13} /> : <Play size={13} />} Start</button>
            ) : null}
          </div>
        </div>
        <div className="vs-engine-meta">
          <span><HardDrive size={13} /> {s?.dir ?? '…'}</span>
          {settings.data && (
            <label className="vs-check" style={{ margin: 0 }}>
              <input
                type="checkbox"
                checked={settings.data.voiceStudioAutoStart}
                onChange={(e) =>
                  act('auto', async () => {
                    const next = await systemApi.saveSettings({ voiceStudioAutoStart: e.target.checked })
                    settings.setData(next)
                  })
                }
              />
              <span>Start VoiceStudio when Producer Studio opens</span>
            </label>
          )}
          <button className="btn ghost sm" onClick={() => setShowLog((v) => !v)}><ScrollText size={13} /> {showLog ? 'Hide' : 'Show'} log</button>
          {s?.state !== 'not-installed' && s?.state !== 'installing' && (
            <button className="btn ghost sm" onClick={() => setConfirmInstall(true)} title="Re-run setup (keeps your voices and downloaded models)"><RefreshCw size={13} /> Repair</button>
          )}
        </div>
        {showLog && <pre className="vs-log">{(s?.log ?? []).join('\n') || 'No log output yet.'}</pre>}
      </section>

      {running && <Engines />}
      {running && <Models />}

      <section className="card vs-about">
        <strong>About VoiceStudio</strong>
        <p>
          Voice cloning, design, dubbing and audiobooks in Producer Studio are powered by{' '}
          <a href="https://github.com/debpalash/VoiceStudio" target="_blank" rel="noreferrer">VoiceStudio</a> {s?.version} by Palash Debnath and contributors, licensed under the{' '}
          <a href="https://www.gnu.org/licenses/agpl-3.0.html" target="_blank" rel="noreferrer">GNU AGPL-3.0</a>. Producer Studio downloads the unmodified VoiceStudio
          source (<a href={s?.sourceUrl ?? 'https://github.com/debpalash/VoiceStudio'} target="_blank" rel="noreferrer">complete corresponding source <ExternalLink size={11} /></a>) and runs it as a separate program on this computer; nothing is sent to VoiceStudio’s servers and its analytics are switched off.
        </p>
        <p className="muted">
          Model weights carry their own licences, separate from VoiceStudio’s. VoiceStudio’s default model (OmniVoice) is <b>non-commercial (CC-BY-NC)</b>; each engine below shows its licence. Only clone voices with the speaker’s permission.
        </p>
      </section>

      {confirmInstall && (
        <Modal
          title={s?.state === 'not-installed' ? 'Set up VoiceStudio' : 'Repair VoiceStudio'}
          subtitle="One-time setup on this computer. Your voices and downloaded models are kept on repair."
          onClose={() => setConfirmInstall(false)}
          width={560}
          footer={
            <>
              <button className="btn ghost" onClick={() => setConfirmInstall(false)}>Cancel</button>
              <button
                className="btn primary"
                onClick={() =>
                  act('install', async () => {
                    setConfirmInstall(false)
                    await vsApi.install()
                    toast('Setting up VoiceStudio — you can keep working while it installs')
                  })
                }
              >
                <Download size={14} /> {s?.state === 'not-installed' ? 'Download and install' : 'Repair'}
              </button>
            </>
          }
        >
          <ul className="vs-install-list">
            <li>Downloads VoiceStudio {s?.version} (unmodified, AGPL-3.0) from GitHub and a private Python 3.11 with PyTorch — about <b>8–9 GB</b>, often 10–20 minutes.</li>
            <li>Voice models download on first use (the default is about 3.3 GB). Needs at least 9 GB free in <code>{s?.dir}</code>.</li>
            <li>An NVIDIA GPU is used automatically; without one it runs on the CPU (slower).</li>
            <li>Everything stays on this computer. VoiceStudio’s usage analytics are turned off.</li>
          </ul>
        </Modal>
      )}
    </div>
  )
}

const SIDECARS = new Set(['indextts2', 'moss-tts-v15', 'confucius4-tts', 'dots-tts', 'supertonic3', 'pockettts', 'voxcpm2', 'moss-tts-nano', 'cosyvoice'])

interface SidecarStatus {
  engine_id: string
  installed: boolean
  install_allowed?: boolean
  job: null | { state: 'running' | 'succeeded' | 'failed'; steps: Array<{ id: string; state: string; detail?: string }>; error?: string | null; remediation?: string | null; weights_progress?: { pct?: number } | null }
}

function Engines() {
  const engines = useTtsEngines(true)
  const [busy, setBusy] = useState<string>()
  const [installs, setInstalls] = useState<Record<string, SidecarStatus>>({})
  // an engine whose licence must be accepted: shown first, then used or installed
  const [licence, setLicence] = useState<{ b: TtsBackend; then: 'use' | 'install' }>()

  // poll sidecar installs while any is running
  useEffect(() => {
    const running = Object.values(installs).filter((s) => s.job?.state === 'running')
    if (!running.length) return
    const t = setTimeout(async () => {
      const next: Record<string, SidecarStatus> = {}
      for (const s of running) {
        try {
          next[s.engine_id] = await vsGet<SidecarStatus>(`/engines/sidecar/${s.engine_id}/install/status`)
        } catch {
          /* keep polling */
        }
      }
      setInstalls((cur) => ({ ...cur, ...next }))
      if (Object.values(next).some((s) => s.job?.state !== 'running')) engines.reload()
    }, 2000)
    return () => clearTimeout(t)
  }, [installs, engines.reload])

  const select = async (b: TtsBackend) => {
    setBusy(b.id)
    try {
      if (b.license_required && !b.license_accepted) await vsFetch('/api/settings/license', { body: { engine_id: b.id, accepted: true } })
      await vsFetch('/engines/select', { body: { family: 'tts', backend_id: b.id } })
      engines.reload()
      toast(`${engineName(b)} is now the default engine`)
    } catch (e) {
      toastError(e)
    } finally {
      setBusy(undefined)
    }
  }
  const installSidecar = async (b: TtsBackend) => {
    setBusy(b.id)
    try {
      if (b.license_required && !b.license_accepted) await vsFetch('/api/settings/license', { body: { engine_id: b.id, accepted: true } })
      await vsFetch(`/engines/sidecar/${b.id}/install`, { method: 'POST' })
      setInstalls((cur) => ({ ...cur, [b.id]: { engine_id: b.id, installed: false, job: { state: 'running', steps: [] } } }))
    } catch (e) {
      toastError(e)
    } finally {
      setBusy(undefined)
    }
  }

  return (
    <section className="card vs-engine-card">
      <div className="row"><Cpu size={15} /> <strong>Speech engines</strong><span className="spacer" /><button className="btn ghost sm" onClick={engines.reload}><RefreshCw size={13} /> Refresh</button></div>
      <p className="muted" style={{ fontSize: '0.8125rem', margin: '6px 0 12px' }}>
        The default engine generates speech unless a voice was made with another one. Extra engines install into their own environment. Licences come from each model’s card; non-commercial ones are marked.
      </p>
      {engines.loading && !engines.data ? (
        <Spinner />
      ) : engines.error ? (
        <div className="ps-alert">Couldn’t load engines. <button className="btn sm" onClick={engines.reload}>Retry</button></div>
      ) : (
        <div className="vs-engine-list">
          {(engines.data?.backends ?? []).map((b) => {
            const active = b.id === engines.data?.active
            const note = LICENSE_NOTES[b.id]
            const inst = installs[b.id]
            const job = inst?.job
            const step = job?.steps?.find((x) => x.state === 'running')
            return (
              <div key={b.id} className={`vs-engine-row ${active ? 'on' : ''} ${b.available === false ? 'off' : ''}`}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <strong>{engineName(b)} {active && <span className="vs-chip ok"><CheckCircle2 size={11} /> Default</span>}</strong>
                  <div className="row" style={{ gap: 6, flexWrap: 'wrap', marginTop: 4 }}>
                    {b.supports_cloning && <span className="vs-chip">Cloning</span>}
                    {canDesign(b) && <span className="vs-chip">Voice design</span>}
                    {b.supports_emotion && <span className="vs-chip">Emotion</span>}
                    {b.routing_status && <span className="vs-chip muted">{b.routing_status === 'accelerated' ? 'GPU' : b.routing_status === 'cpu_fallback' ? 'CPU fallback' : b.routing_status === 'cpu_only' ? 'CPU' : b.routing_status}</span>}
                    {b.min_vram_gb ? <span className="vs-chip muted">{b.min_vram_gb} GB VRAM</span> : null}
                    <LicenseChip engine={b.id} />
                  </div>
                  {b.available === false && !job && <div className="muted" style={{ fontSize: '0.75rem', marginTop: 4 }}>{b.reason || b.install_hint || b.hint || 'Not installed'}</div>}
                  {note?.note && <div className="muted" style={{ fontSize: '0.75rem', marginTop: 4 }}>{note.note}</div>}
                  {job && (
                    <div style={{ marginTop: 8 }}>
                      {job.state === 'running' && <Progress value={job.weights_progress?.pct ?? -1} />}
                      <div className="muted" style={{ fontSize: '0.7188rem', marginTop: 4 }}>
                        {job.state === 'running' ? `Installing · ${step?.id.replace(/_/g, ' ') ?? 'starting'}${step?.detail ? ` — ${step.detail}` : ''}` : job.state === 'failed' ? `Install failed: ${job.error ?? ''} ${job.remediation ?? ''}` : 'Installed'}
                      </div>
                    </div>
                  )}
                </div>
                {b.available === false && SIDECARS.has(b.id) && job?.state !== 'running' ? (
                  <button className="btn sm" disabled={!!busy} onClick={() => (b.license_required && !b.license_accepted ? setLicence({ b, then: 'install' }) : void installSidecar(b))}>{busy === b.id ? <Spinner size={12} /> : <Download size={13} />} {b.license_required && !b.license_accepted ? 'Review licence & install' : 'Install'}</button>
                ) : !active && b.available !== false ? (
                  <button className="btn sm" disabled={!!busy} onClick={() => (b.license_required && !b.license_accepted ? setLicence({ b, then: 'use' }) : void select(b))}>{busy === b.id && <Spinner size={12} />} {b.license_required && !b.license_accepted ? 'Review licence & use' : 'Make default'}</button>
                ) : null}
              </div>
            )
          })}
        </div>
      )}
      {licence && <LicenceDialog b={licence.b} action={licence.then === 'use' ? 'use' : 'install'} onClose={() => setLicence(undefined)} onAccept={() => {
        const { b, then } = licence
        setLicence(undefined)
        void (then === 'use' ? select(b) : installSidecar(b))
      }} />}
    </section>
  )
}

/** The licence an engine needs accepted, shown before accepting it. */
function LicenceDialog({ b, action, onClose, onAccept }: { b: TtsBackend; action: 'use' | 'install'; onClose: () => void; onAccept: () => void }) {
  const n = LICENSE_NOTES[b.id]
  return (
    <Modal
      title={`${engineName(b)} licence`}
      subtitle="This engine’s model weights come with their own licence. Read it before accepting."
      onClose={onClose}
      width={520}
      footer={
        <>
          <button className="btn ghost" autoFocus onClick={onClose}>Cancel</button>
          <button className="btn primary" onClick={onAccept}>Accept and {action}</button>
        </>
      }
    >
      <div className="vs-licence">
        {n ? (
          <>
            <strong>{n.license}</strong>
            <div className="muted" style={{ fontSize: '0.8125rem', marginTop: 4 }}>
              {n.commercial === false ? 'Non-commercial use only.' : n.commercial === null ? 'Commercial use depends on the model you choose: check its card.' : 'Commercial use allowed.'}
              {n.note ? ` ${n.note}` : ''}
            </div>
          </>
        ) : (
          <div className="muted" style={{ fontSize: '0.8125rem' }}>Producer Studio hasn’t reviewed this licence: read it on the model card.</div>
        )}
        {b.docs_url && /^https:\/\//.test(b.docs_url) && (
          <a className="btn sm" style={{ marginTop: 12 }} href={b.docs_url} target="_blank" rel="noreferrer noopener"><ExternalLink size={13} /> Read the licence and model card</a>
        )}
      </div>
    </Modal>
  )
}

interface InstallJob {
  repo_id: string
  state: 'downloading' | 'failed'
  bytes_done?: number
  total_bytes?: number
  eta_seconds?: number
  error?: string
}

function Models() {
  const models = useAsync(() => vsGet<{ models: ModelRow[]; disk_free_gb?: number }>('/models'), [])
  const [jobs, setJobs] = useState<Record<string, InstallJob>>({})
  const [busy, setBusy] = useState<string>()
  const [poll, setPoll] = useState(0)
  const [removing, setRemoving] = useState<ModelRow>()

  // VoiceStudio's own renderer polls install status while anything downloads
  useEffect(() => {
    let alive = true
    const tick = async () => {
      try {
        const r = await vsGet<{ jobs: InstallJob[] }>('/models/install/status')
        if (!alive) return
        const next = Object.fromEntries((r.jobs ?? []).map((j) => [j.repo_id, j]))
        setJobs((cur) => {
          if (Object.keys(cur).some((k) => !next[k])) models.reload()
          return next
        })
        if ((r.jobs ?? []).some((j) => j.state === 'downloading')) setTimeout(() => alive && setPoll((n) => n + 1), 2000)
      } catch {
        /* VoiceStudio restarting */
      }
    }
    void tick()
    return () => {
      alive = false
    }
  }, [poll, models.reload])

  const install = async (m: ModelRow) => {
    setBusy(m.repo_id)
    try {
      await vsFetch('/models/install', { body: { repo_id: m.repo_id } })
      setPoll((n) => n + 1)
    } catch (e) {
      toastError(e)
    } finally {
      setBusy(undefined)
    }
  }
  const remove = async (m: ModelRow) => {
    setBusy(m.repo_id)
    try {
      await vsFetch(`/models/${m.repo_id.split('/').map(encodeURIComponent).join('/')}`, { method: 'DELETE' })
      setRemoving(undefined)
      models.reload()
    } catch (e) {
      toastError(e)
    } finally {
      setBusy(undefined)
    }
  }
  const cancel = async (m: ModelRow) => {
    try {
      await vsFetch('/models/install/cancel', { body: { repo_id: m.repo_id } })
      setPoll((n) => n + 1)
    } catch (e) {
      toastError(e)
    }
  }

  const rows = (models.data?.models ?? []).filter((m) => m.supported !== false)
  const roles = [...new Set(rows.map((m) => m.role || 'Other'))]
  const removingSize = removing && (removing.size_on_disk_bytes || (removing.size_gb ? removing.size_gb * 1024 ** 3 : undefined))
  return (
    <section className="card vs-engine-card">
      <div className="row"><HardDrive size={15} /> <strong>Models</strong><span className="spacer" />{models.data?.disk_free_gb != null && <span className="muted" style={{ fontSize: '0.75rem' }}>{models.data.disk_free_gb.toFixed(0)} GB free</span>}<button className="btn ghost sm" onClick={models.reload}><RefreshCw size={13} /> Refresh</button></div>
      <p className="muted" style={{ fontSize: '0.8125rem', margin: '6px 0 4px' }}>The default voice model is required. Dubbing and transcription also need a speech-recognition (ASR) model.</p>
      {models.loading && !models.data ? (
        <Spinner />
      ) : models.error ? (
        <div className="ps-alert">Couldn’t load models. <button className="btn sm" onClick={models.reload}>Retry</button></div>
      ) : (
        roles.map((role) => (
          <div key={role} style={{ marginTop: 12 }}>
            <div className="eyebrow" style={{ marginBottom: 6 }}>{role}</div>
            <div className="vs-engine-list">
              {rows.filter((m) => (m.role || 'Other') === role).map((m) => {
                const j = jobs[m.repo_id]
                const size = m.size_on_disk_bytes || (m.size_gb ? m.size_gb * 1024 ** 3 : undefined)
                const eng = m.engine ?? m.engines?.[0]
                return (
                  <div key={m.repo_id} className="vs-engine-row">
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <strong className="ellipsis">{m.label || m.repo_id}</strong>
                      <div className="row" style={{ gap: 6, flexWrap: 'wrap', marginTop: 4 }}>
                        <span className="vs-chip muted">{m.repo_id}</span>
                        {size ? <span className="vs-chip muted">{fmtBytes(size)}</span> : null}
                        {m.required && <span className="vs-chip">Required</span>}
                        {m.curated && <span className="vs-chip">Recommended</span>}
                        {m.installed && !m.incomplete && <span className="vs-chip ok"><CheckCircle2 size={11} /> Installed</span>}
                        {m.incomplete && <span className="vs-chip warn">Incomplete</span>}
                        {eng && <LicenseChip engine={eng} />}
                      </div>
                      {m.note && <div className="muted" style={{ fontSize: '0.75rem', marginTop: 4 }}>{m.note}</div>}
                      {j && (
                        <div style={{ marginTop: 8 }}>
                          {j.state === 'downloading' && <Progress value={j.total_bytes ? (j.bytes_done ?? 0) / j.total_bytes : -1} />}
                          <div className="muted" style={{ fontSize: '0.7188rem', marginTop: 4 }}>
                            {j.state === 'failed' ? `Download failed: ${j.error ?? ''}` : `${fmtBytes(j.bytes_done)} of ${fmtBytes(j.total_bytes) || '…'}${j.eta_seconds ? ` · about ${Math.ceil(j.eta_seconds / 60)} min left` : ''}`}
                          </div>
                        </div>
                      )}
                    </div>
                    {j?.state === 'downloading' ? (
                      <button className="btn ghost sm" onClick={() => cancel(m)}>Cancel</button>
                    ) : m.installed && !m.incomplete ? (
                      <button className="btn ghost sm icon" disabled={busy === m.repo_id} onClick={() => setRemoving(m)} aria-label={`Remove ${m.repo_id}`} title="Remove from disk"><Trash2 size={14} /></button>
                    ) : (
                      <button className="btn sm" disabled={busy === m.repo_id} onClick={() => install(m)}>{busy === m.repo_id ? <Spinner size={12} /> : <Download size={13} />} {m.incomplete || j?.state === 'failed' ? 'Retry' : 'Download'}</button>
                    )}
                  </div>
                )
              })}
            </div>
          </div>
        ))
      )}
      {removing && (
        <Modal
          title={`Remove ${removing.label || removing.repo_id}?`}
          subtitle={`${removingSize ? `Frees ${fmtBytes(removingSize)} on this computer.` : 'Removes it from this computer.'} ${removing.required ? 'This is the required voice model: speech won’t generate until it’s downloaded again.' : 'You can download it again any time.'}`}
          onClose={() => setRemoving(undefined)}
          width={480}
          footer={
            <>
              <button className="btn ghost" autoFocus onClick={() => setRemoving(undefined)}>Cancel</button>
              <button className="btn danger" disabled={busy === removing.repo_id} onClick={() => void remove(removing)}>{busy === removing.repo_id && <Spinner size={12} />} Remove from disk</button>
            </>
          }
        >
          <span />
        </Modal>
      )}
    </section>
  )
}
