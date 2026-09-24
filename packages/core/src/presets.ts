// Catalogues shared by the editor UI (panels), the AI tools (valid enum values) and the renderer.
import type {
  AnimationPreset,
  CaptionStyle,
  ColorAdjust,
  EffectType,
  TextStyle,
  TransitionType,
} from './types'

export const NEUTRAL_ADJUST: ColorAdjust = {
  brightness: 0,
  contrast: 0,
  saturation: 0,
  exposure: 0,
  temperature: 0,
  tint: 0,
  hue: 0,
  sharpen: 0,
  vignette: 0,
}

export interface FilterPreset {
  id: string
  name: string
  category: 'Featured' | 'Life' | 'Landscape' | 'Portrait' | 'Mono' | 'Movies' | 'Retro'
  /** Adjustments applied at 100 % intensity. */
  adjust: Partial<ColorAdjust>
  sepia?: number
  grayscale?: number
}

export const FILTERS: FilterPreset[] = [
  { id: 'warm-gold', name: 'Warm Gold', category: 'Featured', adjust: { temperature: 35, saturation: 12, contrast: 8 } },
  { id: 'clean-pop', name: 'Clean Pop', category: 'Featured', adjust: { contrast: 18, saturation: 22, brightness: 4 } },
  { id: 'filmic-haze', name: 'Filmic Haze', category: 'Featured', adjust: { contrast: -12, brightness: 8, saturation: -10 }, sepia: 12 },
  { id: 'teal-orange', name: 'Teal & Orange', category: 'Movies', adjust: { temperature: 18, contrast: 20, saturation: 15, tint: -8 } },
  { id: 'noir', name: 'Noir', category: 'Mono', adjust: { contrast: 35 }, grayscale: 100 },
  { id: 'silver', name: 'Silver', category: 'Mono', adjust: { contrast: 10, brightness: 6 }, grayscale: 100 },
  { id: 'sepia-memory', name: 'Sepia Memory', category: 'Retro', adjust: { contrast: 6 }, sepia: 70 },
  { id: 'faded-70s', name: 'Faded 70s', category: 'Retro', adjust: { contrast: -20, saturation: -25, temperature: 20 }, sepia: 25 },
  { id: 'cool-morning', name: 'Cool Morning', category: 'Landscape', adjust: { temperature: -30, brightness: 6, saturation: 8 } },
  { id: 'vivid-green', name: 'Vivid Nature', category: 'Landscape', adjust: { saturation: 35, contrast: 10, hue: -6 } },
  { id: 'soft-skin', name: 'Soft Skin', category: 'Portrait', adjust: { brightness: 8, contrast: -8, temperature: 10, saturation: -5 } },
  { id: 'cold-light', name: 'Cold Light', category: 'Portrait', adjust: { temperature: -20, contrast: 12, brightness: 4 } },
  { id: 'daylight', name: 'Daylight', category: 'Life', adjust: { brightness: 10, saturation: 10 } },
  { id: 'iced-fog', name: 'Iced Fog', category: 'Life', adjust: { temperature: -25, contrast: -15, brightness: 10, saturation: -20 } },
  { id: 'blockbuster', name: 'Blockbuster', category: 'Movies', adjust: { contrast: 30, saturation: -8, temperature: -10, exposure: -6 } },
  { id: 'dusk', name: 'Dusk', category: 'Movies', adjust: { temperature: 28, tint: 12, contrast: 14, exposure: -8 } },
]

export const ANIMATION_PRESETS: Array<{ id: AnimationPreset; name: string; textOnly?: boolean }> = [
  { id: 'fade', name: 'Fade' },
  { id: 'slideLeft', name: 'Slide left' },
  { id: 'slideRight', name: 'Slide right' },
  { id: 'slideUp', name: 'Slide up' },
  { id: 'slideDown', name: 'Slide down' },
  { id: 'zoomIn', name: 'Zoom in' },
  { id: 'zoomOut', name: 'Zoom out' },
  { id: 'pop', name: 'Pop' },
  { id: 'spin', name: 'Spin' },
  { id: 'blur', name: 'Blur' },
  { id: 'wipeLeft', name: 'Wipe left' },
  { id: 'wipeRight', name: 'Wipe right' },
  { id: 'rise', name: 'Rise' },
  { id: 'typewriter', name: 'Typewriter', textOnly: true },
]

export const COMBO_PRESETS = [
  { id: 'pulse', name: 'Pulse' },
  { id: 'float', name: 'Float' },
  { id: 'shake', name: 'Shake' },
  { id: 'swing', name: 'Swing' },
] as const

export const TRANSITIONS: Array<{ id: TransitionType; name: string; category: 'Basic' | 'Motion' | 'Stylised' }> = [
  { id: 'crossfade', name: 'Crossfade', category: 'Basic' },
  { id: 'dipBlack', name: 'Dip to black', category: 'Basic' },
  { id: 'dipWhite', name: 'Flash white', category: 'Basic' },
  { id: 'slideLeft', name: 'Push left', category: 'Motion' },
  { id: 'slideRight', name: 'Push right', category: 'Motion' },
  { id: 'slideUp', name: 'Push up', category: 'Motion' },
  { id: 'slideDown', name: 'Push down', category: 'Motion' },
  { id: 'zoomIn', name: 'Zoom through', category: 'Motion' },
  { id: 'zoomOut', name: 'Pull back', category: 'Motion' },
  { id: 'wipeLeft', name: 'Wipe left', category: 'Stylised' },
  { id: 'wipeRight', name: 'Wipe right', category: 'Stylised' },
  { id: 'blur', name: 'Blur dissolve', category: 'Stylised' },
  { id: 'spin', name: 'Spin', category: 'Stylised' },
]

export const EFFECTS: Array<{ id: EffectType; name: string; category: 'Basic' | 'Motion' | 'Retro' | 'Light' }> = [
  { id: 'blur', name: 'Blur', category: 'Basic' },
  { id: 'blackWhite', name: 'Black & white', category: 'Basic' },
  { id: 'vignette', name: 'Vignette', category: 'Basic' },
  { id: 'shake', name: 'Camera shake', category: 'Motion' },
  { id: 'zoomPulse', name: 'Zoom pulse', category: 'Motion' },
  { id: 'kenBurns', name: 'Ken Burns', category: 'Motion' },
  { id: 'flash', name: 'Flash', category: 'Light' },
  { id: 'glow', name: 'Soft glow', category: 'Light' },
  { id: 'rgbSplit', name: 'RGB split', category: 'Retro' },
  { id: 'vhs', name: 'VHS', category: 'Retro' },
  { id: 'grain', name: 'Film grain', category: 'Retro' },
]

/** Fonts bundled by the web app and the renderer (all SIL OFL, served locally). */
export const FONTS = [
  'Inter',
  'Montserrat',
  'Space Grotesk',
  'Poppins',
  'Playfair Display',
  'Bebas Neue',
  'Oswald',
  'Roboto Slab',
  'DM Serif Display',
  'Caveat',
  'JetBrains Mono',
  'IBM Plex Mono',
] as const

export const ASPECT_RATIOS = [
  { id: '16:9', name: '16:9', hint: 'YouTube, presentations', width: 1920, height: 1080 },
  { id: '9:16', name: '9:16', hint: 'TikTok, Reels, Shorts', width: 1080, height: 1920 },
  { id: '1:1', name: '1:1', hint: 'Instagram posts', width: 1080, height: 1080 },
  { id: '4:5', name: '4:5', hint: 'Instagram portrait', width: 1080, height: 1350 },
  { id: '4:3', name: '4:3', hint: 'LinkedIn, Facebook', width: 1440, height: 1080 },
  { id: '3:4', name: '3:4', hint: 'Pinterest', width: 1080, height: 1440 },
  { id: '21:9', name: '21:9', hint: 'Cinematic', width: 2560, height: 1080 },
] as const

export const EXPORT_RESOLUTIONS = [
  { id: '720p', short: 720 },
  { id: '1080p', short: 1080 },
  { id: '1440p', short: 1440 },
  { id: '4k', short: 2160 },
] as const

export const EXPORT_FPS = [24, 25, 30, 50, 60] as const

/** Kokoro-82M voices available to TTS. */
export const VOICES = [
  { id: 'af_heart', name: 'Heart', lang: 'American English', gender: 'female', style: 'Warm narration' },
  { id: 'af_bella', name: 'Bella', lang: 'American English', gender: 'female', style: 'Bright' },
  { id: 'af_nicole', name: 'Nicole', lang: 'American English', gender: 'female', style: 'Soft, close' },
  { id: 'af_sarah', name: 'Sarah', lang: 'American English', gender: 'female', style: 'Conversational' },
  { id: 'af_sky', name: 'Sky', lang: 'American English', gender: 'female', style: 'Light' },
  { id: 'af_kore', name: 'Kore', lang: 'American English', gender: 'female', style: 'Confident' },
  { id: 'af_aoede', name: 'Aoede', lang: 'American English', gender: 'female', style: 'Calm' },
  { id: 'af_nova', name: 'Nova', lang: 'American English', gender: 'female', style: 'Upbeat' },
  { id: 'af_jessica', name: 'Jessica', lang: 'American English', gender: 'female', style: 'Friendly' },
  { id: 'am_michael', name: 'Michael', lang: 'American English', gender: 'male', style: 'Warm narration' },
  { id: 'am_adam', name: 'Adam', lang: 'American English', gender: 'male', style: 'Deep' },
  { id: 'am_fenrir', name: 'Fenrir', lang: 'American English', gender: 'male', style: 'Bold' },
  { id: 'am_puck', name: 'Puck', lang: 'American English', gender: 'male', style: 'Playful' },
  { id: 'am_eric', name: 'Eric', lang: 'American English', gender: 'male', style: 'Professional' },
  { id: 'am_liam', name: 'Liam', lang: 'American English', gender: 'male', style: 'Casual' },
  { id: 'am_onyx', name: 'Onyx', lang: 'American English', gender: 'male', style: 'Authoritative' },
  { id: 'bf_emma', name: 'Emma', lang: 'British English', gender: 'female', style: 'Polished' },
  { id: 'bf_isabella', name: 'Isabella', lang: 'British English', gender: 'female', style: 'Elegant' },
  { id: 'bf_alice', name: 'Alice', lang: 'British English', gender: 'female', style: 'Clear' },
  { id: 'bf_lily', name: 'Lily', lang: 'British English', gender: 'female', style: 'Gentle' },
  { id: 'bm_george', name: 'George', lang: 'British English', gender: 'male', style: 'Documentary' },
  { id: 'bm_lewis', name: 'Lewis', lang: 'British English', gender: 'male', style: 'Measured' },
  { id: 'bm_daniel', name: 'Daniel', lang: 'British English', gender: 'male', style: 'Newsreader' },
  { id: 'bm_fable', name: 'Fable', lang: 'British English', gender: 'male', style: 'Storyteller' },
] as const

export function defaultTextStyle(over: Partial<TextStyle> = {}): TextStyle {
  return {
    fontFamily: 'Inter',
    fontSize: 72,
    fontWeight: 700,
    italic: false,
    underline: false,
    align: 'center',
    letterSpacing: 0,
    lineHeight: 1.15,
    uppercase: false,
    color: '#ffffff',
    boxWidth: 1400,
    ...over,
  }
}

export interface TextTemplate {
  id: string
  name: string
  category: 'Basic' | 'Titles' | 'Lower thirds' | 'Social' | 'Callouts'
  text: string
  style: Partial<TextStyle>
  animationIn?: AnimationPreset
  animationOut?: AnimationPreset
}

export const TEXT_TEMPLATES: TextTemplate[] = [
  { id: 'heading', name: 'Heading', category: 'Basic', text: 'Add heading', style: { fontSize: 120, fontWeight: 800 } },
  { id: 'body', name: 'Body text', category: 'Basic', text: 'Add body text', style: { fontSize: 56, fontWeight: 500 } },
  { id: 'title-bold', name: 'Bold title', category: 'Titles', text: 'BIG IDEA', style: { fontFamily: 'Bebas Neue', fontSize: 180, fontWeight: 400, letterSpacing: 4 }, animationIn: 'rise', animationOut: 'fade' },
  { id: 'title-serif', name: 'Editorial', category: 'Titles', text: 'A quiet revolution', style: { fontFamily: 'Playfair Display', fontSize: 110, fontWeight: 700, italic: true }, animationIn: 'fade' },
  { id: 'title-grotesk', name: 'Studio', category: 'Titles', text: 'Built for teams', style: { fontFamily: 'Space Grotesk', fontSize: 120, fontWeight: 700, letterSpacing: -2 }, animationIn: 'slideUp' },
  { id: 'lower-third', name: 'Lower third', category: 'Lower thirds', text: 'Jordan Lee · Product Lead', style: { fontSize: 44, fontWeight: 600, align: 'left', boxWidth: 900, background: { color: '#0b1830', radius: 10, padding: 22, opacity: 0.92 } }, animationIn: 'wipeRight', animationOut: 'fade' },
  { id: 'lower-accent', name: 'Accent bar', category: 'Lower thirds', text: 'Chapter 1 — The problem', style: { fontSize: 48, fontWeight: 700, align: 'left', boxWidth: 1000, background: { color: '#ff5a5f', radius: 6, padding: 18, opacity: 1 } }, animationIn: 'slideRight' },
  { id: 'social-caption', name: 'Social pop', category: 'Social', text: 'wait for it…', style: { fontSize: 84, fontWeight: 900, stroke: { color: '#000000', width: 8 } }, animationIn: 'pop' },
  { id: 'social-highlight', name: 'Highlight', category: 'Social', text: 'Game changer', style: { fontSize: 90, fontWeight: 800, color: '#111111', background: { color: '#ffe14d', radius: 14, padding: 20, opacity: 1 } }, animationIn: 'pop' },
  { id: 'callout-number', name: 'Big number', category: 'Callouts', text: '3× faster', style: { fontSize: 160, fontWeight: 900, color: '#ff5a5f' }, animationIn: 'zoomIn' },
  { id: 'callout-glow', name: 'Neon', category: 'Callouts', text: 'Now live', style: { fontSize: 110, fontWeight: 800, color: '#e8fbff', glow: { color: '#35e0ff', blur: 24 } }, animationIn: 'fade' },
  { id: 'typewriter', name: 'Typewriter', category: 'Callouts', text: 'Loading the future_', style: { fontFamily: 'JetBrains Mono', fontSize: 64, fontWeight: 500 }, animationIn: 'typewriter' },
]

export const CAPTION_PRESETS: Array<{ id: string; name: string; caption: Omit<CaptionStyle, 'preset'> }> = [
  {
    id: 'clean',
    name: 'Clean',
    caption: { style: defaultTextStyle({ fontSize: 56, fontWeight: 700, shadow: { color: 'rgba(0,0,0,.75)', blur: 12, x: 0, y: 3 }, boxWidth: 1500 }), position: 0.86, highlightColor: '#ffe14d', mode: 'line', maxWordsPerLine: 7 },
  },
  {
    id: 'boxed',
    name: 'Boxed',
    caption: { style: defaultTextStyle({ fontSize: 50, fontWeight: 600, background: { color: '#000000', radius: 10, padding: 14, opacity: 0.72 }, boxWidth: 1500 }), position: 0.86, highlightColor: '#ffffff', mode: 'line', maxWordsPerLine: 8 },
  },
  {
    id: 'karaoke',
    name: 'Karaoke',
    caption: { style: defaultTextStyle({ fontSize: 64, fontWeight: 900, uppercase: true, stroke: { color: '#000000', width: 6 }, boxWidth: 1400 }), position: 0.78, highlightColor: '#35e0ff', mode: 'karaoke', maxWordsPerLine: 5 },
  },
  {
    id: 'word-pop',
    name: 'Word pop',
    caption: { style: defaultTextStyle({ fontFamily: 'Montserrat', fontSize: 96, fontWeight: 900, uppercase: true, stroke: { color: '#000000', width: 8 }, boxWidth: 1200 }), position: 0.7, highlightColor: '#ffe14d', mode: 'word', maxWordsPerLine: 1 },
  },
  {
    id: 'editorial',
    name: 'Editorial',
    caption: { style: defaultTextStyle({ fontFamily: 'Playfair Display', fontSize: 54, fontWeight: 600, italic: true, shadow: { color: 'rgba(0,0,0,.6)', blur: 10, x: 0, y: 2 }, boxWidth: 1500 }), position: 0.88, highlightColor: '#ffffff', mode: 'line', maxWordsPerLine: 9 },
  },
]

export function captionStyleFromPreset(id: string): CaptionStyle {
  const p = CAPTION_PRESETS.find((c) => c.id === id) ?? CAPTION_PRESETS[0]
  return { preset: p.id, ...structuredClone(p.caption) }
}
