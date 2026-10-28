import { describe, expect, it } from 'vitest'
import { estimateCost, rateFamily, tokenRate } from './usage'

describe('estimated AI cost (A-18)', () => {
  it('prices tokens by the longest matching model prefix of the provider', () => {
    expect(tokenRate('anthropic-api', 'claude-opus-5-5')).toEqual({ input: 4, output: 20 })
    expect(tokenRate('anthropic-key', 'claude-opus-5')).toEqual({ input: 5, output: 25 })
    expect(tokenRate('anthropic-key', 'claude-sonnet-5-5')).toEqual({ input: 2, output: 10 })
    expect(tokenRate('openai', 'gpt-5.5')).toEqual({ input: 1.25, output: 10 })
    // a model not listed falls back to the provider's own row
    expect(tokenRate('gemini', 'gemini-pro-latest')).toEqual({ input: 1.25, output: 10 })
    expect(tokenRate('somebody-else', 'x')).toBeUndefined()
  })

  it('costs a million input and output tokens at the listed rates; the Claude CLI and nothing cost nothing here', () => {
    expect(estimateCost('anthropic-api', 'claude-opus-5-5', 1_000_000, 1_000_000)).toBe(24)
    expect(estimateCost('anthropic-key', 'claude-opus-5-5', 200, 100)).toBeCloseTo(0.0028)
    expect(estimateCost('claude-cli', 'claude-opus-5-5', 1_000_000, 0)).toBe(0)
    expect(estimateCost('none', '', 10, 10)).toBe(0)
    expect(rateFamily('anthropic-key')).toBe('anthropic')
  })
})
