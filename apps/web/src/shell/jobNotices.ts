// A-8: when a long job you started ends (Producer AI, a transcription, a voiceover, a smart tool), say so wherever you
// are in the app: a toast with Open, and a browser notification while the tab is in the background. Exports announce
// themselves (editor/exportJobs.ts, with Retry). A failed job's toast has Retry too (the job history's retry route).
// The first long job offers to turn browser notifications on.
import { NOTIFY_JOB_KINDS, type Job } from '@producer/core'
import { useEffect, useRef } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { browserNotify, claimJobNotice, requestNotifications, shouldOfferNotifications } from '../lib/notify'
import { useSession } from '../lib/session'
import { toast, toastError, type ToastAction } from '../lib/toast'
import { usageApi } from '../lib/usageApi'
import { isActive, liveBus } from './stores'
import { JOB_LABELS } from './util'

const DONE: Partial<Record<Job['kind'], string>> = {
  'ai.produce.script': 'Producer AI wrote the script',
  'ai.produce.assemble': 'Your Producer AI video is ready',
  'ai.transcribe': 'Transcript ready',
  'ai.tts': 'Voiceover ready',
  'media.stabilise': 'Stabilised copy ready',
  'media.denoise': 'Denoised copy ready',
  'media.bgremove': 'Background removed',
  'media.smooth': 'Smooth slow motion ready',
  'voicestudio.install': 'VoiceStudio is installed',
}

/** Where Open goes for a job. */
export function jobTarget(j: Pick<Job, 'kind' | 'projectId'>): string {
  if (j.kind === 'voicestudio.install') return '/voice'
  if (!j.projectId) return '/library'
  if (j.kind.startsWith('ai.produce')) return `/producer/${j.projectId}`
  return `/edit/${j.projectId}`
}

const LONG = new Set<string>(NOTIFY_JOB_KINDS.filter((k) => k !== 'export.render'))

/** Which jobs this tab watched run: only those are announced when they end (not a reload's old ones). */
const watching = new Set<string>()

export function useJobNotices() {
  const me = useSession((s) => s.user?.id)
  const navigate = useNavigate()
  const loc = useLocation()
  const here = useRef(loc.pathname)
  here.current = loc.pathname
  useEffect(() => {
    if (!me) return
    return liveBus.onJob((j) => {
      if (j.startedBy !== me || !LONG.has(j.kind)) return
      if (isActive(j)) {
        if (watching.has(j.id)) return
        watching.add(j.id)
        void shouldOfferNotifications().then((offer) => {
          if (offer)
            toast('Get a browser notification when long jobs finish?', [
              { label: 'Turn on', run: () => void requestNotifications() },
              { label: 'Not now', run: () => undefined },
            ])
        })
        return
      }
      if (!watching.delete(j.id) || j.status === 'cancelled' || !claimJobNotice(j.id)) return
      const target = jobTarget(j)
      const open = () => navigate(target)
      const label = JOB_LABELS[j.kind] ?? j.kind
      if (j.status === 'done') {
        const text = DONE[j.kind] ?? `${label}: done`
        // already looking at it: the page shows the result itself
        if (here.current !== target) toast(text, { label: 'Open', run: open })
        void browserNotify(text, 'Producer Studio', open)
      } else {
        const actions: ToastAction[] = [{ label: 'Open', run: open }]
        // Voice Studio's own jobs are run again from Voice Studio on the desktop; the server refuses those
        if (!j.kind.startsWith('voicestudio.'))
          actions.push({
            label: 'Retry',
            run: () => void usageApi.retryJob(j.id).then(() => toast(`${label}: queued again`), (e) => toastError(e, `Couldn’t retry ${label.toLowerCase()}`)),
          })
        toastError(j.error || 'It stopped with an error', `${label} failed`, actions)
        void browserNotify(`${label} failed`, j.error || 'Open Producer Studio to try again.', open)
      }
    })
  }, [me, navigate])
}
