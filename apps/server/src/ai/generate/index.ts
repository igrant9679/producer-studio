// Media for videos made without recordings: AI stills, AI video clips, stock clips and photos, illustrations.
// The contract (types + function signatures) lives here; the work is in images.ts / video.ts / stock.ts / icons.ts /
// capabilities.ts / fal.ts. Generation is billed to the workspace's own OpenAI / Gemini / fal.ai key (Settings → AI), never the server's;
// stock comes from free libraries (the server's free Pexels / Pixabay keys, and Wikimedia Commons and Openverse with
// none) and illustrations from Iconify's open-source sets, at no charge. Which models and why: see capabilities.ts.

export type GenAspect = '16:9' | '9:16' | '1:1'
/** fal.ai makes clips only (Wan). */
export type GenProvider = 'openai' | 'gemini' | 'fal'

export interface GenCapabilities {
  /** AI stills, when the workspace has a key that can make them. */
  image?: { provider: Exclude<GenProvider, 'fal'>; model: string }
  /** AI video clips, when the workspace has a key that can make them. */
  video?: { provider: GenProvider; model: string; maxSeconds: number }
  /** Stock clips and photos (some free library is searched here). */
  stock: boolean
  /** Which libraries, in the order they are tried. */
  stockSources?: { video: string[]; photo: string[] }
}

export type StockMedia = 'video' | 'photo'
export type StockSource = 'pexels' | 'pixabay' | 'openverse' | 'commons'

export interface StockClip {
  id: string
  /** A clip (the default) or a photo. */
  kind?: StockMedia
  /** The library it's from (absent: Pexels). */
  source?: StockSource
  /** The file to download (a clip: the rendition closest to 1080p). */
  url: string
  previewImage: string
  width: number
  height: number
  duration: number
  author: string
  authorUrl: string
  pageUrl: string
  /** Set when the licence asks for credit in the video (CC BY, CC BY-SA). */
  licence?: string
}

export interface GeneratedFile {
  file: string
  mime: string
  provider: string
  model: string
  /** Pixel size of the file as written (ffprobe), when it could be read. Providers don't always honour the aspect. */
  width?: number
  height?: number
}

// generationCapabilities(workspaceId): Promise<GenCapabilities>
export { generationCapabilities } from './capabilities'
// generateImage({ workspaceId, prompt, aspect, outDir, signal? }): Promise<GeneratedFile>
export { generateImage } from './images'
// generateVideo({ workspaceId, prompt, aspect, seconds, outDir, signal?, onProgress? }): Promise<GeneratedFile & { seconds }>
export { generateVideo } from './video'
// searchStock({ query, aspect, media?, minSeconds?, signal? }): Promise<StockClip[]>; downloadStock(clip, outDir, signal?)
export { downloadStock, searchStock, SOURCE_NAMES, stockSources } from './stock'
// findIllustration(name, signal?): Promise<{ icon, svg } | null>; illustrationPng(svg, outDir, signal?)
export { findIllustration, illustrationPng, ICON_SETS } from './icons'
