import type { SyncStatus } from '@producer/core'
import { describe, expect, it } from 'vitest'
import { CORE_VOICES, filterVoices } from '../components/VoiceCard'
import { syncSummary } from '../SystemChrome'
import { aiLabel, projectSyncBadge } from '../system'
import { aspectLabel, formatDuration, relativeTime } from '../util'

const sync = (over: Partial<SyncStatus> = {}): SyncStatus => ({ linked: true, state: 'idle', pending: 0, conflicts: [], lastSyncAt: Date.now() - 120_000, ...over })

describe('sync status', () => {
  it('summarises every state', () => {
    expect(syncSummary(sync({ linked: false, state: 'unlinked' })).label).toBe('Not synced')
    expect(syncSummary(sync({ state: 'syncing' })).tone).toBe('busy')
    expect(syncSummary(sync({ state: 'offline' })).label).toBe('Offline')
    expect(syncSummary(sync({ state: 'error' })).tone).toBe('bad')
    expect(syncSummary(sync({ pending: 3 })).label).toBe('3 pending')
    expect(syncSummary(sync({ conflicts: [{ projectId: 'p', name: 'P', localVersion: 1, cloudVersion: 2 }] })).label).toBe('1 conflict')
    expect(syncSummary(sync()).label).toBe('Synced 2m ago')
  })

  it('derives per-project badges', () => {
    const s = sync({ conflicts: [{ projectId: 'p1', name: 'P', localVersion: 1, cloudVersion: 2 }] })
    expect(projectSyncBadge('p1', s)).toBe('conflict')
    expect(projectSyncBadge('p2', s)).toBe('synced')
    expect(projectSyncBadge('p2', sync({ linked: false, state: 'unlinked' }))).toBe('local')
    expect(projectSyncBadge('p2', undefined)).toBeUndefined()
  })

  it('labels AI providers', () => {
    const base = { mode: 'desktop' as const, version: '1', capabilities: { transcribe: true, tts: true, render: true } }
    expect(aiLabel({ ...base, ai: { provider: 'claude-cli', available: true, detail: '' } })).toBe('Claude · your subscription')
    expect(aiLabel({ ...base, ai: { provider: 'anthropic-api', available: true, detail: '' } })).toBe('Claude API')
    expect(aiLabel({ ...base, ai: { provider: 'gemini', available: true, detail: '', model: 'gemini-3-pro' } })).toBe('Gemini · gemini-3-pro')
    expect(aiLabel({ ...base, ai: { provider: 'openai', available: true, detail: '', model: 'gpt-5.5' } })).toBe('OpenAI · gpt-5.5')
    expect(aiLabel({ ...base, ai: { provider: 'anthropic-key', available: true, detail: '', model: 'claude-opus-5' } })).toBe('Claude · claude-opus-5')
    expect(aiLabel({ ...base, ai: { provider: 'openai', available: true, detail: '' } })).toBe('OpenAI API')
    expect(aiLabel({ ...base, ai: { provider: 'none', available: false, detail: '' } })).toBe('AI unavailable')
  })
})

describe('voice filters', () => {
  it('filters the Kokoro library', () => {
    expect(filterVoices(CORE_VOICES, 'All')).toHaveLength(CORE_VOICES.length)
    expect(filterVoices(CORE_VOICES, 'British').every((v) => v.lang.startsWith('British'))).toBe(true)
    expect(filterVoices(CORE_VOICES, 'Male').every((v) => v.gender === 'male')).toBe(true)
    expect(filterVoices(CORE_VOICES, 'All', 'fable').map((v) => v.id)).toEqual(['bm_fable'])
    expect(filterVoices(CORE_VOICES, 'Narration').length).toBeGreaterThan(0)
  })
})

describe('formatting', () => {
  it('formats durations, aspects and relative times', () => {
    expect(formatDuration(75.4)).toBe('1:15')
    expect(formatDuration(3725)).toBe('1:02:05')
    expect(aspectLabel(1080, 1920)).toBe('9:16')
    expect(aspectLabel(2560, 1080)).toBe('21:9')
    const now = Date.now()
    expect(relativeTime(now - 10_000, now)).toBe('just now')
    expect(relativeTime(now - 5 * 60_000, now)).toBe('5 min ago')
    expect(relativeTime(now - 26 * 3600_000, now)).toBe('yesterday')
  })
})
