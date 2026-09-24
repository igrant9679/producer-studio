// Producer Studio editor: top bar, left rail + asset panel, canvas, properties, timeline.
import { ChevronsLeft, Loader2, TriangleAlert, Upload } from 'lucide-react'
import { Component, useEffect, useState, type ReactNode } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { HttpError } from '../lib/api'
import { toast, toastError } from '../lib/toast'
import { Canvas } from './Canvas'
import { ExportDialog, ShortcutsDialog } from './Dialogs'
import './editor.css'
import { AssetPanel, LeftRail } from './LeftPanel'
import { isFileDrag } from './media'
import { flush, keepBoth, loadInto, onProjectEvent, overwriteServer, reloadTheirs, startAutosave } from './persistence'
import { startPlaybackClock } from './playback'
import { PropertiesPanel } from './PropertiesPanel'
import { useShortcuts } from './shortcuts'
import { useEditor } from './store'
import { Timeline } from './Timeline'
import { TopBar } from './TopBar'
import { loadLibrary, subscribeWorkspace, uploadFiles } from './uploads'

export function EditorPage({ demo = false }: { demo?: boolean }) {
  const params = useParams()
  const id = demo ? 'demo' : params.projectId ?? ''
  const loaded = useEditor((s) => s.loaded && s.projectId === id)
  const name = useEditor((s) => s.project.name)
  const workspaceId = useEditor((s) => s.workspaceId)
  const [error, setError] = useState<{ msg: string; code?: number } | null>(null)

  useEffect(() => {
    setError(null)
    useEditor.setState({ loaded: false })
    loadInto(id, demo).catch((e) => setError({ msg: e instanceof Error ? e.message : String(e), code: e instanceof HttpError ? e.status : undefined }))
    return () => {
      void flush().catch(() => undefined)
    }
  }, [id, demo])

  useEffect(() => startPlaybackClock(), [])
  useEffect(() => startAutosave(), [])
  useShortcuts()

  useEffect(() => {
    if (!loaded) return
    document.title = `${name || 'Untitled'} · Producer Studio`
  }, [loaded, name])

  useEffect(() => {
    if (demo || !workspaceId) return
    void loadLibrary(workspaceId)
    return subscribeWorkspace(workspaceId, (ev) => void onProjectEvent(ev))
  }, [demo, workspaceId])

  if (error)
    return (
      <div className="ed-fatal">
        <TriangleAlert size={28} color="var(--danger)" />
        <h2>{error.code === 404 ? 'Project not found' : error.code === 403 ? 'No access to this project' : 'Could not open the project'}</h2>
        <p className="muted">{error.msg}</p>
        <div className="row">
          <Link className="btn" to="/">Back to home</Link>
          <Link className="btn primary" to="/edit/demo">Open the demo</Link>
        </div>
      </div>
    )
  if (!loaded)
    return (
      <div className="ed-fatal">
        <Loader2 size={22} className="spin" />
        <p className="muted">Opening project…</p>
      </div>
    )
  return (
    <EditorErrorBoundary>
      <EditorShell />
    </EditorErrorBoundary>
  )
}

class EditorErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null }
  static getDerivedStateFromError(error: Error) {
    return { error }
  }
  componentDidCatch(error: Error) {
    console.error('Editor crashed', error)
    // keep the user's work: push whatever is in memory to storage/server
    void flush().catch(() => undefined)
  }
  render() {
    if (!this.state.error) return this.props.children
    return (
      <div className="ed-fatal">
        <TriangleAlert size={28} color="var(--danger)" />
        <h2>The editor hit a problem</h2>
        <p className="muted">{this.state.error.message}. Your last changes were saved where possible.</p>
        <div className="row">
          <button className="btn" onClick={() => this.setState({ error: null })}>Try again</button>
          <button className="btn primary" onClick={() => location.reload()}>Reload editor</button>
        </div>
      </div>
    )
  }
}

function EditorShell() {
  const exportOpen = useEditor((s) => s.exportOpen)
  const shortcutsOpen = useEditor((s) => s.shortcutsOpen)
  const rightCollapsed = useEditor((s) => s.rightCollapsed)
  const leftCollapsed = useEditor((s) => s.leftCollapsed)
  const saveState = useEditor((s) => s.saveState)
  const [fileDrag, setFileDrag] = useState(false)

  useEffect(() => {
    let depth = 0
    const enter = (e: DragEvent) => {
      if (!isFileDrag(e)) return
      depth++
      setFileDrag(true)
    }
    const leave = (e: DragEvent) => {
      if (!isFileDrag(e)) return
      depth = Math.max(0, depth - 1)
      if (!depth) setFileDrag(false)
    }
    const over = (e: DragEvent) => {
      if (isFileDrag(e)) e.preventDefault()
    }
    const drop = (e: DragEvent) => {
      if (!isFileDrag(e)) return
      e.preventDefault()
      depth = 0
      setFileDrag(false)
      if (e.dataTransfer?.files.length) {
        useEditor.setState({ activeLeftTab: 'media', leftCollapsed: false })
        void uploadFiles(e.dataTransfer.files).catch(toastError)
      }
    }
    window.addEventListener('dragenter', enter)
    window.addEventListener('dragleave', leave)
    window.addEventListener('dragover', over)
    window.addEventListener('drop', drop)
    return () => {
      window.removeEventListener('dragenter', enter)
      window.removeEventListener('dragleave', leave)
      window.removeEventListener('dragover', over)
      window.removeEventListener('drop', drop)
    }
  }, [])

  return (
    <div className={`ed-root${leftCollapsed ? ' left-collapsed' : ''}`}>
      <TopBar />
      {saveState === 'conflict' && <ConflictBanner />}
      <div className="ed-body">
        <LeftRail />
        <AssetPanel />
        <div className="ed-work">
          <div className="ed-stagebar">
            <div className="ed-center">
              <Canvas />
            </div>
            {rightCollapsed ? (
              <button className="ed-expand" title="Show properties" onClick={() => useEditor.setState({ rightCollapsed: false })}>
                <ChevronsLeft size={14} />
                <span>Properties</span>
              </button>
            ) : (
              <PropertiesPanel />
            )}
          </div>
          <Timeline />
        </div>
      </div>
      {exportOpen && <ExportDialog />}
      {shortcutsOpen && <ShortcutsDialog />}
      {fileDrag && (
        <div className="ed-filedrop">
          <div>
            <Upload size={28} />
            <b>Drop to upload</b>
            <span>Video, audio and images are added to your media library</span>
          </div>
        </div>
      )}
    </div>
  )
}

function ConflictBanner() {
  const [busy, setBusy] = useState(false)
  const nav = useNavigate()
  const run = (fn: () => Promise<void>) => async () => {
    setBusy(true)
    try {
      await fn()
    } catch (e) {
      toastError(e)
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="ed-banner">
      <TriangleAlert size={15} />
      <span>This project was saved somewhere else (another tab, teammate or device) while you had unsaved edits.</span>
      <div className="spacer" />
      <button className="btn sm" disabled={busy} onClick={run(reloadTheirs)} title="Discard your unsaved edits and load the other version">Reload theirs</button>
      <button className="btn sm" disabled={busy} onClick={run(overwriteServer)} title="Replace the other version with yours">Overwrite with mine</button>
      <button
        className="btn sm primary"
        disabled={busy}
        title="Save your version as a separate conflicted copy and open it"
        onClick={run(async () => {
          const id = await keepBoth()
          toast('Saved your version as a conflicted copy')
          nav(`/edit/${id}`)
        })}
      >
        Keep both
      </button>
    </div>
  )
}
