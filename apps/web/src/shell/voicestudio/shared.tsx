// Shared bits for the VoiceStudio tabs: engine hooks, the "needs the desktop" panels, language list, small widgets.
import { Download, Laptop, MonitorSmartphone, Power, Sparkles } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import { useAsync } from '../ui'
import { systemApi, useIsDesktop } from '../system'
import { LICENSE_NOTES, useVsStatus, vsApi, vsGet, vsRunning, type VsStatus } from './vsApi'
import { Spinner } from '../ui'
import { toastError } from '../../lib/toast'

export interface TtsBackend {
  id: string
  display_name?: string
  available?: boolean
  reason?: string | null
  hint?: string | null
  install_hint?: string | null
  docs_url?: string | null
  one_click_install?: boolean
  supports_cloning?: boolean
  supports_voice_design?: boolean
  supports_emotion?: boolean
  max_ref_seconds?: number | null
  min_vram_gb?: number | null
  routing_status?: string
  effective_device?: string
  license_required?: boolean
  license_accepted?: boolean
  supported_language_names?: string[]
}

export interface TtsEngines {
  active: string
  active_model?: string | null
  backends: TtsBackend[]
}

/** /engines/tts while VoiceStudio is running. */
export function useTtsEngines(running: boolean) {
  return useAsync(() => (running ? vsGet<TtsEngines>('/engines/tts') : Promise.resolve(undefined)), [running])
}

export const engineName = (b?: Pick<TtsBackend, 'id' | 'display_name'>) => (b ? b.display_name || b.id : '')

/** Languages VoiceStudio accepts by name (OmniVoice covers 600+; these are the common ones; "Auto" detects). */
export const LANGUAGES = [
  'Auto', 'English', 'Spanish', 'French', 'German', 'Italian', 'Portuguese', 'Dutch', 'Polish', 'Russian', 'Ukrainian', 'Turkish', 'Arabic',
  'Hebrew', 'Hindi', 'Bengali', 'Urdu', 'Tamil', 'Telugu', 'Marathi', 'Gujarati', 'Punjabi', 'Chinese', 'Cantonese', 'Japanese', 'Korean',
  'Vietnamese', 'Thai', 'Indonesian', 'Malay', 'Filipino', 'Swahili', 'Yoruba', 'Hausa', 'Amharic', 'Greek', 'Czech', 'Slovak', 'Hungarian',
  'Romanian', 'Bulgarian', 'Serbian', 'Croatian', 'Swedish', 'Norwegian', 'Danish', 'Finnish', 'Persian',
]

/** Dub target languages (ISO code → name), as VoiceStudio's dubbing offers them. */
export const DUB_LANGUAGES: Array<{ code: string; label: string }> = 'af:Afrikaans|sq:Albanian|am:Amharic|ar:Arabic|hy:Armenian|az:Azerbaijani|eu:Basque|be:Belarusian|bn:Bengali|bs:Bosnian|bg:Bulgarian|my:Burmese|ca:Catalan|cmn-Hans:Chinese (Simplified)|cmn-Hant:Chinese (Traditional)|hr:Croatian|cs:Czech|da:Danish|nl:Dutch|en:English|et:Estonian|fi:Finnish|fr:French|gl:Galician|ka:Georgian|de:German|el:Greek|gu:Gujarati|ht:Haitian Creole|ha:Hausa|haw:Hawaiian|he:Hebrew|hi:Hindi|hu:Hungarian|is:Icelandic|id:Indonesian|it:Italian|ja:Japanese|jw:Javanese|kn:Kannada|kk:Kazakh|km:Khmer|ko:Korean|ku:Kurdish|ky:Kyrgyz|lo:Lao|la:Latin|lv:Latvian|lt:Lithuanian|mk:Macedonian|ms:Malay|ml:Malayalam|mt:Maltese|mi:Maori|mr:Marathi|mn:Mongolian|ne:Nepali|no:Norwegian|ps:Pashto|fa:Persian|pl:Polish|pt:Portuguese|pa:Punjabi|ro:Romanian|ru:Russian|sm:Samoan|gd:Scots Gaelic|sr:Serbian|sn:Shona|sd:Sindhi|si:Sinhala|sk:Slovak|sl:Slovenian|so:Somali|es:Spanish|su:Sundanese|sw:Swahili|sv:Swedish|tg:Tajik|ta:Tamil|te:Telugu|th:Thai|tr:Turkish|uk:Ukrainian|ur:Urdu|uz:Uzbek|vi:Vietnamese|cy:Welsh|xh:Xhosa|yi:Yiddish|yo:Yoruba|zu:Zulu'
  .split('|')
  .map((p) => {
    const i = p.indexOf(':')
    return { code: p.slice(0, i), label: p.slice(i + 1) }
  })

/** Engines that can design a voice from a description in VoiceStudio 0.5.6 (OmniVoice's instruct tags). */
export const canDesign = (b: { id: string; supports_voice_design?: boolean }) => b.supports_voice_design === true || b.id.startsWith('omnivoice')

export function LicenseChip({ engine }: { engine: string }) {
  const n = LICENSE_NOTES[engine]
  if (!n) return <span className="vs-chip muted" title="Licence not reviewed by Producer Studio — check the model card">Licence: check model card</span>
  return (
    <span className={`vs-chip ${n.commercial ? 'ok' : n.commercial === null ? 'muted' : 'warn'}`} title={`${n.license}${n.note ? ` — ${n.note}` : ''}`}>
      {n.commercial || n.commercial === null ? n.license : `${n.license} · non-commercial`}
    </span>
  )
}

/** Desktop + engine state for a tab. */
export function useEngine() {
  const desktop = useIsDesktop()
  const status = useVsStatus(desktop)
  return { desktop, status, running: vsRunning(status) }
}

/** Latest Windows installer (GitHub release page; always the newest version). */
export const DESKTOP_DOWNLOAD_URL = 'https://github.com/igrant9679/producer-studio/releases/latest'

/** Web edition: what VoiceStudio is, and how to use it through a linked desktop. */
export function DesktopOnly({ feature, children }: { feature: string; children?: ReactNode }) {
  const devices = useAsync(() => systemApi.devices(), [])
  const online = (devices.data ?? []).filter((d) => d.lastSeenAt && Date.now() - d.lastSeenAt < 2 * 60_000)
  return (
    <div className="vs-desktop-only">
      <div className="vs-desktop-only-icon"><MonitorSmartphone size={26} /></div>
      <h2>{feature} runs in Producer Studio for desktop</h2>
      <p>
        VoiceStudio’s voice cloning, voice design, dubbing and audiobook engines run on your own computer’s GPU. Install Producer Studio for
        Windows, sign in to the same account (Settings → Account &amp; sync → Link), and everything it makes — voices, voiceovers, dubbed videos,
        audiobooks — syncs to this space automatically.
      </p>
      <a className="btn primary" href={DESKTOP_DOWNLOAD_URL} target="_blank" rel="noreferrer" style={{ marginBottom: 14 }}>
        <Download size={14} /> Download Producer Studio for Windows
      </a>
      <ul className="vs-steps">
        <li><Download size={14} /> Install Producer Studio for Windows and open <b>Voice Studio → Engine</b> to set up VoiceStudio (one-time, several GB).</li>
        <li><Laptop size={14} /> Link it: <b>Settings → Account &amp; sync</b>, sign in with this account.</li>
        <li><Sparkles size={14} /> Cloned and designed voices appear here. While that computer is on, you can generate with them from the web too.</li>
      </ul>
      <div className="vs-devices">
        <strong>Your linked computers</strong>
        {devices.loading && !devices.data ? (
          <span className="muted"><Spinner size={13} /> Checking…</span>
        ) : !devices.data?.length ? (
          <span className="muted">None yet.</span>
        ) : (
          devices.data.map((d) => {
            const on = online.includes(d)
            return (
              <span key={d.id} className={`vs-device ${on ? 'on' : ''}`}>
                <Power size={12} /> {d.name} · {on ? 'online' : d.lastSeenAt ? `last seen ${new Date(d.lastSeenAt).toLocaleString()}` : 'never connected'}
              </span>
            )
          })
        )}
      </div>
      {children}
    </div>
  )
}

/** Desktop, VoiceStudio not running: install / start prompt. `onOpenEngine` jumps to the Engine tab. */
export function EngineGate({ status, onOpenEngine, children }: { status?: VsStatus; onOpenEngine: () => void; children: ReactNode }) {
  const [busy, setBusy] = useState(false)
  if (vsRunning(status)) return <>{children}</>
  const notInstalled = !status || status.state === 'not-installed'
  return (
    <div className="vs-gate">
      <Power size={22} />
      <div>
        <strong>{notInstalled ? 'VoiceStudio isn’t set up yet' : status?.state === 'installing' ? 'VoiceStudio is installing…' : status?.state === 'starting' ? 'VoiceStudio is starting…' : 'VoiceStudio is stopped'}</strong>
        <span>
          {notInstalled
            ? 'It’s a one-time setup (Python, PyTorch and the voice models — several GB).'
            : status?.state === 'error'
              ? status.error
              : status?.message || 'Start the engine to use this.'}
        </span>
      </div>
      <span className="spacer" />
      {notInstalled || status?.state === 'installing' ? (
        <button className="btn primary sm" onClick={onOpenEngine}>Open Engine</button>
      ) : status?.state === 'starting' ? (
        <Spinner />
      ) : (
        <button
          className="btn primary sm"
          disabled={busy}
          onClick={async () => {
            setBusy(true)
            try {
              await vsApi.start()
            } catch (e) {
              toastError(e)
            } finally {
              setBusy(false)
            }
          }}
        >
          {busy && <Spinner size={13} />} Start VoiceStudio
        </button>
      )}
    </div>
  )
}

/** Elapsed seconds while `active`. */
export function useElapsed(active: boolean): number {
  const [t, setT] = useState(0)
  useEffect(() => {
    if (!active) return setT(0)
    const start = Date.now()
    const id = setInterval(() => setT(Math.floor((Date.now() - start) / 1000)), 250)
    return () => clearInterval(id)
  }, [active])
  return t
}

export const fmtBytes = (n?: number | null) => (n == null ? '' : n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(1)} GB` : n >= 1024 ** 2 ? `${Math.round(n / 1024 ** 2)} MB` : `${Math.round(n / 1024)} KB`)
