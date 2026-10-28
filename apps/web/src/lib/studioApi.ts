// First-run onboarding (A-6) and Voice Studio settings (A-20). Contract: packages/core/src/onboarding.ts, voice.ts.
import type { OnboardingState } from '@producer/core'
import { req } from './api'

export const onboardingApi = {
  get: (ws: string) => req<OnboardingState>('GET', `/workspaces/${ws}/onboarding`),
  setDismissed: (ws: string, dismissed: boolean) => req<OnboardingState>('PUT', `/workspaces/${ws}/onboarding`, { dismissed }),
}
