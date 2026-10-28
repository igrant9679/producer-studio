import { AlertTriangle, Lock, RotateCcw } from 'lucide-react'
import { Component, lazy, Suspense, type ErrorInfo, type ReactNode } from 'react'
import { Link, Navigate, Route, Routes, useLocation } from 'react-router-dom'
import './dev/installMock'
import './shell.css'
import './pages.css'
import './voicestudio/voicestudio.css'
import { Layout } from './Layout'
import { EmptyState, Spinner, useEditGate } from './ui'

// Each page's code, by the first segment of its path. main.tsx starts the current page's download while the
// sign-in check is still out (preloadRoute), and React.lazy picks up the same module.
const pages = {
  '': () => import('./pages/HomePage'),
  editor: () => import('./pages/EditorHome'),
  producer: () => import('./producer/ProducerWizard'),
  voice: () => import('./pages/VoiceStudio'),
  templates: () => import('./pages/TemplatesPage'),
  library: () => import('./pages/LibraryPage'),
  tools: () => import('./pages/ToolsPage'),
  brand: () => import('./pages/BrandPage'),
  space: () => import('./pages/SpacePage'),
  exports: () => import('./pages/ExportsPage'),
  activity: () => import('./pages/ActivityPage'),
  settings: () => import('./pages/SettingsPage'),
  invite: () => import('./pages/InvitePage'),
  account: () => import('./pages/AccountPage'),
}

/** Start loading the code for the shell page at `pathname` (no-op for paths that aren't shell pages). */
export function preloadRoute(pathname: string) {
  const seg = pathname.split('/')[1] ?? ''
  const load = pages[seg as keyof typeof pages]
  if (load) void load().catch(() => undefined)
}

const HomePage = lazy(pages[''])
const EditorHome = lazy(pages.editor)
const ProducerWizard = lazy(pages.producer)
const VoiceStudio = lazy(pages.voice)
const TemplatesPage = lazy(pages.templates)
const LibraryPage = lazy(pages.library)
const ToolsPage = lazy(pages.tools)
const BrandPage = lazy(pages.brand)
const SpacePage = lazy(pages.space)
const ExportsPage = lazy(pages.exports)
const ActivityPage = lazy(pages.activity)
const SettingsPage = lazy(pages.settings)
const InvitePage = lazy(pages.invite)
const AccountPage = lazy(pages.account)
const NotFound = lazy(() => import('./pages/NotFound'))

/** Producer AI only makes new things: a viewer gets who can use it instead of a wizard that fails at the end. */
function RequireEdit({ children, what }: { children: ReactNode; what: string }) {
  const gate = useEditGate()
  if (gate.canEdit) return <>{children}</>
  return (
    <div className="ps-page narrow" style={{ paddingTop: 70 }}>
      <EmptyState icon={<Lock size={24} />} title={`${what} needs an editor`} body={gate.tip} action={<Link className="btn" to="/library">Open the Library</Link>} />
    </div>
  )
}

function PageFallback() {
  return (
    <div style={{ display: 'grid', placeItems: 'center', height: '60vh' }} className="muted">
      <Spinner size={22} />
    </div>
  )
}

/** Keeps the nav usable when a page throws; resets when the route changes. */
class PageBoundary extends Component<{ children: ReactNode; resetKey: string }, { error?: Error }> {
  state: { error?: Error } = {}
  static getDerivedStateFromError(error: Error) {
    return { error }
  }
  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[shell] page crashed', error, info.componentStack)
  }
  componentDidUpdate(prev: { resetKey: string }) {
    if (prev.resetKey !== this.props.resetKey && this.state.error) this.setState({ error: undefined })
  }
  render() {
    if (!this.state.error) return this.props.children
    const chunk = /dynamically imported module|Loading chunk/i.test(this.state.error.message)
    return (
      <div className="ps-page narrow" style={{ paddingTop: 70 }}>
        <EmptyState
          icon={<AlertTriangle size={24} />}
          title={chunk ? 'A new version is available' : 'This page hit a problem'}
          body={chunk ? 'Reload to get the latest Producer Studio.' : 'Your work is saved. Try again, or head back home.'}
          action={
            <div className="row">
              <button className="btn primary" onClick={() => (chunk ? window.location.reload() : this.setState({ error: undefined }))}><RotateCcw size={14} /> {chunk ? 'Reload' : 'Try again'}</button>
              <a className="btn" href="/">Home</a>
            </div>
          }
        />
      </div>
    )
  }
}

export function ShellRoutes() {
  const loc = useLocation()
  return (
    <Layout>
      <PageBoundary resetKey={loc.pathname}>
        <Suspense fallback={<PageFallback />}>
          <Routes>
            <Route index element={<HomePage />} />
            <Route path="editor" element={<EditorHome />} />
            <Route path="producer" element={<Navigate to="/producer/new" replace />} />
            <Route path="producer/new" element={<RequireEdit what="Producer AI"><ProducerWizard /></RequireEdit>} />
            <Route path="producer/:projectId" element={<RequireEdit what="Producer AI"><ProducerWizard /></RequireEdit>} />
            <Route path="voice" element={<VoiceStudio />} />
            <Route path="templates" element={<TemplatesPage />} />
            <Route path="library" element={<LibraryPage />} />
            <Route path="tools" element={<ToolsPage />} />
            <Route path="brand" element={<BrandPage />} />
            <Route path="space" element={<SpacePage />} />
            <Route path="exports" element={<ExportsPage />} />
            <Route path="activity" element={<ActivityPage />} />
            <Route path="settings" element={<SettingsPage />} />
            <Route path="invite/:token" element={<InvitePage />} />
            <Route path="account" element={<AccountPage />} />
            <Route path="*" element={<NotFound />} />
          </Routes>
        </Suspense>
      </PageBoundary>
    </Layout>
  )
}
