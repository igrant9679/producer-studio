// The language a transcription listens for (P-20), and a plain sentence about the speech model the server has: which
// one, and what it can hear. "Detect" is offered only by a model that can tell languages apart; an English-only model
// says so, so nobody waits for a French transcript that comes out as English nonsense.
import type { TranscriptionInfo } from '@producer/core'
import { useEffect, useId } from 'react'
import { create } from 'zustand'
import { api } from '../../lib/api'

const KEY = 'ps.transcribe.language'

function saved(): string {
  try {
    return localStorage.getItem(KEY) ?? 'auto'
  } catch {
    return 'auto'
  }
}

interface LangState {
  info?: TranscriptionInfo
  /** A code from info.languages, or 'auto'. */
  language: string
  set(language: string): void
}

export const useTranscribeLanguage = create<LangState>((set) => ({
  language: saved(),
  set(language) {
    try {
      localStorage.setItem(KEY, language)
    } catch {
      /* not kept */
    }
    set({ language })
  },
}))

let loading: Promise<void> | undefined
/** Ask the server once per visit (again after a failure). */
export function loadTranscriptionInfo(): Promise<void> {
  if (useTranscribeLanguage.getState().info) return Promise.resolve()
  loading ??= api
    .transcription()
    .then((info) => useTranscribeLanguage.setState({ info }))
    .catch(() => undefined)
    .finally(() => {
      loading = undefined
    })
  return loading
}

/**
 * The language to send with a transcription: the one picked, if this server's model can hear it; else "detect" on a
 * multilingual model and English on an English-only one (undefined: the server decides the same way).
 */
export function transcribeLanguage(): string | undefined {
  const { info, language } = useTranscribeLanguage.getState()
  if (!info) return language === 'auto' ? undefined : language
  if (language !== 'auto' && info.languages.some((l) => l.code === language)) return language
  return info.multilingual ? 'auto' : 'en'
}

function languageName(code: string): string {
  try {
    return new Intl.DisplayNames(['en'], { type: 'language' }).of(code) ?? code
  } catch {
    return code
  }
}

/** The picker and the model's sentence, above a Transcribe button. */
export function TranscribeLanguage({ disabled }: { disabled?: boolean }) {
  const { info, language, set } = useTranscribeLanguage()
  const id = useId()
  useEffect(() => {
    void loadTranscriptionInfo()
  }, [])
  if (!info) return null
  if (!info.available) return <p className="ed-note" role="note">{info.summary}</p>
  const value = transcribeLanguage() ?? 'auto'
  return (
    <div className="tr-lang">
      <div className="row" style={{ gap: 6, alignItems: 'center' }}>
        <label htmlFor={id} className="muted" style={{ fontSize: '0.75rem' }}>
          Spoken language
        </label>
        <select id={id} className="input sm" value={value} disabled={disabled || (!info.multilingual && info.languages.length <= 1)} onChange={(e) => set(e.target.value)}>
          {info.detect && <option value="auto">Detect it</option>}
          {info.languages.map((l) => (
            <option key={l.code} value={l.code}>
              {l.name}
            </option>
          ))}
        </select>
      </div>
      <p className="ed-note" role="note" style={{ margin: '4px 0 8px' }}>
        {info.summary}
        {language !== 'auto' && !info.languages.some((l) => l.code === language) ? ` ${languageName(language)} isn’t one of them, so ${info.multilingual ? 'it will be detected' : 'English is used'}.` : ''}
      </p>
    </div>
  )
}
