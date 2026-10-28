// DEV-ONLY mock routes for the brand kits, templates, onboarding, Voice Studio and Producer additions (A-6, A-7, A-20,
// A-21, A-22), registered by mockApi.ts with its router and state. Same role rules as the server.
import type { BrandFont, BrandKitDoc, BrandKitSummary, TemplateSummary } from '@producer/core'
import { DEFAULT_KIT_ID, addItem, createProject, createTextItem } from '@producer/core'

type Json = Record<string, unknown>
type Handler = (m: RegExpMatchArray, q: URLSearchParams, body: Json) => Response | Promise<Response>

export interface MockKit {
  on: (method: string, pattern: string, h: Handler) => void
  json: (body: unknown, status?: number) => Response
  fail: (status: number, error: string, code?: string) => Response
  delay: (ms: number) => Promise<unknown>
  editorOnly: (wsId: string | undefined) => Response | null
  memberOf: (wsId: string) => boolean
  brands: Record<string, BrandKitDoc>
  templates: TemplateSummary[]
  /** Add a team template project; returns its summary. */
  addTemplate: (ws: string, name: string, width: number, height: number) => TemplateSummary
}

const SIZES: Record<string, [number, number]> = { '16:9': [1920, 1080], '9:16': [1080, 1920], '1:1': [1080, 1080] }

let n = 0
const id = (p: string) => `${p}_${Date.now().toString(36)}${++n}`

export function registerR3cMocks(k: MockKit) {
  const { on, json, fail, delay, editorOnly, memberOf, brands, templates, addTemplate } = k
  const extra: Record<string, BrandKitSummary[]> = {}
  const fonts: Record<string, BrandFont[]> = {}
  const defaultKit = (ws: string): BrandKitSummary => ({ id: DEFAULT_KIT_ID, default: true, doc: brands[ws] ?? { name: '', colors: [], fonts: { headline: 'Space Grotesk', body: 'Inter' } }, updatedAt: Date.now() })
  const list = (ws: string) => ({ items: [defaultKit(ws), ...(extra[ws] ?? [])] })
  const notMember = (ws: string) => (memberOf(ws) ? null : fail(404, 'Not found', 'not_found'))

  // ---- brand kits (A-21) ----
  on('GET', '/api/workspaces/([^/]+)/brand-kits', (m) => notMember(m[1]) ?? json(list(m[1])))
  on('POST', '/api/workspaces/([^/]+)/brand-kits', async (m, _q, b) => {
    await delay(200)
    const denied = notMember(m[1]) ?? editorOnly(m[1])
    if (denied) return denied
    const from = typeof b.from === 'string' && b.from !== DEFAULT_KIT_ID ? extra[m[1]]?.find((x) => x.id === b.from)?.doc : defaultKit(m[1]).doc
    const doc = (b.doc as BrandKitDoc | undefined) ?? { ...structuredClone(from ?? defaultKit(m[1]).doc), name: `${from?.name ?? 'Brand'} copy` }
    const kit: BrandKitSummary = { id: id('bk'), default: false, doc, updatedAt: Date.now(), etag: `"${n}"` }
    ;(extra[m[1]] ??= []).push(kit)
    return json(kit)
  })
  on('GET', '/api/workspaces/([^/]+)/brand-kits/([^/]+)', (m) => {
    const denied = notMember(m[1])
    if (denied) return denied
    const kit = m[2] === DEFAULT_KIT_ID ? defaultKit(m[1]) : extra[m[1]]?.find((x) => x.id === m[2])
    return kit ? json(kit) : fail(404, 'Brand kit not found', 'not_found')
  })
  on('PUT', '/api/workspaces/([^/]+)/brand-kits/([^/]+)', async (m, _q, b) => {
    await delay(200)
    const denied = notMember(m[1]) ?? editorOnly(m[1])
    if (denied) return denied
    if (m[2] === DEFAULT_KIT_ID) {
      brands[m[1]] = b as unknown as BrandKitDoc
      return json(defaultKit(m[1]))
    }
    const kit = extra[m[1]]?.find((x) => x.id === m[2])
    if (!kit) return fail(404, 'Brand kit not found', 'not_found')
    kit.doc = b as unknown as BrandKitDoc
    kit.etag = `"${++n}"`
    return json(kit)
  })
  on('DELETE', '/api/workspaces/([^/]+)/brand-kits/([^/]+)', (m) => {
    const denied = notMember(m[1]) ?? editorOnly(m[1])
    if (denied) return denied
    if (m[2] === DEFAULT_KIT_ID) return fail(409, 'The default brand kit can’t be deleted. Make another kit the default first.', 'conflict')
    extra[m[1]] = (extra[m[1]] ?? []).filter((x) => x.id !== m[2])
    return json({ ok: true })
  })
  on('POST', '/api/workspaces/([^/]+)/brand-kits/([^/]+)/default', (m) => {
    const denied = notMember(m[1]) ?? editorOnly(m[1])
    if (denied) return denied
    const kit = extra[m[1]]?.find((x) => x.id === m[2])
    if (!kit) return fail(404, 'Brand kit not found', 'not_found')
    const old = defaultKit(m[1]).doc
    brands[m[1]] = kit.doc
    extra[m[1]] = [...(extra[m[1]] ?? []).filter((x) => x !== kit), { id: id('bk'), default: false, doc: old, updatedAt: Date.now() }]
    return json(list(m[1]))
  })
  on('POST', '/api/workspaces/([^/]+)/brand/palette', async (m) => {
    await delay(400)
    return notMember(m[1]) ?? json({ colors: ['#ff5a5f', '#0b1830', '#f3f5fa', '#35e0ff'] })
  })
  on('GET', '/api/workspaces/([^/]+)/brand/fonts', (m) => notMember(m[1]) ?? json(fonts[m[1]] ?? []))
  on('POST', '/api/workspaces/([^/]+)/brand/fonts', async (m, q) => {
    await delay(300)
    const denied = notMember(m[1]) ?? editorOnly(m[1])
    if (denied) return denied
    const family = (q.get('family') ?? '').trim()
    if (!family) return fail(400, 'Name the font family (letters, digits and spaces)', 'invalid')
    const fid = id('bf')
    // the mock keeps no bytes: the browser falls back to Inter for it
    const f: BrandFont = { id: fid, family, format: 'woff2', weight: Number(q.get('weight') ?? 400), italic: q.get('italic') === '1', sizeBytes: 1, url: `/api/workspaces/${m[1]}/brand/fonts/${fid}/file` }
    ;(fonts[m[1]] ??= []).push(f)
    return json(f)
  })
  on('DELETE', '/api/workspaces/([^/]+)/brand/fonts/([^/]+)', (m) => {
    const denied = notMember(m[1]) ?? editorOnly(m[1])
    if (denied) return denied
    fonts[m[1]] = (fonts[m[1]] ?? []).filter((f) => f.id !== m[2])
    return json({ ok: true })
  })

  // ---- templates (A-22) ----
  const kitDoc = (ws: string | null, kitId: string | null): BrandKitDoc | undefined => (ws ? (kitId && kitId !== DEFAULT_KIT_ID ? extra[ws]?.find((x) => x.id === kitId)?.doc : defaultKit(ws).doc) : undefined)
  /** A stand-in for the server's starter project: the look's name as a title card in the kit's colours. */
  const starter = (t: TemplateSummary, aspect: string, brand?: BrandKitDoc) => {
    const [width, height] = SIZES[aspect] ?? SIZES[t.aspect] ?? SIZES['16:9']
    let p = createProject({ name: t.name, width, height, background: brand?.colors[0] ?? '#0b1830' })
    p = addItem(p, createTextItem(0.3, 'title-bold', { text: brand?.name || t.name, duration: Math.max(3, t.duration - 0.3) }, p))
    return p
  }
  on('GET', '/api/templates/([^/]+)/doc', (m, q) => {
    const t = templates.find((x) => x.id === decodeURIComponent(m[1]))
    if (!t) return fail(404, 'Template not found', 'not_found')
    const ws = q.get('workspaceId')
    if (ws && !memberOf(ws)) return fail(404, 'Not found', 'not_found')
    return json(starter(t, q.get('aspect') ?? t.aspect, kitDoc(ws, q.get('kitId'))))
  })
  on('POST', '/api/templates/from-brand', async (_m, _q, b) => {
    await delay(300)
    const ws = String(b.workspaceId)
    const denied = notMember(ws) ?? editorOnly(ws)
    if (denied) return denied
    const t = templates.find((x) => x.id === `tpl:${b.lookId}`)
    if (!t) return fail(404, 'Template not found', 'not_found')
    const brand = kitDoc(ws, typeof b.kitId === 'string' ? b.kitId : null)
    const [w, h] = SIZES[String(b.aspect ?? t.aspect)] ?? SIZES['16:9']
    return json(addTemplate(ws, String(b.name ?? `${brand?.name || 'Brand'} · ${t.name}`), w, h))
  })
}
