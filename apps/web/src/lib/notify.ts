// Browser notifications for finished work (A-8), shared by exports (editor/exportJobs.ts) and the shell's job notices
// (shell/jobNotices.ts). They follow the account's choice (Account → Notifications, on by default), only show while
// the person isn't looking at this tab, and the browser's permission is asked for once, from a button, on the first
// long job.
import { DEFAULT_NOTIFICATIONS, type NotificationPrefs } from '@producer/core'
import { accountApi } from './accountApi'
import { onUserReset } from './session'

let prefs: NotificationPrefs | undefined
let loading: Promise<NotificationPrefs> | undefined

/** The account's notification choices (read once per sign-in; the Account page keeps them current). */
export function notifyPrefs(): Promise<NotificationPrefs> {
  if (prefs) return Promise.resolve(prefs)
  loading ??= accountApi
    .get()
    .then((a) => (prefs = a.notifications))
    .catch(() => ({ ...DEFAULT_NOTIFICATIONS }))
    .finally(() => {
      loading = undefined
    })
  return loading
}

/** The choices if already read (undefined: not yet). */
export const knownNotifyPrefs = (): NotificationPrefs | undefined => prefs

export function setNotifyPrefs(p: NotificationPrefs) {
  prefs = p
}

const announced = new Set<string>()

/** First caller for a job wins: exports announce themselves, and the shell's notices leave those alone. */
export function claimJobNotice(jobId: string): boolean {
  if (announced.has(jobId)) return false
  announced.add(jobId)
  return true
}

onUserReset(() => {
  prefs = undefined
  announced.clear()
})

export const notificationsSupported = () => typeof Notification !== 'undefined'

/** A system notification, only when allowed, chosen, and the person isn't looking at this tab. */
export async function browserNotify(title: string, body: string, onClick: () => void, tag = 'producer-job') {
  if (!notificationsSupported() || Notification.permission !== 'granted') return
  if (typeof document !== 'undefined' && document.visibilityState === 'visible' && document.hasFocus()) return
  if (!(await notifyPrefs()).browser) return
  try {
    const n = new Notification(title, { body, tag })
    n.onclick = () => {
      window.focus()
      onClick()
      n.close()
    }
  } catch {
    /* some browsers only allow notifications from a service worker */
  }
}

const ASKED_KEY = 'ps.notifyAsked'

/**
 * Whether to offer browser notifications now: the browser hasn't been asked yet, this browser wasn't offered before,
 * and the account wants them. Marks the offer as made.
 */
export async function shouldOfferNotifications(): Promise<boolean> {
  if (!notificationsSupported() || Notification.permission !== 'default') return false
  try {
    if (localStorage.getItem(ASKED_KEY)) return false
    localStorage.setItem(ASKED_KEY, '1')
  } catch {
    /* private window: offer anyway */
  }
  return (await notifyPrefs()).browser
}

/** Ask the browser (from a click). */
export function requestNotifications(): Promise<NotificationPermission | undefined> {
  if (!notificationsSupported() || Notification.permission !== 'default') return Promise.resolve(notificationsSupported() ? Notification.permission : undefined)
  try {
    return Promise.resolve(Notification.requestPermission()).catch(() => undefined)
  } catch {
    return Promise.resolve(undefined)
  }
}
