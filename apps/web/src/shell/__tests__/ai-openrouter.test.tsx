// Settings → AI: OpenRouter (27 Nov 2026). Its card picks a model from OpenRouter's own list with the price per million
// tokens, offering only the models that answer in shape; a space without a key of its own can choose OpenRouter on the
// server's shared key (the server's AI); the Operator page switches the server's AI for spaces that chose none.
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { AiSettings, OpenRouterModel, PlatformAiSettings } from '@producer/core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { opsApi } from '../../lib/opsApi'
import { useSession } from '../../lib/session'
import { AiProviders } from '../pages/AiProviders'
import { systemApi, useSystem } from '../system'

const eff = { provider: 'none' as const }
const base = (patch: Partial<AiSettings> = {}): AiSettings => ({
  canEdit: true,
  defaultProvider: null,
  perFeature: {},
  builtin: { id: 'anthropic-api', available: true, detail: 'Anthropic API' },
  providers: {},
  media: {},
  videoProvider: null,
  effective: { writer: eff, script: eff, assistant: eff, animation: eff },
  ...patch,
})
const model = (id: string, name: string, p: number, c: number, extra: Partial<OpenRouterModel> = {}): OpenRouterModel => ({ id, name, created: 1, contextLength: 1000, promptPerM: p, completionPerM: c, tools: true, structured: true, vision: true, reasoning: false, ...extra })
const MODELS = [
  model('anthropic/claude-sonnet-5.5', 'Anthropic: Claude Sonnet 5.5', 2, 10),
  model('openai/gpt-5.5', 'OpenAI: GPT-5.5', 1.25, 10),
  model('some/plain-chat', 'Plain chat', 0.1, 0.2, { tools: false, structured: false }),
  model('meta/llama-text', 'Llama text', 0.05, 0.08, { vision: false }),
]

beforeEach(() => {
  useSession.setState({ status: 'ready', workspaceId: 'ws_a', workspaces: [{ id: 'ws_a', name: 'Home', role: 'owner', personal: true, memberCount: 1 }] })
  useSystem.setState({ load: vi.fn(async () => undefined) } as never)
  vi.spyOn(systemApi, 'openRouterModels').mockResolvedValue({ models: MODELS, defaultModel: 'anthropic/claude-sonnet-5.5' })
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('the OpenRouter card', () => {
  it('lists OpenRouter’s models that answer in shape, with prices, searchable; saving one saves it for OpenRouter', async () => {
    vi.spyOn(systemApi, 'aiSettings').mockResolvedValue(base({ providers: { openrouter: { model: '', hasKey: true, keyLast4: 'abcd', valid: true, models: ['anthropic/claude-sonnet-5.5'] } } }))
    const save = vi.spyOn(systemApi, 'saveAiSettings').mockResolvedValue(base({ providers: { openrouter: { model: 'openai/gpt-5.5', hasKey: true, valid: true } } }))
    render(<AiProviders desktop={false} renderBuiltin={() => null} />)
    const card = await screen.findByLabelText('OpenRouter')
    const select = await waitFor(() => {
      const s = within(card).getByLabelText('Model') as HTMLSelectElement
      expect(s.disabled).toBe(false)
      return s
    })
    const options = [...select.options].map((o) => o.textContent)
    expect(options).toContain('Anthropic: Claude Sonnet 5.5 · $2.00 in / $10.00 out per M tokens')
    expect(options).toContain('OpenAI: GPT-5.5 · $1.25 in / $10.00 out per M tokens')
    // a model that can't answer in shape isn't offered
    expect(options.some((o) => o?.includes('Plain chat'))).toBe(false)
    expect(options[0]).toBe('Default: anthropic/claude-sonnet-5.5')
    fireEvent.change(within(card).getByLabelText('Search OpenRouter models'), { target: { value: 'gpt' } })
    expect([...select.options].map((o) => o.value)).toEqual(['', 'openai/gpt-5.5', '__custom'])
    fireEvent.change(select, { target: { value: 'openai/gpt-5.5' } })
    await waitFor(() => expect(save).toHaveBeenCalledWith({ workspaceId: 'ws_a', models: { openrouter: 'openai/gpt-5.5' } }))
  })

  it('says when a picked model can’t look at pictures', async () => {
    vi.spyOn(systemApi, 'aiSettings').mockResolvedValue(base({ providers: { openrouter: { model: 'meta/llama-text', hasKey: true, valid: true } } }))
    render(<AiProviders desktop={false} renderBuiltin={() => null} />)
    expect(await screen.findByText(/This model can’t look at pictures/)).toBeTruthy()
  })

  it('without a key of its own, the space can choose OpenRouter on the server’s key', async () => {
    vi.spyOn(systemApi, 'aiSettings').mockResolvedValue(base({ openrouterShared: { available: true, detail: 'OpenRouter · Producer Studio’s key', model: 'anthropic/claude-sonnet-5.5' } }))
    const save = vi.spyOn(systemApi, 'saveAiSettings').mockResolvedValue(base({ defaultProvider: 'openrouter' }))
    render(<AiProviders desktop={false} renderBuiltin={() => null} />)
    expect(await screen.findByText(/Without a key of your own, OpenRouter runs on Producer Studio’s key/)).toBeTruthy()
    const def = screen.getByLabelText('Default AI provider') as HTMLSelectElement
    expect([...def.options].map((o) => o.textContent)).toContain('OpenRouter (Producer Studio’s key) · anthropic/claude-sonnet-5.5')
    fireEvent.change(def, { target: { value: 'openrouter' } })
    await waitFor(() => expect(save).toHaveBeenCalledWith({ workspaceId: 'ws_a', defaultProvider: 'openrouter' }))
  })

  it('no shared key and no key of its own: OpenRouter isn’t a choice', async () => {
    vi.spyOn(systemApi, 'aiSettings').mockResolvedValue(base())
    render(<AiProviders desktop={false} renderBuiltin={() => null} />)
    await screen.findByLabelText('OpenRouter')
    const def = screen.getByLabelText('Default AI provider') as HTMLSelectElement
    expect([...def.options].some((o) => o.value === 'openrouter')).toBe(false)
  })
})

describe('Operator → AI', () => {
  it('switches the server’s AI to OpenRouter only when its key is set', async () => {
    useSession.setState({ operator: true } as never)
    const { default: OperatorPage } = await import('../pages/OperatorPage')
    const view = (p: Partial<PlatformAiSettings>): PlatformAiSettings => ({ defaultProvider: 'anthropic', openrouterKey: false, anthropicKey: true, openrouterModel: 'anthropic/claude-sonnet-5.5', ...p })
    vi.spyOn(opsApi, 'aiDefault').mockResolvedValue(view({}))
    vi.spyOn(opsApi, 'users').mockResolvedValue([])
    const set = vi.spyOn(opsApi, 'setAiDefault').mockResolvedValue(view({ openrouterKey: true, defaultProvider: 'openrouter' }))
    const { MemoryRouter } = await import('react-router-dom')
    const r = render(
      <MemoryRouter>
        <OperatorPage />
      </MemoryRouter>,
    )
    fireEvent.click(await screen.findByRole('tab', { name: /AI/ }))
    const radios = await screen.findAllByRole('radio')
    expect((radios[1] as HTMLInputElement).disabled).toBe(true)
    expect(screen.getByText(/set OPENROUTER_API_KEY on the server/)).toBeTruthy()
    r.unmount()
    vi.spyOn(opsApi, 'aiDefault').mockResolvedValue(view({ openrouterKey: true }))
    render(
      <MemoryRouter>
        <OperatorPage />
      </MemoryRouter>,
    )
    fireEvent.click(await screen.findByRole('tab', { name: /AI/ }))
    const on = (await screen.findAllByRole('radio'))[1] as HTMLInputElement
    expect(on.disabled).toBe(false)
    fireEvent.click(on)
    await waitFor(() => expect(set).toHaveBeenCalledWith({ defaultProvider: 'openrouter' }))
  })
})
