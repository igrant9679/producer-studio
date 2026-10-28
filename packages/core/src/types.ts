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
  /**
   * Media location. The server fills src/proxySrc/thumbnail/filmstrip.src with `/api/media/<id>/<variant>` URLs;
   * the export compiler maps asset ids to local files instead.
   */
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
  /** Peak amplitudes 0..1, `waveformRate` per second (at most ~4,000 of them for a long clip). */
  waveform?: number[]
  /** Peaks per second of `waveform`; absent means 50. */
  waveformRate?: number
  /** The full waveform (one byte per peak, 0..255, 50 per second) when `waveform` is a shortened copy. */
  waveformSrc?: string
  transcript?: Transcript
  /** Detected pauses (start/end seconds) used by "remove silences". */
  silences?: Array<{ start: number; end: number }>
  createdAt?: number
}

/** How a keyframe eases into the next one; `bezier` follows the keyframe's own curve. */
export type EaseName = 'linear' | 'easeIn' | 'easeOut' | 'easeInOut' | 'hold' | 'bezier'

/** CSS-style cubic-bezier control points x1, y1, x2, y2 (x in 0..1; y may overshoot). */
export type Bezier = [number, number, number, number]

export interface Keyframe {
  /** Seconds from the item's start. */
  t: number
  value: number
  ease?: EaseName
  /** The curve to the next keyframe when `ease` is 'bezier'. */
  bezier?: Bezier
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
  /**
   * Where this piece sits in the clip it was split from (seconds): `offset` from that clip's start, `length` its whole
   * duration. Ken Burns, loops, flashes and zoom pulses carry on across a cut instead of restarting. Absent: whole.
   */
  phase?: { offset: number; length: number }
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
  /** Speed ramp (E-17): see `SpeedPoint`; `speed` then holds the clip's average speed. */
  speedRamp?: SpeedPoint[]
  /** Let the pitch follow the speed (faster sounds higher); absent: the voice keeps its pitch at any speed. */
  pitchShift?: boolean
  /** Smooth slow motion (E-17): a copy of the picture with frames made in between, played in place of the source. */
  smooth?: SmoothCopy
}

/**
 * One point of a speed ramp: the speed `v` (0.1–10×) at `t` seconds from the clip's start (timeline time). Between
 * points the speed changes evenly in steps of ratio (log scale), as HyperFrames' rate lane plays it; before the first
 * and after the last it holds. Points can lie outside the clip after a trim or a split, so the speed inside stays.
 */
export interface SpeedPoint {
  t: number
  v: number
}

/**
 * A smooth slow-motion copy of source `from`..`to` (seconds), made by the server (media.smooth) at `fps` with
 * in-between frames: the copy's time 0 is source `from`. While it is being made it has a `jobId` and no `assetId`.
 */
export interface SmoothCopy {
  from: number
  to: number
  fps: number
  assetId?: Id
  jobId?: string
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
  /** Speed ramp (E-17), as on a video clip; `speed` then holds the clip's average speed. */
  speedRamp?: SpeedPoint[]
  /** Let the pitch follow the speed; absent: the pitch stays. */
  pitchShift?: boolean
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
  /** A colour gradient filling the letters (in place of `color`), `angle` in degrees as in CSS. */
  gradient?: { from: string; to: string; angle: number }
  /** Box width in canvas px; text wraps inside it. */
  boxWidth: number
  /** Shrink to fit: the text is drawn as large as it can be, up to its size, inside boxWidth × height. */
  fit?: { height: number }
}

/** Styling for a range of a text's characters (offsets into `text`, end exclusive). */
export interface TextSpan {
  start: number
  end: number
  color?: string
  fontWeight?: number
  italic?: boolean
  underline?: boolean
}

export interface TextItem extends ItemBase, VisualProps {
  type: 'text'
  text: string
  style: TextStyle
  /** Per-word styling: ranges of `text` drawn in another colour or weight, sorted and not overlapping. */
  spans?: TextSpan[]
  /** Template id this text was created from (for re-styling). */
  template?: string
  /** The text effect (TEXT_EFFECTS) last applied. */
  effect?: string
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
  /** Sound tracks (audio, video, overlay): level of the whole track (1 = as mixed, up to +12 dB). */
  volume?: number
  /** Only soloed tracks are heard while any track is soloed. */
  solo?: boolean
  /** Duck under voice: dB this track drops while a voiceover or a clip with a transcript is speaking (0/absent = off). */
  duck?: number
  /** A caption track's language (BCP 47, e.g. "en", "es-MX"); a project can hold one track per language. */
  language?: string
}

export interface BrandKit {
  name: string
  colors: string[]
  fonts: { headline: string; body: string; mono?: string }
  logoAssetId?: Id
}

/** A named point on the timeline (M adds one at the playhead); `beat` ones come from beat detection on a music clip. */
export interface Marker {
  id: Id
  /** Timeline seconds. */
  t: number
  name?: string
  beat?: boolean
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
  /** Timeline markers, by time. */
  markers?: Marker[]
  /** Producer AI metadata (brief, script) for projects built by the AI pipeline. */
  ai?: ProducerMeta
  /** The transcript's filler words and phrases ("um", "you know"); `on` ones are marked and removed. Absent: the defaults. */
  fillerWords?: Array<{ w: string; on: boolean }>
  createdAt: number
  updatedAt: number
}

/** A diagram drawn from editable shapes and text, its parts appearing as the narration reaches them. */
export type SceneDiagram =
  | { type: 'steps'; items: string[] }
  | { type: 'cycle'; items: string[] }
  | { type: 'hub'; center: string; items: string[] }
  | { type: 'bars'; items: Array<{ label: string; value: number }>; unit?: string }
  | { type: 'compare'; left: { title: string; points: string[] }; right: { title: string; points: string[] } }
  | { type: 'timeline'; items: Array<{ label: string; detail?: string }> }
  | { type: 'stat'; value: string; label: string }

export type DiagramType = SceneDiagram['type']

/**
 * What fills the screen during a scene. Absent or `footage`: windows from the uploaded recordings (a title card when
 * there are none). The rest need no recording: animated text, a diagram, an AI still with slow motion, a stock clip,
 * or an AI-generated clip (`assetId` once generated or downloaded, so re-assembling reuses it).
 */
export type SceneVisual =
  | { kind: 'footage' }
  | { kind: 'motion'; points?: string[] }
  | { kind: 'diagram'; diagram: SceneDiagram }
  | { kind: 'image'; prompt: string; assetId?: Id }
  | { kind: 'stock'; query: string; assetId?: Id; credit?: { author: string; url: string } }
  | { kind: 'aiVideo'; prompt: string; assetId?: Id }

export type VisualKind = SceneVisual['kind']

export interface ScriptScene {
  id: string
  title: string
  headline: string
  narration: string
  /** Source footage windows in seconds. */
  footage: Array<{ assetId: Id; start: number; end: number }>
  visuals?: string
  /** What fills the screen (videos made from an idea); absent = footage windows as before. */
  visual?: SceneVisual
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
    /** Where the video comes from: uploaded recordings (default), or an idea / pasted script with no recordings. */
    source?: 'recordings' | 'idea'
    /** The topic, outline or full script to make the video from (source = idea). */
    idea?: string
    /** Target length in seconds (source = idea). */
    lengthSec?: number
    /** Scene visuals the writer may use (source = idea); AI images and clips also need a key that can make them. */
    visualKinds?: VisualKind[]
  }
  script?: {
    scenes: ScriptScene[]
    message?: string
    /** The brief this script was written from (a brief changed since can leave the narration out of date). */
    brief?: ProducerMeta['brief']
  }
  status?: 'draft' | 'transcribed' | 'scripted' | 'voiced' | 'assembled'
  /** The timeline as the last assembly left it: assembling again over edits made since asks first. */
  assembled?: { fingerprint: string; at: number }
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
  /** `full`: the whole text's markup when `html` shows part of it (typewriter); a fit is measured on it. */
  text?: { html: string; style: TextStyle; full?: string }
  shape?: ShapeItem
  z: number
}

export interface FrameAudio {
  itemId: Id
  assetId: Id
  mediaTime: number
  volume: number
  /** The clip's speed at this moment (a ramp's changes over time). */
  speed: number
  /** The pitch follows the speed (see `pitchShift`). */
  pitchShift?: boolean
}

export interface FrameState {
  time: number
  layers: FrameLayer[]
  audio: FrameAudio[]
}
