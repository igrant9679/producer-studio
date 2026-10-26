// Scene visuals in the Producer wizard (videos made from an idea): labels, defaults, and the plain-text form people
// edit diagrams in (one item per line). Pure — unit-tested in __tests__.
import type { DiagramType, SceneDiagram, SceneVisual, VisualKind } from '@producer/core'

export const VISUAL_KIND_INFO: Record<Exclude<VisualKind, 'footage'>, { label: string; hint: string }> = {
  motion: { label: 'Animated text', hint: 'The headline and a few points animate in as they’re said' },
  diagram: { label: 'Diagram', hint: 'Steps, a cycle, a chart or a comparison, built as it’s explained' },
  image: { label: 'AI image', hint: 'A generated picture with a slow pan and zoom' },
  stock: { label: 'Stock footage', hint: 'A real video clip found for the scene' },
  aiVideo: { label: 'AI video clip', hint: 'A generated moving shot (slow, and billed per second)' },
}

export const DIAGRAM_INFO: Record<DiagramType, { label: string; placeholder: string }> = {
  steps: { label: 'Steps', placeholder: 'One step per line\nPlan\nBuild\nShip' },
  cycle: { label: 'Cycle', placeholder: 'One stage per line\nListen\nLearn\nImprove' },
  hub: { label: 'Hub and parts', placeholder: 'Centre on the first line, then one part per line\nPlatform\nData\nApps\nPeople' },
  bars: { label: 'Bar chart', placeholder: 'Label: number, one per line\n2024: 40\n2025: 65' },
  compare: { label: 'Comparison', placeholder: 'Left title, its points, a line with ---, then the right side\nBefore\nManual\n---\nAfter\nAutomatic' },
  timeline: { label: 'Timeline', placeholder: 'Label: detail, one per line\nJanuary: Kickoff\nMarch: Beta' },
  stat: { label: 'Big number', placeholder: 'The figure on the first line, what it means on the second\n3x\nfaster onboarding' },
}

/** Lines of text → a diagram of `type`, or an error to show (nothing is drawn until it parses). */
export function diagramFromText(type: DiagramType, text: string): { diagram?: SceneDiagram; error?: string } {
  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
  const need = (n: number, what: string) => ({ error: `Add at least ${n} ${what}, one per line` })
  switch (type) {
    case 'steps':
      return lines.length >= 2 ? { diagram: { type, items: lines.slice(0, 6) } } : need(2, 'steps')
    case 'cycle':
      return lines.length >= 3 ? { diagram: { type, items: lines.slice(0, 6) } } : need(3, 'stages')
    case 'hub':
      return lines.length >= 3 ? { diagram: { type, center: lines[0], items: lines.slice(1, 7) } } : { error: 'Put the centre on the first line, then at least 2 parts' }
    case 'bars': {
      const items = lines.map((l) => {
        const m = l.match(/^(.+?)\s*[:=]\s*(-?[\d.,]+)\s*(%|[a-z$€£]+)?$/i)
        return m ? { label: m[1].trim(), value: Number(m[2].replace(/,/g, '')), unit: m[3] } : null
      })
      if (items.some((i) => !i || !Number.isFinite(i.value))) return { error: 'Write each bar as “label: number”' }
      const ok = items as Array<{ label: string; value: number; unit?: string }>
      if (ok.length < 2) return need(2, 'bars')
      const unit = ok.find((i) => i.unit)?.unit
      return { diagram: { type, items: ok.slice(0, 6).map(({ label, value }) => ({ label, value })), ...(unit ? { unit } : {}) } }
    }
    case 'compare': {
      const split = lines.findIndex((l) => /^-{3,}$/.test(l))
      if (split < 1 || split >= lines.length - 1) return { error: 'Write the left side, a line with ---, then the right side' }
      const left = lines.slice(0, split)
      const right = lines.slice(split + 1)
      return { diagram: { type, left: { title: left[0], points: left.slice(1, 5) }, right: { title: right[0], points: right.slice(1, 5) } } }
    }
    case 'timeline': {
      if (lines.length < 2) return need(2, 'points')
      return {
        diagram: {
          type,
          items: lines.slice(0, 6).map((l) => {
            const i = l.indexOf(':')
            return i > 0 ? { label: l.slice(0, i).trim(), detail: l.slice(i + 1).trim() || undefined } : { label: l }
          }),
        },
      }
    }
    case 'stat':
      return lines.length ? { diagram: { type, value: lines[0], label: lines.slice(1).join(' ') } } : { error: 'Put the figure on the first line' }
  }
}

/** A diagram as the lines diagramFromText reads back. */
export function diagramToText(d: SceneDiagram): string {
  switch (d.type) {
    case 'steps':
    case 'cycle':
      return d.items.join('\n')
    case 'hub':
      return [d.center, ...d.items].join('\n')
    case 'bars':
      return d.items.map((b, i) => `${b.label}: ${b.value}${i === 0 && d.unit ? d.unit : ''}`).join('\n')
    case 'compare':
      return [d.left.title, ...d.left.points, '---', d.right.title, ...d.right.points].join('\n')
    case 'timeline':
      return d.items.map((t) => (t.detail ? `${t.label}: ${t.detail}` : t.label)).join('\n')
    case 'stat':
      return [d.value, d.label].filter(Boolean).join('\n')
  }
}

/** A fresh visual of `kind` for a scene (keeping what can carry over, e.g. its headline as the first point). */
export function defaultVisual(kind: Exclude<VisualKind, 'footage'>, scene: { headline: string; narration: string }): SceneVisual {
  switch (kind) {
    case 'motion':
      return { kind, points: [] }
    case 'diagram':
      return { kind, diagram: { type: 'steps', items: ['First', 'Then', 'Finally'] } }
    case 'image':
      return { kind, prompt: scene.headline ? `An image that shows: ${scene.headline}` : '' }
    case 'stock':
      return { kind, query: scene.headline.split(/\s+/).slice(0, 4).join(' ') }
    case 'aiVideo':
      return { kind, prompt: scene.headline ? `A cinematic shot that shows: ${scene.headline}` : '' }
  }
}

/** Editing what a generated visual asks for means it must be made again: drop the made asset. */
export function withPrompt(v: SceneVisual, text: string): SceneVisual {
  if (v.kind === 'image' || v.kind === 'aiVideo') return text === v.prompt ? v : { kind: v.kind, prompt: text }
  if (v.kind === 'stock') return text === v.query ? v : { kind: 'stock', query: text }
  return v
}
