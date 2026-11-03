export interface MusicCut {
  id: string
  t: number
}
export interface ComposeInput {
  id: string
  duration: number
  cuts: MusicCut[]
  style?: string
  product?: string
  drop?: string | number
  ending?: 'ring' | 'button' | 'stop'
  brand?: string
  seed?: number
  voiced?: boolean
  /** Integrated loudness of the result (default -18 LUFS). */
  lufs?: number
}
export interface ComposeResult {
  wav: Buffer
  lufs: number
  style: string
  bpm: number
  about: string
  sections: Array<{ id: string; t: number; energy: number }>
}
export const STYLES: Record<string, { about: string; variants?: Record<string, { about?: string }> }>
export const PRODUCTS: Record<string, { about: string; styles: string[] }>
export const RATE: number
export function composeMusic(o: ComposeInput): ComposeResult
export function loudness(L: Float32Array, R?: Float32Array | null): number
