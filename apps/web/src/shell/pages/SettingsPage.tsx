import type { AiSettings, Device, DesktopSettings } from '@producer/core'
import clsx from 'clsx'
import { AlertTriangle, CheckCircle2, Cloud, CloudOff, Cpu, FolderOpen, HardDrive, Info, Laptop, Link2, LogIn, RefreshCw, Save, Sparkles, Unlink, User } from 'lucide-react'
import { useEffect, useState, type FormEvent, type ReactNode } from 'react'
import { useLocation } from 'react-router-dom'
import { HttpError } from '../../lib/api'
import { useSession } from '../../lib/session'
import { toast, toastError } from '../../lib/toast'
import { syncSummary } from '../SystemChrome'
import { aiLabel, aiLabelHasModel, sysFetch, systemApi, useSystem } from '../system'
import { AiProviders } from './AiProviders'
import { Avatar, EmptyState, Spinner, useAsync, usePageTitle } from '../ui'
import { relativeTime } from '../util'

const DEFAULT_CLOUD_URL = 'https://producerstudio.app'

/** Narrow bridge exposed by the Electron preload (desktop app only). */
interface ProducerDesktopBridge {
  version: string
  platform: string
  openExternal(url: string): Promise<boolean>
  showItemInFolder(path: string): Promise<boolean>
}
const desktopBridge = (): ProducerDesktopBridge | undefined => (window as unknown as { producerDesktop?: ProducerDesktopBridge }).producerDesktop

function Section({ id, icon, title, sub, children }: { id: string; icon: ReactNode; title: string; sub?: string; children: ReactNode }) {
  return (
    <section id={id} className="card ps-set-sec">
      <div className="ps-set-head">
        <span className="ps-set-icon">{icon}</span>
        <div>
          <h2>{title}</h2>
          {sub && <p>{sub}</p>}
        </div>
      </div>
      {children}
    </section>
  )
}

function Toggle({ on, onChange, label, disabled }: { on: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button type="button" role="switch" aria-checked={on} aria-label={label} className={clsx('ps-toggle', on && 'on')} onClick={() => onChange(!on)} disabled={disabled}>
      <i />
    </button>
  )
}

function errText(e: unknown): string {
  if (e instanceof HttpError) {
    if (e.status === 401) return 'The cloud rejected that email or password.'
    return e.body?.error || e.message
  }
  if (e instanceof TypeError) return 'Couldn’t reach the cloud. Check the URL and your connection.'
  return e instanceof Error ? e.message : String(e)
}

// ---------------- desktop: account & sync ----------------
function LinkForm() {
  const setSync = useSystem((s) => s.setSync)
  const [cloudUrl, setCloudUrl] = useState(DEFAULT_CLOUD_URL)
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string>()
  async function submit(e: FormEvent) {
    e.preventDefault()
    if (!/^https?:\/\/.+/.test(cloudUrl.trim())) return setErr('Enter the full cloud URL, starting with https://')
    if (!email.trim() || !password) return setErr('Enter your cloud email and password')
    setBusy(true)
    setErr(undefined)
    try {
      setSync(await systemApi.link(cloudUrl.trim().replace(/\/+$/, ''), email.trim(), password))
      setPassword('')
      // linking adopts the cloud account and its workspaces: reload the signed-in user
      await useSession.getState().load()
      toast('Linked — syncing your projects')
    } catch (e2) {
      setErr(errText(e2))
    } finally {
      setBusy(false)
    }
  }
  return (
    <form onSubmit={submit} className="ps-set-form" aria-label="Link a cloud account">
      <p className="muted" style={{ margin: '0 0 14px', fontSize: 13 }}>Sign in with your Producer Studio cloud account. Your password is exchanged for a device token and isn’t stored on this computer.</p>
      <div className="ps-set-grid">
        <div className="ps-field" style={{ gridColumn: '1 / -1' }}>
          <label className="label" htmlFor="sync-url">Cloud URL</label>
          <input id="sync-url" className="input" value={cloudUrl} onChange={(e) => setCloudUrl(e.target.value)} spellCheck={false} />
        </div>
        <div className="ps-field">
          <label className="label" htmlFor="sync-email">Email</label>
          <input id="sync-email" className="input" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@company.com" />
        </div>
        <div className="ps-field">
          <label className="label" htmlFor="sync-pw">Password</label>
          <input id="sync-pw" className="input" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </div>
      </div>
      {err && <div className="ps-alert" role="alert" style={{ marginBottom: 12 }}>{err}</div>}
      <button className="btn primary" disabled={busy}>{busy ? <Spinner /> : <Link2 size={15} />} Link account</button>
    </form>
  )
}

function DesktopAccount({ settings, onSettings }: { settings?: DesktopSettings; onSettings: (p: Partial<DesktopSettings>) => Promise<void> }) {
  const sync = useSystem((s) => s.sync)
  const setSync = useSystem((s) => s.setSync)
  const [confirm, setConfirm] = useState(false)
  const [busy, setBusy] = useState<string>()
  async function run(key: string, fn: () => Promise<void>) {
    setBusy(key)
    try {
      await fn()
    } catch (e) {
      toastError(e)
    } finally {
      setBusy(undefined)
    }
  }
  if (!sync) return <div className="skeleton" style={{ height: 120 }} />
  if (!sync.linked) return <LinkForm />
  const sum = syncSummary(sync)
  return (
    <div>
      <div className="ps-linked">
        <span className="ps-set-icon" style={{ background: 'rgba(61,220,151,.12)', color: 'var(--green)' }}><Cloud size={18} /></span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <strong>{sync.account ?? 'Linked account'}</strong>
          <span>{sync.cloudUrl} · {sum.label}{sync.lastSyncAt ? ` · last synced ${relativeTime(sync.lastSyncAt)}` : ''}</span>
        </div>
        <button className="btn sm" disabled={!!busy || sync.state === 'syncing'} onClick={() => run('now', async () => setSync(await systemApi.syncNow()))}>
          {busy === 'now' || sync.state === 'syncing' ? <Spinner size={13} /> : <RefreshCw size={13} />} Sync now
        </button>
        {confirm ? (
          <span className="row" style={{ gap: 6 }}>
            <button className="btn sm" style={{ borderColor: 'var(--danger)', color: 'var(--danger)' }} disabled={!!busy} onClick={() => run('unlink', async () => { setSync(await systemApi.unlink()); setConfirm(false); toast('Unlinked — projects stay on this computer') })}>
              {busy === 'unlink' && <Spinner size={13} />} Unlink
            </button>
            <button className="btn ghost sm" onClick={() => setConfirm(false)}>Cancel</button>
          </span>
        ) : (
          <button className="btn ghost sm" onClick={() => setConfirm(true)}><Unlink size={13} /> Unlink</button>
        )}
      </div>
      {sync.error && <div className="ps-alert" style={{ marginTop: 12 }}>{sync.error}</div>}
      {sync.conflicts.length > 0 && (
        <div className="ps-alert info" style={{ marginTop: 12 }}>
          <AlertTriangle size={15} style={{ flex: 'none' }} /> {sync.conflicts.length} project{sync.conflicts.length === 1 ? ' was' : 's were'} edited on both sides. Open the sync menu in the top bar to choose which version to keep.
        </div>
      )}
      <div className="ps-set-row">
        <div>
          <strong>Sync automatically</strong>
          <span>Push and pull changes in the background while the app is open.</span>
        </div>
        <Toggle label="Sync automatically" on={!!settings?.autoSync} disabled={!settings} onChange={(v) => void onSettings({ autoSync: v })} />
      </div>
    </div>
  )
}

// ---------------- cloud: devices ----------------
function Devices() {
  const { data, loading, error, reload, setData } = useAsync(() => systemApi.devices(), [])
  const [confirm, setConfirm] = useState<string>()
  const [busy, setBusy] = useState<string>()
  async function revoke(d: Device) {
    setBusy(d.id)
    try {
      await systemApi.revokeDevice(d.id)
      setData((cur) => (cur ?? []).filter((x) => x.id !== d.id))
      toast(`Revoked “${d.name}”`)
    } catch (e) {
      toastError(e)
    } finally {
      setBusy(undefined)
      setConfirm(undefined)
    }
  }
  if (loading && !data) return <div className="skeleton" style={{ height: 100 }} />
  if (error) return <div className="ps-alert">Couldn’t load devices. <button className="btn sm" onClick={reload}>Retry</button></div>
  if (!data?.length)
    return <EmptyState icon={<Laptop size={22} />} title="No desktop apps linked" body="Install Producer Studio for desktop and link it to this account — it will appear here so you can revoke it any time." />
  return (
    <div className="ps-devices">
      {data.map((d) => (
        <div key={d.id} className="ps-device">
          <span className="ps-set-icon"><Laptop size={17} /></span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <strong>{d.name}</strong>
            <span>Linked {relativeTime(d.createdAt)}{d.lastSeenAt ? ` · last seen ${relativeTime(d.lastSeenAt)}` : ''}</span>
          </div>
          {confirm === d.id ? (
            <span className="row" style={{ gap: 6 }}>
              <button className="btn sm" style={{ borderColor: 'var(--danger)', color: 'var(--danger)' }} disabled={busy === d.id} onClick={() => revoke(d)}>{busy === d.id && <Spinner size={13} />} Revoke access</button>
              <button className="btn ghost sm" onClick={() => setConfirm(undefined)}>Cancel</button>
            </span>
          ) : (
            <button className="btn ghost sm" onClick={() => setConfirm(d.id)}>Revoke</button>
          )}
        </div>
      ))}
    </div>
  )
}

// ---------------- AI ----------------
function AiInfo() {
  const info = useSystem((s) => s.info)
  if (!info) return <div className="skeleton" style={{ height: 80 }} />
  const ok = info.ai.available && info.ai.provider !== 'none'
  return (
    <div className={clsx('ps-ai-status', ok ? 'ok' : 'bad')}>
      {ok ? <CheckCircle2 size={18} /> : <AlertTriangle size={18} />}
      <div style={{ flex: 1, minWidth: 0 }}>
        <strong>{ok ? 'Active: ' : ''}{aiLabel(info)}{info.ai.model && !aiLabelHasModel(info) ? ` · ${info.ai.model}` : ''}</strong>
        <span>{info.ai.detail || (ok ? 'Ready' : 'Not available')}</span>
      </div>
    </div>
  )
}

type Builtin = AiSettings['builtin']

/** Status of the Claude Code CLI (the desktop's built-in provider), independent of the chosen default. */
function BuiltinInfo({ builtin }: { builtin?: Builtin }) {
  if (!builtin) return <div className="skeleton" style={{ height: 56 }} />
  return (
    <div className={clsx('ps-ai-status', builtin.available ? 'ok' : 'bad')}>
      {builtin.available ? <CheckCircle2 size={18} /> : <AlertTriangle size={18} />}
      <div style={{ flex: 1, minWidth: 0 }}>
        <strong>{builtin.id === 'claude-cli' ? 'Claude Code CLI' : builtin.id === 'none' ? 'AI disabled' : 'Claude API'}{builtin.model ? ` · ${builtin.model}` : ''}</strong>
        <span>{builtin.detail || (builtin.available ? 'Ready' : 'Not available')}</span>
      </div>
    </div>
  )
}

function DesktopAi({ settings, onSettings, builtin, refresh }: { settings?: DesktopSettings; onSettings: (p: Partial<DesktopSettings>) => Promise<void>; builtin?: Builtin; refresh: () => Promise<Builtin | undefined> }) {
  const [path, setPath] = useState('')
  const [model, setModel] = useState('')
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [test, setTest] = useState<{ ok: boolean; detail: string }>()
  const [signingIn, setSigningIn] = useState(false)
  const load = useSystem((s) => s.load)
  const signedOut = builtin?.id === 'claude-cli' && !builtin.available && /not signed in/i.test(builtin.detail)
  useEffect(() => {
    if (!signingIn) return
    // after "Sign in to Claude": poll until the CLI reports a signed-in account (up to 5 minutes)
    let alive = true
    const t0 = Date.now()
    const iv = setInterval(async () => {
      try {
        const next = await refresh()
        if (!alive) return
        if (next?.available) {
          setSigningIn(false)
          setTest({ ok: true, detail: next.detail })
          toast('Signed in to Claude')
        } else if (Date.now() - t0 > 5 * 60_000) setSigningIn(false)
      } catch {
        /* server busy; keep polling */
      }
    }, 3000)
    return () => {
      alive = false
      clearInterval(iv)
    }
  }, [signingIn])
  async function signIn() {
    setTest(undefined)
    try {
      await sysFetch('POST', '/desktop/claude/login')
      setSigningIn(true)
      toast('A terminal window opened — finish signing in to Claude in your browser')
    } catch (e) {
      setTest({ ok: false, detail: errText(e) })
    }
  }
  useEffect(() => {
    if (settings) {
      setPath(settings.claudePath)
      setModel(settings.claudeModel)
    }
  }, [settings])
  const dirty = !!settings && (path !== settings.claudePath || model !== settings.claudeModel)
  async function testClaude() {
    setTesting(true)
    setTest(undefined)
    try {
      const b = await refresh()
      setTest({ ok: !!b?.available, detail: b?.detail || (b?.available ? 'Claude responded' : 'Claude is not available') })
    } catch (e) {
      setTest({ ok: false, detail: errText(e) })
    } finally {
      setTesting(false)
    }
  }
  return (
    <div>
      <BuiltinInfo builtin={builtin} />
      <div className="ps-set-grid" style={{ marginTop: 16 }}>
        <div className="ps-field">
          <label className="label" htmlFor="ai-path">Claude CLI path</label>
          <input id="ai-path" className="input mono" value={path} onChange={(e) => setPath(e.target.value)} placeholder="Auto-detect" spellCheck={false} disabled={!settings} />
          <div className="ps-hint">Leave empty to auto-detect: the Claude desktop bundle, ~/.local/bin, then your PATH. Uses your own Claude subscription.</div>
        </div>
        <div className="ps-field">
          <label className="label" htmlFor="ai-model">Model override</label>
          <input id="ai-model" className="input mono" value={model} onChange={(e) => setModel(e.target.value)} placeholder="Default" spellCheck={false} disabled={!settings} />
          <div className="ps-hint">Optional. Passed to the CLI as <span className="kbd">--model</span>.</div>
        </div>
      </div>
      <div className="row" style={{ flexWrap: 'wrap' }}>
        <button
          className="btn primary"
          disabled={!dirty || saving}
          onClick={async () => {
            setSaving(true)
            try {
              await onSettings({ claudePath: path.trim(), claudeModel: model.trim() })
              await load()
            } finally {
              setSaving(false)
            }
          }}
        >
          {saving ? <Spinner /> : <Save size={14} />} Save
        </button>
        <button className="btn" onClick={testClaude} disabled={testing}>{testing ? <Spinner /> : <Sparkles size={14} />} Check Claude sign-in</button>
        {(signedOut || signingIn) && (
          <button className="btn primary" onClick={signIn} disabled={signingIn}>
            {signingIn ? <Spinner /> : <LogIn size={14} />} {signingIn ? 'Waiting for sign-in…' : 'Sign in to Claude'}
          </button>
        )}
        {test && (
          <span className={clsx('ps-test', test.ok ? 'ok' : 'bad')} role="status">
            {test.ok ? <CheckCircle2 size={14} /> : <AlertTriangle size={14} />} {test.detail}
          </span>
        )}
      </div>
    </div>
  )
}

function DesktopStorage({ settings, onSettings }: { settings?: DesktopSettings; onSettings: (p: Partial<DesktopSettings>) => Promise<void> }) {
  const [dir, setDir] = useState('')
  const [saving, setSaving] = useState(false)
  useEffect(() => {
    if (settings) setDir(settings.dataDir)
  }, [settings])
  return (
    <div>
      <div className="ps-field">
        <label className="label" htmlFor="st-dir">Data folder</label>
        <div className="row">
          <input id="st-dir" className="input mono" value={dir} onChange={(e) => setDir(e.target.value)} spellCheck={false} disabled={!settings} />
          <button
            className="btn"
            disabled={!settings || dir === settings.dataDir || !dir.trim() || saving}
            onClick={async () => {
              setSaving(true)
              try {
                await onSettings({ dataDir: dir.trim() })
              } finally {
                setSaving(false)
              }
            }}
          >
            {saving ? <Spinner /> : <FolderOpen size={14} />} Change folder
          </button>
          {desktopBridge() && settings?.dataDir && (
            <button className="btn ghost" onClick={() => void desktopBridge()!.showItemInFolder(settings.dataDir)}>
              <FolderOpen size={14} /> Open data folder
            </button>
          )}
        </div>
        <div className="ps-hint">Local media, proxies and renders live here. Changing it takes effect after restarting the app.</div>
      </div>
      <div className="ps-set-row">
        <div>
          <strong>Cloud media</strong>
          <span>Download everything for offline editing, or fetch media the first time a project opens.</span>
        </div>
        <div className="ps-seg">
          <button className={settings?.mediaSync === 'all' ? 'on' : ''} disabled={!settings} onClick={() => void onSettings({ mediaSync: 'all' })}>Download all</button>
          <button className={settings?.mediaSync === 'on-demand' ? 'on' : ''} disabled={!settings} onClick={() => void onSettings({ mediaSync: 'on-demand' })}>On demand</button>
        </div>
      </div>
    </div>
  )
}

export default function SettingsPage() {
  usePageTitle('Settings')
  const info = useSystem((s) => s.info)
  const loaded = useSystem((s) => s.loaded)
  const user = useSession((s) => s.user)
  const loc = useLocation()
  const desktop = info?.mode === 'desktop'
  const [settings, setSettings] = useState<DesktopSettings>()
  const [settingsErr, setSettingsErr] = useState<string>()

  useEffect(() => {
    if (!desktop) return
    systemApi
      .settings()
      .then(setSettings)
      .catch((e) => setSettingsErr(errText(e)))
  }, [desktop])

  useEffect(() => {
    if (!loc.hash) return
    const t = setTimeout(() => document.getElementById(loc.hash.slice(1))?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 60)
    return () => clearTimeout(t)
  }, [loc.hash, loaded])

  async function saveSettings(p: Partial<DesktopSettings>) {
    const prev = settings
    if (settings) setSettings({ ...settings, ...p })
    try {
      setSettings(await systemApi.saveSettings(p))
      toast('Settings saved')
    } catch (e) {
      setSettings(prev)
      toastError(e)
      throw e
    }
  }
  const onSettings = (p: Partial<DesktopSettings>) => saveSettings(p).catch(() => undefined)

  return (
    <div className="ps-page narrow">
      <div className="ps-page-head">
        <div>
          <span className="eyebrow">{desktop ? 'Producer Studio for desktop' : 'Producer Studio cloud'}{info?.version ? ` · v${info.version}` : ''}</span>
          <h1>Settings</h1>
        </div>
      </div>
      {!loaded ? (
        <div className="ps-set">{[0, 1, 2].map((i) => <div key={i} className="skeleton" style={{ height: 180, borderRadius: 16 }} />)}</div>
      ) : (
        <div className="ps-set">
          {settingsErr && <div className="ps-alert">Couldn’t load desktop settings: {settingsErr}</div>}
          <Section id="account" icon={desktop ? <Cloud size={18} /> : <User size={18} />} title="Account & sync" sub={desktop ? 'Link this computer to your cloud account to back up and share projects.' : 'Your account and the desktop apps linked to it.'}>
            {desktop ? (
              <DesktopAccount settings={settings} onSettings={onSettings} />
            ) : (
              <>
                <div className="ps-linked" style={{ marginBottom: 18 }}>
                  <Avatar name={user?.name} color={user?.avatarColor} size={38} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <strong>{user?.name}</strong>
                    <span>{user?.email}</span>
                  </div>
                </div>
                <div className="eyebrow" style={{ marginBottom: 10 }}>Linked devices</div>
                <Devices />
              </>
            )}
          </Section>

          <Section
            id="ai"
            icon={<Cpu size={18} />}
            title="AI"
            sub={desktop ? 'Use Claude through the Claude Code CLI on this computer, or bring your own Anthropic, Gemini or OpenAI key.' : 'Use Producer Studio’s built-in Claude, or bring your own Anthropic, Gemini or OpenAI key for this workspace.'}
          >
            <AiInfo />
            <div style={{ height: 14 }} />
            <AiProviders
              desktop={desktop}
              renderBuiltin={({ builtin, refresh }) =>
                desktop ? (
                  <DesktopAi settings={settings} onSettings={saveSettings} builtin={builtin} refresh={refresh} />
                ) : (
                  <>
                    <BuiltinInfo builtin={builtin} />
                    {info && (
                      <div className="ps-caps">
                        {(['transcribe', 'tts', 'render'] as const).map((k) => (
                          <span key={k} className={clsx('ps-cap-pill', info.capabilities[k] ? 'ok' : 'off')}>
                            {info.capabilities[k] ? <CheckCircle2 size={12} /> : <CloudOff size={12} />} {k === 'tts' ? 'Voiceover' : k === 'transcribe' ? 'Transcription' : 'Rendering'}
                          </span>
                        ))}
                      </div>
                    )}
                  </>
                )
              }
            />
          </Section>

          {desktop && (
            <Section id="storage" icon={<HardDrive size={18} />} title="Storage" sub="Where Producer keeps your media on this computer.">
              <DesktopStorage settings={settings} onSettings={onSettings} />
            </Section>
          )}

          {desktop && (
            <Section id="about" icon={<Info size={18} />} title="About" sub="Producer Studio for desktop.">
              <div className="ps-set-row" style={{ borderTop: 0, marginTop: 0, paddingTop: 0 }}>
                <div>
                  <strong>Producer Studio {desktopBridge()?.version || info?.version}</strong>
                  <span>
                    Local engine v{info?.version} · {desktopBridge()?.platform ?? 'desktop'} · {aiLabel(info)}
                  </span>
                </div>
              </div>
            </Section>
          )}
        </div>
      )}
    </div>
  )
}
