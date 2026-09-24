// Producer Studio project model. One JSON document describes a whole edit; the browser preview and
// the HyperFrames export both evaluate it through `evaluate()` so what you see is what renders.
// All times are seconds (float). Positions are canvas pixels relative to the canvas centre.

export type Id = string

export type AssetKind = 'video' | 'audio' | 'image'

export interface TranscriptWord {
  w: string
  start: number
  end: number
}

export interface TranscriptSegment {
  start: number
  end: number
  text: string
  words: TranscriptWord[]
  speaker?: string
}

export interface Transcript {
  language: string
  engine: string
  segments: TranscriptSegment[]
}

export interface Asset {
  id: Id
  kind: AssetKind
  name: string
  /** Storage key; resolved to a URL by the host (browser: signed URL, export: local path). */
  src: string
  /** Optional low-res proxy used for editing preview. */
  proxySrc?: string
  mime?: string
  duration?: number
  width?: number
  height?: number
  fps?: number
  hasAudio?: boolean
  sizeBytes?: number
  /** Storage key of a filmstrip sprite (horizontal strip of thumbnails) and its frame count. */
  filmstrip?: { src: string; frames: number; frameWidth: number; frameHeight: number }
  thumbnail?: string
  /** Peak amplitudes 0..1, ~50 per second. */
  waveform?: number[]
  transcript?: Transcript
  /** Detected pauses (start/end seconds) used by "remove silences". */
  silences?: Array<{ start: number; end: number }>
  createdAt?: number
}

export type EaseName = 'linear' | 'easeIn' | 'easeOut' | 'easeInOut' | 'hold'

export interface Keyframe {
  /** Seconds from the item's start. */
  t: number
  value: number
  ease?: EaseName
}

/** Every keyframe-able numeric property. */
export type AnimProp = 'x' | 'y' | 'scale' | 'rotation' | 'opacity' | 'volume'

export type Keyframes = Partial<Record<AnimProp, Keyframe[]>>

export interface Transform {
  x: number
  y: number
  /** 1 = fit to canvas for media, font-size scale for text. */
  scale: number
  rotation: number
  flipX?: boolean
  flipY?: boolean
}

export type BlendMode =
  | 'normal'
  | 'multiply'
  | 'screen'
  | 'overlay'
  | 'darken'
  | 'lighten'
  | 'color-dodge'
  | 'color-burn'
  | 'hard-light'
  | 'soft-light'
  | 'difference'
  | 'exclusion'

/** Colour adjustments, each -100..100 (0 = neutral). */
export interface ColorAdjust {
  brightness: number
  contrast: number
  saturation: number
  exposure: number
  temperature: number
  tint: number
  hue: number
  sharpen: number
  vignette: number
}

export interface Crop {
  /** Fractions 0..1 of the source frame. */
  left: number
  top: number
  right: number
  bottom: number
}

export type AnimationPreset =
  | 'none'
  | 'fade'
  | 'slideLeft'
  | 'slideRight'
  | 'slideUp'
  | 'slideDown'
  | 'zoomIn'
  | 'zoomOut'
  | 'pop'
  | 'spin'
  | 'blur'
  | 'wipeLeft'
  | 'wipeRight'
  | 'typewriter'
  | 'rise'

export interface AnimationSpec {
  preset: AnimationPreset
  duration: number
}

export interface ItemAnimations {
  in?: AnimationSpec
  out?: AnimationSpec
  /** Looping emphasis for the whole item (pulse, float, shake). */
  combo?: { preset: 'pulse' | 'float' | 'shake' | 'swing' | 'none'; period: number }
}

export type EffectType =
  | 'blur'
  | 'shake'
  | 'zoomPulse'
  | 'flash'
  | 'vignette'
  | 'grain'
  | 'rgbSplit'
  | 'blackWhite'
  | 'vhs'
  | 'glow'
  | 'kenBurns'

export interface Effect {
  id: Id
  type: EffectType
  /** 0..100 */
  intensity: number
}

export type TransitionType =
  | 'crossfade'
  | 'dipBlack'
  | 'dipWhite'
  | 'slideLeft'
  | 'slideRight'
  | 'slideUp'
  | 'slideDown'
  | 'zoomIn'
  | 'zoomOut'
  | 'wipeLeft'
  | 'wipeRight'
  | 'blur'
  | 'spin'

/** A transition that plays across the cut between this item and the next adjacent item on its track. */
export interface Transition {
  type: TransitionType
  duration: number
}

export type BackgroundFill =
  | { type: 'color'; color: string }
  | { type: 'blur'; amount: number }
  | { type: 'image'; assetId: Id }

interface ItemBase {
  id: Id
  /** Timeline start in seconds. */
  start: number
  /** Timeline duration in seconds (already accounts for speed). */
  duration: number
  name?: string
  locked?: boolean
  /** Group id for items that move together (e.g. video + its separated audio). */
  linkId?: Id
}

interface VisualProps {
  transform: Transform
  opacity: number
  blend: BlendMode
  keyframes: Keyframes
  animations: ItemAnimations
  effects: Effect[]
  transitionOut?: Transition
}

export interface VideoItem extends ItemBase, VisualProps {
  type: 'video'
  assetId: Id
  /** Source offset (seconds into the asset) at the item's start. */
  in: number
  speed: number
  volume: number
  muted?: boolean
  fadeIn: number
  fadeOut: number
  adjust: ColorAdjust
  filter?: { id: string; intensity: number }
  crop?: Crop
  fit: 'contain' | 'cover'
  background?: BackgroundFill
  /** If set, holds this source time for the whole item (freeze frame). */
  freezeAt?: number
  reverse?: boolean
}

export interface ImageItem extends ItemBase, VisualProps {
  type: 'image'
  assetId: Id
  adjust: ColorAdjust
  filter?: { id: string; intensity: number }
  crop?: Crop
  fit: 'contain' | 'cover'
  background?: BackgroundFill
}

export interface AudioItem extends ItemBase {
  type: 'audio'
  assetId: Id
  in: number
  speed: number
  volume: number
  muted?: boolean
  fadeIn: number
  fadeOut: number
  keyframes: Keyframes
  /** Voiceover generated by TTS keeps its script so it can be regenerated. */
  tts?: { text: string; voice: string; speed: number }
}

export interface TextStyle {
  fontFamily: string
  fontSize: number
  fontWeight: number
  italic: boolean
  underline: boolean
  align: 'left' | 'center' | 'right'
  letterSpacing: number
  lineHeight: number
  uppercase: boolean
  color: string
  stroke?: { color: string; width: number }
  background?: { color: string; radius: number; padding: number; opacity: number }
  shadow?: { color: string; blur: number; x: number; y: number }
  glow?: { color: string; blur: number }
  /** Box width in canvas px; text wraps inside it. */
  boxWidth: number
}

export interface TextItem extends ItemBase, VisualProps {
  type: 'text'
  text: string
  style: TextStyle
  /** Template id this text was created from (for re-styling). */
  template?: string
}

export interface CaptionItem extends ItemBase {
  type: 'caption'
  text: string
  /** Word timings relative to the item start, for karaoke highlight. */
  words?: TranscriptWord[]
}

export interface ShapeItem extends ItemBase, VisualProps {
  type: 'shape'
  shape: 'rect' | 'ellipse' | 'line'
  width: number
  height: number
  fill: string
  radius: number
  stroke?: { color: string; width: number }
}

export type VisualItem = VideoItem | ImageItem | TextItem | ShapeItem
export type Item = VideoItem | ImageItem | AudioItem | TextItem | CaptionItem | ShapeItem
export type ItemType = Item['type']

export type TrackKind = 'video' | 'overlay' | 'text' | 'audio' | 'caption'

export interface CaptionStyle {
  preset: string
  style: TextStyle
  /** Vertical position as fraction of canvas height (0 top .. 1 bottom). */
  position: number
  highlightColor: string
  mode: 'line' | 'word' | 'karaoke'
  maxWordsPerLine: number
}

export interface Track {
  id: Id
  kind: TrackKind
  name: string
  items: Item[]
  muted?: boolean
  hidden?: boolean
  locked?: boolean
  /** The main track is magnetic: items stay packed edge to edge with no gaps. */
  main?: boolean
  /** Caption tracks carry their style. */
  captionStyle?: CaptionStyle
}

export interface BrandKit {
  name: string
  colors: string[]
  fonts: { headline: string; body: string; mono?: string }
  logoAssetId?: Id
}

export interface Project {
  id: Id
  schema: 1
  name: string
  width: number
  height: number
  fps: number
  background: string
  /**
   * Tracks in visual stacking order: index 0 is drawn at the bottom. Audio/caption tracks can be anywhere;
   * caption tracks always draw on top of every visual track.
   */
  tracks: Track[]
  assets: Record<Id, Asset>
  brand?: BrandKit
  /** Producer AI metadata (brief, script) for projects built by the AI pipeline. */
  ai?: ProducerMeta
  createdAt: number
  updatedAt: number
}

export interface ScriptScene {
  id: string
  title: string
  headline: string
  narration: string
  /** Source footage windows in seconds. */
  footage: Array<{ assetId: Id; start: number; end: number }>
  visuals?: string
  voice?: { assetId: Id; duration: number }
}

export interface ProducerMeta {
  brief?: {
    title: string
    audience: string
    goal: string
    tone: string
    template: string
    voice: string
    aspect: '16:9' | '9:16' | '1:1'
    notes?: string
  }
  script?: { scenes: ScriptScene[]; message?: string }
  status?: 'draft' | 'transcribed' | 'scripted' | 'voiced' | 'assembled'
}

/** Evaluated state of the project at one instant — consumed by renderers. */
export interface FrameLayer {
  itemId: Id
  trackId: Id
  type: 'video' | 'image' | 'text' | 'shape' | 'caption'
  assetId?: Id
  /** Source time to display (video only). */
  mediaTime?: number
  /** CSS for the layer's positioned wrapper: left/top are the centre point in canvas px. */
  box: { cx: number; cy: number; width: number; height: number }
  transform: string
  opacity: number
  filter: string
  blend: BlendMode
  clipPath?: string
  /** Overlay decorations drawn above the layer (vignette/grain) as CSS backgrounds. */
  overlay?: string
  objectFit?: 'contain' | 'cover' | 'fill'
  crop?: Crop
  background?: BackgroundFill
  text?: { html: string; style: TextStyle }
  shape?: ShapeItem
  z: number
}

export interface FrameAudio {
  itemId: Id
  assetId: Id
  mediaTime: number
  volume: number
  speed: number
}

export interface FrameState {
  time: number
  layers: FrameLayer[]
  audio: FrameAudio[]
}
