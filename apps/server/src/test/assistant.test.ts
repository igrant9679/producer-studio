import { describe, expect, it } from 'vitest'
import { addAsset, addItem, createAudioItem, createProject, createVideoItem, findItem, projectDuration, type Asset, type Project, type Transcript } from '@producer/core'
import { ASSISTANT_SYSTEM, toolSpecs } from '../ai/assistant'
import { writeRequestParams } from '../ai/claude'
import { buildScriptPrompt, syntheticTranscript, validateScript } from '../ai/produce'
import { TOOL_SCHEMAS, ToolError, runTool, timelineSummary, type ToolEnv, type ToolState } from '../ai/tools'

const transcript: Transcript = {
  language: 'en',
  engine: 'test',
  segments: [
    {
      start: 0,
      end: 6,
      text: 'Hello um this is the demo uh of the product',
      words: [
        { w: 'Hello', start: 0.2, end: 0.6 },
        { w: 'um', start: 0.7, end: 1.0 },
        { w: 'this', start: 1.1, end: 1.3 },
        { w: 'is', start: 1.35, end: 1.5 },
        { w: 'the', start: 1.55, end: 1.7 },
        { w: 'demo', start: 1.75, end: 2.2 },
        { w: 'uh', start: 3.5, end: 3.8 },
        { w: 'of', start: 3.9, end: 4.0 },
        { w: 'the', start: 4.05, end: 4.2 },
        { w: 'product', start: 4.25, end: 4.9 },
      ],
    },
  ],
}

const clip: Asset = { id: 'as_clip', kind: 'video', name: 'clip.mp4', src: '/api/media/as_clip/source', duration: 10, width: 1920, height: 1080, hasAudio: true, silences: [{ start: 2.3, end: 3.4 }] }

function makeState(): ToolState {
  let p: Project = createProject({ name: 'T' })
  p = addAsset(p, clip)
  p = addItem(p, createVideoItem(clip, 0, { id: 'v_1', duration: 10 }))
  return { project: p, playhead: 2, selection: ['v_1'], changes: [] }
}

const env: ToolEnv = {
  transcribe: async () => transcript,
  tts: async (text) => ({ asset: { id: 'as_tts', kind: 'audio', name: 'vo', src: '/api/media/as_tts/source', duration: 2.5, transcript: syntheticTranscript(text, 2.5) }, duration: 2.5 }),
}

describe('assistant tools', () => {
  it('get_timeline returns a compact summary', async () => {
    const s = makeState()
    const r = await runTool(s, 'get_timeline', {}, env)
    const j = JSON.parse(r.result)
    expect(j.canvas).toMatchObject({ width: 1920, height: 1080 })
    expect(j.tracks[0]).toMatchObject({ main: true, items: [{ id: 'v_1', type: 'video', start: 0, end: 10 }] })
    expect(j.selection).toEqual(['v_1'])
    expect(s.changes).toHaveLength(0)
  })

  it('split_at, trim_item, delete_items and move_item apply core ops', async () => {
    const s = makeState()
    await runTool(s, 'split_at', { time: 4 }, env)
    const main = s.project.tracks.find((t) => t.main)!
    expect(main.items).toHaveLength(2)
    const right = main.items[1]
    expect(right).toMatchObject({ start: 4, duration: 6, in: 4 })
    await runTool(s, 'trim_item', { itemId: 'v_1', edge: 'end', time: 3 }, env)
    expect(projectDuration(s.project)).toBe(9) // main track ripples
    await runTool(s, 'delete_items', { itemIds: ['v_1'] }, env)
    expect(s.project.tracks.find((t) => t.main)!.items.map((i) => i.id)).toEqual([right.id])
    expect(s.changes).toHaveLength(3)
  })

  it('add_text, update_text_style, add_animation, add_transition, set_item_properties', async () => {
    const s = makeState()
    const r = await runTool(s, 'add_text', { text: 'Hello world', start: 1, duration: 2, position: 'top', template: 'title-bold' }, env)
    const id = JSON.parse(r.result).itemId
    const f = findItem(s.project, id)!
    expect(f.track.kind).toBe('text')
    expect(f.item).toMatchObject({ type: 'text', text: 'Hello world', start: 1, duration: 2 })
    expect((f.item as { transform: { y: number } }).transform.y).toBeLessThan(0)
    await runTool(s, 'update_text_style', { itemId: id, color: '#ff0000', fontFamily: 'Poppins', background: { color: '#000000', opacity: 0.5 } }, env)
    const styled = findItem(s.project, id)!.item as { style: { color: string; fontFamily: string; background?: { opacity: number } } }
    expect(styled.style).toMatchObject({ color: '#ff0000', fontFamily: 'Poppins', background: { opacity: 0.5 } })
    await runTool(s, 'add_animation', { itemId: id, which: 'in', preset: 'pop', duration: 0.4 }, env)
    expect((findItem(s.project, id)!.item as { animations: { in?: { preset: string } } }).animations.in?.preset).toBe('pop')
    await runTool(s, 'add_transition', { itemId: 'v_1', type: 'dipBlack', duration: 0.6 }, env)
    expect((findItem(s.project, 'v_1')!.item as { transitionOut?: { type: string } }).transitionOut?.type).toBe('dipBlack')
    await runTool(s, 'set_item_properties', { itemId: 'v_1', speed: 2, opacity: 0.8, filter: { id: 'noir', intensity: 80 } }, env)
    const v = findItem(s.project, 'v_1')!.item as { speed: number; duration: number; opacity: number; filter?: { id: string } }
    expect(v).toMatchObject({ speed: 2, duration: 5, opacity: 0.8, filter: { id: 'noir' } })
    await runTool(s, 'set_keyframe', { itemId: 'v_1', prop: 'scale', time: 1, value: 1.2 }, env)
    expect((findItem(s.project, 'v_1')!.item as { keyframes: { scale?: unknown[] } }).keyframes.scale).toHaveLength(1)
    await runTool(s, 'add_effect', { itemId: 'v_1', type: 'grain', intensity: 40 }, env)
    expect((findItem(s.project, 'v_1')!.item as { effects: Array<{ type: string }> }).effects.map((e) => e.type)).toEqual(['grain'])
  })

  it('captions, silence and filler removal use transcripts (transcribing when missing)', async () => {
    const s = makeState()
    await runTool(s, 'generate_captions', { preset: 'karaoke' }, env)
    const cap = s.project.tracks.find((t) => t.kind === 'caption')!
    expect(cap.items.length).toBeGreaterThan(0)
    expect(cap.captionStyle?.preset).toBe('karaoke')
    await runTool(s, 'set_caption_style', { position: 0.5, maxWordsPerLine: 3 }, env)
    expect(s.project.tracks.find((t) => t.kind === 'caption')!.captionStyle).toMatchObject({ position: 0.5, maxWordsPerLine: 3 })

    const before = projectDuration(s.project)
    await runTool(s, 'remove_filler_words', { itemId: 'v_1' }, env)
    expect(projectDuration(s.project)).toBeLessThan(before)

    const s2 = makeState()
    await runTool(s2, 'remove_silences', { itemId: 'v_1', minGap: 0.5 }, env)
    expect(projectDuration(s2.project)).toBeLessThan(10)

    const s3 = makeState()
    const tr = JSON.parse((await runTool(s3, 'get_transcript', { itemId: 'v_1' }, env)).result)
    expect(tr.words.map((w: { w: string }) => w.w)).toContain('demo')
    await runTool(s3, 'cut_transcript_ranges', { itemId: 'v_1', ranges: [{ start: 1.75, end: 2.2 }] }, env)
    expect(projectDuration(s3.project)).toBeCloseTo(10 - 0.45, 1)
  })

  it('aspect ratio, voiceover, separate audio and freeze frame', async () => {
    const s = makeState()
    await runTool(s, 'set_aspect_ratio', { ratio: '9:16' }, env)
    expect(s.project).toMatchObject({ width: 1080, height: 1920 })
    const vo = JSON.parse((await runTool(s, 'add_voiceover', { text: 'Welcome to the demo.', start: 1 }, env)).result)
    const audio = findItem(s.project, vo.itemId)!
    expect(audio.track.kind).toBe('audio')
    expect(audio.item).toMatchObject({ type: 'audio', start: 1, duration: 2.5, tts: { text: 'Welcome to the demo.' } })
    expect(s.project.assets.as_tts).toBeDefined()
    await runTool(s, 'separate_audio', { itemId: 'v_1' }, env)
    expect((findItem(s.project, 'v_1')!.item as { muted?: boolean }).muted).toBe(true)
    await runTool(s, 'freeze_frame', { itemId: 'v_1', time: 5, hold: 1.5 }, env)
    const frozen = s.project.tracks.find((t) => t.main)!.items.find((i) => (i as { freezeAt?: number }).freezeAt !== undefined)
    expect(frozen).toMatchObject({ duration: 1.5, freezeAt: 5 })
  })

  it('rejects invalid input and unknown ids with ToolError (model-fixable)', async () => {
    const s = makeState()
    await expect(runTool(s, 'trim_item', { itemId: 'v_1', edge: 'middle', time: 1 }, env)).rejects.toBeInstanceOf(ToolError)
    await expect(runTool(s, 'move_item', { itemId: 'nope', start: 1 }, env)).rejects.toThrow(/No item/)
    await expect(runTool(s, 'add_transition', { itemId: 'v_1', type: 'explode' }, env)).rejects.toBeInstanceOf(ToolError)
    await expect(runTool(s, 'set_caption_style', { position: 0.2 }, env)).rejects.toThrow(/generate_captions/)
    await expect(runTool(s, 'no_such_tool', {}, env)).rejects.toThrow(/Unknown tool/)
    expect(s.changes).toHaveLength(0)
  })

  it('tool definitions are valid JSON-schema tools covering every schema', () => {
    const defs = toolSpecs()
    expect(defs.map((d) => d.name).sort()).toEqual(Object.keys(TOOL_SCHEMAS).sort())
    for (const d of defs) {
      expect(d.inputSchema.type).toBe('object')
      expect(typeof d.description).toBe('string')
      expect(d.description.length).toBeGreaterThan(10)
    }
    const trim = defs.find((d) => d.name === 'trim_item')!
    expect((trim.inputSchema as { required?: string[] }).required).toEqual(expect.arrayContaining(['itemId', 'edge', 'time']))
    expect(ASSISTANT_SYSTEM).toMatch(/magnetic/)
    expect(ASSISTANT_SYSTEM).toMatch(/CENTRE/)
    expect(timelineSummary(makeState()).duration).toBe(10)
  })
})

describe('prompt building (no network)', () => {
  it('writeRequestParams uses the model, adaptive thinking and no sampling params', () => {
    const p = writeRequestParams('headline', 'Launch video for Tableau Next', 'B2B audience', 6) as Record<string, unknown>
    expect(p.model).toBe('claude-opus-5')
    expect(p.thinking).toEqual({ type: 'adaptive' })
    expect(p).not.toHaveProperty('temperature')
    expect(p).not.toHaveProperty('top_p')
    expect(JSON.stringify(p.messages)).toMatch(/under 6 words/)
  })

  it('buildScriptPrompt includes brief, transcript windows and asset ids; validateScript clamps windows', () => {
    const prompt = buildScriptPrompt({
      brief: { title: 'Pipeline analytics', audience: 'Sales leaders', goal: 'Show the dashboard', tone: 'warm', template: 'studio-dark', voice: 'af_heart', aspect: '16:9' },
      sources: [{ id: 'as_1', name: 'rec.mp4', duration: 30, transcript, sheet: { interval: 2, frames: 15 } }],
      rules: 'RULES-TEXT',
      example: 'EXAMPLE-TEXT',
    })
    expect(prompt).toContain('Pipeline analytics')
    expect(prompt).toContain('as_1')
    expect(prompt).toContain('[0.0–6.0] Hello um this is the demo')
    expect(prompt).toContain('RULES-TEXT')
    expect(prompt).toContain('frame k (row-major, from 0) shows second 2·k')
    const scenes = validateScript(
      {
        message: 'm',
        scenes: [
          { id: 'x', title: 'Hook', headline: 'Pipeline at a glance', narration: 'Every deal in one place.', footage: [{ assetId: 'as_1', start: 25, end: 45, note: '' }, { assetId: 'as_unknown', start: 0, end: 5, note: '' }], visuals: '' },
          { id: 'y', title: 'Close', headline: 'Thanks', narration: 'That is it.', footage: [{ assetId: 'as_1', start: 12, end: 12.1, note: '' }], visuals: '' },
        ],
      },
      new Map([['as_1', 30]]),
    )
    expect(scenes.map((s) => s.id)).toEqual(['s01', 's02'])
    expect(scenes[0].footage).toEqual([{ assetId: 'as_1', start: 25, end: 30 }])
    expect(scenes[1].footage[0].end - scenes[1].footage[0].start).toBeCloseTo(2)
  })

  it('syntheticTranscript spreads words across the voice duration', () => {
    const t = syntheticTranscript('One two three four.', 2)
    const w = t.segments[0].words
    expect(w).toHaveLength(4)
    expect(w[0].start).toBeGreaterThanOrEqual(0)
    expect(w[3].end).toBeLessThanOrEqual(2)
  })
})

// keep the import used for type-only helpers
void createAudioItem
