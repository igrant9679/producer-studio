// OpenRouter model ids ("vendor/model") in the shared helpers: price estimates use the maker's list price (the Usage
// page shows the dollars OpenRouter reports instead), and the automatic animation model ranks the Claude lines as
// Anthropic's own.
import { describe, expect, it } from 'vitest'
import { estimateCost, rateFamily, strongestModel, tokenRate } from './index'

describe('OpenRouter ids', () => {
  it('estimate at the maker’s list price; a model with no known maker estimates nothing', () => {
    expect(tokenRate('openrouter', 'anthropic/claude-sonnet-5.5')).toEqual(tokenRate('anthropic-key', 'claude-sonnet-5-5'))
    expect(tokenRate('openrouter-api', 'openai/gpt-5.5')).toEqual(tokenRate('openai', 'gpt-5.5'))
    expect(tokenRate('openrouter', 'google/gemini-2.5-flash')).toEqual(tokenRate('gemini', 'gemini-2.5-flash'))
    expect(tokenRate('openrouter', 'anthropic/claude-sonnet-5.5:batch')).toEqual(tokenRate('anthropic', 'claude-sonnet-5-5'))
    expect(tokenRate('openrouter', 'meta-llama/llama-4')).toBeUndefined()
    expect(estimateCost('openrouter', 'meta-llama/llama-4', 1000, 1000)).toBe(0)
    expect(rateFamily('openrouter-api')).toBe('openrouter')
  })

  it('the strongest on an OpenRouter list is the strongest Claude, free and batch variants passed over', () => {
    const list = ['openai/gpt-5.5', 'anthropic/claude-sonnet-5.5', 'anthropic/claude-opus-5.5', 'anthropic/claude-fable-5.2:batch', 'anthropic/claude-opus-5', 'meta-llama/llama-4']
    expect(strongestModel('openrouter', list)).toBe('anthropic/claude-opus-5.5')
    expect(strongestModel('openrouter', [...list, 'anthropic/claude-fable-5.2'])).toBe('anthropic/claude-fable-5.2')
    expect(strongestModel('openrouter', ['openai/gpt-5.5', 'meta-llama/llama-4'])).toBeUndefined()
  })
})
