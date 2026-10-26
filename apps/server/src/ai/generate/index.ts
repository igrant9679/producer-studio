// Media generation for videos made without recordings: AI stills, AI video clips, stock footage.
// The contract (types + function signatures) lives here; the work is in images.ts / video.ts / stock.ts /
// capabilities.ts. Generation is billed to the workspace's own OpenAI / Gemini key (Settings → AI), never the server's;
// stock footage uses the server's PEXELS_API_KEY (free). Which models and why: see the top of capabilities.ts.

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
// searchStock({ query, aspect, minSeconds?, signal? }): Promise<StockClip[]>; downloadStock(clip, outDir, signal?)
export { downloadStock, searchStock } from './stock'
