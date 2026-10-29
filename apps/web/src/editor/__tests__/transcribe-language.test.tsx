// The spoken-language picker (P-20): it says which speech model the server has and what it can hear, offers "Detect it"
// only on a multilingual model, keeps the choice, and the transcription is asked for in it.
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { TranscriptionInfo } from '@producer/core'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { api } from '../../lib/api'
import { TranscribeLanguage, loadTranscriptionInfo, transcribeLanguage, useTranscribeLanguage } from '../panels/TranscribeLanguage'

const english: TranscriptionInfo = { available: true, model: 'ggml-small.en.bin', multilingual: false, detect: false, languages: [{ code: 'en', name: 'English' }], summary: 'The speech model (ggml-small.en.bin) understands English only.' }
const multi: TranscriptionInfo = { available: true, model: 'ggml-small.bin', multilingual: true, detect: true, languages: [{ code: 'en', name: 'English' }, { code: 'fr', name: 'French' }, { code: 'de', name: 'German' }], summary: 'The speech model (ggml-small.bin) understands about 100 languages and can tell which one is spoken.' }

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  localStorage.clear()
  useTranscribeLanguage.setState({ info: undefined, language: 'auto' })
})

describe('the spoken-language picker (P-20)', () => {
  it('an English-only model: English it is, and the panel says so plainly', async () => {
    vi.spyOn(api, 'transcription').mockResolvedValue(english)
    render(<TranscribeLanguage />)
    const pick = await screen.findByRole('combobox', { name: 'Spoken language' })
    expect((pick as HTMLSelectElement).disabled).toBe(true)
    expect(screen.queryByRole('option', { name: 'Detect it' })).toBeNull()
    expect(screen.getByRole('note').textContent).toMatch(/ggml-small\.en\.bin.*English only/)
    expect(transcribeLanguage()).toBe('en')
  })

  it('a multilingual model: detect by default, or the language picked, kept for next time', async () => {
    vi.spyOn(api, 'transcription').mockResolvedValue(multi)
    render(<TranscribeLanguage />)
    const pick = (await screen.findByRole('combobox', { name: 'Spoken language' })) as HTMLSelectElement
    expect(pick.value).toBe('auto')
    expect(screen.getByRole('option', { name: 'Detect it' })).toBeTruthy()
    expect(transcribeLanguage()).toBe('auto')
    fireEvent.change(pick, { target: { value: 'fr' } })
    expect(pick.value).toBe('fr')
    expect(transcribeLanguage()).toBe('fr')
    expect(localStorage.getItem('ps.transcribe.language')).toBe('fr')
  })

  it('a language picked on another server that this one can’t hear falls back, and says why', async () => {
    useTranscribeLanguage.setState({ language: 'ja' })
    vi.spyOn(api, 'transcription').mockResolvedValue(english)
    render(<TranscribeLanguage />)
    await screen.findByRole('combobox', { name: 'Spoken language' })
    expect(transcribeLanguage()).toBe('en')
    expect(screen.getByRole('note').textContent).toMatch(/Japanese isn’t one of them, so English is used/)
  })

  it('a server without transcription says so, with no picker', async () => {
    vi.spyOn(api, 'transcription').mockResolvedValue({ available: false, multilingual: false, detect: false, languages: [], summary: 'Transcription isn’t set up on this server.' })
    render(<TranscribeLanguage />)
    expect((await screen.findByRole('note')).textContent).toMatch(/isn’t set up/)
    expect(screen.queryByRole('combobox')).toBeNull()
  })

  it('the transcription request carries the language', async () => {
    vi.spyOn(api, 'transcription').mockResolvedValue(multi)
    await loadTranscriptionInfo()
    useTranscribeLanguage.getState().set('de')
    expect(transcribeLanguage()).toBe('de')
  })
})
