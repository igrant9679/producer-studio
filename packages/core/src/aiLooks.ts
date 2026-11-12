// The look of a video's AI pictures and clips (the brief's `aiLook`): one art direction added to every generated image
// and clip prompt, so the scenes look like one film rather than a mix of styles. Absent or 'auto': the writer's own
// description decides, as before.

export const AI_LOOKS = [
  { id: 'auto', label: 'As each scene suits', about: 'No set look: each picture is described on its own', prompt: '' },
  {
    id: 'cinematic',
    label: 'Cinematic live action',
    about: 'Like a scene from a well-shot film',
    prompt: 'Cinematic live-action film look: natural, motivated lighting, shallow depth of field, rich but true colour, gentle film grain, smooth deliberate camera movement.',
  },
  {
    id: 'animated3d',
    label: '3D animated film',
    about: 'Appealing 3D characters and worlds, like a big-studio animated feature',
    prompt: 'High-end 3D animated feature film style: appealing stylised characters with expressive faces, soft global illumination, warm rim light, rich saturated colour, detailed but clean sets, fluid character animation.',
  },
  {
    id: 'cartoon2d',
    label: '2D cartoon',
    about: 'Clean outlines and flat colour, like a polished TV cartoon',
    prompt: 'Polished 2D cartoon animation style: clean confident outlines, flat cel shading with soft shadow shapes, a bright harmonious palette, simple painted backgrounds, lively squash-and-stretch animation.',
  },
  {
    id: 'anime',
    label: 'Anime',
    about: 'Painted backgrounds and cel-shaded characters',
    prompt: 'Anime film style: detailed hand-painted backgrounds, cel-shaded characters with clean line art, cinematic light and atmosphere, expressive but natural animation.',
  },
  {
    id: 'claymation',
    label: 'Claymation',
    about: 'Handmade plasticine characters and sets, like stop motion',
    prompt: 'Stop-motion claymation style: handmade plasticine characters and miniature sets, visible fingerprints and texture, soft studio lighting, charming slightly stepped movement.',
  },
  {
    id: 'motiongraphics',
    label: 'Motion graphics',
    about: 'Clean flat shapes and smooth design-led motion',
    prompt: 'Clean flat motion-graphics style: bold geometric shapes, a limited modern palette, minimal detail, generous space, smooth eased design-led motion, no photographic textures.',
  },
  {
    id: 'watercolour',
    label: 'Watercolour storybook',
    about: 'Soft painted washes on paper, like a picture book',
    prompt: 'Hand-painted watercolour storybook style: soft washes and blooms of colour on textured paper, delicate pencil line, gentle light, calm unhurried motion.',
  },
  {
    id: 'papercut',
    label: 'Paper cut-out',
    about: 'Layers of cut paper with soft shadows between them',
    prompt: 'Layered paper cut-out craft style: cut paper shapes in layers with soft shadows between them, tactile paper texture, a warm limited palette, gentle parallax movement.',
  },
] as const

export type AiLookId = (typeof AI_LOOKS)[number]['id']

/** A known look id, or 'auto'. */
export function aiLookOf(v: unknown): AiLookId {
  return AI_LOOKS.some((l) => l.id === v) ? (v as AiLookId) : 'auto'
}

/** A scene's image / clip prompt in the video's look (unchanged for 'auto'). */
export function withAiLook(prompt: string, look: unknown): string {
  const l = AI_LOOKS.find((x) => x.id === aiLookOf(look))
  return l?.prompt ? `${prompt.trim()}\n\nVisual style: ${l.prompt}` : prompt
}

/** Every scene a generated clip (the brief's `motion: 'full'`): AI clips made per video at most then. */
export const MAX_AI_CLIPS_FULL_MOTION = 16
