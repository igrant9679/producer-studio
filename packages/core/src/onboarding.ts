// First-run onboarding (A-6): the Home checklist, ticked from what the space really holds, and its sample project.

// GET /api/workspaces/:id/onboarding                 -> OnboardingState (viewer+)
// PUT /api/workspaces/:id/onboarding {dismissed}     -> OnboardingState (any member: it's their own checklist)
export type OnboardingStepId = 'upload' | 'brand' | 'producer' | 'invite'

export interface OnboardingState {
  /** Done, from the space's real state: a recording uploaded, the brand kit saved, a Producer video assembled, a teammate in (or invited). */
  steps: Record<OnboardingStepId, boolean>
  /** This person hid the checklist in this space. */
  dismissed: boolean
  /** The sample project made with the space, while it still exists. */
  sampleProjectId?: string
}

export const ONBOARDING_STEPS: ReadonlyArray<{ id: OnboardingStepId; title: string; body: string }> = [
  { id: 'upload', title: 'Upload a recording', body: 'A screen capture, demo or talking head: Producer AI and the editor start from it.' },
  { id: 'brand', title: 'Set your brand kit', body: 'Colours, fonts, logo and voice, used by every video in this space.' },
  { id: 'producer', title: 'Make a first Producer video', body: 'Producer AI writes, narrates and cuts a video from your recording or an idea.' },
  { id: 'invite', title: 'Invite a teammate', body: 'Editors make and change videos; viewers watch and comment.' },
]

export function onboardingProgress(s: Pick<OnboardingState, 'steps'>): { done: number; total: number } {
  const total = ONBOARDING_STEPS.length
  return { done: ONBOARDING_STEPS.filter((x) => s.steps[x.id]).length, total }
}
