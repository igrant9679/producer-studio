/**
 * Background music for videos made by Producer: the styles its composer plays (apps/server/scripts/music, from
 * huashu-motion), named for people, and the one a tone gets when the brief leaves the choice to it.
 */
export const MUSIC_STYLES = [
  { id: 'mallet', label: 'Friendly explainer', about: 'Marimba, vibraphone and e-piano, re-voiced every scene' },
  { id: 'pulse', label: 'Tech pulse', about: 'Clean synth-pop: offbeat bass, four-on-the-floor; products, SaaS, AI' },
  { id: 'piano', label: 'Felt piano', about: 'Broken chords and a simple tune, strings at the peak; human stories' },
  { id: 'acoustic', label: 'Acoustic', about: 'Strummed guitar, claps and a shaker; warm, lifestyle' },
  { id: 'lofi', label: 'Lo-fi', about: 'Dusty Rhodes chords and a swung beat; cozy, creative' },
  { id: 'ambient', label: 'Ambient', about: 'No drums: slow pads, a low drone, glass twinkles; calm, science' },
  { id: 'cinematic', label: 'Cinematic', about: 'String ostinato, taiko and horns; big launches, epic moments' },
  { id: 'funk', label: 'Funk', about: 'Popping bass, clav and brass stabs; confident, fun' },
  { id: 'pizzicato', label: 'Playful', about: 'Pizzicato strings, glockenspiel and finger snaps; cute, quirky' },
  { id: 'synthwave', label: 'Synthwave', about: '80s neon: driving bass, supersaw pads, gated snare' },
  { id: 'chiptune', label: '8-bit', about: 'Pulse-wave arps and noise drums; games, retro' },
  { id: 'trap', label: 'Trap', about: 'Half-time beat, sliding 808, rolling hats; bold, high energy' },
  { id: 'guofeng', label: 'Guofeng', about: 'Guzheng and dizi over soft strings; Chinese culture and brands' },
] as const

export type MusicStyle = (typeof MUSIC_STYLES)[number]['id']

const BY_TONE: Record<string, MusicStyle> = {
  confident: 'pulse',
  friendly: 'mallet',
  professional: 'piano',
  energetic: 'funk',
  calm: 'ambient',
  playful: 'pizzicato',
  warm: 'acoustic',
}

/** The style a brief's music setting plays: its own, the tone's for 'auto', or none ('off', absent, unknown). */
export function musicStyleFor(music: string | undefined, tone: string): MusicStyle | undefined {
  if (!music || music === 'off') return undefined
  if (music !== 'auto') return MUSIC_STYLES.find((m) => m.id === music)?.id
  const t = tone.trim().toLowerCase()
  return BY_TONE[t] ?? Object.entries(BY_TONE).find(([k]) => t.includes(k))?.[1] ?? 'mallet'
}

/** The sound-effect kit that suits a music style: soft and organic under quiet styles, crisp under bright ones, punchy under beats. */
export function sfxKitFor(style: MusicStyle | undefined): 'calm' | 'crisp' | 'launch' {
  if (!style) return 'crisp'
  if (['ambient', 'piano', 'acoustic', 'lofi', 'guofeng'].includes(style)) return 'calm'
  if (['mallet', 'pizzicato'].includes(style)) return 'crisp'
  return 'launch'
}

/** The sounds a video's effects play, in the order the brief's preview plays them (earshot's role names). */
export const SFX_PREVIEW_ROLES = ['whoosh.short', 'pop', 'click.confirm'] as const

/**
 * A track in the music library: composed once by the server with the same composer as a video's own music (so it is
 * free to use in any video, here and elsewhere), kept, and added to a video from the editor's Audio panel. Every style
 * has at least one, so the brief's music choice can be heard before it is picked.
 */
export interface LibraryTrack {
  id: string
  title: string
  style: MusicStyle
  /** In a few words, for the list. */
  mood: string
  seconds: number
}

/** Bumped when the library's tracks change: a new number composes them again. */
export const MUSIC_LIBRARY_VERSION = 1

export const MUSIC_LIBRARY: readonly LibraryTrack[] = [
  { id: 'sunny-mallets', title: 'Sunny Mallets', style: 'mallet', mood: 'Friendly and light', seconds: 75 },
  { id: 'clear-explainer', title: 'Clear Explainer', style: 'mallet', mood: 'Upbeat and curious', seconds: 90 },
  { id: 'launch-pulse', title: 'Launch Pulse', style: 'pulse', mood: 'Confident and modern', seconds: 75 },
  { id: 'cloud-drive', title: 'Cloud Drive', style: 'pulse', mood: 'Driving and techy', seconds: 90 },
  { id: 'quiet-story', title: 'Quiet Story', style: 'piano', mood: 'Warm and human', seconds: 90 },
  { id: 'first-light', title: 'First Light', style: 'piano', mood: 'Hopeful and gentle', seconds: 75 },
  { id: 'porch-guitar', title: 'Porch Guitar', style: 'acoustic', mood: 'Warm, for lifestyle', seconds: 75 },
  { id: 'weekend-strum', title: 'Weekend Strum', style: 'acoustic', mood: 'Bright and easy', seconds: 60 },
  { id: 'study-session', title: 'Study Session', style: 'lofi', mood: 'Cozy and focused', seconds: 90 },
  { id: 'rainy-window', title: 'Rainy Window', style: 'lofi', mood: 'Mellow and creative', seconds: 75 },
  { id: 'deep-field', title: 'Deep Field', style: 'ambient', mood: 'Calm and spacious', seconds: 90 },
  { id: 'clean-room', title: 'Clean Room', style: 'ambient', mood: 'Still, for science and tech', seconds: 60 },
  { id: 'rising-horizon', title: 'Rising Horizon', style: 'cinematic', mood: 'Epic, building', seconds: 75 },
  { id: 'big-reveal', title: 'Big Reveal', style: 'cinematic', mood: 'Dramatic and bold', seconds: 60 },
  { id: 'brass-strut', title: 'Brass Strut', style: 'funk', mood: 'Confident and fun', seconds: 75 },
  { id: 'tiptoe', title: 'Tiptoe', style: 'pizzicato', mood: 'Playful and quirky', seconds: 60 },
  { id: 'neon-highway', title: 'Neon Highway', style: 'synthwave', mood: 'Retro, driving', seconds: 75 },
  { id: 'pixel-quest', title: 'Pixel Quest', style: 'chiptune', mood: 'Games and retro', seconds: 60 },
  { id: 'heavy-hitter', title: 'Heavy Hitter', style: 'trap', mood: 'Bold, high energy', seconds: 60 },
  { id: 'silk-road', title: 'Silk Road', style: 'guofeng', mood: 'Elegant and traditional', seconds: 75 },
]

/** The library track the brief plays when its music style is previewed. */
export const libraryTrackFor = (style: MusicStyle): LibraryTrack | undefined => MUSIC_LIBRARY.find((t) => t.style === style)

/** Where a library track changes section (the composer re-voices on each, so the track develops): every 8 s. */
export function libraryCuts(seconds: number): Array<{ id: string; t: number }> {
  const out: Array<{ id: string; t: number }> = []
  for (let t = 0, i = 0; t < seconds - 4; t += 8, i++) out.push({ id: `part${i + 1}`, t })
  return out
}
