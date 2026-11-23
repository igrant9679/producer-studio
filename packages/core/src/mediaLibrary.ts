// The media library (21 Nov 2026, the owner: "remove the current music samples and create 20 additional music clip
// samples (a mix of genres) as well as 10 different animation video clips, and 10 different full motion video clips").
// Every item is made once, on the cloud server, with the AI keys of a space an operator picks (Operator → Media
// library), kept in the server's storage and shared by every space: people hear or watch it in the editor and add it
// to their video. The music is Google's Lyria (instrumental), the animations are drawn by the space's AI the way a
// video's drawn scenes are, and the full-motion clips are Gemini video. This list is what is made: a changed item
// needs a new id or a new version below (a version makes every item of its kind again).
import type { DrawingStyleId } from './drawingStyles'

/** A track in the music library. */
export interface LibraryTrack {
  id: string
  title: string
  genre: string
  /** In a few words, for the list. */
  mood: string
  /** What the music model is asked for. */
  prompt: string
}

/** A clip in the clip library: drawn by the AI (`animation`) or AI video (`motion`). */
export interface LibraryClip {
  id: string
  title: string
  kind: 'animation' | 'motion'
  /** How an animation is drawn (DRAWING_STYLES; never Blender, which needs a graphics card). */
  style?: DrawingStyleId
  /** What the AI is asked to draw or film. */
  prompt: string
  /** The length asked for. */
  seconds: number
}

/** Bumped when the music changes: every track is made again (and the old files are no longer listed). */
export const MUSIC_LIBRARY_VERSION = 2
/** Bumped when the clips change: every clip is made again. */
export const CLIP_LIBRARY_VERSION = 1

const inst = (s: string) => `Instrumental only, no vocals and no singing. ${s} About two minutes long, with a clear intro and a proper ending.`

export const MUSIC_LIBRARY: readonly LibraryTrack[] = [
  { id: 'morning-espresso', title: 'Morning Espresso', genre: 'Jazz', mood: 'Warm café swing', prompt: inst('A warm jazz trio in a cozy café: brushed drums, walking upright bass and a mellow piano, medium swing.') },
  { id: 'neon-pulse', title: 'Neon Pulse', genre: 'House', mood: 'Energetic, four on the floor', prompt: inst('Upbeat deep house at 124 BPM: four-on-the-floor kick, offbeat hi-hats, warm chord stabs and a rolling bassline.') },
  { id: 'garage-anthem', title: 'Garage Anthem', genre: 'Indie rock', mood: 'Bright and driving', prompt: inst('Feel-good indie rock: jangly electric guitars, punchy live drums and a melodic bass, building to a big final chorus riff.') },
  { id: 'notebook-beats', title: 'Notebook Beats', genre: 'Hip-hop', mood: 'Laid-back boom bap', prompt: inst('Classic boom bap hip-hop beat at 90 BPM: dusty drums, a jazzy sampled-style piano loop, deep bass and vinyl crackle.') },
  { id: 'island-breeze', title: 'Island Breeze', genre: 'Reggae', mood: 'Sunny and relaxed', prompt: inst('Sunny roots reggae: one-drop drums, offbeat guitar skank, round bass and a gentle organ bubble.') },
  { id: 'fiesta-brass', title: 'Fiesta Brass', genre: 'Latin', mood: 'Festive salsa', prompt: inst('Festive salsa: piano montuno, congas and timbales, a tight horn section with trumpets and trombones.') },
  { id: 'heroes-rise', title: 'Heroes Rise', genre: 'Orchestral', mood: 'Epic and triumphant', prompt: inst('Epic cinematic orchestra: soaring strings, bold French horns, timpani and taiko drums, rising to a triumphant climax.') },
  { id: 'velvet-strings', title: 'Velvet Strings', genre: 'Classical', mood: 'Elegant string quartet', prompt: inst('An elegant classical string quartet: two violins, viola and cello playing a graceful, flowing piece.') },
  { id: 'front-porch', title: 'Front Porch', genre: 'Country', mood: 'Homey and easygoing', prompt: inst('Easygoing country: acoustic guitar picking, pedal steel, fiddle and light brushed drums, warm and homey.') },
  { id: 'midnight-groove', title: 'Midnight Groove', genre: 'Funk', mood: 'Groovy and confident', prompt: inst('Groovy funk: slap bass, tight wah-wah guitar, clavinet and punchy horn stabs over a crisp drum groove.') },
  { id: 'dream-drift', title: 'Dream Drift', genre: 'Downtempo', mood: 'Dreamy and floating', prompt: inst('Dreamy downtempo electronica: soft pads, a gentle arpeggio, mellow electric piano and a slow, airy beat.') },
  { id: 'rainy-desk', title: 'Rainy Desk', genre: 'Lo-fi', mood: 'Cozy and focused', prompt: inst('A mellow, relaxed lo-fi beat: soft warm electric piano chords, a gentle laid-back drum groove with a light swing, a round bass line, soft tape texture and distant rain.') },
  { id: 'afro-sun', title: 'Afro Sun', genre: 'Afrobeats', mood: 'Joyful and danceable', prompt: inst('Joyful Afrobeats: bouncy log drums and shakers, bright highlife guitar lines and a warm synth bass.') },
  { id: 'city-rush', title: 'City Rush', genre: 'Drum and bass', mood: 'Fast and urgent', prompt: inst('Liquid drum and bass at 174 BPM: fast breakbeats, a deep rolling sub bass, atmospheric pads and a bright lead.') },
  { id: 'bossa-sunset', title: 'Bossa Sunset', genre: 'Bossa nova', mood: 'Relaxed and breezy', prompt: inst('Relaxed bossa nova: nylon-string guitar, soft brushed drums, upright bass and a light flute melody.') },
  { id: 'delta-road', title: 'Delta Road', genre: 'Blues', mood: 'Slow and soulful', prompt: inst('A slow, soulful twelve-bar blues: a warm electric guitar playing expressive bends, a smooth church-style organ, a walking bass and brushed shuffle drums.') },
  { id: 'highland-trail', title: 'Highland Trail', genre: 'Celtic', mood: 'Adventurous folk', prompt: inst('Adventurous Celtic folk: tin whistle and fiddle melodies, bodhrán drum, acoustic guitar and a lively jig rhythm.') },
  { id: 'bright-ideas', title: 'Bright Ideas', genre: 'Corporate pop', mood: 'Optimistic background', prompt: inst('Optimistic corporate pop for presentations: clean plucked guitars, light piano, claps and a steady uplifting beat.') },
  { id: 'still-water', title: 'Still Water', genre: 'Solo piano', mood: 'Calm and reflective', prompt: inst('A calm, reflective solo piano piece in a neo-classical style, gentle and spacious, with soft dynamics.') },
  { id: 'arena-stomp', title: 'Arena Stomp', genre: 'Stomp rock', mood: 'Powerful, for sport', prompt: inst('Powerful stomp-and-clap rock for sports: huge stomps and claps, distorted guitar riffs and pounding drums.') },
]

/** Drawn without words or narration: a clip anyone can put under their own titles. */
const drawn = (s: string) => `${s} No words, letters, numbers or logos anywhere in the picture.`

export const CLIP_LIBRARY: readonly LibraryClip[] = [
  { id: 'rocket-launch', title: 'Rocket Launch', kind: 'animation', style: 'clean', seconds: 8, prompt: drawn('A cartoon rocket lifts off from its launch pad in a puff of smoke, climbs through fluffy clouds and arcs into a starry sky.') },
  { id: 'hills-sunrise', title: 'Sunrise Over the Hills', kind: 'animation', style: 'watercolour', seconds: 8, prompt: drawn('Sunrise over rolling hills: the sky warms from violet to gold, a few birds glide across and morning mist drifts in the valleys.') },
  { id: 'autumn-fox', title: 'Fox in the Autumn Woods', kind: 'animation', style: 'storybook', seconds: 8, prompt: drawn('A small red fox trots through an autumn forest while orange and yellow leaves fall and swirl around it.') },
  { id: 'machine-blueprint', title: 'Machine Blueprint', kind: 'animation', style: 'blueprint', seconds: 8, prompt: drawn('Gears, pistons and a turbine draw themselves on a technical blueprint, lock together and start turning in sync.') },
  { id: 'chalk-idea', title: 'Chalk Idea', kind: 'animation', style: 'chalkboard', seconds: 8, prompt: drawn('A light bulb is sketched in chalk, flickers on, and sparks fly out into arrows, stars and a rising bar chart.') },
  { id: 'city-street', title: 'Busy City Street', kind: 'animation', style: 'riso', seconds: 8, prompt: drawn('A lively city street: a bus, cyclists and pedestrians pass in front of colourful shopfronts while clouds roll by.') },
  { id: 'growing-charts', title: 'Growing Charts', kind: 'animation', style: 'lottie', seconds: 8, prompt: drawn('Flat motion graphics: a bar chart grows bar by bar, a pie chart fills in, a line chart climbs and a check mark pops in.') },
  { id: 'social-icons', title: 'Connected Icons', kind: 'animation', style: 'lottie', seconds: 8, prompt: drawn('Flat motion graphics: a phone, a chat bubble, a heart and a bell pop in one by one, bounce, and get joined by flowing lines.') },
  { id: 'clay-planet', title: 'Clay Planet', kind: 'animation', style: 'clay3d', seconds: 8, prompt: drawn('A soft clay planet with a ring turns slowly in space while a little clay satellite orbits it and stars twinkle.') },
  { id: 'tiny-factory', title: 'Tiny Factory', kind: 'animation', style: 'isometric3d', seconds: 8, prompt: drawn('A tidy isometric factory: boxes ride a conveyor belt, a robot arm lifts them onto a small truck, and the truck drives away.') },
  { id: 'coastline-aerial', title: 'Coastline From Above', kind: 'motion', seconds: 8, prompt: 'Aerial drone shot gliding over a turquoise ocean coastline, waves breaking on white sand, golden-hour light, smooth cinematic movement.' },
  { id: 'coffee-pour', title: 'Coffee Pour', kind: 'motion', seconds: 8, prompt: 'Slow-motion close-up of hot coffee being poured into a white cup on a wooden table, steam rising, warm morning window light.' },
  { id: 'city-dusk', title: 'City at Dusk', kind: 'motion', seconds: 8, prompt: 'Time-lapse of a modern city skyline at dusk as the office lights switch on and car light trails stream along the streets below.' },
  { id: 'ridge-hiker', title: 'Hiker on the Ridge', kind: 'motion', seconds: 8, prompt: 'A hiker with a backpack walks along a mountain ridge above a sea of clouds at sunrise, the camera following from behind.' },
  { id: 'laptop-typing', title: 'Typing at Work', kind: 'motion', seconds: 8, prompt: 'Close-up of hands typing on a laptop keyboard in a bright, modern office, shallow depth of field, soft daylight.' },
  { id: 'snowy-forest', title: 'Snowy Forest Night', kind: 'motion', seconds: 8, prompt: 'Snow falling softly in a quiet pine forest at night, cool blue moonlight, the camera slowly pushing forward between the trees.' },
  { id: 'balloon-valley', title: 'Balloons at Dawn', kind: 'motion', seconds: 8, prompt: 'Colourful hot-air balloons rising slowly over a green valley at dawn, mist on the fields, a gentle wide shot.' },
  { id: 'team-meeting', title: 'Team Brainstorm', kind: 'motion', seconds: 8, prompt: 'A small team of young professionals smiling and talking around a table covered in sticky notes in a sunny meeting room.' },
  { id: 'rain-leaves', title: 'Rain on Leaves', kind: 'motion', seconds: 8, prompt: 'Macro shot of raindrops falling onto bright green leaves in a lush rainforest, droplets splashing, soft natural light.' },
  { id: 'sunrise-run', title: 'Sunrise Run', kind: 'motion', seconds: 8, prompt: 'A runner jogs across a footbridge in a park at sunrise, the camera tracking alongside, warm backlight and long shadows.' },
]

export type LibraryKind = 'music' | 'animation' | 'motion'

/** A clip as Producer's script writer reads it: what it shows, without the drawing instructions it was made with. */
export function libraryClipAbout(c: Pick<LibraryClip, 'prompt'>): string {
  return c.prompt.replace(/\s*No words, letters, numbers or logos anywhere in the picture\.\s*$/, '').trim()
}

// ---------------- the library in videos Producer makes (23 Nov 2026) ----------------
// The owner asked for the clips and songs "to insert into their videos"; Producer uses them on its own: a song that
// suits the brief's tone under the narration, and clips where they show what a scene says.

/** The library songs that suit each tone, best first (a video plays the first that has been made). */
export const LIBRARY_SONGS_BY_TONE: Record<string, readonly string[]> = {
  confident: ['midnight-groove', 'bright-ideas', 'garage-anthem', 'neon-pulse'],
  friendly: ['bright-ideas', 'morning-espresso', 'front-porch', 'island-breeze'],
  professional: ['bright-ideas', 'still-water', 'velvet-strings', 'dream-drift'],
  energetic: ['neon-pulse', 'arena-stomp', 'city-rush', 'garage-anthem'],
  calm: ['still-water', 'dream-drift', 'rainy-desk', 'bossa-sunset'],
  playful: ['fiesta-brass', 'afro-sun', 'island-breeze', 'notebook-beats'],
  warm: ['morning-espresso', 'front-porch', 'bossa-sunset', 'bright-ideas'],
}
const ANY_TONE = ['bright-ideas', 'morning-espresso', 'dream-drift', 'midnight-groove']

/** The tone's songs (best first; a few that suit most videos for a tone it doesn't know). */
export function librarySongsForTone(tone: string): readonly string[] {
  const t = tone.trim().toLowerCase()
  return LIBRARY_SONGS_BY_TONE[t] ?? Object.entries(LIBRARY_SONGS_BY_TONE).find(([k]) => t.includes(k))?.[1] ?? ANY_TONE
}

/**
 * The library song a video in this tone plays, of those made (`ready`): the tone's best, so the brief can say which
 * one before the video is made. Undefined when none is made.
 */
export function librarySongFor(tone: string, ready: readonly string[]): string | undefined {
  return [...librarySongsForTone(tone), ...ANY_TONE, ...ready].find((id) => ready.includes(id))
}

/** The sound-effect kit that goes with a library song: soft under quiet ones, punchy under beats, crisp otherwise. */
export function libraryKitFor(t: Pick<LibraryTrack, 'genre'>): 'calm' | 'crisp' | 'launch' {
  const g = t.genre.toLowerCase()
  if (/piano|classical|downtempo|lo-fi|bossa|jazz|blues|country|reggae/.test(g)) return 'calm'
  if (/house|drum and bass|rock|orchestral|hip-hop|funk|afrobeats|latin/.test(g)) return 'launch'
  return 'crisp'
}

/** Any item of the library, by id. */
export function libraryItem(id: string): ({ kind: 'music' } & LibraryTrack) | LibraryClip | undefined {
  const t = MUSIC_LIBRARY.find((x) => x.id === id)
  if (t) return { kind: 'music', ...t }
  return CLIP_LIBRARY.find((x) => x.id === id)
}

/**
 * Making an item a space's own (21 Nov 2026, the owner: "customize based on their needs/brand/topic"): any item remade
 * for the space's topic on its own AI keys ('topic'). The brand goes on in the editor, as titles, text and a logo stamp
 * over a clip (the owner: "the branding doesn't need to affect the animations so much as the Narrative Text, Titles,
 * Thumbnail, company stamp/logo").
 */
export type LibraryCustomMode = 'topic'

/** What a remake for a topic costs the space, in words: said before it starts. */
export function libraryCustomCost(it: { kind: LibraryKind; seconds?: number }): string {
  if (it.kind === 'music') return 'One song from Google’s Lyria, on this space’s Gemini key.'
  if (it.kind === 'motion') return `One ${Math.round(it.seconds ?? 8)}-second AI clip, on this space’s video key (Gemini or fal.ai).`
  return 'One drawing by this space’s animation AI, on its key (minutes; a 3D one can take a quarter of an hour).'
}

/** An item as the server lists it: made (`ready`) and how long it measured. */
export type LibraryEntry<T> = T & { ready: boolean; seconds?: number }

/** The operator's view of one item: made, being made, or what stopped it the last time. */
export interface LibraryItemStatus {
  id: string
  kind: LibraryKind
  title: string
  ready: boolean
  seconds?: number
  madeAt?: number
  /** What made it (the model). */
  model?: string
  /** The newest job that made or is making it. */
  job?: { id: string; status: 'queued' | 'running' | 'done' | 'error' | 'cancelled'; progress: number; message: string; error?: string | null }
}
