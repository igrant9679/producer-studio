// The most capable model on a key's live model list, for work where quality matters more than speed or price (AI-drawn
// animation: the model writes drawing code and judges its own frames). A heuristic on the model ids each provider
// publishes, not a benchmark: the tier its name says (Opus / Fable over Sonnet over Haiku; Pro over Flash over Lite;
// a full GPT over mini and nano), then the highest version. Ids for audio, images, embeddings, search or realtime
// aren't writing models and are passed over. Settings → AI shows the pick and lets an owner choose another.
import type { AiKeyProvider } from './api'

const SKIP: Record<AiKeyProvider, RegExp> = {
  anthropic: /(instant|-v\d+:|embed)/i,
  gemini: /(image|tts|audio|live|embed|vision|robotics|computer|learnlm|gemma|aqa|imagen|veo|native)/i,
  openai: /(mini|nano|audio|realtime|search|transcribe|tts|image|dall-e|whisper|embed|moderation|codex|oss|instruct|babbage|davinci|chat-latest|-pro\b|deep-research|sora)/i,
}

function tier(p: AiKeyProvider, id: string): number {
  const s = id.toLowerCase()
  if (p === 'anthropic') return /(opus|fable)/.test(s) ? 3 : /sonnet/.test(s) ? 2 : /haiku/.test(s) ? 1 : 0
  if (p === 'gemini') return /lite/.test(s) ? 1 : /pro/.test(s) ? 3 : /flash/.test(s) ? 2 : 0
  return /^(gpt-\d|o\d)/.test(s) ? 3 : 0
}

/** The model's version as a number: "claude-opus-5-5" → 5.05, "gemini-3.1-pro-preview" → 3.01, "gpt-5.10" → 5.1 (above 5.9 → 5.09). */
export function modelVersion(id: string): number {
  // the first number of one or two digits (dates and long numbers aren't versions), with an optional minor part
  const m = /(?:^|[^\d])(\d{1,2})(?:[.-](\d{1,2}))?(?!\d)/.exec(id)
  if (!m) return 0
  return Number(m[1]) + (m[2] ? Number(m[2]) / 100 : 0)
}

/** The strongest writing model among `models` (as listed, newest first), or undefined when none qualifies. */
export function strongestModel(p: AiKeyProvider, models: readonly string[] | undefined): string | undefined {
  let best: { id: string; score: number } | undefined
  for (const id of models ?? []) {
    if (SKIP[p].test(id)) continue
    const t = tier(p, id)
    if (!t) continue
    // tier first, then version; a preview or dated snapshot loses a tie to the plain id
    const score = t * 1e6 + modelVersion(id) * 1000 - (/(preview|exp|\d{8})/i.test(id) ? 1 : 0)
    if (!best || score > best.score) best = { id, score }
  }
  return best?.id
}
