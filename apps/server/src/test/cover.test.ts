// A branded cover (22 Nov 2026, the owner: branding is "the Narrative Text, Titles, Thumbnail, company stamp/logo"):
// the code that paints it, run here against a stand-in canvas (the real one runs in the export's sandboxed browser,
// which this machine's tests don't start), and its size.
import { describe, expect, it } from 'vitest'
import { coverCode, coverSize } from '../render/cover'

/** A canvas context that records what is drawn; text is measured at 0.55 em a character. */
function fakeCtx() {
  const calls: Array<{ op: string; args: unknown[]; font?: string; fill?: unknown }> = []
  const state = { font: '', fillStyle: '' as unknown }
  const ctx = {
    get font() {
      return state.font
    },
    set font(v: string) {
      state.font = v
    },
    get fillStyle() {
      return state.fillStyle
    },
    set fillStyle(v: unknown) {
      state.fillStyle = v
    },
    shadowColor: '',
    shadowBlur: 0,
    textBaseline: '',
    measureText: (s: string) => ({ width: s.length * (Number(/(\d+)px/.exec(state.font)?.[1]) || 10) * 0.55 }),
    createLinearGradient: () => ({ addColorStop: () => undefined }),
    fillRect: (...args: unknown[]) => calls.push({ op: 'fillRect', args, fill: state.fillStyle }),
    fillText: (...args: unknown[]) => calls.push({ op: 'fillText', args, font: state.font, fill: state.fillStyle }),
    drawImage: (...args: unknown[]) => calls.push({ op: 'drawImage', args }),
  }
  return { ctx, calls }
}

function paint(o: Parameters<typeof coverCode>[0], images: Record<string, { width: number; height: number }> = {}) {
  const draw = new Function(`${coverCode(o)}\n;return draw`)() as (ctx: unknown, t: number, env: unknown) => void
  const { ctx, calls } = fakeCtx()
  draw(ctx, 0, { W: 1280, H: 720, fonts: { headline: 'Montserrat', body: 'Inter' }, image: (n: string) => images[n] })
  return calls
}

describe('a branded cover', () => {
  it('draws the frame, the title in the brand’s headline font in at most two lines, the accent bar and the brand’s name while it has no logo', () => {
    const calls = paint({ title: 'Morning ritual: the perfect pour, step by step, for every coffee lover', name: 'Northwind', accent: '#ff5a5f' }, { frame: { width: 1920, height: 1080 } })
    expect(calls[0]).toMatchObject({ op: 'drawImage', args: [{ width: 1920, height: 1080 }, 0, 0, 1280, 720] })
    const title = calls.filter((c) => c.op === 'fillText' && String(c.args[0]) !== 'Northwind')
    expect(title.length).toBeGreaterThan(0)
    expect(title.length).toBeLessThanOrEqual(2)
    expect(title.map((c) => c.args[0]).join(' ')).toBe('Morning ritual: the perfect pour, step by step, for every coffee lover')
    expect(title[0].font).toMatch(/^900 \d+px "Montserrat"/)
    for (const c of title) expect(c.args[1]).toBeCloseTo(1280 * 0.06, 3)
    expect(calls.some((c) => c.op === 'fillRect' && c.fill === '#ff5a5f')).toBe(true)
    const stamp = calls.find((c) => c.op === 'fillText' && c.args[0] === 'Northwind')!
    expect(Number(stamp.args[1])).toBeGreaterThan(1280 / 2)
  })

  it('stamps the logo top right instead of the name when the brand has one', () => {
    const calls = paint({ title: 'Launch day', name: '', accent: '#35e0ff' }, { frame: { width: 1280, height: 720 }, logo: { width: 400, height: 200 } })
    const logo = calls.filter((c) => c.op === 'drawImage')[1]
    expect(logo.args[0]).toEqual({ width: 400, height: 200 })
    const [, x, y, w] = logo.args as number[]
    expect(x + w).toBeLessThan(1280)
    expect(x).toBeGreaterThan(1280 / 2)
    expect(y).toBeLessThan(720 / 4)
    expect(calls.some((c) => c.op === 'fillText' && c.args[0] === '')).toBe(false)
  })

  it('is 720 px on its short side, in the export’s shape', () => {
    expect(coverSize(1920, 1080)).toEqual({ width: 1280, height: 720 })
    expect(coverSize(1080, 1920)).toEqual({ width: 720, height: 1280 })
    expect(coverSize(1080, 1080)).toEqual({ width: 720, height: 720 })
  })
})
