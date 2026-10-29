// The desktop app names broken bundled tools at start (D-13).
import { describe, expect, it, vi } from 'vitest'
import { type ToolReport, fetchToolReport, toolsWarning } from '../health'

const ok: ToolReport = {
  ok: true,
  tools: [
    { id: 'ffmpeg', name: 'ffmpeg', needed: 'Uploads, proxies, clean-up tools and exports', status: 'ok', detail: 'ffmpeg 7.0.2' },
    { id: 'kokoro', name: 'Voices (Kokoro)', needed: 'Built-in voiceovers', status: 'warn', detail: 'Downloads on first use.' },
  ],
}

describe('the start-up tool warning (D-13)', () => {
  it('says nothing when nothing is broken (a warning shows only in Settings)', () => {
    expect(toolsWarning(ok)).toBeNull()
    expect(toolsWarning(undefined)).toBeNull()
  })

  it('names each broken tool, what it is for and what to do', () => {
    const one = toolsWarning({ ok: false, tools: [...ok.tools, { id: 'whisper', name: 'Transcription (whisper)', needed: 'Captions and transcripts', status: 'error', detail: 'The speech model is missing. Reinstall Producer Studio to put it back.' }] })!
    expect(one.message).toBe('Part of Producer Studio isn’t working: Transcription (whisper).')
    expect(one.detail).toContain('• Transcription (whisper) (for captions and transcripts): The speech model is missing. Reinstall Producer Studio')
    expect(one.detail).toContain('Settings → This computer')
    expect(one.detail).not.toContain('Kokoro')
    const two = toolsWarning({ ok: false, tools: ok.tools.map((t) => ({ ...t, status: 'error' as const })) })!
    expect(two.message).toBe('2 parts of Producer Studio aren’t working.')
  })

  it('asks the engine with the local session, and an engine that can’t answer gives no report (no false alarm)', async () => {
    const f = vi.fn(async () => new Response(JSON.stringify(ok), { status: 200 }))
    expect(await fetchToolReport('http://127.0.0.1:5000', 'tok', f as unknown as typeof fetch)).toEqual(ok)
    expect(f).toHaveBeenCalledWith('http://127.0.0.1:5000/api/tools/health', expect.objectContaining({ headers: { cookie: 'ps_session=tok' } }))
    expect(await fetchToolReport('http://x', 't', (async () => new Response('no', { status: 404 })) as unknown as typeof fetch)).toBeUndefined()
    expect(await fetchToolReport('http://x', 't', (async () => Promise.reject(new Error('down'))) as unknown as typeof fetch)).toBeUndefined()
  })
})
