// Stock clips and photos for videos made without recordings, from free libraries, tried in order until one has a match:
//   Pexels            – the server's PEXELS_API_KEY (free). Videos: /v1/videos/search, the mp4 rendition whose short
//                       side is closest to 1080; photos: /v1/search. Pexels asks apps to credit the creator and link
//                       to Pexels (shown in the app; the licence needs no credit in the video).
//                       Limits: 200 requests an hour, 20,000 a month per key (pexels.com/api/documentation).
//   Pixabay           – the server's PIXABAY_API_KEY (free). /api/videos/ and /api/; the Pixabay Content License needs
//                       no credit. Limits: 100 requests a minute; photos up to 1280 px on a standard key.
//   Openverse         – no key (WordPress's open-source catalogue of openly licensed images, api.openverse.org);
//                       photos only, licences that allow commercial use and changes; the file comes through
//                       Openverse's own image endpoint, so only its host is fetched. Anonymous use is throttled and has
//                       been seen to 504: a failure moves on to the next library.
//   Wikimedia Commons – no key (commons.wikimedia.org/w/api.php, with a User-Agent as Wikimedia's policy asks).
//                       Clips (WebM / Ogg, made into an mp4 proxy like any upload) and photos (a 1920 px rendition).
// Openverse and Commons are on unless FREE_MEDIA=off. Their CC BY and CC BY-SA files carry `licence`, and the scene
// shows a credit line for them; CC0 and public-domain files, like Pexels and Pixabay, need none.
// A clip whose short side is under 480 px, or a file larger than the upload limit, is skipped.
import fs from 'node:fs'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { ctx } from '../../context'
import { HttpError, invalid } from '../../http'
import { CancelledError } from '../../jobs/worker'
import { log } from '../../log'
import { describeFile, genDeps, outFile } from './capabilities'
import type { GenAspect, GeneratedFile, StockClip, StockMedia, StockSource } from './index'

const PEXELS_VIDEOS = 'https://api.pexels.com/v1/videos/search'
const PEXELS_PHOTOS = 'https://api.pexels.com/v1/search'
const PIXABAY_VIDEOS = 'https://pixabay.com/api/videos/'
const PIXABAY_PHOTOS = 'https://pixabay.com/api/'
const OPENVERSE = 'https://api.openverse.org/v1/images/'
const COMMONS = 'https://commons.wikimedia.org/w/api.php'
const PER_PAGE = 40
/** A library that hasn't answered a search by then is passed over (anonymous Openverse has been seen to hang). */
const SEARCH_TIMEOUT_MS = 15_000
const TARGET_SHORT_SIDE = 1080
const MIN_SHORT_SIDE = 480
const PEXELS_ORIENTATION: Record<GenAspect, string> = { '16:9': 'landscape', '9:16': 'portrait', '1:1': 'square' }
const PIXABAY_ORIENTATION: Record<GenAspect, string> = { '16:9': 'horizontal', '9:16': 'vertical', '1:1': 'all' }
const OPENVERSE_ASPECT: Record<GenAspect, string> = { '16:9': 'wide', '9:16': 'tall', '1:1': 'square' }
export const USER_AGENT = 'ProducerStudio/1.0 (https://producerstudio.app; video editor stock search)'

export const SOURCE_NAMES: Record<StockSource, string> = { pexels: 'Pexels', pixabay: 'Pixabay', openverse: 'Openverse', commons: 'Wikimedia Commons' }

/** Hosts each library serves files from (a clip may come from a request body, so nothing else is fetched). */
const MEDIA_HOSTS: Record<StockSource, RegExp[]> = {
  pexels: [/(^|\.)pexels\.com$/, /^player\.vimeo\.com$/, /(^|\.)vimeocdn\.com$/],
  pixabay: [/^(cdn\.)?pixabay\.com$/],
  // Openverse's own image endpoint, and the hosts most of its files live on (fetched direct: the endpoint is a proxy
  // that has been seen to fail on large originals)
  openverse: [/^api\.openverse\.org$/, /^live\.staticflickr\.com$/, /^farm\d+\.staticflickr\.com$/, /^upload\.wikimedia\.org$/],
  commons: [/^(upload|thumb)\.wikimedia\.org$/],
}

/** The libraries searched for this kind of media here, in order. */
export function stockSources(media: StockMedia): StockSource[] {
  const c = ctx().config
  const out: StockSource[] = []
  if (c.pexelsApiKey) out.push('pexels')
  if (c.pixabayApiKey) out.push('pixabay')
  if (c.freeMedia) out.push(...(media === 'photo' ? (['openverse', 'commons'] as const) : (['commons'] as const)))
  return out
}

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
interface PexelsPhoto {
  id: number
  width?: number
  height?: number
  url?: string
  photographer?: string
  photographer_url?: string
  src?: { original?: string; large?: string; medium?: string }
}

const notSetUp = () => new HttpError(503, 'server', 'Stock footage isn’t set up on this server (it needs a free Pexels or Pixabay API key, or the free libraries turned on).')

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

/** GET a library's JSON, with its errors as plain messages (`name` is how the person knows the library). */
async function getJson<T>(url: string, name: string, headers: Record<string, string>, signal?: AbortSignal): Promise<T> {
  let res: Response
  const timeout = AbortSignal.timeout(SEARCH_TIMEOUT_MS)
  try {
    res = await genDeps().fetch(url, { headers: { Accept: 'application/json', ...headers }, signal: signal ? AbortSignal.any([signal, timeout]) : timeout })
  } catch (err) {
    if (signal?.aborted) throw new CancelledError()
    if (timeout.aborted) throw new HttpError(502, 'server', `${name} didn’t answer in time. Try again.`)
    if (abortedError(err, signal)) throw new CancelledError()
    throw new HttpError(502, 'server', `Could not reach ${name} for stock media. Try again.`)
  }
  if (res.status === 401 || res.status === 403) {
    log.warn('a stock library rejected the request', { name, status: res.status })
    throw new HttpError(503, 'server', `Stock media isn’t available right now (the server’s ${name} key was rejected).`)
  }
  if (res.status === 429) throw new HttpError(429, 'quota', `Stock media search is busy (${name}’s limit). Try again in a few minutes.`)
  if (!res.ok) throw new HttpError(502, 'server', `Stock media search failed (${name} ${res.status}). Try again.`)
  try {
    return (await res.json()) as T
  } catch {
    throw new HttpError(502, 'server', `${name} sent an unreadable answer. Try again.`)
  }
}

const fitsAspect = (w: number, h: number, aspect: GenAspect) => (aspect === '16:9' ? w >= h : aspect === '9:16' ? h >= w : true)

async function searchPexels(query: string, media: StockMedia, aspect: GenAspect, signal?: AbortSignal): Promise<StockClip[]> {
  const key = ctx().config.pexelsApiKey!
  const qs = new URLSearchParams({ query, orientation: PEXELS_ORIENTATION[aspect], per_page: String(PER_PAGE) })
  const clips: StockClip[] = []
  if (media === 'video') {
    const body = await getJson<{ videos?: PexelsVideo[] }>(`${PEXELS_VIDEOS}?${qs}`, 'Pexels', { Authorization: key }, signal)
    for (const v of body.videos ?? []) {
      const f = pickRendition(v.video_files ?? [])
      if (!f || !v.url) continue
      clips.push({
        id: String(v.id),
        kind: 'video',
        source: 'pexels',
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
    return clips
  }
  const body = await getJson<{ photos?: PexelsPhoto[] }>(`${PEXELS_PHOTOS}?${qs}`, 'Pexels', { Authorization: key }, signal)
  for (const p of body.photos ?? []) {
    if (!p.src?.original || !p.url || !p.width || !p.height) continue
    // Pexels resizes on request: 2400 px on the long side is plenty for a 1080p frame with a slow zoom
    const sep = p.src.original.includes('?') ? '&' : '?'
    const scale = Math.min(1, 2400 / Math.max(p.width, p.height))
    clips.push({
      id: String(p.id),
      kind: 'photo',
      source: 'pexels',
      url: `${p.src.original}${sep}auto=compress&cs=tinysrgb&w=${Math.round(p.width * scale)}`,
      previewImage: p.src.medium ?? p.src.large ?? '',
      width: Math.round(p.width * scale),
      height: Math.round(p.height * scale),
      duration: 0,
      author: p.photographer ?? 'Pexels',
      authorUrl: p.photographer_url ?? 'https://www.pexels.com',
      pageUrl: p.url,
    })
  }
  return clips
}

interface PixabayRendition {
  url?: string
  width?: number
  height?: number
  thumbnail?: string
}
interface PixabayHit {
  id: number
  pageURL?: string
  user?: string
  user_id?: number
  duration?: number
  videos?: Record<string, PixabayRendition>
  largeImageURL?: string
  webformatURL?: string
  imageWidth?: number
  imageHeight?: number
}

async function searchPixabay(query: string, media: StockMedia, aspect: GenAspect, signal?: AbortSignal): Promise<StockClip[]> {
  const key = ctx().config.pixabayApiKey!
  const q = query.slice(0, 100)
  const author = (h: PixabayHit) => ({ author: h.user || 'Pixabay', authorUrl: h.user && h.user_id ? `https://pixabay.com/users/${encodeURIComponent(h.user)}-${h.user_id}/` : 'https://pixabay.com' })
  const clips: StockClip[] = []
  if (media === 'video') {
    const qs = new URLSearchParams({ key, q, safesearch: 'true', per_page: String(PER_PAGE) })
    const body = await getJson<{ hits?: PixabayHit[] }>(`${PIXABAY_VIDEOS}?${qs}`, 'Pixabay', {}, signal)
    for (const h of body.hits ?? []) {
      // the rendition whose short side is closest to 1080
      const all = Object.values(h.videos ?? {}).filter((r): r is Required<Pick<PixabayRendition, 'url' | 'width' | 'height'>> & PixabayRendition => !!r.url && !!r.width && !!r.height)
      const f = pickRendition(all.map((r) => ({ file_type: 'video/mp4', link: r.url, width: r.width, height: r.height })))
      if (!f || !h.pageURL || !fitsAspect(f.width, f.height, aspect)) continue
      clips.push({ id: String(h.id), kind: 'video', source: 'pixabay', url: f.link, previewImage: all.find((r) => r.thumbnail)?.thumbnail ?? '', width: f.width, height: f.height, duration: h.duration ?? 0, ...author(h), pageUrl: h.pageURL })
    }
    return clips
  }
  const qs = new URLSearchParams({ key, q, image_type: 'photo', orientation: PIXABAY_ORIENTATION[aspect], safesearch: 'true', per_page: String(PER_PAGE) })
  const body = await getJson<{ hits?: PixabayHit[] }>(`${PIXABAY_PHOTOS}?${qs}`, 'Pixabay', {}, signal)
  for (const h of body.hits ?? []) {
    if (!h.largeImageURL || !h.pageURL || !h.imageWidth || !h.imageHeight) continue
    // largeImageURL is at most 1280 px on the long side
    const scale = Math.min(1, 1280 / Math.max(h.imageWidth, h.imageHeight))
    clips.push({ id: String(h.id), kind: 'photo', source: 'pixabay', url: h.largeImageURL, previewImage: h.webformatURL ?? '', width: Math.round(h.imageWidth * scale), height: Math.round(h.imageHeight * scale), duration: 0, ...author(h), pageUrl: h.pageURL })
  }
  return clips
}

/** "by", "4.0" → "CC BY 4.0"; nothing for a licence that needs no credit (CC0, public domain). */
export function creditLicence(code: string, version?: string): string | undefined {
  const c = code.trim().toLowerCase()
  if (c === 'by' || c === 'by-sa') return `CC ${c.toUpperCase()}${version ? ` ${version}` : ''}`
  return undefined
}

interface OpenverseImage {
  id: string
  title?: string
  creator?: string | null
  creator_url?: string | null
  license?: string
  license_version?: string | null
  foreign_landing_url?: string | null
  width?: number | null
  height?: number | null
  thumbnail?: string | null
  url?: string | null
  mature?: boolean
}

function openverseFile(r: OpenverseImage): string {
  try {
    const u = new URL(r.url ?? '')
    if (u.protocol === 'https:' && MEDIA_HOSTS.openverse.slice(1).some((re) => re.test(u.hostname))) return u.toString()
  } catch {
    // no usable original address
  }
  return `${OPENVERSE}${r.id}/thumb/?full_size=true&compressed=true`
}

async function searchOpenverse(query: string, aspect: GenAspect, signal?: AbortSignal): Promise<StockClip[]> {
  // commercial use and changes allowed: CC0, public domain, CC BY, CC BY-SA
  const qs = new URLSearchParams({ q: query, license_type: 'commercial,modification', aspect_ratio: OPENVERSE_ASPECT[aspect], size: 'large', mature: 'false', page_size: '20' })
  const body = await getJson<{ results?: OpenverseImage[] }>(`${OPENVERSE}?${qs}`, 'Openverse', { 'User-Agent': USER_AGENT }, signal)
  const clips: StockClip[] = []
  for (const r of body.results ?? []) {
    if (!r.id || !/^[\w-]{8,64}$/.test(r.id) || r.mature || !r.license || !['cc0', 'pdm', 'by', 'by-sa'].includes(r.license)) continue
    const w = r.width ?? 0
    const h = r.height ?? 0
    if (w && h && Math.min(w, h) < MIN_SHORT_SIDE) continue
    const licence = creditLicence(r.license, r.license_version ?? undefined)
    clips.push({
      id: r.id,
      kind: 'photo',
      source: 'openverse',
      // the original where it lives when that's a host we fetch from, else through Openverse's own endpoint
      url: openverseFile(r),
      previewImage: r.thumbnail ?? '',
      width: w,
      height: h,
      duration: 0,
      author: r.creator?.trim() || 'Unknown',
      authorUrl: /^https:\/\//.test(r.creator_url ?? '') ? r.creator_url! : r.foreign_landing_url ?? 'https://openverse.org',
      pageUrl: /^https:\/\//.test(r.foreign_landing_url ?? '') ? r.foreign_landing_url! : `https://openverse.org/image/${r.id}`,
      ...(licence ? { licence } : {}),
    })
  }
  return clips
}

interface CommonsPage {
  title: string
  index?: number
  imageinfo?: Array<{
    url?: string
    thumburl?: string
    width?: number
    height?: number
    thumbwidth?: number
    thumbheight?: number
    size?: number
    duration?: number
    mime?: string
    descriptionurl?: string
    extmetadata?: Record<string, { value?: string }>
  }>
}

/** Plain text from a Commons metadata field (it holds HTML: links, spans). */
const plain = (html: string | undefined) =>
  (html ?? '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&[a-z]+;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

/** A Commons licence name → what the video must credit ('' = no credit needed), or undefined when it isn't free enough. */
export function commonsLicence(name: string): string | undefined {
  const n = name.trim()
  if (/^(cc0|cc-zero|public domain|pd\b|pdm|pd-)/i.test(n)) return ''
  const m = n.match(/^cc[ -]by(-sa)?[ -]?(\d(\.\d)?)?/i)
  if (m && !/\bnc\b|\bnd\b|-nc|-nd/i.test(n)) return `CC BY${m[1] ? '-SA' : ''}${m[2] ? ` ${m[2]}` : ''}`
  return undefined
}

async function searchCommons(query: string, media: StockMedia, aspect: GenAspect, signal?: AbortSignal): Promise<StockClip[]> {
  const qs = new URLSearchParams({
    action: 'query',
    format: 'json',
    formatversion: '1',
    generator: 'search',
    gsrsearch: `${query} filetype:${media === 'video' ? 'video' : 'bitmap'}`,
    gsrnamespace: '6',
    gsrlimit: '30',
    prop: 'imageinfo',
    iiprop: 'url|size|mime|extmetadata',
    iiurlwidth: '1920',
    iiextmetadatafilter: 'LicenseShortName|Artist|Restrictions',
    origin: '*',
  })
  const body = await getJson<{ query?: { pages?: Record<string, CommonsPage> } }>(`${COMMONS}?${qs}`, 'Wikimedia Commons', { 'User-Agent': USER_AGENT }, signal)
  const pages = Object.values(body.query?.pages ?? {}).sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
  const max = ctx().config.maxUploadBytes
  const clips: StockClip[] = []
  for (const p of pages) {
    const ii = p.imageinfo?.[0]
    if (!ii?.url || !ii.width || !ii.height || !ii.descriptionurl) continue
    const meta = ii.extmetadata ?? {}
    // trademarks, personality rights and the like: not for a video someone publishes
    if (plain(meta.Restrictions?.value)) continue
    const licence = commonsLicence(plain(meta.LicenseShortName?.value))
    if (licence === undefined) continue
    const mime = ii.mime ?? ''
    if (media === 'video' ? !/^(video\/(webm|ogg|mp4)|application\/ogg)$/.test(mime) : !/^image\/(jpeg|png|webp)$/.test(mime)) continue
    if (Math.min(ii.width, ii.height) < MIN_SHORT_SIDE || !fitsAspect(ii.width, ii.height, aspect)) continue
    if ((ii.size ?? 0) > max) continue
    const photo = media === 'photo'
    const url = photo && ii.thumburl ? ii.thumburl : ii.url
    clips.push({
      id: p.title.replace(/^File:/, '').slice(0, 120),
      kind: media,
      source: 'commons',
      url,
      previewImage: ii.thumburl ?? '',
      width: photo && ii.thumbwidth ? ii.thumbwidth : ii.width,
      height: photo && ii.thumbheight ? ii.thumbheight : ii.height,
      duration: ii.duration ?? 0,
      author: plain(meta.Artist?.value).slice(0, 120) || 'Wikimedia Commons contributor',
      authorUrl: ii.descriptionurl,
      pageUrl: ii.descriptionurl,
      ...(licence ? { licence } : {}),
    })
  }
  return clips
}

/**
 * Clips or photos for a search, from the first library (in stockSources order) with a match. A library that fails
 * (down, over its limit, its key rejected) is skipped; the first failure is thrown when none had anything.
 */
export async function searchStock(opts: { query: string; aspect: GenAspect; media?: StockMedia; minSeconds?: number; signal?: AbortSignal; skip?: StockSource[] }): Promise<StockClip[]> {
  const media = opts.media ?? 'video'
  const query = opts.query.trim().slice(0, 200)
  if (!query) throw invalid(media === 'video' ? 'Describe the footage to search for.' : 'Describe the photo to search for.')
  const sources = stockSources(media).filter((s) => !opts.skip?.includes(s))
  if (!sources.length) throw notSetUp()
  let failure: unknown
  for (const source of sources) {
    let clips: StockClip[]
    try {
      clips =
        source === 'pexels'
          ? await searchPexels(query, media, opts.aspect, opts.signal)
          : source === 'pixabay'
            ? await searchPixabay(query, media, opts.aspect, opts.signal)
            : source === 'openverse'
              ? await searchOpenverse(query, opts.aspect, opts.signal)
              : await searchCommons(query, media, opts.aspect, opts.signal)
    } catch (err) {
      if (err instanceof CancelledError || opts.signal?.aborted) throw err instanceof CancelledError ? err : new CancelledError()
      log.warn('stock search failed; trying the next library', { source, error: err instanceof Error ? err.message : String(err) })
      failure ??= err
      continue
    }
    if (!clips.length) continue
    const min = opts.minSeconds ?? 0
    // stable: long-enough clips first, each group still in the library's relevance order
    return media === 'video' ? [...clips.filter((c) => c.duration >= min), ...clips.filter((c) => c.duration < min)] : clips
  }
  if (failure) throw failure
  return []
}

const EXT: Record<string, string> = { 'video/mp4': 'mp4', 'video/webm': 'webm', 'video/ogg': 'ogv', 'application/ogg': 'ogv', 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' }

export async function downloadStock(clip: StockClip, outDir: string, signal?: AbortSignal): Promise<GeneratedFile> {
  const source: StockSource = clip.source ?? 'pexels'
  const name = SOURCE_NAMES[source] ?? 'the library'
  const kind: StockMedia = clip.kind ?? 'video'
  let u: URL
  try {
    u = new URL(clip.url)
  } catch {
    throw invalid('That stock clip has no valid address.')
  }
  if (u.protocol !== 'https:' || !(MEDIA_HOSTS[source] ?? []).some((re) => re.test(u.hostname))) throw invalid(`Stock media can only be downloaded from ${name}.`)
  let res: Response
  try {
    res = await genDeps().fetch(u.toString(), { signal, redirect: 'follow', headers: { 'User-Agent': USER_AGENT } })
  } catch (err) {
    if (abortedError(err, signal)) throw new CancelledError()
    throw new HttpError(502, 'server', `Could not download the stock ${kind === 'video' ? 'clip' : 'photo'} from ${name}. Try again.`)
  }
  if (!res.ok || !res.body) throw new HttpError(502, 'server', `Could not download the stock ${kind === 'video' ? 'clip' : 'photo'} from ${name} (${res.status}).`)
  // redirects (Openverse's image endpoint) must stay on the library's hosts too
  if (res.url) {
    const final = new URL(res.url)
    if (final.protocol !== 'https:' || !(MEDIA_HOSTS[source] ?? []).some((re) => re.test(final.hostname))) throw new HttpError(502, 'server', `${name} sent the file from somewhere else.`)
  }
  const type = (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase()
  const fallback = kind === 'video' ? 'video/mp4' : 'image/jpeg'
  const mime = EXT[type] ? type : !type || /^(application|binary)\/octet-stream$/.test(type) ? fallback : ''
  if (!mime || (kind === 'video' ? mime.startsWith('image/') : !mime.startsWith('image/'))) throw new HttpError(502, 'server', `${name} sent something that isn’t a ${kind === 'video' ? 'video' : 'photo'}.`)
  const max = ctx().config.maxUploadBytes
  const tooBig = () => new HttpError(413, 'invalid', `That stock ${kind === 'video' ? 'clip' : 'photo'} is larger than this server accepts.`)
  const declared = Number(res.headers.get('content-length') ?? 0)
  if (declared > max) throw tooBig()
  const file = outFile(outDir, `stock-${clip.id.replace(/[^\w-]/g, '').slice(0, 24) || 'clip'}`, EXT[mime])
  let seen = 0
  const cap = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      seen += chunk.length
      cb(seen > max ? tooBig() : null, chunk)
    },
  })
  try {
    await pipeline(Readable.fromWeb(res.body as import('node:stream/web').ReadableStream<Uint8Array>), cap, fs.createWriteStream(file), signal ? { signal } : {})
  } catch (err) {
    await fs.promises.rm(file, { force: true })
    if (abortedError(err, signal)) throw new CancelledError()
    if (err instanceof HttpError) throw err
    throw new HttpError(502, 'server', `The stock ${kind === 'video' ? 'clip' : 'photo'} download was interrupted. Try again.`)
  }
  const info = await describeFile(file, signal)
  return { file, mime, provider: source, model: 'stock', width: info.width ?? clip.width, height: info.height ?? clip.height }
}
