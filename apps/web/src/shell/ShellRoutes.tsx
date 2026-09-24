import { AlertTriangle, RotateCcw } from 'lucide-react'
import { Component, lazy, Suspense, type ErrorInfo, type ReactNode } from 'react'
import { Navigate, Route, Routes, useLocation } from 'react-router-dom'
import './dev/installMock'
import './shell.css'
import './pages.css'
import { Layout } from './Layout'
import { EmptyState, Spinner } from './ui'

const HomePage = lazy(() => import('./pages/HomePage'))
const EditorHome = lazy(() => import('./pages/EditorHome'))
const ProducerWizard = lazy(() => import('./producer/ProducerWizard'))
const VoiceStudio = lazy(() => import('./pages/VoiceStudio'))
const TemplatesPage = lazy(() => import('./pages/TemplatesPage'))
const LibraryPage = lazy(() => import('./pages/LibraryPage'))
const ToolsPage = lazy(() => import('./pages/ToolsPage'))
const BrandPage = lazy(() => import('./pages/BrandPage'))
const SpacePage = lazy(() => import('./pages/SpacePage'))
const ExportsPage = lazy(() => import('./pages/ExportsPage'))
const SettingsPage = lazy(() => import('./pages/SettingsPage'))
const NotFound = lazy(() => import('./pages/NotFound'))

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
            <Route path="producer/new" element={<ProducerWizard />} />
            <Route path="producer/:projectId" element={<ProducerWizard />} />
            <Route path="voice" element={<VoiceStudio />} />
            <Route path="templates" element={<TemplatesPage />} />
            <Route path="library" element={<LibraryPage />} />
            <Route path="tools" element={<ToolsPage />} />
            <Route path="brand" element={<BrandPage />} />
            <Route path="space" element={<SpacePage />} />
            <Route path="exports" element={<ExportsPage />} />
            <Route path="settings" element={<SettingsPage />} />
            <Route path="*" element={<NotFound />} />
          </Routes>
        </Suspense>
      </PageBoundary>
    </Layout>
  )
}
