import { ASPECT_RATIOS } from '@producer/core'
import { ArrowUpRight, Captions, Clapperboard, FileText, FolderOpen, Plus, Sparkles, Type, Wand2 } from 'lucide-react'
import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useCreateAndOpen } from '../actions'
import { ProjectCard } from '../components/ProjectCard'
import { AspectBox, AspectPickerModal } from '../modals'
import { CardSkeletons, EmptyState, usePageTitle } from '../ui'
import { AMBER, CYAN, QuickCard, VIOLET, useRecentProjects } from './HomePage'

export default function EditorHome() {
  usePageTitle('Video Editor')
  const navigate = useNavigate()
  const [modal, setModal] = useState(false)
  const [create, creating] = useCreateAndOpen()
  const recent = useRecentProjects(12)

  return (
    <div className="ps-page">
      <div className="ps-page-head">
        <div>
          <span className="eyebrow">Video Editor</span>
          <h1>Cut, caption and polish</h1>
          <p>A full multi-track timeline in your browser — keyframes, transitions, effects, captions and transcript editing.</p>
        </div>
      </div>

      <div className="ps-editor-create">
        <button className="ps-create-hero" onClick={() => setModal(true)} disabled={creating}>
          <span className="ps-create-hero-icon"><Plus size={28} /></span>
          <span>
            <strong>Create new</strong>
            <span>Blank project · choose a canvas</span>
          </span>
        </button>
        <div className="ps-aspect-quick">
          {ASPECT_RATIOS.slice(0, 5).map((a) => (
            <button key={a.id} className="ps-aspect" onClick={() => void create({ width: a.width, height: a.height })} disabled={creating} title={`New ${a.name} project — ${a.hint}`}>
              <div className="ps-aspect-box" style={{ height: 44 }}><AspectBox w={a.width} h={a.height} max={38} /></div>
              <strong>{a.name}</strong>
              <span>{a.hint}</span>
            </button>
          ))}
        </div>
      </div>

      <section className="ps-section">
        <div className="ps-section-head">
          <h2 className="ps-h2">Start with AI</h2>
        </div>
        <div className="ps-grid ps-cols-5">
          <QuickCard icon={<Captions size={20} />} title="AI captions" body="Speech-to-caption with word timing and styles." onClick={() => void create({ tab: 'captions', name: 'Auto captions' })} {...CYAN} />
          <QuickCard icon={<FileText size={20} />} title="Transcript-based editing" body="Delete words, remove fillers and pauses." onClick={() => void create({ tab: 'transcript', name: 'Transcript edit' })} {...AMBER} />
          <QuickCard icon={<Type size={20} />} title="Text templates" body="Titles, lower thirds and callouts, animated." onClick={() => void create({ tab: 'text', name: 'Untitled project' })} />
          <QuickCard icon={<Wand2 size={20} />} title="Transitions" body="Crossfades, pushes, zooms and wipes between clips." onClick={() => void create({ tab: 'transitions', name: 'Untitled project' })} {...VIOLET} />
          <QuickCard icon={<Sparkles size={20} />} title="Producer AI" body="Let AI write, narrate and assemble the first cut." onClick={() => navigate('/producer/new')} {...VIOLET} />
        </div>
      </section>

      <section className="ps-section">
        <div className="ps-section-head">
          <h2 className="ps-h2">Recent projects</h2>
          <span className="spacer" />
          <Link to="/library" className="btn ghost sm">Library <ArrowUpRight size={14} /></Link>
        </div>
        {recent.loading && !recent.data ? (
          <div className="ps-grid"><CardSkeletons n={4} /></div>
        ) : recent.data?.length ? (
          <div className="ps-grid">
            {recent.data.map((p) => (
              <ProjectCard key={p.id} p={p} onOpen={() => navigate(`/edit/${p.id}`)} />
            ))}
          </div>
        ) : (
          <EmptyState icon={<FolderOpen size={24} />} title="Your edits will live here" body="Create a project above — it autosaves as you work." action={<button className="btn primary" onClick={() => setModal(true)}><Clapperboard size={15} /> Create new</button>} />
        )}
      </section>

      {modal && <AspectPickerModal onClose={() => setModal(false)} busy={creating} onPick={(a) => void create({ width: a.width, height: a.height, name: a.name })} />}
    </div>
  )
}
