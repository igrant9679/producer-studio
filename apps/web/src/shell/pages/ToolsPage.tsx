import {
  AudioLines,
  Captions,
  Crop,
  Eraser,
  FileText,
  Film,
  Gauge,
  Layers,
  Mic,
  Music,
  Palette,
  Scissors,
  ScissorsLineDashed,
  Sparkles,
  SunMedium,
  Type,
  Video,
  Wand2,
  Waves,
  Zap,
} from 'lucide-react'
import type { ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import { useCreateAndOpen, type EditorTab } from '../actions'
import { usePageTitle } from '../ui'
import { AMBER, CYAN, GREEN, QuickCard, VIOLET } from './HomePage'

interface Tool {
  title: string
  body: string
  icon: ReactNode
  go?: { tab?: EditorTab; route?: string; name?: string }
  soon?: boolean
  tint?: typeof CYAN
}

const GROUPS: Array<{ title: string; blurb: string; tools: Tool[] }> = [
  {
    title: 'Create with AI',
    blurb: 'Let AI do the first 80% — you finish the last 20%.',
    tools: [
      { title: 'Producer AI', body: 'Recording in, scripted, narrated, branded video out.', icon: <Sparkles size={20} />, go: { route: '/producer/new' }, tint: VIOLET },
      { title: 'Text to speech', body: '24 natural voices with an AI script writer.', icon: <AudioLines size={20} />, go: { route: '/voice' }, tint: GREEN },
      { title: 'AI editing assistant', body: 'Ask for edits in plain English — “tighten the intro”.', icon: <Wand2 size={20} />, go: { tab: 'ai', name: 'AI-assisted edit' }, tint: VIOLET },
      { title: 'Prompt to video', body: 'Generate footage from a text description.', icon: <Film size={20} />, soon: true },
      { title: 'Design studio', body: 'Covers, thumbnails and social graphics from a prompt.', icon: <Palette size={20} />, soon: true },
    ],
  },
  {
    title: 'For video',
    blurb: 'Precision tools inside the timeline editor.',
    tools: [
      { title: 'Auto captions', body: 'Word-timed captions in one click, fully styled.', icon: <Captions size={20} />, go: { tab: 'captions', name: 'Auto captions' }, tint: CYAN },
      { title: 'Transcript editing', body: 'Cut video by deleting words from the transcript.', icon: <FileText size={20} />, go: { tab: 'transcript', name: 'Transcript edit' }, tint: AMBER },
      { title: 'Remove pauses & fillers', body: 'Strip silences and “um”s automatically.', icon: <ScissorsLineDashed size={20} />, go: { tab: 'transcript', name: 'Remove pauses' } },
      { title: 'Text & titles', body: 'Animated titles, lower thirds and callouts.', icon: <Type size={20} />, go: { tab: 'text' } },
      { title: 'Transitions', body: 'Crossfades, pushes, zooms, wipes and more.', icon: <Layers size={20} />, go: { tab: 'transitions' }, tint: VIOLET },
      { title: 'Effects & filters', body: 'Colour looks, grain, VHS, glow, camera shake.', icon: <SunMedium size={20} />, go: { tab: 'filters' }, tint: AMBER },
      { title: 'Resize video', body: 'Reframe for 16:9, 9:16, 1:1 and more.', icon: <Crop size={20} />, go: { tab: 'media' }, tint: CYAN },
      { title: 'Speed & freeze frame', body: 'Constant speed changes and held frames.', icon: <Gauge size={20} />, go: { tab: 'media' } },
      { title: 'Remove background', body: 'Cut out people without a green screen.', icon: <Eraser size={20} />, soon: true },
      { title: 'Stabilize', body: 'Smooth shaky handheld footage.', icon: <Zap size={20} />, soon: true },
      { title: 'Batch edit', body: 'Apply one edit to many videos at once.', icon: <Scissors size={20} />, soon: true },
    ],
  },
  {
    title: 'For audio',
    blurb: 'Voice, music and sound — mixed right.',
    tools: [
      { title: 'Voiceover', body: 'Write a script, generate narration, drop it in.', icon: <Mic size={20} />, go: { route: '/voice' }, tint: GREEN },
      { title: 'Music & sound', body: 'Add music beds and effects with fades and ducking.', icon: <Music size={20} />, go: { tab: 'audio' }, tint: CYAN },
      { title: 'Separate audio', body: 'Split a clip’s audio onto its own track.', icon: <Waves size={20} />, go: { tab: 'audio' } },
      { title: 'Voice changer', body: 'Re-voice a recording with any voice.', icon: <AudioLines size={20} />, soon: true },
      { title: 'Voice cloning', body: 'Create a custom voice from 10 seconds of audio.', icon: <Video size={20} />, soon: true },
    ],
  },
]

export default function ToolsPage() {
  usePageTitle('All tools')
  const navigate = useNavigate()
  const [create] = useCreateAndOpen()
  return (
    <div className="ps-page">
      <div className="ps-page-head">
        <div>
          <span className="eyebrow">All tools</span>
          <h1>Everything in the studio</h1>
          <p>Every tool opens where it belongs — AI flows in their own workspace, editing tools in a fresh project with the right panel open.</p>
        </div>
      </div>
      {GROUPS.map((g) => (
        <section key={g.title} className="ps-section" style={{ marginTop: 32 }}>
          <div className="ps-section-head">
            <h2 className="ps-h2">{g.title}</h2>
            <span className="muted" style={{ fontSize: 13 }}>{g.blurb}</span>
          </div>
          <div className="ps-grid">
            {g.tools.map((t) => (
              <QuickCard
                key={t.title}
                icon={t.icon}
                title={t.title}
                body={t.body}
                soon={t.soon}
                {...(t.tint ?? {})}
                onClick={() => {
                  if (!t.go) return
                  if (t.go.route) navigate(t.go.route)
                  else void create({ tab: t.go.tab, name: t.go.name ?? 'Untitled project' })
                }}
              />
            ))}
          </div>
        </section>
      ))}
    </div>
  )
}
