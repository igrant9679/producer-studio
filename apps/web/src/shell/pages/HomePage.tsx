import type { ProjectSummary } from '@producer/core'
import { ArrowRight, ArrowUpRight, AudioLines, Captions, Clapperboard, FileText, FolderOpen, Paperclip, Plus, ScissorsLineDashed, Sparkles, Video, X } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { api } from '../../lib/api'
import { useSession } from '../../lib/session'
import { useCreateAndOpen, type EditorTab } from '../actions'
import { ProjectCard } from '../components/ProjectCard'
import { AspectPickerModal } from '../modals'
import { setProducerHandoff } from '../producer/handoff'
import { CardSkeletons, EmptyState, useAsync, useFilePicker, usePageTitle } from '../ui'
import { formatBytes } from '../util'

export function QuickCard({ icon, title, body, onClick, glow, iconBg, iconFg, soon }: { icon: ReactNode; title: string; body: string; onClick?: () => void; glow?: string; iconBg?: string; iconFg?: string; soon?: boolean }) {
  return (
    <button className={`ps-qcard ${soon ? 'disabled' : ''}`} onClick={soon ? undefined : onClick} style={{ ['--glow' as string]: glow, ['--icon-bg' as string]: iconBg, ['--icon-fg' as string]: iconFg }} aria-disabled={soon}>
      <div className="ps-qcard-icon">{icon}</div>
      <h3>{title}</h3>
      <p>{body}</p>
      {soon && <span className="ps-soon">Coming soon</span>}
    </button>
  )
}

export const CYAN = { glow: 'rgba(53,224,255,.14)', iconBg: 'var(--cyan-soft)', iconFg: 'var(--cyan)' }
export const AMBER = { glow: 'rgba(255,194,77,.14)', iconBg: 'rgba(255,194,77,.14)', iconFg: 'var(--amber)' }
export const GREEN = { glow: 'rgba(61,220,151,.14)', iconBg: 'rgba(61,220,151,.14)', iconFg: 'var(--green)' }
export const VIOLET = { glow: 'rgba(151,117,250,.16)', iconBg: 'rgba(151,117,250,.16)', iconFg: '#b197fc' }

const ASPECTS = ['16:9', '9:16', '1:1'] as const
const IDEAS = ['A 90-second product tour from my screen recording', 'A vertical teaser for our new feature', 'An onboarding walkthrough for new customers']

export function useRecentProjects(limit = 8) {
  const workspaceId = useSession((s) => s.workspaceId)
  return useAsync<ProjectSummary[]>(async () => {
    if (!workspaceId) return []
    const list = await api.projects(workspaceId)
    return list.filter((p) => !p.trashed).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, limit)
  }, [workspaceId, limit])
}

export default function HomePage() {
  usePageTitle('Home')
  const navigate = useNavigate()
  const user = useSession((s) => s.user)
  const [prompt, setPrompt] = useState('')
  const [aspect, setAspect] = useState<(typeof ASPECTS)[number]>('16:9')
  const [files, setFiles] = useState<File[]>([])
  const [aspectModal, setAspectModal] = useState(false)
  const [create, creating] = useCreateAndOpen()
  const recent = useRecentProjects(8)
  const pick = useFilePicker('video/*', true, (f) => setFiles((cur) => [...cur, ...f]))

  function makeIt() {
    setProducerHandoff({ prompt: prompt.trim(), aspect, files })
    navigate('/producer/new')
  }

  const tool = (tab: EditorTab, name: string) => () => void create({ tab, name })
  const first = user?.name?.split(' ')[0]

  return (
    <div className="ps-page">
      <section className="ps-hero">
        <span className="eyebrow">{first ? `Good to see you, ${first}` : 'Producer Studio'}</span>
        <h1>
          What do you want to <em>make</em>?
        </h1>
        <form
          className="ps-prompt"
          onSubmit={(e) => {
            e.preventDefault()
            makeIt()
          }}
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault()
            const f = Array.from(e.dataTransfer.files).filter((x) => x.type.startsWith('video/'))
            if (f.length) setFiles((cur) => [...cur, ...f])
          }}
        >
          <textarea
            className="ps-prompt-input"
            placeholder="Describe the video — e.g. “Turn my screen recording into a 2-minute product tour for new customers”. Attach recordings with +"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            rows={3}
            aria-label="Describe the video you want to make"
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) makeIt()
            }}
          />
          {files.length > 0 && (
            <div className="ps-attach-list">
              {files.map((f, i) => (
                <span key={i} className="ps-attach">
                  <Video size={13} />
                  <span className="ps-attach-name">{f.name}</span>
                  <span className="muted">{formatBytes(f.size)}</span>
                  <button type="button" aria-label={`Remove ${f.name}`} onClick={() => setFiles((cur) => cur.filter((_, j) => j !== i))}>
                    <X size={12} />
                  </button>
                </span>
              ))}
            </div>
          )}
          <div className="ps-prompt-bar">
            <button type="button" className="btn icon ps-prompt-plus" onClick={pick} aria-label="Attach recordings" title="Attach screen recordings or videos">
              <Plus size={18} />
            </button>
            <div className="ps-seg" role="radiogroup" aria-label="Aspect ratio">
              {ASPECTS.map((a) => (
                <button type="button" key={a} role="radio" aria-checked={aspect === a} className={aspect === a ? 'on' : ''} onClick={() => setAspect(a)}>
                  <i className={`ps-ar ps-ar-${a.replace(':', '-')}`} /> {a}
                </button>
              ))}
            </div>
            <span className="spacer" />
            <span className="ps-prompt-model"><Sparkles size={13} /> Producer AI</span>
            <button className="btn primary ps-make" type="submit">
              Make it <ArrowRight size={16} />
            </button>
          </div>
        </form>
        <div className="ps-ideas">
          {IDEAS.map((idea) => (
            <button key={idea} className="chip" onClick={() => setPrompt(idea)}>
              {idea}
            </button>
          ))}
        </div>
      </section>

      <section className="ps-section">
        <div className="ps-section-head">
          <h2 className="ps-h2">Quick start</h2>
          <span className="spacer" />
          <Link to="/tools" className="btn ghost sm">All tools <ArrowUpRight size={14} /></Link>
        </div>
        <div className="ps-grid ps-quick">
          <QuickCard icon={<Clapperboard size={20} />} title="Video Editor" body="Start a blank multi-track timeline in any aspect ratio." onClick={() => setAspectModal(true)} />
          <QuickCard icon={<Sparkles size={20} />} title="Producer AI from a recording" body="Upload a capture; get a scripted, narrated, branded cut." onClick={() => navigate('/producer/new')} {...VIOLET} />
          <QuickCard icon={<Captions size={20} />} title="Auto captions" body="Transcribe speech into styled, word-timed captions." onClick={tool('captions', 'Auto captions')} {...CYAN} />
          <QuickCard icon={<FileText size={20} />} title="Transcript editing" body="Edit the video by deleting words from its transcript." onClick={tool('transcript', 'Transcript edit')} {...AMBER} />
          <QuickCard icon={<AudioLines size={20} />} title="Voiceover" body="Type a script and generate natural narration." onClick={() => navigate('/voice')} {...GREEN} />
          <QuickCard icon={<ScissorsLineDashed size={20} />} title="Remove pauses" body="Cut silences and filler words in one click." onClick={tool('transcript', 'Remove pauses')} />
        </div>
      </section>

      <section className="ps-section">
        <div className="ps-section-head">
          <h2 className="ps-h2">Recent projects</h2>
          <span className="spacer" />
          <Link to="/library" className="btn ghost sm">View all <ArrowUpRight size={14} /></Link>
        </div>
        {recent.error ? (
          <div className="ps-alert">Couldn’t load your projects. <button className="btn sm" onClick={recent.reload}>Retry</button></div>
        ) : recent.loading && !recent.data ? (
          <div className="ps-grid">
            <CardSkeletons n={4} />
          </div>
        ) : recent.data?.length ? (
          <div className="ps-grid">
            {recent.data.map((p) => (
              <ProjectCard key={p.id} p={p} onOpen={() => navigate(`/edit/${p.id}`)} />
            ))}
          </div>
        ) : (
          <EmptyState
            icon={<FolderOpen size={24} />}
            title="No projects yet"
            body="Describe a video above, or start from a recording and let Producer AI do the first cut for you."
            action={
              <div className="row">
                <button className="btn primary" onClick={() => navigate('/producer/new')}><Sparkles size={15} /> New from recording</button>
                <button className="btn" onClick={() => setAspectModal(true)}>Blank project</button>
              </div>
            }
          />
        )}
      </section>

      {aspectModal && <AspectPickerModal onClose={() => setAspectModal(false)} busy={creating} onPick={(a) => void create({ width: a.width, height: a.height, name: a.name })} />}
    </div>
  )
}
