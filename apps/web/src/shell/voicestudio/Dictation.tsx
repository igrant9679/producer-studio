// Dictation (desktop): in-app (Ctrl+Shift+Space dictates into the focused text field) and system-wide (a global
// shortcut + floating widget that pastes into any app). Both stream to VoiceStudio through /api/voicestudio/ws/dictation.
import type { DesktopSettings } from '@producer/core'
import clsx from 'clsx'
import { Check, Download, Keyboard, Mic, Square, X } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { DictationSession, insertIntoFocused, isEditable } from '../../lib/dictation'
import { toast, toastError } from '../../lib/toast'
import { systemApi, useIsDesktop } from '../system'
import { Spinner, useAsync } from '../ui'
import { useVsStatus, vsFetch, vsGet, vsRunning } from './vsApi'
import './voicestudio.css'

export const IN_APP_SHORTCUT = 'Ctrl+Shift+Space'

interface DictationBridge {
  configure: (c: { enabled: boolean; shortcut: string; paste: boolean }) => Promise<{ ok: boolean; error?: string }>
  result: (text: string) => Promise<boolean>
  cancel: () => Promise<boolean>
  toggle: () => Promise<boolean>
  onCommand: (cb: (cmd: string) => void) => () => void
}
export const dictationBridge = (): DictationBridge | undefined => (window as unknown as { producerDesktop?: { dictation?: DictationBridge } }).producerDesktop?.dictation

const friendly = (e: unknown) => {
  const m = e instanceof Error ? e.message : String(e)
  if (/Permission|NotAllowed/i.test(m)) return 'Microphone access was blocked.'
  if (/NotFound|Requested device/i.test(m)) return 'No microphone found.'
  return m
}

// ---------------- in-app dictation ----------------

/** Mounted once in the shell (desktop): the in-app shortcut, the live-text pill, and applying the global shortcut. */
export function DictationController() {
  const desktop = useIsDesktop()
  const status = useVsStatus(desktop)
  const [state, setState] = useState<'idle' | 'listening' | 'finishing'>('idle')
  const [text, setText] = useState('')
  const [level, setLevel] = useState(0)
  const session = useRef<DictationSession>()
  const target = useRef<Element | null>(null)
  const settings = useRef<DesktopSettings>()

  // apply the system-wide shortcut from settings once per launch
  useEffect(() => {
    if (!desktop) return
    systemApi
      .settings()
      .then(async (s) => {
        settings.current = s
        const b = dictationBridge()
        if (b && s.dictationGlobal) {
          const r = await b.configure({ enabled: true, shortcut: s.dictationShortcut, paste: s.dictationPaste })
          if (!r.ok) toast(`System-wide dictation: ${r.error ?? 'shortcut unavailable'}`)
        }
      })
      .catch(() => undefined)
  }, [desktop])

  const stop = useCallback(async () => {
    const s = session.current
    if (!s) return
    setState('finishing')
    try {
      const final = await s.stop()
      if (final && !insertIntoFocused(target.current, final)) {
        await navigator.clipboard.writeText(final).catch(() => undefined)
        toast('Dictation copied to the clipboard')
      }
    } catch (e) {
      s.cancel()
      // a failure already said by the session's error event isn't said twice
      if (session.current === s) toastError(new Error(friendly(e)))
    } finally {
      if (session.current === s) session.current = undefined
      setState('idle')
      setText('')
    }
  }, [])

  const cancel = useCallback(() => {
    session.current?.cancel()
    session.current = undefined
    setState('idle')
    setText('')
  }, [])

  const start = useCallback(async () => {
    if (!vsRunning(status)) return toast('Dictation needs the VoiceStudio engine — start it in Voice Studio → Engine')
    const el = document.activeElement
    if (!isEditable(el)) return toast(`Click into a text box first, then press ${IN_APP_SHORTCUT}`)
    target.current = el
    setState('listening')
    setText('')
    // the model as set now (Settings may have changed it since launch)
    settings.current = await systemApi.settings().catch(() => settings.current)
    const s: DictationSession = new DictationSession({
      model: settings.current?.dictationModel || undefined,
      onEvent: (e) => {
        if (session.current !== s) return
        if (e.type === 'partial') setText(e.text)
        else if (e.type === 'level') setLevel(e.level)
        else if (e.type === 'status' && e.stage !== 'ready') setText(e.stage === 'downloading' ? 'Downloading the dictation model…' : 'Loading the dictation model…')
        else if (e.type === 'error') {
          // an error or a dropped connection mid-dictation: say so and stop listening, instead of "Listening…"
          session.current = undefined
          setState('idle')
          setText('')
          toastError(new Error(friendly(e.message)))
        }
      },
    })
    session.current = s
    try {
      await s.start()
    } catch (e) {
      s.cancel()
      if (session.current === s) {
        session.current = undefined
        setState('idle')
        toastError(new Error(friendly(e)))
      }
    }
  }, [status])

  useEffect(() => {
    if (!desktop) return
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.shiftKey && !e.altKey && e.code === 'Space') {
        e.preventDefault()
        if (state === 'idle') void start()
        else if (state === 'listening') void stop()
      } else if (e.key === 'Escape' && state === 'listening') {
        e.preventDefault()
        cancel()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [desktop, state, start, stop, cancel])

  if (state === 'idle') return null
  return (
    <div className="vs-dict-pill" role="status" aria-live="polite" onMouseDown={(e) => e.preventDefault()}>
      <span className={clsx('vs-dict-dot', state === 'listening' && 'on')} style={{ transform: `scale(${1 + level * 0.8})` }} />
      <span className="vs-dict-text">{text || (state === 'finishing' ? 'Finishing…' : 'Listening… speak now')}</span>
      {state === 'listening' ? (
        <>
          <button className="btn sm" onClick={() => void stop()} title={`Insert (${IN_APP_SHORTCUT})`}><Check size={13} /> Insert</button>
          <button className="btn ghost sm icon" onClick={cancel} title="Cancel (Esc)" aria-label="Cancel dictation"><X size={14} /></button>
        </>
      ) : (
        <Spinner size={14} />
      )}
    </div>
  )
}

// ---------------- system-wide widget (/dictate) ----------------

/** The floating widget the global shortcut opens. Never focused; the main process pastes the result. */
export default function DictationWidget() {
  const [state, setState] = useState<'idle' | 'listening' | 'finishing' | 'error'>('idle')
  const [text, setText] = useState('')
  const [level, setLevel] = useState(0)
  const [err, setErr] = useState<string>()
  const session = useRef<DictationSession>()
  const model = useRef<string>()

  useEffect(() => {
    document.documentElement.classList.add('vs-dict-widget-root')
    systemApi.settings().then((s) => (model.current = s.dictationModel || undefined)).catch(() => undefined)
    const b = dictationBridge()
    if (!b) return
    const showError = (e: unknown) => {
      setErr(friendly(e))
      setState('error')
      setTimeout(() => void b.cancel(), 2500)
    }
    const begin = async () => {
      session.current?.cancel()
      setErr(undefined)
      setText('')
      setState('listening')
      // the model as set now: Settings may have changed it since this widget opened
      model.current = await systemApi.settings().then((st) => st.dictationModel || undefined, () => model.current)
      const s: DictationSession = new DictationSession({
        model: model.current,
        onEvent: (e) => {
          if (session.current !== s) return
          if (e.type === 'partial') setText(e.text)
          else if (e.type === 'level') setLevel(e.level)
          else if (e.type === 'status' && e.stage !== 'ready') setText('Loading the dictation model…')
          else if (e.type === 'error') {
            session.current = undefined
            showError(e.message)
          }
        },
      })
      session.current = s
      try {
        await s.start()
      } catch (e) {
        s.cancel()
        if (session.current === s) {
          session.current = undefined
          showError(e)
        }
      }
    }
    const finish = async () => {
      const s = session.current
      if (!s) return void b.cancel()
      setState('finishing')
      try {
        const final = await s.stop()
        await b.result(final)
        // functional: an error shown meanwhile stays on screen
        setState((st) => (st === 'error' ? st : 'idle'))
      } catch (e) {
        s.cancel()
        // a failure the session's error event already showed isn't shown twice
        if (session.current === s) showError(e)
      } finally {
        if (session.current === s) session.current = undefined
      }
    }
    return b.onCommand((cmd) => (cmd === 'start' ? void begin() : cmd === 'stop' ? void finish() : undefined))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div className="vs-dict-widget">
      <span className={clsx('vs-dict-dot', state === 'listening' && 'on')} style={{ transform: `scale(${1 + level * 0.8})` }} />
      <span className="vs-dict-text">{err ?? (text || (state === 'finishing' ? 'Inserting…' : 'Listening… speak, then press the shortcut again'))}</span>
      {state === 'listening' && (
        <button className="btn ghost sm icon" onClick={() => {
          session.current?.cancel()
          session.current = undefined
          setState('idle')
          void dictationBridge()?.cancel()
        }} aria-label="Cancel dictation"><X size={14} /></button>
      )}
      {state === 'finishing' && <Spinner size={14} />}
    </div>
  )
}

// ---------------- settings ----------------

interface DictModel {
  id: string
  repo_id: string
  label: string
  tag?: string
  recommended?: boolean
  size_gb?: number
  installed?: boolean
}

/** Electron accelerator from a key event (e.g. Ctrl+Alt+D → CommandOrControl+Alt+D). */
function accelFromEvent(e: React.KeyboardEvent): string | undefined {
  if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) return undefined
  const mods = [e.ctrlKey && 'CommandOrControl', e.altKey && 'Alt', e.shiftKey && 'Shift', e.metaKey && 'Super'].filter(Boolean) as string[]
  if (!mods.length) return undefined
  const k = e.code.startsWith('Key') ? e.code.slice(3) : e.code.startsWith('Digit') ? e.code.slice(5) : e.code === 'Space' ? 'Space' : /^F\d+$/.test(e.code) ? e.code : undefined
  return k ? [...mods, k].join('+') : undefined
}

export const prettyAccel = (a: string) => a.replace('CommandOrControl', 'Ctrl').replace(/\+/g, ' + ')

export function DictationSettings({ settings, onSettings }: { settings?: DesktopSettings; onSettings: (p: Partial<DesktopSettings>) => Promise<void> }) {
  const status = useVsStatus(true)
  const running = vsRunning(status)
  const models = useAsync(() => (running ? vsGet<{ models: DictModel[]; engine_available: boolean; default_model_id?: string }>('/dictation/models') : Promise.resolve(undefined)), [running])
  const ready = useAsync(() => (running ? vsGet<{ ready: boolean; missing?: { repo_ids?: string[]; message?: string } | null }>('/dictation/readiness', { query: { model_id: settings?.dictationModel || undefined } }) : Promise.resolve(undefined)), [running, settings?.dictationModel])
  const [recording, setRecording] = useState(false)
  const [busy, setBusy] = useState(false)

  const apply = async (p: Partial<DesktopSettings>) => {
    await onSettings(p)
    const next = { ...settings!, ...p }
    const b = dictationBridge()
    if (b) {
      const r = await b.configure({ enabled: next.dictationGlobal, shortcut: next.dictationShortcut, paste: next.dictationPaste })
      if (!r.ok) {
        toastError(new Error(r.error ?? 'Couldn’t register the shortcut'))
        if (p.dictationGlobal) await onSettings({ dictationGlobal: false })
      }
    }
  }

  const installMissing = async () => {
    const repo = ready.data?.missing?.repo_ids?.[0] ?? models.data?.models.find((m) => m.id === (settings?.dictationModel || models.data?.default_model_id))?.repo_id
    if (!repo) return
    setBusy(true)
    try {
      await vsFetch('/models/install', { body: { repo_id: repo } })
      toast('Downloading the dictation model — see Voice Studio → Engine for progress')
    } catch (e) {
      toastError(e)
    } finally {
      setBusy(false)
    }
  }

  if (!settings) return <Spinner />
  return (
    <div>
      {!running && <div className="ps-alert info" style={{ marginBottom: 12 }}>Dictation uses the VoiceStudio engine. Set it up or start it in Voice Studio → Engine.</div>}
      {running && ready.data && !ready.data.ready && (
        <div className="ps-alert" style={{ marginBottom: 12 }}>
          <span style={{ flex: 1 }}>{ready.data.missing?.message ?? 'The dictation model isn’t downloaded yet.'}</span>
          <button className="btn sm" disabled={busy} onClick={installMissing}>{busy ? <Spinner size={12} /> : <Download size={13} />} Download</button>
        </div>
      )}
      <div className="ps-set-row" style={{ borderTop: 0, marginTop: 0, paddingTop: 0 }}>
        <div>
          <strong><Mic size={13} style={{ verticalAlign: -2 }} /> In Producer Studio</strong>
          <span>Click into any text box and press <kbd className="kbd">{IN_APP_SHORTCUT}</kbd>; press it again to insert, Esc to cancel.</span>
        </div>
      </div>
      <div className="ps-set-row">
        <div>
          <strong>Dictate into any app</strong>
          <span>A global shortcut opens a small dictation bar over whatever you’re using and pastes the text where your cursor is.</span>
        </div>
        <button type="button" role="switch" aria-checked={settings.dictationGlobal} aria-label="System-wide dictation" className={clsx('ps-toggle', settings.dictationGlobal && 'on')} onClick={() => void apply({ dictationGlobal: !settings.dictationGlobal })}>
          <i />
        </button>
      </div>
      <div className="ps-set-row">
        <div>
          <strong><Keyboard size={13} style={{ verticalAlign: -2 }} /> Shortcut</strong>
          <span>Press to start, press again to insert.</span>
        </div>
        <button
          className={clsx('btn sm', recording && 'primary')}
          onClick={() => setRecording(true)}
          onKeyDown={(e) => {
            if (!recording) return
            e.preventDefault()
            if (e.key === 'Escape') return setRecording(false)
            const a = accelFromEvent(e)
            if (a) {
              setRecording(false)
              void apply({ dictationShortcut: a })
            }
          }}
          onBlur={() => setRecording(false)}
        >
          {recording ? 'Press keys…' : prettyAccel(settings.dictationShortcut)}
        </button>
      </div>
      <div className="ps-set-row">
        <div>
          <strong>Paste automatically</strong>
          <span>Off: the text is only copied to the clipboard.</span>
        </div>
        <button type="button" role="switch" aria-checked={settings.dictationPaste} aria-label="Paste automatically" className={clsx('ps-toggle', settings.dictationPaste && 'on')} onClick={() => void apply({ dictationPaste: !settings.dictationPaste })}>
          <i />
        </button>
      </div>
      <div className="ps-set-row">
        <div>
          <strong>Dictation model</strong>
          <span>Streaming models show words as you speak; offline models are more accurate and insert when you stop.</span>
        </div>
        <select className="input" style={{ width: 'auto', maxWidth: 280 }} value={settings.dictationModel} disabled={!models.data} onChange={(e) => void apply({ dictationModel: e.target.value })}>
          <option value="">VoiceStudio default (Whisper)</option>
          {(models.data?.models ?? []).map((m) => (
            <option key={m.id} value={m.id}>{m.label}{m.installed ? '' : ` — ${m.size_gb ?? '?'} GB to download`}</option>
          ))}
        </select>
      </div>
      {dictationBridge() && settings.dictationGlobal && (
        <div className="row" style={{ marginTop: 12 }}>
          <button className="btn sm" onClick={() => void dictationBridge()!.toggle()}><Square size={12} /> Try the dictation bar</button>
        </div>
      )}
    </div>
  )
}
