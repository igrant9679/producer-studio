import { Suspense, lazy, useRef } from 'react'
import { Navigate, Route, Routes, useLocation } from 'react-router-dom'
import { useSession } from './lib/session'
import { Toasts } from './lib/Toasts'
import { TooltipLayer } from './lib/tooltip'
import { AuthPage } from './shell/AuthPage'
import { ForgotPage, ResetPage, VerifyPage } from './shell/AccountAuthPages'
import { AppErrorBoundary, EditorSkeleton, ShellSkeleton, SmallScreenNote } from './shell/boot'
import { ShellRoutes } from './shell/ShellRoutes'
import { SharePage } from './shell/SharePage'

const DictationWidget = lazy(() => import('./shell/voicestudio/Dictation'))
/** The editor is its own download: shell pages don't wait for it, and main.tsx starts it early on /edit links. */
export const loadEditor = () => import('./editor/EditorPage')
const EditorPage = lazy(() => loadEditor().then((m) => ({ default: m.EditorPage })))

/**
 * Signed-in pages. While the sign-in check is out the app shell shows with placeholders; signed out sends to sign-in
 * with `next`. `keepWhenSignedOut` (the editor): a session that ends while it's open leaves it on screen, so its
 * unsaved changes survive and its own banner offers to sign in again in another tab.
 */
function RequireAuth({ children, fallback = <ShellSkeleton />, keepWhenSignedOut }: { children: React.ReactNode; fallback?: React.ReactNode; keepWhenSignedOut?: boolean }) {
  const status = useSession((s) => s.status)
  const loc = useLocation()
  const wasReady = useRef(false)
  if (status === 'ready') wasReady.current = true
  if (status === 'loading') return <>{fallback}</>
  if (status === 'anon' && !(keepWhenSignedOut && wasReady.current)) return <Navigate to={`/login?next=${encodeURIComponent(loc.pathname + loc.search)}`} replace />
  return <>{children}</>
}

// The sign-in check starts in main.tsx, before React mounts.
export function App() {
  return (
    <AppErrorBoundary>
      <Routes>
        <Route path="/login" element={<AuthPage mode="login" />} />
        <Route path="/signup" element={<AuthPage mode="signup" />} />
        <Route path="/forgot" element={<ForgotPage />} />
        <Route path="/reset/:token" element={<ResetPage />} />
        <Route path="/verify/:token" element={<VerifyPage />} />
        <Route path="/r/:token" element={<SharePage />} />
        {/* Offline demo project (bundled media in /public/demo) for editor development without the API. */}
        <Route path="/edit/demo" element={<Suspense fallback={<EditorSkeleton />}><EditorPage demo /><SmallScreenNote /></Suspense>} />
        {/* Desktop: the floating system-wide dictation bar (its own frameless window). */}
        <Route path="/dictate" element={<RequireAuth fallback={null}><Suspense fallback={null}><DictationWidget /></Suspense></RequireAuth>} />
        <Route
          path="/edit/:projectId"
          element={
            <RequireAuth fallback={<EditorSkeleton />} keepWhenSignedOut>
              <Suspense fallback={<EditorSkeleton />}>
                <EditorPage />
                <SmallScreenNote />
              </Suspense>
            </RequireAuth>
          }
        />
        <Route path="/*" element={<RequireAuth><ShellRoutes /></RequireAuth>} />
      </Routes>
      <Toasts />
      <TooltipLayer />
    </AppErrorBoundary>
  )
}
