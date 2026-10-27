// Voice Studio: consent starts blank for every gallery voice and pack (APP-12); deletes ask first, with sizes, the
// licence is shown before it's accepted, and My voices deletes once (APP-28).
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { SystemInfo, VoiceProfile, Workspace } from '@producer/core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useSession } from '../../lib/session'
import { useSystem } from '../system'
import EnginePanel from '../voicestudio/EnginePanel'
import Gallery from '../voicestudio/Gallery'
import { MyVoices } from '../voicestudio/MyVoices'
import { useVsStatusStore } from '../voicestudio/vsApi'

vi.setConfig({ testTimeout: 30_000 })

const ws: Workspace = { id: 'ws_me', name: 'Me', role: 'owner', personal: true, memberCount: 1 }
const desktop: SystemInfo = { mode: 'desktop', version: '1', ai: { provider: 'claude-cli', available: true, detail: '' }, capabilities: { transcribe: true, tts: true, render: true } }

type Handler = (url: URL, init: RequestInit) => unknown
let routes: Array<[string, RegExp, Handler]>
let calls: Array<{ method: string; path: string; body?: unknown }>
const route = (method: string, re: RegExp, h: Handler) => routes.push([method, re, h])

beforeEach(() => {
  routes = []
  calls = []
  useSession.setState({ status: 'ready', workspaces: [ws], workspaceId: ws.id, user: { id: 'u', email: 'a@b.c', name: 'Alex Kim' } as never })
  useSystem.setState({ info: desktop, loaded: true })
  useVsStatusStore.setState({ status: { state: 'running' } as never, loaded: true })
  route('GET', /\/api\/voicestudio\/status$/, () => ({ state: 'running' }))
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init: RequestInit = {}) => {
      const url = new URL(String(input), 'http://localhost')
      const method = init.method ?? 'GET'
      const body = typeof init.body === 'string' ? JSON.parse(init.body) : init.body
      calls.push({ method, path: url.pathname, body })
      const hit = routes.find(([m, re]) => m === method && re.test(url.pathname))
      const out = hit ? await hit[2](url, init) : {}
      return new Response(JSON.stringify(out ?? {}), { status: 200, headers: { 'content-type': 'application/json' } })
    }),
  )
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const consentBox = () => screen.getByRole('checkbox') as HTMLInputElement
const speakerField = () => screen.getByPlaceholderText('Speaker’s full name') as HTMLInputElement

describe('consent starts blank for every voice (APP-12)', () => {
  it('community voices: adding Tom, then opening Maya, never carries Tom’s consent', async () => {
    route('GET', /\/community\/items$/, () => ({ total: 2, items: [{ id: 'c_tom', name: 'Tom', type: 'voice' }, { id: 'c_maya', name: 'Maya', type: 'voice' }] }))
    route('POST', /\/community\/items\/c_tom\/use$/, () => ({ profile_id: 'vs_tom', name: 'Tom' }))
    route('POST', /\/voicestudio\/voices\/adopt$/, (_u, init) => ({ ...JSON.parse(String(init.body)), id: 'vp_1' }))
    render(<Gallery onOpenEngine={() => undefined} />)
    fireEvent.click(await screen.findByRole('button', { name: /Community/ }))
    const cards = await screen.findAllByRole('button', { name: /Add to my voices/ })
    fireEvent.click(cards[0])
    expect(speakerField().value).toBe('Tom')
    fireEvent.click(consentBox())
    fireEvent.click(screen.getByRole('button', { name: /Add voice/ }))
    await waitFor(() => expect(calls.some((c) => c.path.endsWith('/voices/adopt'))).toBe(true))
    expect(calls.find((c) => c.path.endsWith('/voices/adopt'))!.body).toMatchObject({ name: 'Tom', consent: { agreed: true, speaker: 'Tom' } })
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    fireEvent.click(screen.getAllByRole('button', { name: /Add to my voices/ })[1])
    expect(speakerField().value).toBe('Maya')
    expect(consentBox().checked).toBe(false)
  })

  it('voice packs: picking a second pack starts its consent over', async () => {
    let n = 0
    route('POST', /\/personas\/inspect$/, () => ({ name: ++n === 1 ? 'Tom' : 'Maya', kind: 'clone' }))
    render(<Gallery onOpenEngine={() => undefined} />)
    fireEvent.click(await screen.findByRole('button', { name: /Voice packs/ }))
    const input = document.querySelector('input[type="file"]') as HTMLInputElement
    fireEvent.change(input, { target: { files: [new File(['a'], 'tom.ovsvoice')] } })
    await waitFor(() => expect(speakerField().value).toBe('Tom'))
    fireEvent.click(consentBox())
    expect(consentBox().checked).toBe(true)
    fireEvent.change(input, { target: { files: [new File(['b'], 'maya.ovsvoice')] } })
    await waitFor(() => expect(speakerField().value).toBe('Maya'))
    expect(consentBox().checked).toBe(false)
  })
})

describe('deletes ask first (APP-28)', () => {
  it('a gallery clip is deleted only after confirming, with Cancel focused', async () => {
    route('GET', /\/gallery\/voices$/, () => [{ id: 'g1', name: 'Podcast intro', duration: 12, created_at: 1 }])
    render(<Gallery onOpenEngine={() => undefined} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Delete Podcast intro' }))
    const dialog = screen.getByRole('dialog')
    expect(dialog.textContent).toMatch(/Delete “Podcast intro”\?/)
    expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: 'Cancel' }))
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false)
    fireEvent.click(within(dialog).getByRole('button', { name: /Delete clip/ }))
    await waitFor(() => expect(calls.filter((c) => c.method === 'DELETE').map((c) => c.path)).toEqual(['/api/voicestudio/x/gallery/voices/g1']))
    await waitFor(() => expect(screen.queryByText('Podcast intro')).toBeNull())
  })

  it('removing a model says its size and when it is the required one', async () => {
    route('GET', /\/x\/models$/, () => ({ models: [{ repo_id: 'org/voice-base', label: 'Voice base', size_on_disk_bytes: 3.3 * 1024 ** 3, installed: true, required: true, role: 'Voice' }] }))
    route('GET', /\/models\/install\/status$/, () => ({ jobs: [] }))
    route('GET', /\/engines\/tts$/, () => ({ active: 'omnivoice', backends: [] }))
    render(<EnginePanel />)
    fireEvent.click(await screen.findByRole('button', { name: 'Remove org/voice-base' }))
    const dialog = screen.getByRole('dialog')
    expect(dialog.textContent).toMatch(/Frees 3\.3 GB/)
    expect(dialog.textContent).toMatch(/required voice model/)
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false)
    fireEvent.click(within(dialog).getByRole('button', { name: /Remove from disk/ }))
    await waitFor(() => expect(calls.filter((c) => c.method === 'DELETE').map((c) => c.path)).toEqual(['/api/voicestudio/x/models/org/voice-base']))
  })

  it('“Accept licence” shows the licence and a link to it before accepting', async () => {
    route('GET', /\/x\/models$/, () => ({ models: [] }))
    route('GET', /\/models\/install\/status$/, () => ({ jobs: [] }))
    route('GET', /\/engines\/tts$/, () => ({ active: 'kokoro', backends: [{ id: 'kokoro', available: true }, { id: 'omnivoice', available: true, license_required: true, license_accepted: false, docs_url: 'https://huggingface.co/example/omnivoice' }] }))
    render(<EnginePanel />)
    fireEvent.click(await screen.findByRole('button', { name: /Review licence & use/ }))
    const dialog = screen.getByRole('dialog')
    expect(dialog.textContent).toMatch(/CC-BY-NC/)
    expect(dialog.textContent).toMatch(/Non-commercial use only/)
    expect(within(dialog).getByRole('link', { name: /Read the licence/ }).getAttribute('href')).toBe('https://huggingface.co/example/omnivoice')
    expect(calls.some((c) => c.path.endsWith('/settings/license'))).toBe(false)
    fireEvent.click(within(dialog).getByRole('button', { name: 'Accept and use' }))
    await waitFor(() => expect(calls.find((c) => c.path.endsWith('/settings/license'))?.body).toEqual({ engine_id: 'omnivoice', accepted: true }))
  })

  it('My voices deletes once, however often Delete is pressed', async () => {
    const voice = { id: 'vp_1', workspaceId: ws.id, name: 'Narrator', kind: 'clone', local: true, consent: { agreed: true, statement: 'Mine', attestedAt: 1 }, createdAt: 1 } as unknown as VoiceProfile
    route('GET', /\/voice\/profiles$/, () => [voice])
    let release: () => void = () => undefined
    const gate = new Promise<void>((r) => (release = r))
    routes.push(['DELETE', /\/voice\/profiles\/vp_1$/, () => gate.then(() => ({ ok: true }))])
    render(<MyVoices onUse={() => undefined} onOpenEngine={() => undefined} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Voice actions' }))
    fireEvent.click(screen.getByRole('menuitem', { name: /Delete/ }))
    const del = within(screen.getByRole('dialog')).getByRole('button', { name: /Delete voice/ })
    fireEvent.click(del)
    fireEvent.click(del)
    fireEvent.click(del)
    release()
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(calls.filter((c) => c.method === 'DELETE')).toHaveLength(1)
  })
})
