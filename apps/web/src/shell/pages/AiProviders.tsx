// Settings → AI: the built-in provider (desktop: Claude CLI; cloud: the server's Claude), bring-your-own-key cards for
// Anthropic, Google Gemini (AI Studio) and OpenAI, the default provider and per-feature overrides, then the media-only
// fal.ai key (Wan video clips) and who makes clips when Gemini could too. Keys are write-only: the server returns
// hasKey + last4, never the key.
import { strongestModel, type AiChoice, type AiFeature, type AiKeyProvider, type AiKeyProviderSettings, type AiSettings, type StoredKeyProvider, type SystemInfo, type VideoClipProvider } from '@producer/core'
import clsx from 'clsx'
import { AlertTriangle, CheckCircle2, ExternalLink, Info, KeyRound, Lock, Save, Sparkles, Trash2 } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import { HttpError } from '../../lib/api'
import { useSession } from '../../lib/session'
import { toast, toastError } from '../../lib/toast'
import { aiProviderLabel, sysFetch, systemApi, systemPath, useSystem } from '../system'
import { Spinner } from '../ui'

interface ProviderMeta {
  name: string
  sub: string
  keyUrl: string
  placeholder: string
}

const META: Record<StoredKeyProvider, ProviderMeta> = {
  anthropic: { name: 'Anthropic API key', sub: 'Claude models, billed to your Anthropic account.', keyUrl: 'https://console.anthropic.com/settings/keys', placeholder: 'sk-ant-…' },
  gemini: { name: 'Google Gemini (AI Studio)', sub: 'Gemini models with a Google AI Studio API key.', keyUrl: 'https://aistudio.google.com/apikey', placeholder: 'AIza…' },
  openai: { name: 'OpenAI', sub: 'GPT models with an OpenAI platform API key.', keyUrl: 'https://platform.openai.com/api-keys', placeholder: 'sk-…' },
  fal: {
    name: 'fal.ai (Wan video clips)',
    sub: 'AI video clips made with Wan, billed per second of video to your fal.ai account. Used for clips only, never for writing.',
    keyUrl: 'https://fal.ai/dashboard/keys',
    placeholder: 'key id:secret',
  },
  runpod: {
    name: 'RunPod (Blender scenes)',
    sub: 'Renders Blender scenes on a graphics card rented by the second, billed to your RunPod account. Used for Blender scenes only, never for writing.',
    keyUrl: 'https://www.runpod.io/console/user/settings',
    placeholder: 'rpa_…',
  },
}
const ORDER: AiKeyProvider[] = ['anthropic', 'gemini', 'openai']
const SHORT: Record<AiKeyProvider, string> = { anthropic: 'Claude (your key)', gemini: 'Gemini', openai: 'OpenAI' }
const FEATURES: Array<{ id: AiFeature; label: string; hint: string }> = [
  { id: 'writer', label: 'AI writer', hint: 'Voiceover, captions and headline suggestions' },
  { id: 'script', label: 'Producer script', hint: 'Turns recordings into a scripted video' },
  { id: 'assistant', label: 'Editor assistant', hint: 'Edits the timeline by chat' },
  { id: 'animation', label: 'Animation', hint: 'Draws the AI-drawn scenes of videos made from an idea' },
]

interface DesktopBridge {
  openExternal(url: string): Promise<boolean>
}
const bridge = () => (window as unknown as { producerDesktop?: DesktopBridge }).producerDesktop

function errText(e: unknown): string {
  if (e instanceof HttpError) return e.body?.error || e.message
  return e instanceof Error ? e.message : String(e)
}

function KeyLink({ url }: { url: string }) {
  return (
    <a
      className="btn ghost sm"
      href={url}
      target="_blank"
      rel="noreferrer noopener"
      onClick={(e) => {
        const b = bridge()
        if (b) {
          e.preventDefault()
          void b.openExternal(url)
        }
      }}
    >
      <ExternalLink size={13} /> Get a key
    </a>
  )
}

function ModelPicker({ provider, info, disabled, onSave }: { provider: AiKeyProvider; info?: AiKeyProviderSettings; disabled: boolean; onSave: (m: string) => Promise<void> }) {
  const models = info?.models ?? []
  const current = info?.model ?? ''
  const [text, setText] = useState(current)
  const [custom, setCustom] = useState(false)
  useEffect(() => setText(current), [current])
  const listed = models.length > 0 && !custom && (!current || models.includes(current))
  const id = `ai-model-${provider}`
  return (
    <div className="ps-field" style={{ marginBottom: 0 }}>
      <label className="label" htmlFor={id}>Model</label>
      {listed ? (
        <select
          id={id}
          className="input mono"
          value={current}
          disabled={disabled}
          onChange={(e) => {
            if (e.target.value === '__custom') setCustom(true)
            else void onSave(e.target.value)
          }}
        >
          {!current && <option value="">Choose a model…</option>}
          {models.map((m) => (
            <option key={m} value={m}>{m}</option>
          ))}
          <option value="__custom">Other model id…</option>
        </select>
      ) : (
        <div className="row" style={{ gap: 6 }}>
          <input
            id={id}
            className="input mono"
            value={text}
            placeholder="model id"
            spellCheck={false}
            disabled={disabled}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void onSave(text.trim())
            }}
          />
          <button className="btn sm" disabled={disabled || text.trim() === current} onClick={() => void onSave(text.trim())}>
            <Save size={13} /> Save
          </button>
          {models.length > 0 && (
            <button
              className="btn ghost sm"
              onClick={() => {
                setCustom(false)
                if (!models.includes(text.trim())) setText(current)
              }}
            >
              List
            </button>
          )}
        </div>
      )}
      <div className="ps-hint">{models.length ? `${models.length} models available to this key.` : 'Save & test the key to load the models it can use, or type a model id.'}</div>
    </div>
  )
}

function KeyCard({ provider, s, desktop, workspaceId, onSettings }: { provider: StoredKeyProvider; s: AiSettings; desktop: boolean; workspaceId?: string; onSettings: (s: AiSettings) => void }) {
  const meta = META[provider]
  const media = provider === 'fal' || provider === 'runpod'
  const info = media ? s.media?.[provider] : s.providers[provider]
  const textInfo = media ? undefined : s.providers[provider]
  const okDetail = media ? `✓ valid${s.media?.[provider]?.price ? ` · ${s.media[provider]?.price}` : ''}` : `✓ valid · ${textInfo?.models?.length ?? 0} models`
  const [key, setKey] = useState('')
  const [busy, setBusy] = useState<'save' | 'test' | 'remove' | 'model'>()
  const [result, setResult] = useState<{ ok: boolean; detail: string }>()
  const [confirm, setConfirm] = useState(false)
  const canEdit = s.canEdit
  const status = result ?? (info?.hasKey ? (info.valid === false ? { ok: false, detail: info.error || 'The key didn’t work' } : info.valid ? { ok: true, detail: okDetail } : undefined) : undefined)
  const isDefault = !media && s.defaultProvider === provider
  const inUse = media ? provider === 'fal' && clipMaker(s) === 'fal' : Object.values(s.effective).some((e) => e.provider === (provider === 'anthropic' ? 'anthropic-key' : provider))

  async function run<T>(what: typeof busy, fn: () => Promise<T>): Promise<T | undefined> {
    setBusy(what)
    try {
      return await fn()
    } catch (e) {
      setResult({ ok: false, detail: errText(e) })
      return undefined
    } finally {
      setBusy(undefined)
    }
  }

  async function save() {
    const k = key.trim()
    if (!k) return
    const r = await run('save', () => systemApi.saveAiKey(provider, k, workspaceId))
    if (!r) return
    setKey('')
    setResult({ ok: r.ok, detail: r.detail })
    if (r.settings) onSettings(r.settings)
    if (r.ok) toast(`${meta.name.split(' (')[0]} key saved`)
  }

  return (
    <div className="ps-ai-card" aria-label={meta.name}>
      <div className="ps-ai-card-head">
        <span className="ps-set-icon"><KeyRound size={16} /></span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <strong>{meta.name}</strong>
          <span>{meta.sub}</span>
        </div>
        {isDefault && <span className="ps-ai-badge on">Default</span>}
        {!isDefault && inUse && <span className="ps-ai-badge">In use</span>}
        <KeyLink url={meta.keyUrl} />
      </div>
      <div className="ps-set-grid">
        <div className="ps-field" style={{ marginBottom: 0 }}>
          <label className="label" htmlFor={`ai-key-${provider}`}>API key</label>
          <div className="row" style={{ gap: 6 }}>
            <input
              id={`ai-key-${provider}`}
              className="input mono"
              type="password"
              autoComplete="off"
              spellCheck={false}
              value={key}
              disabled={!canEdit || busy === 'save'}
              placeholder={info?.hasKey ? `•••• •••• •••• ${info.keyLast4 ?? ''}` : meta.placeholder}
              onChange={(e) => setKey(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void save()
              }}
            />
            <button className="btn primary sm" disabled={!canEdit || !key.trim() || !!busy} onClick={() => void save()}>
              {busy === 'save' ? <Spinner size={13} /> : <Save size={13} />} {info?.hasKey ? 'Replace & test' : 'Save & test'}
            </button>
          </div>
          <div className="ps-hint">
            {info?.hasKey
              ? `Stored encrypted${info.keyLast4 ? ` · ends in ${info.keyLast4}` : ''}. ${desktop ? 'It stays on this computer and is never synced.' : 'The key never leaves the server.'}`
              : desktop
                ? 'Stored encrypted on this computer (protected by your Windows account); it’s never shown again or synced.'
                : 'Stored encrypted on the server; it’s never shown again.'}
          </div>
        </div>
        {!media && (
          <ModelPicker
            provider={provider as AiKeyProvider}
            info={textInfo}
            disabled={!canEdit || !!busy}
            onSave={async (m) => {
              const next = await run('model', () => systemApi.saveAiSettings({ workspaceId, models: { [provider]: m } }))
              if (next) onSettings(next)
            }}
          />
        )}
        {provider === 'fal' && (
          <div className="ps-hint" style={{ alignSelf: 'center' }}>
            Wan 2.2 at 720p, up to 10 seconds a clip. When fal.ai retires Wan 2.2 (it says 4 January 2027), clips move to Wan 2.7 by themselves.
          </div>
        )}
        {provider === 'runpod' && (
          <div className="ps-hint" style={{ alignSelf: 'center' }}>
            One card per video (an RTX 4090 when RunPod has one, about $0.70 an hour), started for the first Blender scene and given back when the video is done. Needs a key with read and write access.
          </div>
        )}
      </div>
      <div className="row" style={{ flexWrap: 'wrap', marginTop: 12, gap: 8 }}>
        {status && (
          <span className={clsx('ps-test', status.ok ? 'ok' : 'bad')} role="status">
            {status.ok ? <CheckCircle2 size={14} /> : <AlertTriangle size={14} />} {status.detail.replace(/^✓\s*/, '')}
          </span>
        )}
        <span className="spacer" />
        {info?.hasKey && canEdit && (
          <>
            <button
              className="btn sm"
              disabled={!!busy}
              onClick={async () => {
                const r = await run('test', () => systemApi.testAiKey(provider, workspaceId))
                if (!r) return
                setResult({ ok: r.ok, detail: r.detail })
                if (r.settings) onSettings(r.settings)
              }}
            >
              {busy === 'test' ? <Spinner size={13} /> : <Sparkles size={13} />} Test
            </button>
            {confirm ? (
              <span className="row" style={{ gap: 6 }}>
                <button
                  className="btn sm"
                  style={{ borderColor: 'var(--danger)', color: 'var(--danger)' }}
                  disabled={!!busy}
                  onClick={async () => {
                    const next = await run('remove', () => systemApi.deleteAiKey(provider, workspaceId))
                    setConfirm(false)
                    if (!next) return
                    setResult(undefined)
                    onSettings(next)
                    toast('Key removed')
                  }}
                >
                  {busy === 'remove' && <Spinner size={13} />} Remove key
                </button>
                <button className="btn ghost sm" onClick={() => setConfirm(false)}>Cancel</button>
              </span>
            ) : (
              <button className="btn ghost sm" disabled={!!busy} onClick={() => setConfirm(true)}>
                <Trash2 size={13} /> Remove key
              </button>
            )}
          </>
        )}
      </div>
    </div>
  )
}

const usableKey = (s: AiSettings, p: VideoClipProvider) => {
  const k = p === 'fal' ? s.media?.fal : s.providers.gemini
  return Boolean(k?.hasKey && k.valid !== false)
}

/** Who makes AI clips here, as the server picks it (capabilities.ts): the choice, else Gemini, else fal.ai. */
function clipMaker(s: AiSettings): VideoClipProvider | undefined {
  const order: VideoClipProvider[] = s.videoProvider === 'fal' ? ['fal', 'gemini'] : ['gemini', 'fal']
  return order.find((p) => usableKey(s, p))
}

/** Shown when both a Gemini and a fal.ai key are stored: who makes the clips. */
/** The key provider behind an effective provider id ('anthropic-key' → anthropic), or undefined for the built-in one. */
const keyOf = (id: string): AiKeyProvider | undefined => (id === 'anthropic-key' ? 'anthropic' : id === 'openai' || id === 'gemini' ? id : undefined)

/**
 * Which model draws AI-drawn scenes: automatic (the most capable on the key's list) or one the owner picks. Shown when
 * the animation feature runs on a key with a model list.
 */
function AnimationModelChoice({ s, workspaceId, onSettings }: { s: AiSettings; workspaceId?: string; onSettings: (s: AiSettings) => void }) {
  const [busy, setBusy] = useState(false)
  const p = keyOf(s.effective.animation?.provider ?? '')
  const models = p ? (s.providers[p]?.models ?? []) : []
  if (!p || !models.length) return null
  const auto = strongestModel(p, models) ?? s.providers[p]?.model
  const chosen = s.animationModel && models.includes(s.animationModel) ? s.animationModel : ''
  return (
    <div className="ps-set-row">
      <div>
        <strong>Animation model</strong>
        <span>The model that draws AI-drawn scenes and checks its own frames. A more capable model draws noticeably better, at a higher price per scene.</span>
      </div>
      <select
        className="input"
        style={{ width: 'auto', minWidth: 240 }}
        aria-label="Animation model"
        value={chosen}
        disabled={!s.canEdit || busy}
        onChange={async (e) => {
          setBusy(true)
          try {
            onSettings(await systemApi.saveAiSettings({ workspaceId, animationModel: e.target.value || null }))
            toast('AI settings saved')
          } catch (err) {
            toastError(err)
          } finally {
            setBusy(false)
          }
        }}
      >
        <option value="">Automatic (most capable{auto ? `: ${auto}` : ''})</option>
        {models.map((m) => (
          <option key={m} value={m}>{m}</option>
        ))}
      </select>
    </div>
  )
}

function VideoClipChoice({ s, workspaceId, onSettings }: { s: AiSettings; workspaceId?: string; onSettings: (s: AiSettings) => void }) {
  const [busy, setBusy] = useState(false)
  if (!s.media?.fal?.hasKey || !s.providers.gemini?.hasKey) return null
  return (
    <div className="ps-set-row">
      <div>
        <strong>AI video clips</strong>
        <span>Who makes the clips in videos made from an idea, billed to that key. If it can’t, the other is used.</span>
      </div>
      <select
        className="input"
        style={{ width: 'auto', minWidth: 240 }}
        aria-label="AI video clips provider"
        value={s.videoProvider ?? ''}
        disabled={!s.canEdit || busy}
        onChange={async (e) => {
          setBusy(true)
          try {
            onSettings(await systemApi.saveAiSettings({ workspaceId, videoProvider: (e.target.value || null) as VideoClipProvider | null }))
            toast('AI settings saved')
          } catch (err) {
            toastError(err)
          } finally {
            setBusy(false)
          }
        }}
      >
        <option value="">Automatic (Gemini first)</option>
        <option value="gemini">Gemini Omni Flash (Google)</option>
        <option value="fal">Wan (fal.ai)</option>
      </select>
    </div>
  )
}

function choiceLabel(c: AiChoice, s: AiSettings, desktop: boolean): string {
  if (c === 'builtin') return desktop ? 'Claude · your subscription' : 'Producer Studio (server Claude)'
  const m = s.providers[c]?.model
  return m ? `${SHORT[c].replace(' (your key)', '')} · ${m}` : SHORT[c]
}

function ProviderSelectors({ s, desktop, workspaceId, onSettings }: { s: AiSettings; desktop: boolean; workspaceId?: string; onSettings: (s: AiSettings) => void }) {
  const [busy, setBusy] = useState(false)
  const configured = ORDER.filter((p) => s.providers[p]?.hasKey && s.providers[p]?.valid !== false)
  const choices: AiChoice[] = [...(s.builtin.available ? (['builtin'] as const) : []), ...configured]
  const builtinName = desktop ? 'Claude · your subscription' : 'the server’s Claude'
  async function save(patch: Parameters<typeof systemApi.saveAiSettings>[0]) {
    setBusy(true)
    try {
      onSettings(await systemApi.saveAiSettings({ workspaceId, ...patch }))
      toast('AI settings saved')
    } catch (e) {
      toastError(e)
    } finally {
      setBusy(false)
    }
  }
  const disabled = !s.canEdit || busy
  return (
    <div>
      <div className="ps-set-row">
        <div>
          <strong>Default provider</strong>
          <span>Used by every AI feature unless overridden below. Only configured providers with a working key are listed.</span>
        </div>
        <select
          className="input"
          style={{ width: 'auto', minWidth: 240 }}
          aria-label="Default AI provider"
          value={s.defaultProvider ?? ''}
          disabled={disabled}
          onChange={(e) => void save({ defaultProvider: (e.target.value || null) as AiChoice | null })}
        >
          <option value="">Automatic ({s.builtin.available ? builtinName : 'not available'})</option>
          {choices.map((c) => (
            <option key={c} value={c}>{choiceLabel(c, s, desktop)}</option>
          ))}
          {s.defaultProvider && !choices.includes(s.defaultProvider) && <option value={s.defaultProvider}>{choiceLabel(s.defaultProvider, s, desktop)} (unavailable)</option>}
        </select>
      </div>
      <details className="ps-ai-adv">
        <summary>Advanced: per-feature providers</summary>
        {FEATURES.map((f) => {
          const eff = s.effective[f.id]
          const cur = s.perFeature[f.id]
          return (
            <div key={f.id} className="ps-set-row">
              <div>
                <strong>{f.label}</strong>
                <span>{f.hint} · now: {aiProviderLabel(eff.provider, eff.model)}</span>
              </div>
              <select
                className="input"
                style={{ width: 'auto', minWidth: 240 }}
                aria-label={`${f.label} provider`}
                value={cur ?? ''}
                disabled={disabled}
                onChange={(e) => void save({ perFeature: { [f.id]: (e.target.value || null) as AiChoice | null } })}
              >
                <option value="">Same as default</option>
                {choices.map((c) => (
                  <option key={c} value={c}>{choiceLabel(c, s, desktop)}</option>
                ))}
                {cur && !choices.includes(cur) && <option value={cur}>{choiceLabel(cur, s, desktop)} (unavailable)</option>}
              </select>
            </div>
          )
        })}
      </details>
    </div>
  )
}

/** The AI section body: built-in provider card, key cards, default + per-feature selectors. */
export function AiProviders({
  desktop,
  renderBuiltin,
}: {
  desktop: boolean
  /** Body of the built-in provider card; `refresh` re-probes it (e.g. after "Sign in to Claude") and returns its status. */
  renderBuiltin: (ctx: { builtin?: AiSettings['builtin']; refresh: () => Promise<AiSettings['builtin'] | undefined> }) => ReactNode
}) {
  const sessionWs = useSession((st) => st.workspaceId)
  const workspaceId = desktop ? undefined : sessionWs
  const [s, setS] = useState<AiSettings>()
  const [err, setErr] = useState<string>()
  useEffect(() => {
    if (!desktop && !workspaceId) return
    let alive = true
    // another space's keys and choices must not show (or be edited) while this one's load is out, or after it fails
    setS(undefined)
    setErr(undefined)
    systemApi
      .aiSettings(workspaceId)
      .then((x) => alive && setS(x))
      .catch((e) => alive && setErr(errText(e)))
    return () => {
      alive = false
    }
  }, [desktop, workspaceId])
  const apply = (next: AiSettings) => {
    setS(next)
    // the AI chip follows the effective default provider
    void useSystem.getState().load()
  }
  const refresh = async () => {
    // ?refresh=1 drops the server's cached CLI probe; then re-read the settings (builtin status) and the chip
    const info = await sysFetch<SystemInfo>('GET', systemPath(true))
    useSystem.setState((st) => ({ info, loaded: true, error: undefined, sync: info.sync ?? st.sync }))
    const next = await systemApi.aiSettings(workspaceId)
    setS(next)
    return next.builtin
  }
  return (
    <div className="ps-ai-cards">
      <div className="ps-alert info" style={{ fontSize: '0.7812rem' }}>
        <Info size={15} style={{ flex: 'none' }} />
        <span>
          API keys are billed per token by the provider you choose (OpenAI, Google, Anthropic); AI video clips per second of video.{' '}
          {desktop ? 'Claude through the Claude Code CLI uses your Claude subscription instead — no per-token charges.' : 'The built-in Claude runs on Producer Studio’s servers.'}
        </span>
      </div>
      <div className="ps-ai-card">
        <div className="ps-ai-card-head">
          <span className="ps-set-icon"><Sparkles size={16} /></span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <strong>{desktop ? 'Claude (your subscription)' : 'Producer Studio AI'}</strong>
            <span>{desktop ? 'The Claude Code CLI on this computer, signed in to your Claude account.' : 'Claude on Producer Studio’s servers, when this server has it configured.'}</span>
          </div>
          {s && s.defaultProvider === null && s.builtin.available && <span className="ps-ai-badge on">Default</span>}
        </div>
        {renderBuiltin({ builtin: s?.builtin, refresh })}
      </div>
      {err && <div className="ps-alert">Couldn’t load AI settings: {err}</div>}
      {!s && !err && <div className="skeleton" style={{ height: 160, borderRadius: 14 }} />}
      {s && !s.canEdit && (
        <div className="ps-alert info" role="note">
          <Lock size={15} style={{ flex: 'none' }} /> Your workspace owner manages AI keys. You can see which providers are set up here.
        </div>
      )}
      {s && ORDER.map((p) => <KeyCard key={`${workspaceId ?? ''}:${p}`} provider={p} s={s} desktop={desktop} workspaceId={workspaceId} onSettings={apply} />)}
      {s && <ProviderSelectors key={workspaceId ?? ''} s={s} desktop={desktop} workspaceId={workspaceId} onSettings={apply} />}
      {s && <KeyCard key={`${workspaceId ?? ''}:fal`} provider="fal" s={s} desktop={desktop} workspaceId={workspaceId} onSettings={apply} />}
      {s && !desktop && <KeyCard key={`${workspaceId ?? ''}:runpod`} provider="runpod" s={s} desktop={desktop} workspaceId={workspaceId} onSettings={apply} />}
      {s && <AnimationModelChoice key={`${workspaceId ?? ''}:animation`} s={s} workspaceId={workspaceId} onSettings={apply} />}
      {s && <VideoClipChoice key={`${workspaceId ?? ''}:video`} s={s} workspaceId={workspaceId} onSettings={apply} />}
    </div>
  )
}
