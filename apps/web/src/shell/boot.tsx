// What shows before a page can: the app shell with placeholders while the sign-in check and the page's code load,
// the app-wide error screen, and the editor's note on a phone.
import { AlertTriangle, MonitorSmartphone, RotateCcw, X } from 'lucide-react'
import { Component, useState, type ErrorInfo, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import './shell.css'
import { CardSkeletons, EmptyState, Logo } from './ui'

/** The sidebar, logo and top bar, with placeholders where the page goes. */
export function ShellSkeleton() {
  return (
    <div className="ps-app" role="status" aria-label="Loading Producer Studio">
      <nav className="ps-nav" aria-hidden>
        <div className="ps-nav-head">
          <Logo />
        </div>
        <div className="ps-nav-scroll">
          <div className="skeleton" style={{ height: 44, borderRadius: 12 }} />
          {[62, 80, 70, 58, 76, 66, 84, 60, 72].map((w, i) => (
            <div key={i} className="skeleton" style={{ height: 12, width: `${w}%`, margin: '22px 10px 0' }} />
          ))}
        </div>
      </nav>
      <div className="ps-main" aria-hidden>
        <header className="ps-topbar">
          <div className="skeleton ps-boot-search" />
          <span className="spacer" />
          <div className="skeleton" style={{ width: 32, height: 32, borderRadius: 999 }} />
        </header>
        <main className="ps-content">
          <div className="ps-page">
            <div className="skeleton" style={{ height: 12, width: 90 }} />
            <div className="skeleton" style={{ height: 30, width: 'min(320px, 80%)', marginTop: 12 }} />
            <div className="ps-grid" style={{ marginTop: 30 }}>
              <CardSkeletons n={8} />
            </div>
          </div>
        </main>
      </div>
    </div>
  )
}

/** The editor's frame while its code and the sign-in check load. */
export function EditorSkeleton() {
  return (
    <div className="ps-boot-editor" role="status" aria-label="Opening the editor">
      <div className="ps-boot-editor-top">
        <Logo compact />
        <div className="skeleton" style={{ height: 14, width: 180 }} />
      </div>
    </div>
  )
}

/** A crash outside the shell's own page boundary (sign-in, share page, editor shell): say so, offer a way out. */
export class AppErrorBoundary extends Component<{ children: ReactNode }, { error?: Error }> {
  state: { error?: Error } = {}
  static getDerivedStateFromError(error: Error) {
    return { error }
  }
  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[app] crashed', error, info.componentStack)
  }
  render() {
    if (!this.state.error) return this.props.children
    const chunk = /dynamically imported module|Loading chunk|Importing a module script failed/i.test(this.state.error.message)
    return (
      <div className="ps-page narrow" style={{ paddingTop: 90 }} role="alert">
        <EmptyState
          icon={<AlertTriangle size={24} />}
          title={chunk ? 'A new version is available' : 'Something went wrong'}
          body={chunk ? 'Reload to get the latest Producer Studio.' : 'Reload the page, or head back home. Saved work is safe.'}
          action={
            <div className="row">
              <button className="btn primary" onClick={() => window.location.reload()}>
                <RotateCcw size={14} /> Reload
              </button>
              <a className="btn" href="/">Home</a>
            </div>
          }
        />
      </div>
    )
  }
}

/** On a phone the editor fits the screen but is cramped: say so once, with a way back to the rest of the app. */
export function SmallScreenNote() {
  const [hidden, setHidden] = useState(false)
  if (hidden) return null
  return (
    <div className="ps-small-note" role="note">
      <MonitorSmartphone size={16} style={{ flex: 'none' }} />
      <span>Editing works best on a larger screen. On this one you can look through the project.</span>
      <Link className="btn sm" to="/library">Library</Link>
      <button className="btn ghost sm icon" onClick={() => setHidden(true)} aria-label="Dismiss">
        <X size={14} />
      </button>
    </div>
  )
}
