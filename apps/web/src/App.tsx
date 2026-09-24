import { useEffect } from 'react'
import { Navigate, Route, Routes, useLocation } from 'react-router-dom'
import { EditorPage } from './editor/EditorPage'
import { useSession } from './lib/session'
import { useToasts } from './lib/toast'
import { AuthPage } from './shell/AuthPage'
import { ShellRoutes } from './shell/ShellRoutes'
import { SharePage } from './shell/SharePage'

function RequireAuth({ children }: { children: React.ReactNode }) {
  const status = useSession((s) => s.status)
  const loc = useLocation()
  if (status === 'loading') return <div style={{ display: 'grid', placeItems: 'center', height: '100%' }} className="muted">Loading…</div>
  if (status === 'anon') return <Navigate to={`/login?next=${encodeURIComponent(loc.pathname + loc.search)}`} replace />
  return <>{children}</>
}

function Toasts() {
  const toasts = useToasts((s) => s.toasts)
  return (
    <div className="toast-host" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.kind === 'error' ? 'error' : ''}`}>{t.text}</div>
      ))}
    </div>
  )
}

export function App() {
  const load = useSession((s) => s.load)
  useEffect(() => {
    void load()
  }, [load])
  return (
    <>
      <Routes>
        <Route path="/login" element={<AuthPage mode="login" />} />
        <Route path="/signup" element={<AuthPage mode="signup" />} />
        <Route path="/r/:token" element={<SharePage />} />
        {/* Offline demo project (bundled media in /public/demo) for editor development without the API. */}
        <Route path="/edit/demo" element={<EditorPage demo />} />
        <Route path="/edit/:projectId" element={<RequireAuth><EditorPage /></RequireAuth>} />
        <Route path="/*" element={<RequireAuth><ShellRoutes /></RequireAuth>} />
      </Routes>
      <Toasts />
    </>
  )
}
