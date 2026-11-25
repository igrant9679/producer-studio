// A stock photo or clip is looked at before a video uses it (24 Nov 2026: a real run put a water tower in a scene that
// searched for "person stretching by window morning"). The libraries and the AI are stand-ins here; ffmpeg is real.
import fs from 'node:fs'
import path from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { ctx } from '../context'
import { type AiProvider, setProvider } from '../ai/provider'
import { STOCK, STOCK_LOOKS, findStock, searchesFor, shortReason, stockCheckPrompt } from '../ai/stock-check'
import { inlineContext } from '../jobs/worker'
import { ffmpeg } from '../media/proc'
import { setup } from './helpers'

const real = { ...STOCK }
let work = ''
const scene = { headline: 'Quiet before screens', narration: 'Take a quiet moment before the screens come on.' }
const jc = () => inlineContext({ id: 'j_stock', kind: 'ai.produce.assemble', workspaceId: 'ws_stock', userId: 'u', projectId: null, input: {} })

/** A library's results: `n` pictures from `source`, named by their index. */
const results = (source: 'openverse' | 'commons', n: number, from = 0) =>
  Array.from({ length: n }, (_, i) => ({ id: `${source}-${from + i}`, url: `https://example/${source}/${from + i}.jpg`, pageUrl: `https://example/${source}/${from + i}`, author: `Author ${from + i}`, authorUrl: '', previewImage: '', duration: 0, width: 1920, height: 1080, kind: 'photo' as const, source, ...(source === 'openverse' ? { licence: 'CC BY 2.0' } : {}) }))

beforeAll(async () => {
  await setup()
  work = path.join(ctx().config.dataDir, 'stock-check')
  fs.mkdirSync(work, { recursive: true })
}, 60_000)
afterEach(() => {
  Object.assign(STOCK, real)
  setProvider(undefined)
})
afterAll(() => Object.assign(STOCK, real))

/** Stand-in download: a small picture (or clip) on disk per result. */
function downloads(video = false) {
  const got: string[] = []
  STOCK.download = (async (pick: { id: string }) => {
    got.push(pick.id)
    const file = path.join(work, `${pick.id}.${video ? 'mp4' : 'jpg'}`)
    if (video) await ffmpeg(['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=24:duration=2', '-pix_fmt', 'yuv420p', '-c:v', 'libx264', file])
    else await ffmpeg(['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=teal:size=640x360', '-frames:v', '1', file])
    return { file, mime: video ? 'video/mp4' : 'image/jpeg', provider: 'openverse', model: pick.id }
  }) as typeof STOCK.download
  return got
}

describe('a stock picture for a scene', () => {
  it('passes over the ones that don’t show what was searched for, and uses the first that does, with its credit', async () => {
    const searched: string[][] = []
    STOCK.search = (async (o: { skip?: string[] }) => (searched.push([...(o.skip ?? [])]), results('openverse', 4))) as typeof STOCK.search
    const got = downloads()
    const looked: Array<{ query: string; picture: string }> = []
    STOCK.shows = async (o) => {
      looked.push({ query: o.query, picture: o.picture })
      return looked.length < 3 ? { shows: false, reason: looked.length === 1 ? 'a water tower' : 'a city street' } : { shows: true, reason: 'a woman stretching by a window' }
    }
    const r = await findStock(jc(), { workspaceId: 'ws_stock', photo: true, query: 'person stretching by window morning', aspect: '16:9', seconds: 6, scene, work })
    expect(got).toEqual(['openverse-0', 'openverse-1', 'openverse-2'])
    expect(r.file.model).toBe('openverse-2')
    expect(r.credit).toMatchObject({ author: 'Author 2', url: 'https://example/openverse/2', licence: 'CC BY 2.0' })
    // what it passed over is kept with the one it used
    expect(r.passedOver).toEqual(['a water tower', 'a city street'])
    // each was looked at as a small JPEG
    for (const l of looked) expect(fs.readFileSync(l.picture).subarray(0, 2).toString('hex')).toBe('ffd8')
    expect(searched).toEqual([[]])
    // the ones passed over are gone from disk
    await new Promise((res) => setTimeout(res, 50))
    expect(fs.existsSync(path.join(work, 'openverse-0.jpg'))).toBe(false)
  })

  it('tries the next library, looks at no more than six, then says none showed it', async () => {
    const searched: string[][] = []
    STOCK.search = (async (o: { skip?: string[] }) => {
      searched.push([...(o.skip ?? [])])
      return o.skip?.includes('openverse') ? results('commons', 4, 10) : results('openverse', 4)
    }) as typeof STOCK.search
    downloads()
    let looks = 0
    STOCK.shows = async () => (looks++, { shows: false, reason: 'a water tower' })
    const err = await findStock(jc(), { workspaceId: 'ws_stock', photo: true, query: 'person stretching by window morning', aspect: '16:9', seconds: 6, scene, work }).catch((e: Error) => e)
    expect(looks).toBe(STOCK_LOOKS)
    expect(searched).toEqual([[], ['openverse']])
    expect((err as Error).message).toBe('none of the 6 stock photos found showed “person stretching by window morning” (a water tower; a water tower; a water tower)')
  })

  it('tries shorter searches when one finds nothing, and still judges them against the whole search (24 Nov)', async () => {
    const asked: string[] = []
    STOCK.search = (async (o: { query: string }) => (asked.push(o.query), o.query === 'baker selling' ? results('openverse', 2) : [])) as typeof STOCK.search
    downloads()
    const judged: string[] = []
    STOCK.shows = async (o) => (judged.push(o.query), { shows: true, reason: 'a baker at a market stall' })
    const r = await findStock(jc(), { workspaceId: 'ws_stock', photo: true, query: 'baker selling bread market stall', aspect: '16:9', seconds: 6, scene, work })
    expect(r.file.model).toBe('openverse-0')
    expect(asked).toEqual(['baker selling bread market stall', 'baker selling bread market', 'baker selling bread', 'baker selling'])
    expect(judged).toEqual(['baker selling bread market stall'])
    expect(searchesFor('farmers market vegetable crates')).toEqual(['farmers market vegetable crates', 'farmers market vegetable', 'farmers market'])
    expect(searchesFor('rain')).toEqual(['rain'])
  })

  it('keeps what a picture showed short, ending on a whole word', () => {
    expect(shortReason('Historic stone water tower in a park with lampposts; no person stretching by a window')).toBe('Historic stone water tower in a park with lampposts')
    expect(shortReason('A wide aerial view of a sprawling industrial harbour full of cranes, containers and ships at dusk')).toBe('A wide aerial view of a sprawling industrial harbour full of…')
    expect(shortReason('a water tower')).toBe('a water tower')
  })

  it('uses the first that downloads when there is no AI to look, as before', async () => {
    STOCK.search = (async () => results('openverse', 3)) as typeof STOCK.search
    const got = downloads()
    STOCK.shows = async () => null
    const r = await findStock(jc(), { workspaceId: 'ws_stock', photo: true, query: 'farmer in a wheat field', aspect: '16:9', seconds: 6, scene, work })
    expect(got).toEqual(['openverse-0'])
    expect(r.file.model).toBe('openverse-0')
  })

  it('looks at a clip by a frame from its first seconds', async () => {
    STOCK.search = (async () => results('openverse', 2)) as typeof STOCK.search
    downloads(true)
    const pictures: string[] = []
    STOCK.shows = async (o) => (pictures.push(o.picture), { shows: true, reason: 'a test pattern' })
    await findStock(jc(), { workspaceId: 'ws_stock', photo: false, query: 'city traffic night', aspect: '16:9', seconds: 6, scene, work })
    expect(pictures).toHaveLength(1)
    expect(fs.readFileSync(pictures[0]).subarray(0, 2).toString('hex')).toBe('ffd8')
  })
})

describe('the AI’s look', () => {
  const picture = () => {
    const file = path.join(work, 'look.jpg')
    return ffmpeg(['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=gray:size=320x180', '-frames:v', '1', file]).then(() => file)
  }

  it('shows the AI the picture with the search and the scene, briefly, and reads its verdict', async () => {
    const asked: Array<{ prompt: string; images: Array<{ mediaType: string; data: string }>; effort?: string }> = []
    setProvider({
      id: 'anthropic-key',
      status: async () => ({ available: true, detail: 'fake', model: 'fake' }),
      write: async () => '',
      runAgent: async () => ({ text: '' }),
      structured: (async (req: { prompt: string; images: Array<{ mediaType: string; data: string }>; effort?: string }) => (asked.push(req), { shows: false, reason: 'a water tower' })) as AiProvider['structured'],
    } as AiProvider)
    const v = await STOCK.shows({ workspaceId: 'ws_stock', picture: await picture(), photo: true, query: 'person stretching by window morning', scene, signal: new AbortController().signal })
    expect(v).toEqual({ shows: false, reason: 'a water tower' })
    expect(asked[0].prompt).toBe(stockCheckPrompt({ photo: true, query: 'person stretching by window morning', scene }))
    expect(asked[0].prompt).toContain('"person stretching by window morning"')
    expect(asked[0].prompt).toContain('Take a quiet moment before the screens come on.')
    expect(asked[0].images).toHaveLength(1)
    expect(asked[0].images[0].mediaType).toBe('image/jpeg')
    expect(asked[0].effort).toBe('low')
  })

  it('has no verdict when the AI fails or there is none', async () => {
    setProvider({
      id: 'anthropic-key',
      status: async () => ({ available: true, detail: 'fake', model: 'fake' }),
      write: async () => '',
      runAgent: async () => ({ text: '' }),
      structured: (async () => {
        throw new Error('overloaded')
      }) as AiProvider['structured'],
    } as AiProvider)
    expect(await STOCK.shows({ workspaceId: 'ws_stock', picture: await picture(), photo: true, query: 'q', scene, signal: new AbortController().signal })).toBeNull()
    setProvider({ id: 'none', status: async () => ({ available: false, detail: 'no key' }), write: async () => '', runAgent: async () => ({ text: '' }), structured: (async () => ({})) as AiProvider['structured'] } as unknown as AiProvider)
    expect(await STOCK.shows({ workspaceId: 'ws_stock', picture: await picture(), photo: true, query: 'q', scene, signal: new AbortController().signal })).toBeNull()
  })
})
