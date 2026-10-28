import { create } from 'zustand'

export interface ToastAction {
  label: string
  run: () => void
}

export interface Toast {
  id: number
  text: string
  kind: 'info' | 'error'
  /** The first button on the toast ("Open"); the toast stays longer so there is time to use it. */
  action?: ToastAction
  /** Every button, in order (Open, Retry, Undo…); `action` is the first of them. */
  actions?: ToastAction[]
}

interface ToastState {
  toasts: Toast[]
  push: (text: string, kind?: Toast['kind'], action?: ToastAction | ToastAction[]) => number
  dismiss: (id: number) => void
}

/** How long a toast stays: longer when it has buttons, so they can be reached by keyboard. */
export const toastMs = (t: Pick<Toast, 'kind' | 'actions'>) => (t.actions?.length ? 10000 : t.kind === 'error' ? 6000 : 3500)

let n = 0
export const useToasts = create<ToastState>((set) => ({
  toasts: [],
  push(text, kind = 'info', action) {
    const id = ++n
    const actions = action ? (Array.isArray(action) ? action : [action]) : undefined
    const t: Toast = { id, text, kind, ...(actions?.length ? { action: actions[0], actions } : {}) }
    set((s) => ({ toasts: [...s.toasts, t] }))
    setTimeout(() => set((s) => ({ toasts: s.toasts.filter((x) => x.id !== id) })), toastMs(t))
    return id
  },
  dismiss(id) {
    set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }))
  },
}))

export const toast = (text: string, action?: ToastAction | ToastAction[]) => useToasts.getState().push(text, 'info', action)
/** An error toast; `what` names what failed ("Couldn’t cancel the export"). */
export const toastError = (e: unknown, what?: string, action?: ToastAction | ToastAction[]) => {
  const msg = e instanceof Error ? e.message : String(e)
  return useToasts.getState().push(what ? `${what}: ${msg}` : msg, 'error', action)
}
