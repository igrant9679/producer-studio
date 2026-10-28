import { create } from 'zustand'

export interface ToastAction {
  label: string
  run: () => void
}

export interface Toast {
  id: number
  text: string
  kind: 'info' | 'error'
  /** A button on the toast ("Open"); the toast stays longer so there is time to use it. */
  action?: ToastAction
}

interface ToastState {
  toasts: Toast[]
  push: (text: string, kind?: Toast['kind'], action?: ToastAction) => void
  dismiss: (id: number) => void
}

let n = 0
export const useToasts = create<ToastState>((set) => ({
  toasts: [],
  push(text, kind = 'info', action) {
    const id = ++n
    set((s) => ({ toasts: [...s.toasts, { id, text, kind, action }] }))
    setTimeout(() => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), action ? 10000 : kind === 'error' ? 6000 : 3500)
  },
  dismiss(id) {
    set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }))
  },
}))

export const toast = (text: string, action?: ToastAction) => useToasts.getState().push(text, 'info', action)
/** An error toast; `what` names what failed ("Couldn’t cancel the export"). */
export const toastError = (e: unknown, what?: string, action?: ToastAction) => {
  const msg = e instanceof Error ? e.message : String(e)
  useToasts.getState().push(what ? `${what}: ${msg}` : msg, 'error', action)
}
