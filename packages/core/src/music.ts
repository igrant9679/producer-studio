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

/** How long the sample of a music style the brief plays is (composed by the server, like a video's own music). */
export const STYLE_SAMPLE_SECONDS = 45

/** Where a style sample changes section (the composer re-voices on each, so the sample develops): every 8 s. */
export function styleSampleCuts(seconds: number): Array<{ id: string; t: number }> {
  const out: Array<{ id: string; t: number }> = []
  for (let t = 0, i = 0; t < seconds - 4; t += 8, i++) out.push({ id: `part${i + 1}`, t })
  return out
}
