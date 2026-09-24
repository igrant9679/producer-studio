import type { Voice } from '@producer/core'
import { VOICES } from '@producer/core'
import clsx from 'clsx'
import { Check, Pause, Play } from 'lucide-react'
import { useEffect, useState } from 'react'
import { api } from '../../lib/api'
import { Spinner, useAudioPreview } from '../ui'

export const CORE_VOICES: Voice[] = VOICES.map((v) => ({ ...v }))

const HUES: Record<string, string> = { female: '#ff8fab', male: '#74c0fc' }

export function voiceAccent(v: Voice): string {
  return v.lang.startsWith('British') ? 'British' : v.lang.startsWith('American') ? 'American' : v.lang
}

export function VoiceAvatar({ v, size = 36 }: { v: Voice; size?: number }) {
  const c = HUES[v.gender] ?? '#b197fc'
  return (
    <span className="ps-voice-av" style={{ width: size, height: size, background: `radial-gradient(circle at 30% 25%, ${c}, ${c}55 60%, var(--thumb-a))`, fontSize: size * 0.4 }}>
      {v.name.slice(0, 1)}
    </span>
  )
}

export function PlaySample({ voiceId, size = 'sm' }: { voiceId: string; size?: 'sm' | 'md' }) {
  const playing = useAudioPreview((s) => s.playing === voiceId)
  const loading = useAudioPreview((s) => s.loading === voiceId)
  const toggle = useAudioPreview((s) => s.toggle)
  return (
    <button
      type="button"
      className={clsx('btn icon ps-play', size === 'sm' && 'sm', playing && 'on')}
      aria-label={playing ? 'Stop sample' : 'Play sample'}
      title={playing ? 'Stop' : 'Play sample'}
      onClick={(e) => {
        e.stopPropagation()
        toggle(voiceId, api.voiceSampleUrl(voiceId))
      }}
    >
      {loading ? <Spinner size={13} /> : playing ? <Pause size={13} /> : <Play size={13} />}
    </button>
  )
}

export function VoiceCard({ v, selected, onSelect, compact }: { v: Voice; selected?: boolean; onSelect?: () => void; compact?: boolean }) {
  return (
    <div className={clsx('ps-voice', selected && 'on', compact && 'compact')} onClick={onSelect} role="radio" aria-checked={selected} tabIndex={0} onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), onSelect?.())}>
      <VoiceAvatar v={v} size={compact ? 32 : 38} />
      <div className="ps-voice-meta">
        <strong>{v.name}</strong>
        <span>{voiceAccent(v)} · {v.style}</span>
      </div>
      {selected && <Check size={15} className="ps-voice-check" />}
      <PlaySample voiceId={v.id} />
    </div>
  )
}

/** Voices from the server when available, else the bundled Kokoro list. */
export function useVoices(): Voice[] {
  const [list, setList] = useState<Voice[]>(CORE_VOICES)
  useEffect(() => {
    let alive = true
    api
      .voices()
      .then((v) => alive && Array.isArray(v) && v.length && setList(v))
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [])
  return list
}

export const VOICE_FILTERS = ['All', 'Female', 'Male', 'American', 'British', 'Narration', 'Conversational'] as const
export type VoiceFilter = (typeof VOICE_FILTERS)[number]

export function filterVoices(list: Voice[], filter: VoiceFilter, q = ''): Voice[] {
  const term = q.trim().toLowerCase()
  return list.filter((v) => {
    if (term && !`${v.name} ${v.style} ${v.lang} ${v.gender}`.toLowerCase().includes(term)) return false
    switch (filter) {
      case 'All':
        return true
      case 'Female':
        return v.gender === 'female'
      case 'Male':
        return v.gender === 'male'
      case 'American':
        return v.lang.startsWith('American')
      case 'British':
        return v.lang.startsWith('British')
      case 'Narration':
        return /narrat|documentary|storyteller|newsreader|authoritative|measured|deep|polished|professional/i.test(v.style)
      case 'Conversational':
        return /conversational|friendly|casual|warm|upbeat|bright|playful|soft|light|gentle/i.test(v.style)
    }
  })
}
