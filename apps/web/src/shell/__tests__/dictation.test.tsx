// Dictation releases the microphone when a start fails and says when it fails mid-way, instead of "Listening…" and
// a 30 s Insert (APP-4); the model set in Settings applies to the next dictation, and the widget's error stays on
// screen (APP-31).
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { DesktopSettings } from '@producer/core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DictationSession, type DictationEvent } from '../../lib/dictation'
import { useToasts } from '../../lib/toast'
import { systemApi, useSystem } from '../system'
import DictationWidget, { DictationController } from '../voicestudio/Dictation'

vi.mock('../voicestudio/vsApi', () => ({
  useVsStatus: () => ({ state: 'running' }),
  vsRunning: () => true,
  vsFetch: vi.fn(),
  vsGet: vi.fn(),
}))
vi.setConfig({ testTimeout: 30_000 })

class FakeSocket {
  static OPEN = 1
  static all: FakeSocket[] = []
  readyState = 0
  binaryType = ''
  sent: unknown[] = []
  onopen?: () => void
  onerror?: () => void
  onclose?: () => void
  onmessage?: (m: { data: unknown }) => void
  constructor(public url: string) {
    FakeSocket.all.push(this)
  }
  open() {
    this.readyState = 1
    this.onopen?.()
  }
  send(d: unknown) {
    this.sent.push(d)
  }
  close() {
    if (this.readyState === 3) return
    this.readyState = 3
    this.onclose?.()
  }
  message(m: object) {
    this.onmessage?.({ data: JSON.stringify(m) })
  }
}
class FakeRecorder {
  static isTypeSupported = () => true
  state = 'inactive'
  onstop?: () => void
  ondataavailable?: () => void
  start() {
    this.state = 'recording'
  }
  stop() {
    this.state = 'inactive'
    this.onstop?.()
  }
}
class FakeAudio {
  createAnalyser = () => ({ fftSize: 1024, getFloatTimeDomainData: () => undefined })
  createMediaStreamSource = () => ({ connect: () => undefined })
  close = () => Promise.resolve()
}

let track: { stop: ReturnType<typeof vi.fn> }
const sock = () => FakeSocket.all[FakeSocket.all.length - 1]
const settings = (model: string): DesktopSettings => ({ dictationModel: model, dictationGlobal: false, dictationShortcut: 'CommandOrControl+Alt+D', dictationPaste: true }) as DesktopSettings

beforeEach(() => {
  FakeSocket.all = []
  track = { stop: vi.fn() }
  vi.stubGlobal('WebSocket', FakeSocket)
  vi.stubGlobal('MediaRecorder', FakeRecorder)
  vi.stubGlobal('AudioContext', FakeAudio)
  vi.stubGlobal('requestAnimationFrame', () => 1)
  vi.stubGlobal('cancelAnimationFrame', () => undefined)
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: vi.fn(async () => ({ getTracks: () => [track] })) } })
  useToasts.setState({ toasts: [] })
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

async function started(events: DictationEvent[] = []) {
  const s = new DictationSession({ onEvent: (e) => events.push(e) })
  const p = s.start()
  await waitFor(() => expect(FakeSocket.all.length).toBe(1))
  sock().open()
  await p
  return s
}

describe('DictationSession (APP-4)', () => {
  it('a start that can’t connect releases the microphone and throws', async () => {
    const s = new DictationSession()
    const p = s.start()
    await waitFor(() => expect(FakeSocket.all.length).toBe(1))
    sock().onerror?.()
    await expect(p).rejects.toThrow(/Couldn’t connect to VoiceStudio/)
    expect(track.stop).toHaveBeenCalled()
  })

  it('an error from VoiceStudio mid-dictation is an event, and Insert answers at once with it', async () => {
    const events: DictationEvent[] = []
    const s = await started(events)
    sock().message({ type: 'error', message: 'The dictation model crashed' })
    expect(events).toContainEqual(expect.objectContaining({ type: 'error', message: 'The dictation model crashed' }))
    expect(track.stop).toHaveBeenCalled()
    const t0 = Date.now()
    await expect(s.stop()).rejects.toThrow('The dictation model crashed')
    expect(Date.now() - t0).toBeLessThan(1000)
  })

  it('a dropped connection is said too', async () => {
    const events: DictationEvent[] = []
    await started(events)
    sock().close()
    expect(events.filter((e) => e.type === 'error')).toEqual([expect.objectContaining({ message: expect.stringMatching(/Dictation disconnected/) })])
  })
})

describe('<DictationController> (APP-4, APP-31)', () => {
  const press = () => fireEvent.keyDown(window, { key: ' ', code: 'Space', ctrlKey: true, shiftKey: true })

  it('a failure mid-dictation ends the pill and says why; the next dictation uses the model set since', async () => {
    useSystem.setState({ info: { mode: 'desktop', version: '1', ai: { provider: 'claude-cli', available: true, detail: '' }, capabilities: { transcribe: true, tts: true, render: true } }, loaded: true })
    const get = vi.spyOn(systemApi, 'settings').mockResolvedValue(settings('whisper-small'))
    render(
      <>
        <textarea aria-label="Notes" />
        <DictationController />
      </>,
    )
    ;(screen.getByLabelText('Notes') as HTMLTextAreaElement).focus()
    await act(async () => press())
    await waitFor(() => expect(FakeSocket.all.length).toBe(1))
    expect(sock().url).toMatch(/model=whisper-small/)
    act(() => sock().open())
    expect(await screen.findByText(/Listening… speak now/)).toBeTruthy()
    act(() => sock().message({ type: 'error', message: 'The dictation model crashed' }))
    await waitFor(() => expect(screen.queryByRole('status')).toBeNull())
    expect(useToasts.getState().toasts.map((t) => t.text)).toContain('The dictation model crashed')
    expect(track.stop).toHaveBeenCalled()

    // a model chosen in Settings since applies now, not after a restart
    get.mockResolvedValue(settings('parakeet-streaming'))
    ;(screen.getByLabelText('Notes') as HTMLTextAreaElement).focus()
    await act(async () => press())
    await waitFor(() => expect(FakeSocket.all.length).toBe(2))
    expect(sock().url).toMatch(/model=parakeet-streaming/)
  })
})

describe('<DictationWidget> (APP-31)', () => {
  it('an error stays on screen instead of being replaced at once', async () => {
    let command: (c: string) => void = () => undefined
    const bridge = { configure: vi.fn(), result: vi.fn(async () => true), cancel: vi.fn(async () => true), toggle: vi.fn(), onCommand: (cb: (c: string) => void) => ((command = cb), () => undefined) }
    ;(window as unknown as { producerDesktop: unknown }).producerDesktop = { dictation: bridge }
    vi.spyOn(systemApi, 'settings').mockResolvedValue(settings(''))
    render(<DictationWidget />)
    await act(async () => command('start'))
    await waitFor(() => expect(FakeSocket.all.length).toBe(1))
    act(() => sock().open())
    await act(async () => command('stop'))
    act(() => sock().message({ type: 'error', message: 'Out of memory on the GPU' }))
    expect(await screen.findByText('Out of memory on the GPU')).toBeTruthy()
    await new Promise((r) => setTimeout(r, 100))
    expect(screen.getByText('Out of memory on the GPU')).toBeTruthy()
    delete (window as unknown as { producerDesktop?: unknown }).producerDesktop
  })
})
