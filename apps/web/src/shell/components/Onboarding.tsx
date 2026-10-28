// The Home checklist for a new space (A-6): four steps ticked from what the space really holds, refreshed as things
// change, a link to the sample project, and Hide (kept per person and space). Viewers, who can't do the steps, don't
// see it.
import type { OnboardingState, OnboardingStepId } from '@producer/core'
import { ONBOARDING_STEPS, onboardingProgress } from '@producer/core'
import clsx from 'clsx'
import { Check, Circle, Clapperboard, X } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { api } from '../../lib/api'
import { useSession } from '../../lib/session'
import { onboardingApi } from '../../lib/studioApi'
import { toast, toastError } from '../../lib/toast'
import { liveBus } from '../stores'
import { Progress, Spinner, useEditGate, useFilePicker } from '../ui'
import './onboarding.css'

export function OnboardingChecklist() {
  const workspaceId = useSession((s) => s.workspaceId)
  const ws = useSession((s) => s.workspaces.find((w) => w.id === s.workspaceId))
  const gate = useEditGate()
  const navigate = useNavigate()
  const [state, setState] = useState<{ ws: string; s: OnboardingState }>()
  const [uploading, setUploading] = useState(false)

  const load = useCallback(() => {
    if (!workspaceId) return
    onboardingApi
      .get(workspaceId)
      .then((s) => setState({ ws: workspaceId, s }))
      // an older server, or a failed read: no checklist rather than a wrong one
      .catch(() => undefined)
  }, [workspaceId])

  useEffect(() => {
    load()
    if (!workspaceId) return
    // ticks itself: an upload, a Producer video or a kit saved elsewhere refreshes it
    const offA = liveBus.onAsset((a) => a.workspaceId === workspaceId && load())
    const offP = liveBus.onProject(() => load())
    const onFocus = () => document.visibilityState === 'visible' && load()
    document.addEventListener('visibilitychange', onFocus)
    window.addEventListener('focus', onFocus)
    return () => {
      offA()
      offP()
      document.removeEventListener('visibilitychange', onFocus)
      window.removeEventListener('focus', onFocus)
    }
  }, [workspaceId, load])

  const pick = useFilePicker('video/*,audio/*', true, async (files) => {
    if (!workspaceId || !files.length) return
    setUploading(true)
    try {
      for (const f of files) await api.upload(workspaceId, f)
      toast(files.length > 1 ? `${files.length} recordings uploaded to the Library` : `“${files[0].name}” uploaded to the Library`)
      load()
    } catch (e) {
      toastError(e)
    } finally {
      setUploading(false)
    }
  })

  const s = state && state.ws === workspaceId ? state.s : undefined
  if (!s || s.dismissed || !gate.canEdit) return null
  const { done, total } = onboardingProgress(s)
  const all = done === total

  async function hide() {
    if (!workspaceId) return
    const prev = state
    setState((cur) => cur && { ...cur, s: { ...cur.s, dismissed: true } })
    try {
      await onboardingApi.setDismissed(workspaceId, true)
      toast('Checklist hidden for this space')
    } catch (e) {
      setState(prev)
      toastError(e)
    }
  }

  const owner = ws?.role === 'owner'
  const action = (id: OnboardingStepId) => {
    switch (id) {
      case 'upload':
        return (
          <button className="btn sm" onClick={pick} disabled={uploading}>
            {uploading ? <Spinner size={13} /> : null} Upload
          </button>
        )
      case 'brand':
        return <Link className="btn sm" to="/brand">Set up</Link>
      case 'producer':
        return <button className="btn sm" onClick={() => navigate('/producer/new')}>Start</button>
      case 'invite':
        return owner ? <Link className="btn sm" to="/space">Invite</Link> : <span className="muted ps-onb-note">Ask an owner of this space</span>
    }
  }

  return (
    <section className="ps-onb card" aria-labelledby="ps-onb-title">
      <div className="ps-onb-head">
        <div>
          <h2 id="ps-onb-title" className="ps-h2">{all ? 'You’re all set' : 'Get started'}</h2>
          <p className="muted">{all ? 'Every step is done in this space.' : `${done} of ${total} done in ${ws?.name ?? 'this space'}.`}</p>
        </div>
        <span className="spacer" />
        {s.sampleProjectId && (
          <Link className="btn sm" to={`/edit/${s.sampleProjectId}`}><Clapperboard size={13} /> Open the sample project</Link>
        )}
        <button className="btn ghost sm icon" onClick={() => void hide()} aria-label="Hide the checklist" title="Hide the checklist"><X size={14} /></button>
      </div>
      <Progress value={done / total} />
      <ol className="ps-onb-steps">
        {ONBOARDING_STEPS.map((step) => {
          const ok = s.steps[step.id]
          return (
            <li key={step.id} className={clsx('ps-onb-step', ok && 'done')}>
              <span className="ps-onb-mark" aria-hidden>{ok ? <Check size={14} strokeWidth={3} /> : <Circle size={14} />}</span>
              <div className="ps-onb-text">
                <strong>{step.title}<span className="sr-only">{ok ? ' (done)' : ' (to do)'}</span></strong>
                <span>{step.body}</span>
              </div>
              {!ok && action(step.id)}
            </li>
          )
        })}
      </ol>
    </section>
  )
}
