// Illustrations for animation scenes, from Iconify's open-source colour sets (api.iconify.design, no key, free):
//   fluent-emoji       – Microsoft Fluent Emoji, colour (MIT)
//   fluent-emoji-flat  – the same, flat (MIT)
//   noto               – Google Noto Emoji (Apache 2.0)
// None of these licences asks for credit in the video. Sets that would (Twemoji CC BY, OpenMoji CC BY-SA) are left out.
// The SVG is drawn to a 1024 px transparent PNG with sharp (librsvg), so the editor and the export draw it like any
// image. Iconify's public API has two mirrors, tried in turn when it can't be reached.
import fs from 'node:fs'
import { ctx } from '../../context'
import { HttpError } from '../../http'
import { CancelledError } from '../../jobs/worker'
import { log } from '../../log'
import { genDeps, outFile } from './capabilities'

export const ICON_SETS = ['fluent-emoji', 'fluent-emoji-flat', 'noto'] as const
const HOSTS = ['https://api.iconify.design', 'https://api.simplesvg.com', 'https://api.unisvg.com']
const PNG_SIZE = 1024
const MAX_SVG_BYTES = 512 * 1024
/** Which host answered last (tried first next time). */
let live = 0

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')

async function get(pathAndQuery: string, accept: string, signal?: AbortSignal): Promise<Response | null> {
  for (let i = 0; i < HOSTS.length; i++) {
    const host = HOSTS[(live + i) % HOSTS.length]
    try {
      const timeout = AbortSignal.timeout(10_000)
      const res = await genDeps().fetch(`${host}${pathAndQuery}`, { headers: { Accept: accept }, signal: signal ? AbortSignal.any([signal, timeout]) : timeout })
      if (res.status >= 500) continue
      live = (live + i) % HOSTS.length
      return res
    } catch (err) {
      if (signal?.aborted) throw new CancelledError()
      log.warn('iconify unreachable; trying a mirror', { host, error: err instanceof Error ? err.message : String(err) })
    }
  }
  return null
}

/**
 * The best illustration for a word or two ("rocket", "money bag"): an exact name in the preferred set first, then the
 * search's order with the preferred sets first. Tries the whole phrase, then its last word, then its first.
 */
export async function findIllustration(name: string, signal?: AbortSignal): Promise<{ icon: string; svg: string } | null> {
  if (!ctx().config.freeMedia) return null
  const phrase = name.trim().toLowerCase().slice(0, 60)
  if (!phrase) return null
  const words = phrase.split(/\s+/).filter((w) => w.length > 1)
  const tries = [...new Set([phrase, words.at(-1), words[0]].filter((x): x is string => !!x))]
  for (const q of tries) {
    const res = await get(`/search?${new URLSearchParams({ query: q, limit: '64', prefixes: ICON_SETS.join(',') })}`, 'application/json', signal)
    if (!res?.ok) continue
    let body: { icons?: string[] }
    try {
      body = (await res.json()) as { icons?: string[] }
    } catch {
      continue
    }
    const found = (body.icons ?? []).filter((id) => /^[a-z0-9-]+:[a-z0-9-]+$/.test(id) && (ICON_SETS as readonly string[]).includes(id.split(':')[0]))
    if (!found.length) continue
    const want = slug(q)
    const rank = (id: string) => {
      const [set, icon] = id.split(':')
      const exact = icon === want ? 0 : icon.startsWith(`${want}-`) || icon.endsWith(`-${want}`) ? 1 : 2
      return exact * 10 + ICON_SETS.indexOf(set as (typeof ICON_SETS)[number])
    }
    const pick = [...found].sort((a, b) => rank(a) - rank(b))[0]
    const [set, icon] = pick.split(':')
    // Iconify's search doesn't index the colour Fluent set, which names its emoji as the flat one does: that first
    for (const variant of set === 'fluent-emoji-flat' ? [`fluent-emoji:${icon}`, pick] : [pick]) {
      const [vs, vi] = variant.split(':')
      const svgRes = await get(`/${vs}/${vi}.svg?height=${PNG_SIZE}`, 'image/svg+xml', signal)
      if (!svgRes?.ok) continue
      const svg = await svgRes.text()
      if (svg.length > MAX_SVG_BYTES || !/^\s*<svg[\s>]/.test(svg)) continue
      return { icon: variant, svg }
    }
  }
  return null
}

/** An illustration's SVG → a square transparent PNG file (scripts, links and outside references are never drawn). */
export async function illustrationPng(svg: string, outDir: string, signal?: AbortSignal): Promise<{ file: string; mime: string; width: number; height: number }> {
  if (signal?.aborted) throw new CancelledError()
  // Iconify's SVGs are plain shapes and gradients; anything that could load something else is removed anyway
  const safe = svg.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/\s(?:xlink:)?href\s*=\s*["'](?!#)[^"']*["']/gi, '')
  const sharp = (await import('sharp')).default
  const file = outFile(outDir, 'illustration', 'png')
  try {
    // drawn at the PNG's size: the density that makes its own size (width/height, else the viewBox) 1024 px
    const tag = safe.match(/<svg[^>]*>/)?.[0] ?? ''
    const attr = (n: string) => Number(tag.match(new RegExp(`\\s${n}="([\\d.]+)(px)?"`))?.[1] ?? 0)
    const box = tag.match(/viewBox="[\d.\s-]+?\s([\d.]+)\s+([\d.]+)"/)
    const side = Math.max(attr('width') || Number(box?.[1] ?? 0), attr('height') || Number(box?.[2] ?? 0)) || PNG_SIZE
    const density = Math.min(2400, Math.max(1, (72 * PNG_SIZE) / side))
    await sharp(Buffer.from(safe), { density, limitInputPixels: PNG_SIZE * PNG_SIZE * 4 })
      .resize(PNG_SIZE, PNG_SIZE, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png()
      .toFile(file)
  } catch (err) {
    await fs.promises.rm(file, { force: true })
    log.warn('could not draw an illustration', { error: err instanceof Error ? err.message : String(err) })
    throw new HttpError(502, 'server', 'An illustration could not be drawn.')
  }
  return { file, mime: 'image/png', width: PNG_SIZE, height: PNG_SIZE }
}
