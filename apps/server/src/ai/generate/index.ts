// Media generation for videos made without recordings: AI stills, AI video clips, stock footage.
// CONTRACT ONLY (stub): the implementation lands in images.ts / video.ts / stock.ts / capabilities.ts and is re-exported
// from here with exactly these signatures. Generation is billed to the workspace's own OpenAI / Gemini key (Settings →
// AI); stock footage uses the server's PEXELS_API_KEY (free).
import { HttpError } from '../../http'

export type GenAspect = '16:9' | '9:16' | '1:1'
export type GenProvider = 'openai' | 'gemini'

export interface GenCapabilities {
  /** AI stills, when the workspace has a key that can make them. */
  image?: { provider: GenProvider; model: string }
  /** AI video clips, when the workspace has a key that can make them. */
  video?: { provider: GenProvider; model: string; maxSeconds: number }
  /** Stock footage search (the server has a Pexels key). */
  stock: boolean
}

export interface StockClip {
  id: string
  /** Direct mp4 to download (the rendition closest to 1080p). */
  url: string
  previewImage: string
  width: number
  height: number
  duration: number
  author: string
  authorUrl: string
  pageUrl: string
}

export interface GeneratedFile {
  file: string
  mime: string
  provider: string
  model: string
}

const notYet = () => new HttpError(503, 'server', 'Media generation is not available on this server yet')

export async function generationCapabilities(_workspaceId: string): Promise<GenCapabilities> {
  return { stock: false }
}

export async function generateImage(_opts: { workspaceId: string; prompt: string; aspect: GenAspect; outDir: string; signal?: AbortSignal }): Promise<GeneratedFile> {
  throw notYet()
}

export async function generateVideo(_opts: {
  workspaceId: string
  prompt: string
  aspect: GenAspect
  seconds: number
  outDir: string
  signal?: AbortSignal
  onProgress?: (fraction: number, message: string) => void
}): Promise<GeneratedFile & { seconds: number }> {
  throw notYet()
}

export async function searchStock(_opts: { query: string; aspect: GenAspect; minSeconds?: number; signal?: AbortSignal }): Promise<StockClip[]> {
  throw notYet()
}

export async function downloadStock(_clip: StockClip, _outDir: string, _signal?: AbortSignal): Promise<GeneratedFile> {
  throw notYet()
}
