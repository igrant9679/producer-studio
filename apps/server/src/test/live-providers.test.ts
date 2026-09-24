// Optional live smoke tests against the real APIs. Skipped unless OPENAI_API_KEY / GEMINI_API_KEY (or GOOGLE_API_KEY)
// / ANTHROPIC_LIVE_KEY are set. Each run lists models and streams one tiny completion (a few tokens, billed).
import { describe, expect, it } from 'vitest'
import type { AiKeyProvider } from '@producer/core'
import { buildKeyProvider, testKey } from '../ai/keys'

const KEYS: Record<AiKeyProvider, string | undefined> = {
  openai: process.env.OPENAI_API_KEY,
  gemini: process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY,
  anthropic: process.env.ANTHROPIC_LIVE_KEY,
}

for (const provider of Object.keys(KEYS) as AiKeyProvider[]) {
  const key = KEYS[provider]
  describe.skipIf(!key)(`live ${provider}`, () => {
    it('validates the key, lists models and streams a short headline', async () => {
      const t = await testKey(provider, key!)
      expect(t.ok, t.detail).toBe(true)
      expect(t.models.length).toBeGreaterThan(0)
      const p = buildKeyProvider(provider, key!, t.defaultModel!)
      const deltas: string[] = []
      const text = await p.write({ kind: 'headline', prompt: 'A video about spreadsheets', maxWords: 6 }, (d) => deltas.push(d))
      expect(text.length).toBeGreaterThan(0)
      expect(deltas.join('').trim()).toBe(text)
    }, 120_000)
  })
}
