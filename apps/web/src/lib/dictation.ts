// Live dictation client (desktop): microphone → WebM/Opus chunks → /api/voicestudio/ws/dictation (proxied to
// VoiceStudio's /v1/audio/transcriptions/stream) → partial and final text. One session per start/stop.

export type DictationEvent =
  | { type: 'status'; stage: string }
  | { type: 'partial'; text: string }
  | { type: 'level'; level: number }
  | { type: 'error'; message: string; kind?: string }

export interface DictationOptions {
  model?: string
  onEvent?: (e: DictationEvent) => void
}

export class DictationSession {
  private ws?: WebSocket
  private stream?: MediaStream
  private rec?: MediaRecorder
  private audio?: AudioContext
  private raf = 0
  private committed: string[] = []
  private summary?: string
  private finished?: (text: string) => void
  private failed?: (e: Error) => void
  private ended = false
  /** Why the session stopped working, once it has: stop() then answers at once instead of waiting out its timeout. */
  private failure?: Error

  constructor(private o: DictationOptions = {}) {}

  private emit(e: DictationEvent) {
    this.o.onEvent?.(e)
  }

  /** Text so far (committed utterances). */
  get text(): string {
    return this.summary ?? this.committed.join(' ').trim()
  }

  /** Opens the microphone and the connection. A start that fails releases the microphone and throws. */
  async start(): Promise<void> {
    try {
      await this.open()
    } catch (e) {
      this.ended = true
      this.cleanupMedia()
      try {
        this.ws?.close()
      } catch {
        /* closed */
      }
      throw e
    }
  }

  private async open(): Promise<void> {
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false })
    // level meter
    this.audio = new AudioContext()
    const an = this.audio.createAnalyser()
    an.fftSize = 1024
    this.audio.createMediaStreamSource(this.stream).connect(an)
    const buf = new Float32Array(an.fftSize)
    const tick = () => {
      an.getFloatTimeDomainData(buf)
      let sum = 0
      for (const x of buf) sum += x * x
      this.emit({ type: 'level', level: Math.min(1, Math.sqrt(sum / buf.length) * 4) })
      this.raf = requestAnimationFrame(tick)
    }
    this.raf = requestAnimationFrame(tick)

    const q = new URLSearchParams()
    if (this.o.model) q.set('model', this.o.model)
    const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/voicestudio/ws/dictation${q.size ? `?${q}` : ''}`
    const ws = new WebSocket(url)
    ws.binaryType = 'arraybuffer'
    this.ws = ws
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve()
      ws.onerror = () => reject(new Error('Couldn’t connect to VoiceStudio for dictation. Is the engine running?'))
    })
    ws.onmessage = (m) => this.onMessage(m.data)
    ws.onclose = () => {
      if (!this.ended) this.fail(new Error('Dictation disconnected: VoiceStudio closed the connection.'))
      else if (this.finished) this.finish()
    }
    const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : 'audio/webm'
    const rec = new MediaRecorder(this.stream, { mimeType: mime })
    this.rec = rec
    rec.ondataavailable = async (e) => {
      if (e.data.size && ws.readyState === WebSocket.OPEN) ws.send(await e.data.arrayBuffer())
    }
    rec.start(250)
  }

  private onMessage(data: unknown) {
    if (typeof data !== 'string') return
    let m: { type?: string; text?: string; final_kind?: string; stage?: string; message?: string; detail?: string; kind?: string }
    try {
      m = JSON.parse(data)
    } catch {
      return
    }
    if (m.type === 'partial') this.emit({ type: 'partial', text: [this.committed.join(' '), m.text ?? ''].join(' ').trim() })
    else if (m.type === 'final') {
      const t = (m.text ?? '').trim()
      if (m.final_kind === 'utterance') {
        if (t) this.committed.push(t)
        this.emit({ type: 'partial', text: this.committed.join(' ') })
      } else {
        // whole-session result (summary, or the only final of the Whisper path)
        this.summary = t
        if (this.ended) this.finish()
      }
    } else if (m.type === 'status' && m.stage) this.emit({ type: 'status', stage: m.stage })
    else if (m.type === 'error') this.fail(new Error(m.message || m.detail || 'Dictation failed'), m.kind)
  }

  private cleanupMedia() {
    cancelAnimationFrame(this.raf)
    this.stream?.getTracks().forEach((t) => t.stop())
    void this.audio?.close().catch(() => undefined)
  }

  private finish() {
    const done = this.finished
    this.finished = undefined
    this.cleanupMedia()
    try {
      this.ws?.close()
    } catch {
      /* closed */
    }
    done?.(this.text)
  }

  /** An error or a dropped connection, while listening or finishing: said through onEvent, and stop() rejects with it. */
  private fail(e: Error, kind?: string) {
    if (this.failure) return
    this.failure = e
    const f = this.failed
    this.failed = undefined
    this.finished = undefined
    this.ended = true
    this.cleanupMedia()
    try {
      this.ws?.close()
    } catch {
      /* closed */
    }
    this.emit({ type: 'error', message: e.message, kind })
    f?.(e)
  }

  /** Stop recording and wait for the final text. */
  stop(timeoutMs = 30_000): Promise<string> {
    if (this.failure) return Promise.reject(this.failure)
    return new Promise((resolve, reject) => {
      this.finished = resolve
      this.failed = reject
      this.ended = true
      const ws = this.ws
      const end = () => {
        if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'input_audio.end' }))
      }
      if (this.rec && this.rec.state !== 'inactive') {
        this.rec.onstop = () => setTimeout(end, 50)
        this.rec.stop()
      } else end()
      setTimeout(() => this.finished && this.finish(), timeoutMs)
    })
  }

  cancel() {
    this.ended = true
    this.finished = undefined
    this.failed = undefined
    try {
      if (this.rec && this.rec.state !== 'inactive') this.rec.stop()
    } catch {
      /* stopped */
    }
    this.cleanupMedia()
    try {
      this.ws?.close()
    } catch {
      /* closed */
    }
  }
}

/** Insert text at the caret of the focused input/textarea/contenteditable (fires React's input events). */
export function insertIntoFocused(el: Element | null, text: string): boolean {
  if (!el || !text) return false
  const h = el as HTMLElement
  h.focus()
  const before = (el as HTMLInputElement).value?.slice(0, (el as HTMLInputElement).selectionStart ?? 0) ?? ''
  const spaced = before && !/\s$/.test(before) ? ` ${text}` : text
  // execCommand keeps undo history and triggers onChange in React-controlled fields
  if (document.execCommand('insertText', false, spaced)) return true
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    el.setRangeText(spaced, el.selectionStart ?? el.value.length, el.selectionEnd ?? el.value.length, 'end')
    el.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  }
  return false
}

export const isEditable = (el: Element | null): el is HTMLElement =>
  !!el &&
  ((el instanceof HTMLTextAreaElement && !el.readOnly && !el.disabled) ||
    (el instanceof HTMLInputElement && !el.readOnly && !el.disabled && /^(text|search|url|email|)$/i.test(el.type)) ||
    (el as HTMLElement).isContentEditable)
