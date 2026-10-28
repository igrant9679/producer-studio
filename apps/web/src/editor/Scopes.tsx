// Video scopes of the frame under the playhead (waveform, vectorscope, histogram), read from the preview as it is
// drawn: graded clips and images with their filters and adjustment layers (text and shapes are left out).
import { HUE_RANGES, STAGES, VECTOR_TARGETS, chroma709, histogram, rgbToHsl, vectorscope, waveform } from '@producer/core'
import clsx from 'clsx'
import { useEffect, useRef, useState } from 'react'
import { useThrottledPlayhead } from './controls'
import { useEditor } from './store'

export type ScopeMode = 'waveform' | 'vectorscope' | 'histogram'

const MODES: Array<{ id: ScopeMode; name: string }> = [
  { id: 'waveform', name: 'Waveform' },
  { id: 'vectorscope', name: 'Vectorscope' },
  { id: 'histogram', name: 'Histogram' },
]
const KEY = 'ps.scope'
const W = 256
const LEVELS = 128

type Frame = { data: Uint8ClampedArray; width: number; height: number }

/** What a frame's levels say in words: the scopes for a screen reader, and a check at a glance. */
export function describeFrame(f: Frame): string {
  const h = histogram(f.data)
  const n = Math.max(1, f.width * f.height)
  let lo = 0
  let hi = 255
  for (let acc = 0; lo < 255 && (acc += h.y[lo]) < n * 0.01; lo++);
  for (let acc = 0; hi > 0 && (acc += h.y[hi]) < n * 0.01; hi--);
  let sum = 0
  for (let i = 0; i < 256; i++) sum += i * h.y[i]
  const black = (h.y[0] + h.y[1] + h.y[2]) / n
  const white = (h.y[253] + h.y[254] + h.y[255]) / n
  let sat = 0
  const avg = [0, 0, 0]
  for (let i = 0; i + 3 < f.data.length; i += 4) {
    const { cb, cr } = chroma709(f.data[i], f.data[i + 1], f.data[i + 2])
    sat += Math.hypot(cb, cr)
    for (let c = 0; c < 3; c++) avg[c] += f.data[i + c] / 255 / n
  }
  const pct = (v: number) => `${Math.round(v * 100)} %`
  const parts = [`Levels ${pct(lo / 255)} to ${pct(hi / 255)}, average ${pct(sum / n / 255)}`]
  if (black > 0.02) parts.push(`${pct(black)} crushed to black`)
  if (white > 0.02) parts.push(`${pct(white)} clipped to white`)
  const meanSat = sat / n / 0.5
  if (meanSat < 0.03) parts.push('almost no colour')
  else {
    // the average colour, named by its nearest hue range
    const hue = rgbToHsl(avg[0], avg[1], avg[2])[0]
    const near = HUE_RANGES.reduce((a, x) => (Math.min(Math.abs(x.hue - hue), 360 - Math.abs(x.hue - hue)) < Math.min(Math.abs(a.hue - hue), 360 - Math.abs(a.hue - hue)) ? x : a))
    parts.push(`saturation ${pct(Math.min(1, meanSat))}, leaning ${near.name.toLowerCase()}`)
  }
  return parts.join(' · ')
}

function readMode(): ScopeMode {
  try {
    const v = localStorage.getItem(KEY)
    return v === 'vectorscope' || v === 'histogram' ? v : 'waveform'
  } catch {
    return 'waveform'
  }
}

function draw(c: HTMLCanvasElement, mode: ScopeMode, f: Frame) {
  const ctx = c.getContext('2d')
  if (!ctx) return
  if (mode === 'histogram') {
    c.width = 256
    c.height = 110
    ctx.fillStyle = '#0b0d12'
    ctx.fillRect(0, 0, 256, 110)
    const h = histogram(f.data)
    // the edges are often piled up: scale to the busiest level inside them
    let max = 1
    for (let i = 2; i < 254; i++) max = Math.max(max, h.r[i], h.g[i], h.b[i])
    ctx.globalCompositeOperation = 'lighter'
    for (const [bins, col] of [[h.r, '#ff4d4d'], [h.g, '#3ddc64'], [h.b, '#4d7dff']] as const) {
      ctx.fillStyle = col
      for (let i = 0; i < 256; i++) {
        const v = Math.min(1, bins[i] / max) * 104
        ctx.fillRect(i, 110 - v, 1, v)
      }
    }
    ctx.globalCompositeOperation = 'source-over'
    return
  }
  if (mode === 'waveform') {
    const cols = Math.min(W, f.width)
    c.width = cols
    c.height = LEVELS
    const w = waveform(f.data, f.width, f.height, cols, LEVELS)
    const img = ctx.createImageData(cols, LEVELS)
    const gain = 6 / Math.max(1, f.height)
    for (let l = 0; l < LEVELS; l++)
      for (let x = 0; x < cols; x++) {
        const v = 1 - Math.exp(-w[l * cols + x] * gain)
        const o = ((LEVELS - 1 - l) * cols + x) * 4
        img.data[o] = 40 + 180 * v
        img.data[o + 1] = 60 + 195 * v
        img.data[o + 2] = 40 + 160 * v
        img.data[o + 3] = 255
      }
    ctx.putImageData(img, 0, 0)
    ctx.fillStyle = 'rgba(255,255,255,.25)'
    for (const q of [0.25, 0.5, 0.75]) ctx.fillRect(0, Math.round(LEVELS * (1 - q)), cols, 1)
    return
  }
  const S = 128
  c.width = S
  c.height = S
  const v = vectorscope(f.data, S)
  const img = ctx.createImageData(S, S)
  const gain = 40 / Math.max(1, f.width * f.height)
  for (let i = 0; i < S * S; i++) {
    const k = 1 - Math.exp(-v[i] * gain * 60)
    img.data[i * 4] = 20 + 200 * k
    img.data[i * 4 + 1] = 24 + 220 * k
    img.data[i * 4 + 2] = 30 + 180 * k
    img.data[i * 4 + 3] = 255
  }
  ctx.putImageData(img, 0, 0)
  ctx.strokeStyle = 'rgba(255,255,255,.3)'
  ctx.beginPath()
  ctx.arc(S / 2, S / 2, S / 2 - 1, 0, Math.PI * 2)
  ctx.stroke()
  ctx.font = '9px sans-serif'
  ctx.fillStyle = 'rgba(255,255,255,.6)'
  for (const t of VECTOR_TARGETS) {
    const x = S / 2 + t.cb * (S - 1)
    const y = S / 2 - t.cr * (S - 1)
    ctx.strokeRect(x - 3, y - 3, 6, 6)
    ctx.fillText(t.name, x + 4, y - 4)
  }
}

/** The frame the preview shows now, small (null when nothing can be read). */
export function previewFrame(): Frame | null {
  const el = document.querySelector<HTMLElement>('[data-ps-stage="preview"]')
  const stage = el ? STAGES.get(el) : undefined
  return stage?.snapshot(W) ?? null
}

export function Scopes() {
  const [mode, setMode] = useState<ScopeMode>(readMode)
  const playhead = useThrottledPlayhead()
  const project = useEditor((s) => s.project)
  const canvas = useRef<HTMLCanvasElement>(null)
  const [summary, setSummary] = useState<string | null>(null)
  useEffect(() => {
    // a seek's frame arrives a moment later: read it then, and once more after
    const read = () => {
      const f = previewFrame()
      if (!f) return setSummary(null)
      if (canvas.current) draw(canvas.current, mode, f)
      setSummary(describeFrame(f))
    }
    read()
    const a = window.setTimeout(read, 150)
    const b = window.setTimeout(read, 600)
    return () => {
      window.clearTimeout(a)
      window.clearTimeout(b)
    }
  }, [mode, playhead, project])
  const pick = (m: ScopeMode) => {
    setMode(m)
    try {
      localStorage.setItem(KEY, m)
    } catch {
      /* not kept */
    }
  }
  const name = MODES.find((m) => m.id === mode)!.name
  return (
    <div className="ed-scopes">
      <div className="ed-seg sm" role="group" aria-label="Scope">
        {MODES.map((m) => (
          <button key={m.id} type="button" aria-pressed={m.id === mode} className={clsx(m.id === mode && 'on')} onClick={() => pick(m.id)}>
            {m.name}
          </button>
        ))}
      </div>
      <canvas ref={canvas} className={clsx('ed-scope', mode)} role="img" aria-label={summary ? `${name}: ${summary}` : `${name}: no picture under the playhead`} />
      <p className="ed-note" aria-live="polite">{summary ?? 'No picture under the playhead to read.'}</p>
    </div>
  )
}

