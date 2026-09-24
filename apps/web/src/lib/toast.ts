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
export const toastError = (e: unknown) => useToasts.getState().push(e instanceof Error ? e.message : String(e), 'error')
