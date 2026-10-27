// Stock footage from Pexels (free; the server's PEXELS_API_KEY, not the workspace's AI keys).
//   searchStock   – GET https://api.pexels.com/v1/videos/search (Authorization: <key>), orientation from the aspect;
//                   clips at least minSeconds long first (Pexels' relevance order kept within each group); per clip
//                   the mp4 rendition whose short side is closest to 1080. Author + page URLs come back because
//                   Pexels asks apps to credit the creator and link to Pexels.
//   downloadStock – streams that rendition to outDir. Only Pexels / Vimeo https hosts are fetched (the clip may come
//                   from a request body), capped at the upload size limit.
// Limits: 200 requests an hour, 20,000 a month per key (pexels.com/api/documentation).
import fs from 'node:fs'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { ctx } from '../../context'
import { HttpError, invalid } from '../../http'
import { CancelledError } from '../../jobs/worker'
import { log } from '../../log'
import { describeFile, genDeps, outFile } from './capabilities'
import type { GenAspect, GeneratedFile, StockClip } from './index'

const SEARCH_URL = 'https://api.pexels.com/v1/videos/search'
const PER_PAGE = 40
const TARGET_SHORT_SIDE = 1080
const ORIENTATION: Record<GenAspect, string> = { '16:9': 'landscape', '9:16': 'portrait', '1:1': 'square' }
/** Hosts Pexels serves video files from. */
const MEDIA_HOSTS = [/(^|\.)pexels\.com$/, /^player\.vimeo\.com$/, /(^|\.)vimeocdn\.com$/]

interface PexelsFile {
  id?: number
  quality?: string | null
  file_type?: string | null
  width?: number | null
  height?: number | null
  fps?: number | null
  link?: string | null
}
interface PexelsVideo {
  id: number
  width?: number
  height?: number
  url?: string
  image?: string
  duration?: number
  user?: { id?: number; name?: string; url?: string }
  video_files?: PexelsFile[]
}

const notSetUp = () => new HttpError(503, 'server', 'Stock footage isn’t set up on this server (it needs a free Pexels API key).')

function abortedError(err: unknown, signal?: AbortSignal) {
  return signal?.aborted || (err instanceof Error && err.name === 'AbortError')
}

/** The mp4 rendition whose short side is closest to 1080 (the larger one on a tie). */
export function pickRendition(files: PexelsFile[]): (PexelsFile & { width: number; height: number; link: string }) | undefined {
  let best: (PexelsFile & { width: number; height: number; link: string }) | undefined
  let bestScore = Infinity
  for (const f of files) {
    if (f.file_type !== 'video/mp4' || !f.link || !f.width || !f.height) continue
    const short = Math.min(f.width, f.height)
    const score = Math.abs(short - TARGET_SHORT_SIDE) - (short >= TARGET_SHORT_SIDE ? 0.5 : 0)
    if (score < bestScore) {
      bestScore = score
      best = f as PexelsFile & { width: number; height: number; link: string }
    }
  }
  return best
}

export async function searchStock(opts: { query: string; aspect: GenAspect; minSeconds?: number; signal?: AbortSignal }): Promise<StockClip[]> {
  const key = ctx().config.pexelsApiKey
  if (!key) throw notSetUp()
  const query = opts.query.trim().slice(0, 200)
  if (!query) throw invalid('Describe the footage to search for.')
  const url = `${SEARCH_URL}?${new URLSearchParams({ query, orientation: ORIENTATION[opts.aspect], per_page: String(PER_PAGE) })}`
  let res: Response
  try {
    res = await genDeps().fetch(url, { headers: { Authorization: key, Accept: 'application/json' }, signal: opts.signal })
  } catch (err) {
    if (abortedError(err, opts.signal)) throw new CancelledError()
    throw new HttpError(502, 'server', 'Could not reach Pexels for stock footage. Try again.')
  }
  if (res.status === 401 || res.status === 403) {
    log.warn('pexels rejected the server key', { status: res.status })
    throw new HttpError(503, 'server', 'Stock footage isn’t available right now (the server’s Pexels key was rejected).')
  }
  if (res.status === 429) throw new HttpError(429, 'quota', 'Stock footage search is busy (Pexels’ hourly limit). Try again in a few minutes.')
  if (!res.ok) throw new HttpError(502, 'server', `Stock footage search failed (Pexels ${res.status}). Try again.`)
  let body: { videos?: PexelsVideo[] }
  try {
    body = (await res.json()) as { videos?: PexelsVideo[] }
  } catch {
    throw new HttpError(502, 'server', 'Pexels sent an unreadable answer. Try again.')
  }
  const clips: StockClip[] = []
  for (const v of body.videos ?? []) {
    const f = pickRendition(v.video_files ?? [])
    if (!f || !v.url) continue
    clips.push({
      id: String(v.id),
      url: f.link,
      previewImage: v.image ?? '',
      width: f.width,
      height: f.height,
      duration: v.duration ?? 0,
      author: v.user?.name ?? 'Pexels',
      authorUrl: v.user?.url ?? 'https://www.pexels.com',
      pageUrl: v.url,
    })
  }
  const min = opts.minSeconds ?? 0
  // stable: long-enough clips first, each group still in Pexels' relevance order
  return [...clips.filter((c) => c.duration >= min), ...clips.filter((c) => c.duration < min)]
}

export async function downloadStock(clip: StockClip, outDir: string, signal?: AbortSignal): Promise<GeneratedFile> {
  let u: URL
  try {
    u = new URL(clip.url)
  } catch {
    throw invalid('That stock clip has no valid address.')
  }
  if (u.protocol !== 'https:' || !MEDIA_HOSTS.some((re) => re.test(u.hostname))) throw invalid('Stock clips can only be downloaded from Pexels.')
  let res: Response
  try {
    res = await genDeps().fetch(u.toString(), { signal, redirect: 'follow' })
  } catch (err) {
    if (abortedError(err, signal)) throw new CancelledError()
    throw new HttpError(502, 'server', 'Could not download the stock clip from Pexels. Try again.')
  }
  if (!res.ok || !res.body) throw new HttpError(502, 'server', `Could not download the stock clip from Pexels (${res.status}).`)
  const type = (res.headers.get('content-type') ?? '').split(';')[0].trim()
  if (type && !/^(video\/|application\/octet-stream$|binary\/octet-stream$)/.test(type)) throw new HttpError(502, 'server', 'Pexels sent something that isn’t a video.')
  const max = ctx().config.maxUploadBytes
  const declared = Number(res.headers.get('content-length') ?? 0)
  if (declared > max) throw new HttpError(413, 'invalid', 'That stock clip is larger than this server accepts.')
  const file = outFile(outDir, `stock-${clip.id.replace(/[^\w-]/g, '').slice(0, 24) || 'clip'}`, 'mp4')
  let seen = 0
  const cap = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      seen += chunk.length
      cb(seen > max ? new HttpError(413, 'invalid', 'That stock clip is larger than this server accepts.') : null, chunk)
    },
  })
  try {
    await pipeline(Readable.fromWeb(res.body as import('node:stream/web').ReadableStream<Uint8Array>), cap, fs.createWriteStream(file), signal ? { signal } : {})
  } catch (err) {
    await fs.promises.rm(file, { force: true })
    if (abortedError(err, signal)) throw new CancelledError()
    if (err instanceof HttpError) throw err
    throw new HttpError(502, 'server', 'The stock clip download was interrupted. Try again.')
  }
  const info = await describeFile(file, signal)
  return { file, mime: 'video/mp4', provider: 'pexels', model: 'stock', width: info.width ?? clip.width, height: info.height ?? clip.height }
}
