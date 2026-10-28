// The toast stack (bottom of the screen): one polite live region, each toast with its buttons (Open, Retry, Undo)
// and a close button. Escape closes the toast the focus is in.
import { X } from 'lucide-react'
import { useToasts } from './toast'

export function Toasts() {
  const toasts = useToasts((s) => s.toasts)
  const dismiss = useToasts((s) => s.dismiss)
  return (
    <div className="toast-host" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={`toast ${t.kind === 'error' ? 'error' : ''}`}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.stopPropagation()
              dismiss(t.id)
            }
          }}
        >
          {t.text}
          {(t.actions ?? (t.action ? [t.action] : [])).map((a) => (
            <button
              key={a.label}
              type="button"
              className="toast-action"
              onClick={() => {
                dismiss(t.id)
                a.run()
              }}
            >
              {a.label}
            </button>
          ))}
          {!!t.actions?.length && (
            <button type="button" className="toast-action" aria-label="Dismiss" onClick={() => dismiss(t.id)}>
              <X size={12} />
            </button>
          )}
        </div>
      ))}
    </div>
  )
}
