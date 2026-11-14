// Settings → AI: an owner shares a space's key with other spaces they own ("Shared with" on the key's card), and the
// space that uses a shared key says whose it is and lets its owner stop using it. Owners only; never on the desktop.
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { AiSettings, Workspace } from '@producer/core'
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
  effective: { writer: eff, script: eff, assistant: eff, animation: eff },
  ...patch,
})
const claude = { model: 'claude-opus-5-5', hasKey: true, keyLast4: 'wxyz', valid: true, models: ['claude-opus-5-5'] }
const space = (id: string, name: string, role: Workspace['role']): Workspace => ({ id, name, role, personal: false, memberCount: 1 })
const SPACES = [space('ws_a', 'Home', 'owner'), space('ws_b', 'Client B', 'owner'), space('ws_c', 'Client C', 'owner'), space('ws_e', 'Where I edit', 'editor')]

const card = () => screen.getByLabelText('Anthropic API key')
const group = () => within(card()).getByRole('group', { name: 'Share the Anthropic key' })

beforeEach(() => {
  useSession.setState({ status: 'ready', workspaceId: 'ws_a', workspaces: SPACES })
  useSystem.setState({ load: vi.fn(async () => undefined) } as never)
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('sharing a key with other spaces', () => {
  it('offers the spaces the person owns, shares with the one picked, and lists it', async () => {
    vi.spyOn(systemApi, 'aiSettings').mockResolvedValue(base({ providers: { anthropic: claude } }))
    const share = vi.spyOn(systemApi, 'shareAiKey').mockResolvedValue(base({ providers: { anthropic: { ...claude, sharedWith: [{ workspaceId: 'ws_b', name: 'Client B' }] } } }))
    render(<AiProviders desktop={false} renderBuiltin={() => null} />)
    await waitFor(() => expect(group()).toBeTruthy())
    expect(within(group()).getByText('no other space')).toBeTruthy()
    const pick = within(group()).getByLabelText('Share the Anthropic key with a space') as HTMLSelectElement
    // spaces they own, never this one or one they only edit
    expect([...pick.options].map((o) => o.textContent)).toEqual(['Share with a space…', 'Client B', 'Client C'])
    fireEvent.change(pick, { target: { value: 'ws_b' } })
    await waitFor(() => expect(share).toHaveBeenCalledWith('anthropic', 'ws_b', 'ws_a'))
    await waitFor(() => expect(within(group()).getByRole('button', { name: 'Stop sharing the Anthropic key with Client B' })).toBeTruthy())
    expect(within(group()).queryByText('no other space')).toBeNull()
    // the space it is shared with is no longer offered
    expect([...(within(group()).getByLabelText('Share the Anthropic key with a space') as HTMLSelectElement).options].map((o) => o.textContent)).toEqual(['Share with a space…', 'Client C'])
  })

  it('stops sharing with a space, and says so before a shared key is removed', async () => {
    const withB = base({ providers: { anthropic: { ...claude, sharedWith: [{ workspaceId: 'ws_b', name: 'Client B' }] } } })
    vi.spyOn(systemApi, 'aiSettings').mockResolvedValue(withB)
    const unshare = vi.spyOn(systemApi, 'unshareAiKey').mockResolvedValue(base({ providers: { anthropic: claude } }))
    render(<AiProviders desktop={false} renderBuiltin={() => null} />)
    await waitFor(() => expect(group()).toBeTruthy())
    fireEvent.click(within(card()).getByRole('button', { name: 'Remove key' }))
    expect(within(card()).getByRole('button', { name: 'Remove key (ends sharing with 1 space)' })).toBeTruthy()
    fireEvent.click(within(card()).getByRole('button', { name: 'Cancel' }))
    fireEvent.click(within(group()).getByRole('button', { name: 'Stop sharing the Anthropic key with Client B' }))
    await waitFor(() => expect(unshare).toHaveBeenCalledWith('anthropic', 'ws_b', 'ws_a'))
    await waitFor(() => expect(within(group()).getByText('no other space')).toBeTruthy())
  })

  it('a refusal from the server is shown on the card', async () => {
    vi.spyOn(systemApi, 'aiSettings').mockResolvedValue(base({ providers: { anthropic: claude } }))
    vi.spyOn(systemApi, 'shareAiKey').mockRejectedValue(new Error('“Client C” has its own Claude key. Remove it there first.'))
    render(<AiProviders desktop={false} renderBuiltin={() => null} />)
    await waitFor(() => expect(group()).toBeTruthy())
    fireEvent.change(within(group()).getByLabelText('Share the Anthropic key with a space'), { target: { value: 'ws_c' } })
    expect((await within(card()).findByRole('status')).textContent).toMatch(/has its own Claude key/)
  })

  it('is for owners, on the web, and for keys the space holds itself', async () => {
    // a member who isn't an owner: no sharing controls
    vi.spyOn(systemApi, 'aiSettings').mockResolvedValue(base({ canEdit: false, providers: { anthropic: claude } }))
    const first = render(<AiProviders desktop={false} renderBuiltin={() => null} />)
    await waitFor(() => expect(card()).toBeTruthy())
    expect(within(card()).queryByRole('group', { name: 'Share the Anthropic key' })).toBeNull()
    first.unmount()
    // the desktop app has one local scope
    vi.spyOn(systemApi, 'aiSettings').mockResolvedValue(base({ providers: { anthropic: claude } }))
    const second = render(<AiProviders desktop renderBuiltin={() => null} />)
    await waitFor(() => expect(card()).toBeTruthy())
    expect(within(card()).queryByRole('group', { name: 'Share the Anthropic key' })).toBeNull()
    second.unmount()
    // no key yet: nothing to share
    vi.spyOn(systemApi, 'aiSettings').mockResolvedValue(base())
    render(<AiProviders desktop={false} renderBuiltin={() => null} />)
    await waitFor(() => expect(card()).toBeTruthy())
    expect(within(card()).queryByRole('group', { name: 'Share the Anthropic key' })).toBeNull()
  })

  it('an owner with no other space is told why there is nobody to share with', async () => {
    useSession.setState({ workspaces: [SPACES[0], SPACES[3]] })
    vi.spyOn(systemApi, 'aiSettings').mockResolvedValue(base({ providers: { anthropic: claude } }))
    render(<AiProviders desktop={false} renderBuiltin={() => null} />)
    await waitFor(() => expect(group()).toBeTruthy())
    expect(within(group()).queryByLabelText('Share the Anthropic key with a space')).toBeNull()
    expect(within(group()).getByText(/You don’t own another space yet/)).toBeTruthy()
  })
})

describe('a model that isn’t on the key’s list', () => {
  it('is pointed out, since requests with it are likely to fail', async () => {
    vi.spyOn(systemApi, 'aiSettings').mockResolvedValue(base({ providers: { anthropic: { ...claude, model: 'claude-opus-5.5-...' } } }))
    render(<AiProviders desktop={false} renderBuiltin={() => null} />)
    await waitFor(() => expect(card()).toBeTruthy())
    expect(within(card()).getByRole('alert').textContent).toMatch(/“claude-opus-5\.5-\.\.\.” isn’t on this key’s list of models/)
  })

  it('a listed model, or a key with no list yet, gets no warning', async () => {
    vi.spyOn(systemApi, 'aiSettings').mockResolvedValue(base({ providers: { anthropic: claude, openai: { model: 'gpt-typed-by-hand', hasKey: true, keyLast4: 'abcd' } } }))
    render(<AiProviders desktop={false} renderBuiltin={() => null} />)
    await waitFor(() => expect(card()).toBeTruthy())
    expect(screen.queryByRole('alert')).toBeNull()
  })
})

describe('a space that uses a shared key', () => {
  const lent = base({ defaultProvider: 'anthropic', providers: { anthropic: { model: 'claude-opus-5-5', hasKey: true, valid: true, models: ['claude-opus-5-5'], shared: { workspaceId: 'ws_a', name: 'Home' } } } })

  it('says whose key it is, never shows it, and can’t pass it on', async () => {
    useSession.setState({ workspaceId: 'ws_b' })
    vi.spyOn(systemApi, 'aiSettings').mockResolvedValue(lent)
    render(<AiProviders desktop={false} renderBuiltin={() => null} />)
    await waitFor(() => expect(card()).toBeTruthy())
    const c = within(card())
    expect(c.getByText('Shared')).toBeTruthy()
    expect((c.getByLabelText('API key') as HTMLInputElement).placeholder).toBe('Shared by “Home”')
    expect(c.getByText(/billed to that key’s account/)).toBeTruthy()
    expect(c.queryByRole('group', { name: 'Share the Anthropic key' })).toBeNull()
    // it is a working provider here like any other key
    expect((screen.getByLabelText('Default AI provider') as HTMLSelectElement).value).toBe('anthropic')
    expect(c.getByLabelText('Model')).toBeTruthy()
  })

  it('its owner can stop using it', async () => {
    useSession.setState({ workspaceId: 'ws_b' })
    vi.spyOn(systemApi, 'aiSettings').mockResolvedValue(lent)
    const del = vi.spyOn(systemApi, 'deleteAiKey').mockResolvedValue(base())
    render(<AiProviders desktop={false} renderBuiltin={() => null} />)
    await waitFor(() => expect(card()).toBeTruthy())
    fireEvent.click(within(card()).getByRole('button', { name: 'Stop using shared key' }))
    fireEvent.click(within(card()).getByRole('button', { name: 'Stop using it' }))
    await waitFor(() => expect(del).toHaveBeenCalledWith('anthropic', 'ws_b'))
    await waitFor(() => expect(within(card()).queryByText('Shared')).toBeNull())
  })

  it('a member who isn’t an owner sees whose key it is and no way to change it', async () => {
    useSession.setState({ workspaceId: 'ws_b' })
    vi.spyOn(systemApi, 'aiSettings').mockResolvedValue({ ...lent, canEdit: false })
    render(<AiProviders desktop={false} renderBuiltin={() => null} />)
    await waitFor(() => expect(card()).toBeTruthy())
    expect(within(card()).getByText('Shared')).toBeTruthy()
    expect(within(card()).queryByRole('button', { name: 'Stop using shared key' })).toBeNull()
  })
})
