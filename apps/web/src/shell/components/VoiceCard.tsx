import type { Voice } from '@producer/core'
import { VOICES } from '@producer/core'
import clsx from 'clsx'
import { Check, Pause, Play, Wand2, Mic } from 'lucide-react'
import { useEffect, useState } from 'react'
import { create } from 'zustand'
import { api } from '../../lib/api'
import { useSession } from '../../lib/session'
import { Spinner, useAudioPreview } from '../ui'

export const CORE_VOICES: Voice[] = VOICES.map((v) => ({ ...v }))

const HUES: Record<string, string> = { female: '#ff8fab', male: '#74c0fc' }

export function voiceAccent(v: Voice): string {
  if (v.source === 'clone' || v.source === 'design') return v.lang
  return v.lang.startsWith('British') ? 'British' : v.lang.startsWith('American') ? 'American' : v.lang
}

export const isCustomVoice = (v: Voice) => v.source === 'clone' || v.source === 'design'

export function VoiceAvatar({ v, size = 36 }: { v: Voice; size?: number }) {
  const c = isCustomVoice(v) ? (v.source === 'design' ? '#ffd43b' : '#63e6be') : (HUES[v.gender] ?? '#b197fc')
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
  const custom = isCustomVoice(v)
  const unavailable = v.available === false
  return (
    <div
      className={clsx('ps-voice', selected && 'on', compact && 'compact', unavailable && 'unavailable')}
      onClick={onSelect}
      role="radio"
      aria-checked={selected}
      tabIndex={0}
      title={v.detail}
      onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), onSelect?.())}
    >
      <VoiceAvatar v={v} size={compact ? 32 : 38} />
      <div className="ps-voice-meta">
        <strong>
          {v.name}
          {custom && <span className="ps-voice-tag">{v.source === 'design' ? <Wand2 size={9} /> : <Mic size={9} />} {v.source === 'design' ? 'Designed' : 'My voice'}</span>}
        </strong>
        <span>{unavailable && v.detail ? v.detail : `${voiceAccent(v)} · ${v.style}`}</span>
      </div>
      {selected && <Check size={15} className="ps-voice-check" />}
      {(!custom || v.available) && <PlaySample voiceId={v.id} />}
    </div>
  )
}

/** Bumped after voices are created / renamed / deleted so every picker refetches. */
export const useVoicesVersion = create<{ n: number; bump: () => void }>((set) => ({ n: 0, bump: () => set((s) => ({ n: s.n + 1 })) }))

/** Voices from the server (built-in + this space's cloned/designed voices), else the bundled Kokoro list. */
export function useVoices(): Voice[] {
  const [list, setList] = useState<Voice[]>(CORE_VOICES)
  const workspaceId = useSession((s) => s.workspaceId)
  const version = useVoicesVersion((s) => s.n)
  useEffect(() => {
    let alive = true
    api
      .voices(workspaceId)
      // the space's own voices first
      .then((v) => alive && Array.isArray(v) && v.length && setList([...v.filter(isCustomVoice), ...v.filter((x) => !isCustomVoice(x))]))
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [workspaceId, version])
  return list
}

export const VOICE_FILTERS = ['All', 'My voices', 'Female', 'Male', 'American', 'British', 'Narration', 'Conversational'] as const
export type VoiceFilter = (typeof VOICE_FILTERS)[number]

export function filterVoices(list: Voice[], filter: VoiceFilter, q = ''): Voice[] {
  const term = q.trim().toLowerCase()
  return list.filter((v) => {
    if (term && !`${v.name} ${v.style} ${v.lang} ${v.gender}`.toLowerCase().includes(term)) return false
    switch (filter) {
      case 'All':
        return true
      case 'My voices':
        return isCustomVoice(v)
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
