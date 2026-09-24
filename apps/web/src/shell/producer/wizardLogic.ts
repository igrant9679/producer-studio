// Pure state logic for the Producer AI wizard (no React, no network) — unit-tested in __tests__.
import type { ProducerMeta, ProjectDocResponse, ScriptScene } from '@producer/core'

export type Brief = NonNullable<ProducerMeta['brief']>
export type StepId = 'upload' | 'brief' | 'generate' | 'review' | 'assemble'

export const STEPS: Array<{ id: StepId; label: string; hint: string }> = [
  { id: 'upload', label: 'Recordings', hint: 'Upload footage' },
  { id: 'brief', label: 'Brief', hint: 'Audience, look & voice' },
  { id: 'generate', label: 'Write', hint: 'Transcribe & script' },
  { id: 'review', label: 'Review', hint: 'Edit the script' },
  { id: 'assemble', label: 'Assemble', hint: 'Narrate & cut' },
]

export interface WizardAsset {
  localId: string
  assetId?: string
  name: string
  size: number
  status: 'uploading' | 'processing' | 'ready' | 'error'
  progress: number
  duration?: number
  error?: string
}

export interface WizardState {
  step: StepId
  projectId?: string
  workspaceId?: string
  assets: WizardAsset[]
  brief: Brief
  scenes: ScriptScene[]
  /** Asset ids already transcribed for this project. */
  transcribed: string[]
  run: {
    status: 'idle' | 'running' | 'error' | 'done'
    phase?: 'create' | 'transcribe' | 'script' | 'assemble'
    message?: string
    progress?: number
    error?: string
    jobId?: string
    interrupted?: boolean
  }
  assembledVersion?: number
}

export const TONES = ['Confident', 'Friendly', 'Professional', 'Energetic', 'Calm', 'Playful']

export function briefTitleFromPrompt(prompt: string): string {
  const clean = prompt.replace(/\s+/g, ' ').trim().replace(/[.?!]+$/, '')
  if (!clean) return ''
  const words = clean.split(' ')
  const t = words.slice(0, 8).join(' ')
  return (t.charAt(0).toUpperCase() + t.slice(1)) + (words.length > 8 ? '…' : '')
}

export function defaultBrief(opts: { prompt?: string; aspect?: Brief['aspect']; voice?: string; template?: string } = {}): Brief {
  return {
    title: briefTitleFromPrompt(opts.prompt ?? ''),
    audience: '',
    goal: opts.prompt?.trim() ?? '',
    tone: 'Confident',
    template: opts.template ?? '',
    voice: opts.voice ?? 'af_heart',
    aspect: opts.aspect ?? '16:9',
    notes: '',
  }
}

export function initialState(opts: Parameters<typeof defaultBrief>[0] = {}): WizardState {
  return { step: 'upload', assets: [], brief: defaultBrief(opts), scenes: [], transcribed: [], run: { status: 'idle' } }
}

export function readyAssetIds(s: Pick<WizardState, 'assets'>): string[] {
  return s.assets.filter((a) => a.status === 'ready' && a.assetId).map((a) => a.assetId!)
}

export function sceneWords(text: string): number {
  return text.trim() ? text.trim().split(/\s+/).length : 0
}

/** ~150 wpm narration. */
export function narrationSeconds(text: string): number {
  return sceneWords(text) / 2.5
}

export function validateScenes(scenes: ScriptScene[]): string | undefined {
  if (!scenes.length) return 'Add at least one scene'
  const empty = scenes.findIndex((s) => !s.narration.trim())
  if (empty >= 0) return `Scene ${empty + 1} has no narration`
  const bad = scenes.findIndex((s) => s.footage.some((f) => !(f.end > f.start)))
  if (bad >= 0) return `Scene ${bad + 1} has a footage window that ends before it starts`
  return undefined
}

export function validateBrief(b: Brief): Partial<Record<keyof Brief, string>> {
  const e: Partial<Record<keyof Brief, string>> = {}
  if (!b.title.trim()) e.title = 'Give the video a title'
  if (!b.voice) e.voice = 'Pick a narration voice'
  return e
}

/** Can the user move forward from `step`? */
export function canAdvance(s: WizardState, step: StepId = s.step): { ok: boolean; reason?: string } {
  switch (step) {
    case 'upload': {
      if (s.assets.some((a) => a.status === 'uploading' || a.status === 'processing')) return { ok: false, reason: 'Waiting for uploads to finish processing' }
      if (!readyAssetIds(s).length) return { ok: false, reason: 'Add at least one recording' }
      return { ok: true }
    }
    case 'brief': {
      const errs = validateBrief(s.brief)
      const first = Object.values(errs)[0]
      return first ? { ok: false, reason: first } : { ok: true }
    }
    case 'generate':
      return s.scenes.length ? { ok: true } : { ok: false, reason: 'The script is not ready yet' }
    case 'review': {
      const r = validateScenes(s.scenes)
      return r ? { ok: false, reason: r } : { ok: true }
    }
    case 'assemble':
      return { ok: s.run.status === 'done' && s.run.phase === 'assemble' }
  }
}

/** Furthest step the user may jump to via the stepper. */
export function maxReachableStep(s: WizardState): number {
  const order: StepId[] = ['upload', 'brief', 'generate', 'review', 'assemble']
  let i = 0
  while (i < order.length - 1 && canAdvance(s, order[i]).ok) i++
  // Generate is a process step; if a script exists the user can hop straight to review.
  return i
}

export function moveScene(scenes: ScriptScene[], from: number, to: number): ScriptScene[] {
  if (from === to || from < 0 || to < 0 || from >= scenes.length || to >= scenes.length) return scenes
  const next = scenes.slice()
  const [s] = next.splice(from, 1)
  next.splice(to, 0, s)
  return next
}

let sceneSeq = 0
export function newScene(assetId?: string, after?: ScriptScene): ScriptScene {
  const start = after?.footage[after.footage.length - 1]?.end ?? 0
  return {
    id: `sc_new_${Date.now().toString(36)}_${++sceneSeq}`,
    title: 'New scene',
    headline: '',
    narration: '',
    footage: assetId ? [{ assetId, start, end: start + 5 }] : [],
  }
}

export function insertScene(scenes: ScriptScene[], index: number, scene: ScriptScene): ScriptScene[] {
  const next = scenes.slice()
  next.splice(Math.max(0, Math.min(index, next.length)), 0, scene)
  return next
}

export function updateScene(scenes: ScriptScene[], id: string, patch: Partial<ScriptScene>): ScriptScene[] {
  return scenes.map((s) => (s.id === id ? { ...s, ...patch } : s))
}

export function removeScene(scenes: ScriptScene[], id: string): ScriptScene[] {
  return scenes.filter((s) => s.id !== id)
}

/** Make persisted state safe to resume: interrupted uploads/runs become recoverable states. */
export function sanitizeForResume(s: WizardState): WizardState {
  return {
    ...s,
    assets: s.assets.map((a) => (a.status === 'uploading' && !a.assetId ? { ...a, status: 'error', error: 'Upload was interrupted — add the file again' } : a.status === 'uploading' ? { ...a, status: 'processing' } : a)),
    run: s.run.status === 'running' ? { ...s.run, status: 'idle', interrupted: true, message: 'Interrupted — pick up where you left off' } : s.run,
  }
}

export function storageKey(projectId?: string): string {
  return projectId ? `ps.producer.${projectId}` : 'ps.producer.draft'
}

/** Rebuild wizard state from a saved producer project (resuming from the Library on another device). */
export function stateFromProject(res: ProjectDocResponse): WizardState {
  const { project, summary } = res
  const ai = project.ai ?? {}
  const scenes = ai.script?.scenes ?? []
  const ids = new Set<string>()
  for (const sc of scenes) for (const f of sc.footage) ids.add(f.assetId)
  for (const a of Object.values(project.assets ?? {})) if (a.kind === 'video' && !ids.size) ids.add(a.id)
  const assets: WizardAsset[] = [...ids].map((id) => {
    const a = project.assets?.[id]
    return { localId: id, assetId: id, name: a?.name ?? 'Recording', size: a?.sizeBytes ?? 0, status: 'ready', progress: 1, duration: a?.duration }
  })
  const brief: Brief = ai.brief ?? { ...defaultBrief(), title: summary.name }
  const status = ai.status
  const step: StepId = status === 'assembled' ? 'assemble' : scenes.length ? 'review' : assets.length ? 'brief' : 'upload'
  return {
    step,
    projectId: summary.id,
    workspaceId: summary.workspaceId,
    assets,
    brief,
    scenes,
    transcribed: status && status !== 'draft' ? [...ids] : [],
    run: status === 'assembled' ? { status: 'done', phase: 'assemble', message: 'Video assembled' } : { status: 'idle' },
  }
}
