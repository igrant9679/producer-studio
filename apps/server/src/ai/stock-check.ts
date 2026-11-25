// A stock photo or clip is looked at before a video uses it (24 Nov 2026). A real run asked the free libraries for
// "person stretching by window morning" and put a photo of a water tower in the scene: a search returns what its
// words match in a picture's title and tags, not what the picture shows. The space's AI (the server's key, or the
// space's own) now looks at each one (a clip by a frame from its first seconds) and says whether it shows what the
// scene searched for; one that doesn't is passed over for the next, up to STOCK_LOOKS a scene. Without an AI the
// first that downloads is used, as before.
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import * as z from 'zod/v4'
import type { MediaCredit, ScriptScene } from '@producer/core'
import { HttpError } from '../http'
import type { JobContext } from '../jobs/worker'
import { log } from '../log'
import { ffmpeg } from '../media/proc'
import { SOURCE_NAMES, type StockSource, downloadStock, searchStock } from './generate'
import { requireProvider } from './provider'

/** The most stock pictures the AI looks at for one scene (each look is one small AI call). */
export const STOCK_LOOKS = 6

export const StockVerdictSchema = z.object({
  shows: z.boolean().describe('true when the picture’s main subject is what the search names (or plainly the same thing) and it fits the scene; false otherwise'),
  reason: z.string().describe('What the picture shows, in at most eight words, e.g. "a stone water tower in a park"'),
})
export type StockVerdict = z.infer<typeof StockVerdictSchema>

const SYSTEM =
  'You check stock pictures for a video editor. A narrated video’s scene searched a free stock library; you are shown one result. Judge only whether it shows what was searched for, the way a viewer would see it. Be strict about the subject and generous about style, framing and quality.'

/** The prompt the AI answers for one picture. */
export function stockCheckPrompt(o: { photo: boolean; query: string; scene: Pick<ScriptScene, 'headline' | 'narration'> }): string {
  return `The scene needs a stock ${o.photo ? 'photo' : 'video clip'}${o.photo ? '' : ' (you see one frame of it)'}.
The search was: "${o.query}"
The scene's headline: "${o.scene.headline}"
What the narrator says over it: "${o.scene.narration}"

Does the picture plainly show what was searched for, so that it fits this scene? shows=true when its main subject is what the search names, or clearly the same thing. shows=false when it shows something else: a different subject, a building, object or landscape when people or an action were asked for, a logo, text, a diagram or a map, even when it is a good picture.`
}

/** Test hooks: what searches, downloads and looks. */
export const STOCK = {
  search: searchStock,
  download: downloadStock,
  /** The AI's verdict on a picture (a JPEG file), or null when there is no AI to ask or it couldn't answer. */
  async shows(o: { workspaceId: string; picture: string; photo: boolean; query: string; scene: Pick<ScriptScene, 'headline' | 'narration'>; signal: AbortSignal }): Promise<StockVerdict | null> {
    let provider: Awaited<ReturnType<typeof requireProvider>>
    try {
      provider = await requireProvider(o.workspaceId, 'script')
    } catch {
      return null
    }
    try {
      const out = await provider.structured({
        system: SYSTEM,
        prompt: stockCheckPrompt(o),
        images: [{ label: 'The picture found:', mediaType: 'image/jpeg', data: fs.readFileSync(o.picture).toString('base64') }],
        schema: StockVerdictSchema,
        signal: o.signal,
        effort: 'low',
      })
      return StockVerdictSchema.parse(out)
    } catch (err) {
      if (o.signal.aborted) throw err
      log.warn('stock check: the AI could not look at a picture', { query: o.query, err })
      return null
    }
  },
}

/**
 * A search and the shorter ones tried after it when it finds nothing to use (its last words dropped, down to two). The
 * free libraries match every word against titles and tags, so on 24 Nov "baker selling bread market stall" found
 * nothing at all; the AI's look, which judges against the whole search and the scene, keeps broader results honest.
 */
export function searchesFor(query: string): string[] {
  const words = query.trim().split(/\s+/).filter(Boolean)
  const out: string[] = []
  for (let n = words.length; n >= Math.min(2, words.length); n--) out.push(words.slice(0, n).join(' '))
  return out
}

/** What the AI said a picture shows, short: its first clause, at most 60 characters, ending on a whole word. */
export function shortReason(reason: string): string {
  const first = reason.split(/[;.]/)[0].replace(/\s+/g, ' ').trim()
  if (first.length <= 60) return first
  const cut = first.slice(0, 60)
  // a cut that falls between two words keeps the word before it
  const space = first[60] === ' ' ? 60 : cut.lastIndexOf(' ')
  return `${(space > 30 ? cut.slice(0, space) : cut).replace(/[,:\s]+$/, '')}…`
}

/** A small JPEG of a downloaded photo, or of a clip's most typical frame in its first seconds. */
async function lookAt(file: string, photo: boolean, work: string, signal: AbortSignal): Promise<string | null> {
  const out = path.join(work, `look-${crypto.randomBytes(4).toString('hex')}.jpg`)
  const pick = photo ? ['-vf', 'scale=512:-2'] : ['-t', '8', '-vf', 'thumbnail=48,scale=512:-2']
  try {
    await ffmpeg(['-y', '-v', 'error', '-i', file, ...pick, '-frames:v', '1', '-q:v', '5', out], { signal })
    return fs.existsSync(out) ? out : null
  } catch (err) {
    if (signal.aborted) throw err
    return null
  }
}

/**
 * A stock photo or clip for a scene that shows what it searched for: each library in turn, its first results
 * downloaded and looked at until one shows it, then shorter searches (searchesFor) while looks are left. Throws (and
 * the scene stands in another way) when none does.
 */
export async function findStock(
  jc: Pick<JobContext, 'signal' | 'progress' | 'check'>,
  o: { workspaceId: string; photo: boolean; query: string; aspect: Parameters<typeof searchStock>[0]['aspect']; seconds: number; scene: Pick<ScriptScene, 'headline' | 'narration'>; work: string },
): Promise<{ file: { file: string; mime: string; provider: string; model: string }; credit: MediaCredit; passedOver: string[] }> {
  const what = o.photo ? 'photo' : 'footage'
  jc.progress(0.05, o.photo ? 'Searching stock photos' : 'Searching stock footage')
  let lastErr: unknown
  const passed: string[] = []
  // a result looked at under one search isn't looked at again under a shorter one
  const seen = new Set<string>()
  let looks = 0
  let searched = false
  for (const query of searchesFor(o.query)) {
    if (looks >= STOCK_LOOKS) break
    const skip: StockSource[] = []
    for (let round = 0; round < 4 && looks < STOCK_LOOKS; round++) {
      const results = await STOCK.search({ query, aspect: o.aspect, media: o.photo ? 'photo' : 'video', minSeconds: Math.min(20, o.seconds), signal: jc.signal, skip }).catch((err) => {
        if (jc.signal.aborted || (!lastErr && !passed.length && !searched)) throw err
        return []
      })
      searched = true
      if (!results.length) break
      skip.push(results[0].source ?? 'pexels')
      const found = results.filter((r) => !seen.has(r.url))
      jc.progress(0.3, o.photo ? 'Finding a photo that fits' : 'Finding footage that fits')
      for (const pick of found.slice(0, 4)) {
        if (looks >= STOCK_LOOKS) break
        seen.add(pick.url)
        let got: { file: string; mime: string; provider: string; model: string }
        try {
          got = await STOCK.download(pick, o.work, jc.signal)
        } catch (err) {
          if (jc.signal.aborted) throw err
          lastErr = err
          continue
        }
        const picture = await lookAt(got.file, o.photo, o.work, jc.signal)
        const verdict = picture ? await STOCK.shows({ workspaceId: o.workspaceId, picture, photo: o.photo, query: o.query, scene: o.scene, signal: jc.signal }) : null
        jc.check()
        if (verdict) looks++
        if (verdict && !verdict.shows) {
          passed.push(shortReason(verdict.reason))
          fs.rm(got.file, { force: true }, () => undefined)
          continue
        }
        const credit: MediaCredit = { author: pick.author, url: pick.pageUrl, source: SOURCE_NAMES[pick.source ?? 'pexels'], ...(pick.licence ? { licence: pick.licence } : {}) }
        return { file: got, credit, passedOver: passed }
      }
    }
  }
  if (passed.length) throw new HttpError(404, 'not_found', `none of the ${passed.length} stock ${o.photo ? 'photos' : 'clips'} found showed “${o.query}” (${passed.slice(0, 3).join('; ')})`)
  throw lastErr ?? new HttpError(404, 'not_found', `no stock ${what} matched “${o.query}”`)
}
