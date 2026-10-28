import { create } from 'zustand'

export interface Toast {
  id: number
  text: string
  kind: 'info' | 'error'
}

interface ToastState {
  toasts: Toast[]
  push: (text: string, kind?: Toast['kind']) => void
}

let n = 0
export const useToasts = create<ToastState>((set) => ({
  toasts: [],
  push(text, kind = 'info') {
    const id = ++n
    set((s) => ({ toasts: [...s.toasts, { id, text, kind }] }))
    setTimeout(() => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), kind === 'error' ? 6000 : 3500)
  },
}))

export const toast = (text: string) => useToasts.getState().push(text)
/** An error toast; `what` names what failed ("Couldn’t cancel the export"). */
export const toastError = (e: unknown, what?: string) => {
  const msg = e instanceof Error ? e.message : String(e)
  useToasts.getState().push(what ? `${what}: ${msg}` : msg, 'error')
}
