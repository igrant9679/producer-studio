// First-run onboarding (A-6) and Voice Studio settings (A-20). Contract: packages/core/src/onboarding.ts, voice.ts.
import type { OnboardingState, VoiceDraft, VoiceSettings, VoiceStudioPrefs } from '@producer/core'
import { HttpError, noteStatus, req } from './api'

export const onboardingApi = {
  get: (ws: string) => req<OnboardingState>('GET', `/workspaces/${ws}/onboarding`),
  setDismissed: (ws: string, dismissed: boolean) => req<OnboardingState>('PUT', `/workspaces/${ws}/onboarding`, { dismissed }),
}

export const voiceApi = {
  settings: (ws: string) => req<VoiceSettings>('GET', `/workspaces/${ws}/voice-settings`),
  saveSettings: (ws: string, s: VoiceSettings) => req<VoiceSettings>('PUT', `/workspaces/${ws}/voice-settings`, s),
  prefs: (ws: string) => req<VoiceStudioPrefs>('GET', `/workspaces/${ws}/voice-studio`),
  /** `draft: null` clears this person's draft in the space. */
  savePrefs: (ws: string, p: { draft?: VoiceDraft | null; favourites?: string[] }) => req<VoiceStudioPrefs>('PUT', `/workspaces/${ws}/voice-studio`, p),
  /** A line in a built-in voice, as audio to play (not saved). */
  async preview(ws: string, body: { text: string; voice: string; speed?: number }, signal?: AbortSignal): Promise<Blob> {
    const path = `/workspaces/${ws}/voice-preview`
    const res = await fetch(`/api${path}`, { method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal })
    noteStatus(path, res.status)
    if (!res.ok) {
      let err = { error: res.statusText }
      try {
        err = await res.json()
      } catch {
        /* non-JSON error */
      }
      throw new HttpError(res.status, err)
    }
    return res.blob()
  },
}
