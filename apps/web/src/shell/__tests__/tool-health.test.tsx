// Settings → This computer lists the desktop's bundled tools and says what is broken and what to do (D-13).
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { ToolHealth } from '@producer/core'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { announced } from '../../lib/announce'
import { ToolHealthPanel } from '../pages/DesktopAppSettings'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const healthy: ToolHealth = {
  checkedAt: 1,
  ok: true,
  tools: [
    { id: 'ffmpeg', name: 'ffmpeg', needed: 'Exports', status: 'ok', detail: 'ffmpeg 7.0.2' },
    { id: 'kokoro', name: 'Voices (Kokoro)', needed: 'Built-in voiceovers', status: 'warn', detail: 'Downloads the first time you make a voiceover.' },
  ],
}
const broken: ToolHealth = { ...healthy, ok: false, tools: [{ id: 'whisper', name: 'Transcription (whisper)', needed: 'Captions', status: 'error', detail: 'The speech model is missing. Reinstall Producer Studio to put it back.' }, ...healthy.tools] }

function serve(...answers: Array<ToolHealth | number>) {
  const urls: string[] = []
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (u) => {
    urls.push(String(u))
    const a = answers[Math.min(urls.length - 1, answers.length - 1)]
    return typeof a === 'number' ? new Response(JSON.stringify({ error: 'Engine busy' }), { status: a }) : new Response(JSON.stringify(a), { status: 200 })
  })
  return urls
}

describe('bundled tools in Settings (D-13)', () => {
  it('lists each tool with its state, what it is for and the detail', async () => {
    const urls = serve(healthy)
    render(<ToolHealthPanel />)
    const list = await screen.findByRole('list', { name: 'Bundled tools' })
    const items = within(list).getAllByRole('listitem')
    expect(items).toHaveLength(2)
    expect(items[0].textContent).toContain('ffmpeg')
    expect(items[0].textContent).toContain('Working')
    expect(items[1].textContent).toContain('Works, with a note')
    expect(items[1].textContent).toContain('For: Built-in voiceovers')
    expect(screen.getByText('Everything Producer Studio needs is installed.')).toBeTruthy()
    expect(urls[0]).toBe('/api/tools/health')
  })

  it('a broken tool says so; Check again asks the engine to look again and announces the result', async () => {
    const urls = serve(healthy, broken)
    render(<ToolHealthPanel />)
    await screen.findByRole('list', { name: 'Bundled tools' })
    fireEvent.click(screen.getByRole('button', { name: /Check again/ }))
    await waitFor(() => expect(screen.getByText(/The speech model is missing/)).toBeTruthy())
    expect(urls[1]).toBe('/api/tools/health?refresh=1')
    expect(screen.getByText(/missing or broken/)).toBeTruthy()
    expect(screen.getByText('Not working')).toBeTruthy()
    await waitFor(() => expect(announced()).toMatch(/1 tool not working: Transcription \(whisper\)/))
  })

  it('an engine that can’t answer is reported, not a blank panel', async () => {
    serve(503)
    render(<ToolHealthPanel />)
    expect((await screen.findByRole('alert')).textContent).toMatch(/Couldn’t check the tools: Engine busy/)
  })
})
