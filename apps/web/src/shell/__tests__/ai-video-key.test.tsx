// Settings → AI: the fal.ai key (Wan video clips) is a key card of its own, with no model picker, its price after the
// test, and, when a Gemini key could make clips too, a choice of who does.
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { AiKeyTestResult, AiSettings } from '@producer/core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useSession } from '../../lib/session'
import { AiProviders } from '../pages/AiProviders'
import { systemApi, useSystem } from '../system'

const eff = { provider: 'none' as const }
const base = (patch: Partial<AiSettings> = {}): AiSettings => ({
  canEdit: true,
  defaultProvider: null,
  perFeature: {},
  builtin: { id: 'anthropic-api', available: false, detail: '' },
  providers: {},
  media: {},
  videoProvider: null,
  effective: { writer: eff, script: eff, assistant: eff },
  ...patch,
})
const PRICE = 'Wan 2.2: $0.08 per second of video'
const withFal = (patch: Partial<AiSettings> = {}) => base({ media: { fal: { hasKey: true, keyLast4: 'cdef', valid: true, price: PRICE } }, ...patch })
const gemini = { model: 'gemini-3-pro', hasKey: true, keyLast4: 'hijk', valid: true, models: ['gemini-3-pro'] }

const card = () => screen.getByLabelText('fal.ai (Wan video clips)')

beforeEach(() => {
  useSession.setState({ status: 'ready', workspaceId: 'ws_a' })
  useSystem.setState({ load: vi.fn(async () => undefined) } as never)
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('the fal.ai key card', () => {
  it('saves and tests a key for the space, then shows what a clip costs; no model to pick', async () => {
    vi.spyOn(systemApi, 'aiSettings').mockResolvedValue(base())
    const save = vi.spyOn(systemApi, 'saveAiKey').mockResolvedValue({ ok: true, models: [], detail: `✓ valid · ${PRICE}`, price: PRICE, settings: withFal() } satisfies AiKeyTestResult)
    render(<AiProviders desktop={false} renderBuiltin={() => null} />)
    await waitFor(() => expect(card()).toBeTruthy())
    const c = within(card())
    expect(c.queryByLabelText('Model')).toBeNull()
    expect(c.getByText(/clips only, never for writing/)).toBeTruthy()
    fireEvent.change(c.getByLabelText('API key'), { target: { value: 'abc-123:secret' } })
    fireEvent.click(c.getByRole('button', { name: /Save & test/ }))
    await waitFor(() => expect(save).toHaveBeenCalledWith('fal', 'abc-123:secret', 'ws_a'))
    expect((await c.findByRole('status')).textContent).toMatch(/valid · Wan 2\.2: \$0\.08 per second of video/)
    // fal isn't offered as a writing provider
    expect(screen.getByLabelText('Default AI provider').textContent).not.toMatch(/fal/i)
  })

  it('a stored key that fails its test says why', async () => {
    vi.spyOn(systemApi, 'aiSettings').mockResolvedValue(base({ media: { fal: { hasKey: true, keyLast4: 'cdef', valid: false, error: 'fal.ai didn’t accept this key.' } } }))
    render(<AiProviders desktop={false} renderBuiltin={() => null} />)
    expect(await within(await screen.findByLabelText('fal.ai (Wan video clips)')).findByText('fal.ai didn’t accept this key.')).toBeTruthy()
  })
})

describe('who makes AI clips', () => {
  it('is only asked when Gemini and fal.ai keys are both stored', async () => {
    vi.spyOn(systemApi, 'aiSettings').mockResolvedValue(withFal())
    render(<AiProviders desktop={false} renderBuiltin={() => null} />)
    await waitFor(() => expect(card()).toBeTruthy())
    expect(screen.queryByLabelText('AI video clips provider')).toBeNull()
    // fal alone makes the clips
    expect(within(card()).getByText('In use')).toBeTruthy()
  })

  it('choosing Wan saves it for the space and marks the fal.ai key in use', async () => {
    vi.spyOn(systemApi, 'aiSettings').mockResolvedValue(withFal({ providers: { gemini } }))
    const save = vi.spyOn(systemApi, 'saveAiSettings').mockResolvedValue(withFal({ providers: { gemini }, videoProvider: 'fal' }))
    render(<AiProviders desktop={false} renderBuiltin={() => null} />)
    const select = (await screen.findByLabelText('AI video clips provider')) as HTMLSelectElement
    expect(select.value).toBe('')
    // automatic: Gemini first
    expect(within(card()).queryByText('In use')).toBeNull()
    fireEvent.change(select, { target: { value: 'fal' } })
    await waitFor(() => expect(save).toHaveBeenCalledWith({ workspaceId: 'ws_a', videoProvider: 'fal' }))
    await waitFor(() => expect((screen.getByLabelText('AI video clips provider') as HTMLSelectElement).value).toBe('fal'))
    expect(within(card()).getByText('In use')).toBeTruthy()
  })
})
