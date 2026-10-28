// DEV-ONLY in-memory mock of the Producer Studio API (contract: packages/core/src/api.ts).
//
// Enable:   localStorage.psMock = '1'; location.reload()      (or open any page with ?psmock=1)
// Disable:  delete localStorage.psMock; location.reload()      (or ?psmock=0)
// Mode:     localStorage.psMockMode = 'desktop' | 'cloud'      (or ?psmockmode=desktop) — drives GET /api/system
//
// Intercepts window.fetch for /api/*, replaces EventSource for /api/events, fakes the upload PUT (XHR), and
// rewrites /api/media/* and voice-sample URLs on <img>/<video>/<audio> to the bundled /public/demo media.
// Jobs progress over a few seconds and emit SSE `job` / `asset` events like the real server.
import type {
  AssetRecord,
  BrandKitDoc,
  DesktopSettings,
  Device,
  ExportRecord,
  Job,
  JobKind,
  Member,
  Project,
  ProjectSummary,
  ProjectVersionSummary,
  ScriptScene,
  SyncStatus,
  SystemInfo,
  TemplateSummary,
  User,
  Workspace,
} from '@producer/core'
import { INVITE_TTL_MS, VOICES, createProject as coreCreateProject, normalizeTags, searchSnippet, searchWords, type SearchHit } from '@producer/core'
import { registerR3cMocks } from './mockR3c'
import { installAccountMocks, mockMail } from './mockAccount'

type Json = Record<string, unknown>

let installed = false
export function installMockApi() {
  if (installed) return
  installed = true

const DEMO = {
  clips: [
    { file: '/demo/clip-city.mp4', thumb: '/demo/clip-city-thumb.jpg', strip: '/demo/clip-city-strip.jpg' },
    { file: '/demo/clip-fractal.mp4', thumb: '/demo/clip-fractal-thumb.jpg', strip: '/demo/clip-fractal-strip.jpg' },
    { file: '/demo/clip-aurora.mp4', thumb: '/demo/clip-aurora-thumb.jpg', strip: '/demo/clip-aurora-strip.jpg' },
  ],
  audio: '/demo/music-bed.mp3',
  image: { file: '/demo/still-sunrise.png', thumb: '/demo/still-sunrise-thumb.jpg' },
}

const now = Date.now()
const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR

let seq = 100
const nid = (p: string) => `${p}_${(++seq).toString(36)}${Math.random().toString(36).slice(2, 6)}`

// ---------------- fixtures ----------------
const AUTH_KEY = 'psMockUser'
const demoUser: User = { id: 'u_demo', email: 'alex@example.com', name: 'Alex Rivera', avatarColor: '#35e0ff', createdAt: now - 40 * DAY }
const users: Array<User & { password: string }> = [{ ...demoUser, password: 'password123' }]

const workspaces: Workspace[] = [
  { id: 'ws_personal', name: "Alex's space", role: 'owner', personal: true, memberCount: 1 },
  { id: 'ws_team', name: 'Northwind Marketing', role: 'editor', personal: false, memberCount: 4 },
  // a space the demo user only views, so the viewer experience can be tried without a second account
  { id: 'ws_client', name: 'Acme client review', role: 'viewer', personal: false, memberCount: 3 },
]

const members: Record<string, Member[]> = {
  ws_personal: [{ userId: 'u_demo', name: 'Alex Rivera', email: 'alex@example.com', role: 'owner' }],
  ws_team: [
    { userId: 'u_2', name: 'Priya Natarajan', email: 'priya@northwind.test', role: 'owner' },
    { userId: 'u_demo', name: 'Alex Rivera', email: 'alex@example.com', role: 'editor' },
    { userId: 'u_3', name: 'Marcus Oyelaran', email: 'marcus@northwind.test', role: 'editor' },
    { userId: 'u_4', name: 'Dana Whitfield', email: 'dana@northwind.test', role: 'viewer' },
  ],
  ws_client: [
    { userId: 'u_5', name: 'Jordan Acme', email: 'jordan@acme.test', role: 'owner' },
    { userId: 'u_6', name: 'Sam Lee', email: 'sam@acme.test', role: 'editor' },
    { userId: 'u_demo', name: 'Alex Rivera', email: 'alex@example.com', role: 'viewer' },
  ],
}

const brands: Record<string, BrandKitDoc> = {
  ws_personal: { name: 'Alex Rivera', colors: ['#ff5a5f', '#35e0ff', '#0c0e14', '#ffffff'], fonts: { headline: 'Space Grotesk', body: 'Inter' }, captionPreset: 'clean', voice: 'af_heart' },
  ws_team: { name: 'Northwind', colors: ['#1c7ed6', '#ffd43b', '#101828'], fonts: { headline: 'Montserrat', body: 'Inter' }, captionPreset: 'boxed', voice: 'am_michael' },
}

function thumbSvg(seed: string, w = 320, h = 180, label = ''): string {
  let x = 0
  for (let i = 0; i < seed.length; i++) x = (x * 31 + seed.charCodeAt(i)) >>> 0
  const pals = [['#ff5a5f', '#7950f2'], ['#35e0ff', '#3b5bdb'], ['#ffc24d', '#e8590c'], ['#3ddc97', '#0b7285'], ['#c2255c', '#ff922b'], ['#845ef7', '#35e0ff']]
  const [a, b] = pals[x % pals.length]
  const cx = 40 + (x % 60)
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/></linearGradient></defs><rect width="${w}" height="${h}" fill="#10131b"/><rect width="${w}" height="${h}" fill="url(#g)" opacity=".55"/><circle cx="${(cx / 100) * w}" cy="${h * 0.35}" r="${h * 0.42}" fill="${b}" opacity=".45"/><rect x="${w * 0.08}" y="${h * 0.62}" width="${w * 0.5}" height="${h * 0.09}" rx="4" fill="#fff" opacity=".85"/><rect x="${w * 0.08}" y="${h * 0.76}" width="${w * 0.32}" height="${h * 0.06}" rx="3" fill="#fff" opacity=".45"/>${label ? `<text x="${w * 0.08}" y="${h * 0.24}" font-family="Space Grotesk, sans-serif" font-weight="700" font-size="${h * 0.12}" fill="#fff">${label}</text>` : ''}</svg>`
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`
}

interface MockProject extends ProjectSummary {
  doc?: Project
  version: number
}

function mkProject(p: Partial<MockProject> & { name: string; workspaceId: string }): MockProject {
  const id = p.id ?? nid('p')
  return {
    id,
    width: 1920,
    height: 1080,
    duration: 30,
    isTemplate: false,
    trashed: false,
    kind: 'edit',
    updatedAt: now - HOUR,
    createdAt: now - 3 * DAY,
    createdBy: 'u_demo',
    version: 1,
    thumbnailUrl: thumbSvg(id, 320, (320 * (p.height ?? 1080)) / (p.width ?? 1920)),
    ...p,
  }
}

const projects: MockProject[] = [
  mkProject({ id: 'p_launch', name: 'Spring launch — product tour', workspaceId: 'ws_personal', kind: 'producer', duration: 94, updatedAt: now - 12 * MIN }),
  mkProject({ id: 'p_reel', name: 'Behind the scenes reel', workspaceId: 'ws_personal', width: 1080, height: 1920, duration: 42, updatedAt: now - 3 * HOUR }),
  mkProject({ id: 'p_onboard', name: 'Onboarding walkthrough v2', workspaceId: 'ws_personal', kind: 'producer', duration: 186, updatedAt: now - DAY - 2 * HOUR }),
  mkProject({ id: 'p_square', name: 'Customer quote — square', workspaceId: 'ws_personal', width: 1080, height: 1080, duration: 18, updatedAt: now - 3 * DAY }),
  mkProject({ id: 'p_webinar', name: 'Webinar highlights', workspaceId: 'ws_personal', duration: 312, updatedAt: now - 9 * DAY }),
  mkProject({ id: 'p_tplintro', name: 'Branded intro (template)', workspaceId: 'ws_personal', isTemplate: true, duration: 8, updatedAt: now - 12 * DAY }),
  mkProject({ id: 'p_old', name: 'Old draft — delete me', workspaceId: 'ws_personal', trashed: true, duration: 12, updatedAt: now - 20 * DAY }),
  mkProject({ id: 'p_team1', name: 'Q3 feature recap', workspaceId: 'ws_team', kind: 'producer', duration: 128, updatedAt: now - 2 * HOUR }),
  mkProject({ id: 'p_team2', name: 'Event teaser 9:16', workspaceId: 'ws_team', width: 1080, height: 1920, duration: 24, updatedAt: now - 2 * DAY }),
  mkProject({ id: 'p_team3', name: 'Team lower-third pack', workspaceId: 'ws_team', isTemplate: true, duration: 10, updatedAt: now - 6 * DAY }),
  mkProject({ id: 'p_client1', name: 'Acme launch cut — for review', workspaceId: 'ws_client', duration: 66, updatedAt: now - 5 * HOUR }),
]

interface MockAsset extends AssetRecord {
  demo: string
  demoThumb?: string
}

function mkAsset(workspaceId: string, kind: 'video' | 'audio' | 'image', name: string, origin: string, extra: Partial<AssetRecord['asset']> = {}, ageMs = HOUR, demoIdx = 0): MockAsset {
  const id = extra.id ?? nid('as')
  const clip = DEMO.clips[demoIdx % DEMO.clips.length]
  return {
    asset: { id, kind, name, src: `mock/${id}`, mime: kind === 'video' ? 'video/mp4' : kind === 'audio' ? 'audio/mpeg' : 'image/png', duration: kind === 'image' ? undefined : 30, width: kind === 'audio' ? undefined : 1920, height: kind === 'audio' ? undefined : 1080, sizeBytes: 12_400_000, createdAt: now - ageMs, ...extra },
    workspaceId,
    status: 'ready',
    origin,
    createdAt: now - ageMs,
    demo: kind === 'video' ? clip.file : kind === 'audio' ? DEMO.audio : DEMO.image.file,
    demoThumb: kind === 'video' ? clip.thumb : kind === 'image' ? DEMO.image.thumb : undefined,
  }
}

const assets: MockAsset[] = [
  mkAsset('ws_personal', 'video', 'screen-recording-dashboard.mp4', 'upload', { id: 'as_rec1', duration: 184, sizeBytes: 88_000_000 }, 2 * HOUR, 0),
  mkAsset('ws_personal', 'video', 'feature-walkthrough.mov', 'upload', { id: 'as_rec2', duration: 96, sizeBytes: 54_000_000 }, DAY, 1),
  mkAsset('ws_personal', 'video', 'b-roll-aurora.mp4', 'upload', { duration: 12 }, 4 * DAY, 2),
  mkAsset('ws_personal', 'image', 'hero-still.png', 'upload', { sizeBytes: 1_400_000 }, 5 * DAY),
  mkAsset('ws_personal', 'audio', 'Podcast intro — Heart', 'tts', { duration: 14, sizeBytes: 420_000 }, 30 * MIN),
  mkAsset('ws_personal', 'audio', 'Product demo VO — Michael', 'tts', { duration: 38, sizeBytes: 980_000 }, DAY + HOUR),
  mkAsset('ws_personal', 'video', 'Spring launch — product tour.mp4', 'render', { duration: 94 }, 20 * MIN, 0),
  mkAsset('ws_team', 'video', 'q3-demo-capture.mp4', 'upload', { duration: 240 }, 3 * HOUR, 1),
  mkAsset('ws_team', 'audio', 'Event teaser VO', 'tts', { duration: 21 }, 2 * DAY),
]

const templates: TemplateSummary[] = [
  ['tpl:studio', 'Studio', 'Business', '16:9', 32, 6, 8],
  ['tpl:keynote', 'Keynote', 'Business', '16:9', 45, 8, 10],
  ['tpl:launch', 'Product launch', 'Promo', '16:9', 28, 7, 9],
  ['tpl:vertical-punch', 'Vertical punch', 'Social', '9:16', 20, 6, 7],
  ['tpl:story-pop', 'Story pop', 'Social', '9:16', 15, 5, 6],
  ['tpl:square-quote', 'Square quote', 'Social', '1:1', 12, 3, 4],
  ['tpl:tutorial', 'Tutorial', 'Education', '16:9', 60, 9, 14],
  ['tpl:explainer', 'Clean explainer', 'Education', '16:9', 48, 7, 11],
  ['tpl:intro-neon', 'Neon intro', 'Intro & outro', '16:9', 8, 2, 3],
  ['tpl:outro-sub', 'Subscribe outro', 'Intro & outro', '16:9', 10, 2, 4],
  ['tpl:editorial', 'Editorial', 'Promo', '4:5', 22, 5, 6],
  ['tpl:recap', 'Weekly recap', 'Business', '1:1', 30, 6, 8],
].map(([id, name, category, aspect, duration, clipCount, textCount], i) => {
  const [w, h] = (aspect as string).split(':').map(Number)
  return {
    id: id as string,
    name: name as string,
    category: category as string,
    aspect: aspect as string,
    duration: duration as number,
    clipCount: clipCount as number,
    textCount: textCount as number,
    builtIn: true,
    thumbnailUrl: thumbSvg(id as string, 320, (320 * h) / w, name as string),
    previewUrl: DEMO.clips[i % 3].file,
  }
})

const exportsByProject: Record<string, ExportRecord[]> = {
  p_launch: [
    { exportId: 'ex_1', projectId: 'p_launch', name: 'Spring launch — product tour', url: DEMO.clips[0].file, sizeBytes: 48_200_000, duration: 94, resolution: '1080p', fps: 30, createdAt: now - 20 * MIN },
    { exportId: 'ex_2', projectId: 'p_launch', name: 'Spring launch — draft', url: DEMO.clips[0].file, sizeBytes: 12_800_000, duration: 91, resolution: '720p', fps: 30, createdAt: now - DAY },
  ],
  p_reel: [{ exportId: 'ex_3', projectId: 'p_reel', name: 'Behind the scenes reel', url: DEMO.clips[1].file, sizeBytes: 22_000_000, duration: 42, resolution: '1080p', fps: 60, createdAt: now - 3 * HOUR }],
  p_team1: [{ exportId: 'ex_4', projectId: 'p_team1', name: 'Q3 feature recap', url: DEMO.clips[2].file, sizeBytes: 64_000_000, duration: 128, resolution: '1080p', fps: 30, createdAt: now - 2 * HOUR }],
}
const shares: Record<string, { projectId: string; exportId?: string; createdAt?: number; createdBy?: string; views?: number; lastViewedAt?: number; expiresAt?: number | null; password?: string; allowDownload?: boolean; allowComments?: boolean }> = {
  demo: { projectId: 'p_launch', exportId: 'ex_1', views: 3, lastViewedAt: now - 2 * HOUR, allowComments: true },
}
/** The request being answered (the share page sends its unlock key as X-Share-Key). */
let requestHeaders = new Headers()

// ---------------- jobs ----------------
interface MockJob extends Job {
  startedAt: number
  runMs: number
  onDone?: (j: MockJob) => unknown
  finished?: boolean
}
const jobs: MockJob[] = []

function startJob(kind: JobKind, workspaceId: string, runMs: number, opts: { projectId?: string; message?: string; onDone?: (j: MockJob) => unknown } = {}): MockJob {
  const j: MockJob = { id: nid('job'), kind, status: 'queued', progress: 0, message: opts.message ?? 'Queued', workspaceId, projectId: opts.projectId, createdAt: Date.now(), updatedAt: Date.now(), startedAt: Date.now() + 400, runMs, onDone: opts.onDone }
  jobs.push(j)
  emit('job', publicJob(j))
  return j
}

const STAGE_MSGS: Partial<Record<JobKind, string[]>> = {
  'ai.transcribe': ['Extracting audio', 'Recognising speech', 'Aligning words'],
  'ai.produce.script': ['Reading transcripts', 'Picking the best moments', 'Drafting narration', 'Polishing headlines'],
  'ai.produce.assemble': ['Synthesising narration', 'Cutting footage to the script', 'Applying the template look', 'Adding captions'],
  'ai.tts': ['Synthesising speech', 'Encoding audio'],
  'export.render': ['Rendering frames', 'Encoding video'],
  'asset.process': ['Probing media', 'Building proxy', 'Generating thumbnails'],
}

function publicJob(j: MockJob): Job {
  const { startedAt: _s, runMs: _r, onDone: _o, finished: _f, ...rest } = j
  return rest
}

function tickJobs() {
  const t = Date.now()
  for (const j of jobs) {
    if (j.finished) continue
    if (j.status === 'cancelled') {
      j.finished = true
      continue
    }
    if (t < j.startedAt) continue
    const f = Math.min(1, (t - j.startedAt) / j.runMs)
    if (f >= 1) {
      j.status = 'done'
      j.progress = 1
      j.message = 'Done'
      j.result = j.onDone?.(j)
      j.finished = true
    } else {
      j.status = 'running'
      j.progress = f
      const msgs = STAGE_MSGS[j.kind] ?? ['Working']
      j.message = msgs[Math.min(msgs.length - 1, Math.floor(f * msgs.length))] + '…'
    }
    j.updatedAt = t
    emit('job', publicJob(j))
  }
}

// ---------------- SSE ----------------
type Listener = (e: MessageEvent) => void
const sources = new Set<MockEventSource>()
class MockEventSource {
  url: string
  readyState = 1
  withCredentials = true
  onopen: ((e: Event) => void) | null = null
  onerror: ((e: Event) => void) | null = null
  onmessage: Listener | null = null
  private listeners: Record<string, Listener[]> = {}
  workspaceId: string
  constructor(url: string) {
    this.url = url
    this.workspaceId = new URL(url, location.origin).searchParams.get('workspaceId') ?? ''
    sources.add(this)
    setTimeout(() => this.onopen?.(new Event('open')), 0)
  }
  addEventListener(type: string, fn: Listener) {
    ;(this.listeners[type] ??= []).push(fn)
  }
  removeEventListener(type: string, fn: Listener) {
    this.listeners[type] = (this.listeners[type] ?? []).filter((f) => f !== fn)
  }
  dispatch(type: string, data: unknown) {
    const ev = new MessageEvent(type, { data: JSON.stringify(data) })
    for (const fn of this.listeners[type] ?? []) fn(ev)
  }
  close() {
    this.readyState = 2
    sources.delete(this)
  }
}

function emit(type: 'job' | 'asset' | 'project' | 'sync', data: Job | AssetRecord | SyncStatus | Json) {
  const ws = (data as { workspaceId?: string }).workspaceId
  for (const s of sources) if (!ws || s.workspaceId === ws) s.dispatch(type, data)
}

// ---------------- helpers ----------------
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const fail = (status: number, error: string, code?: string) => json({ error, code }, status)
const pub = (a: MockAsset): AssetRecord => {
  const { demo: _d, demoThumb: _t, ...rest } = a
  return rest
}
const summary = (p: MockProject): ProjectSummary => {
  const { doc: _d, version: _v, ...rest } = p
  return rest
}

function currentUser(): User | undefined {
  try {
    const raw = localStorage.getItem(AUTH_KEY)
    return raw ? (JSON.parse(raw) as User) : undefined
  } catch {
    return undefined
  }
}

function docFor(p: MockProject): Project {
  if (!p.doc) {
    const d = coreCreateProject({ id: p.id, name: p.name, width: p.width, height: p.height })
    if (p.kind === 'producer') {
      d.ai = {
        brief: { title: p.name, audience: 'New customers evaluating the product', goal: 'Show the three features that save the most time', tone: 'Confident, friendly', template: 'tpl:studio', voice: 'af_heart', aspect: '16:9', notes: '' },
        script: { scenes: fakeScenes(['as_rec1', 'as_rec2'], p.name) },
        status: p.id === 'p_onboard' ? 'scripted' : 'assembled',
      }
    }
    p.doc = d
  }
  return p.doc
}

function fakeScenes(assetIds: string[], title: string): ScriptScene[] {
  const ids = assetIds.length ? assetIds : ['as_rec1']
  const beats = [
    ['Hook', `Meet ${title || 'the new workflow'}`, 'Most teams lose hours every week stitching recordings into something presentable. Here is a faster way.'],
    ['The dashboard', 'Everything in one view', 'Start on the dashboard: every project, every status, one screen. No more hunting through folders.'],
    ['Automation', 'Let the busywork run itself', 'Set a rule once and the routine steps happen automatically, so your team can focus on the work that matters.'],
    ['Collaboration', 'Review together, ship sooner', 'Share a link, collect comments on the exact moment, and approve in minutes instead of days.'],
    ['Call to action', 'Try it today', 'Start free today and turn your next recording into a polished video before lunch.'],
  ]
  return beats.map(([t, headline, narration], i) => ({
    id: nid('sc'),
    title: t,
    headline,
    narration,
    footage: [{ assetId: ids[i % ids.length], start: 6 + i * 14.5, end: 6 + i * 14.5 + 8 + (i % 3) * 2.5 }],
  }))
}

function delay(ms: number) {
  return new Promise((r) => setTimeout(r, ms))
}

function writeStream(prompt: string, kind: string): Response {
  const base: Record<string, string> = {
    voiceover: `Welcome back. ${prompt ? `Today we're talking about ${prompt.replace(/[.?!]+$/, '').toLowerCase()}. ` : ''}In the next two minutes you'll see exactly how it works, why it matters, and how to get started without changing the way your team already works.`,
    rewrite: 'Here is a tighter take: every recording becomes a polished, on-brand video in minutes, with narration, captions and your look applied automatically.',
    script: 'Scene one: the problem. Scene two: the product in action. Scene three: the result, and a clear call to action.',
    headline: 'Your recordings, production-ready',
    caption: 'From raw capture to finished cut, in minutes.',
  }
  const text = base[kind] ?? base.voiceover
  const words = text.split(/(\s+)/)
  const enc = new TextEncoder()
  const stream = new ReadableStream({
    async start(ctrl) {
      let acc = ''
      for (let i = 0; i < words.length; i += 2) {
        const chunk = words.slice(i, i + 2).join('')
        acc += chunk
        ctrl.enqueue(enc.encode(`event: delta\ndata: ${JSON.stringify({ text: chunk })}\n\n`))
        await delay(35)
      }
      ctrl.enqueue(enc.encode(`event: done\ndata: ${JSON.stringify({ text: acc })}\n\n`))
      ctrl.close()
    },
  })
  return new Response(stream, { headers: { 'content-type': 'text/event-stream' } })
}

// ---------------- router ----------------
type Handler = (m: RegExpMatchArray, q: URLSearchParams, body: Json) => Response | Promise<Response>
const routes: Array<[string, RegExp, Handler]> = []
const on = (method: string, pattern: string, h: Handler) => routes.push([method, new RegExp(`^${pattern}$`), h])

on('GET', '/api/auth/me', () => {
  const u = currentUser()
  return u ? json({ user: u, workspaces }) : fail(401, 'Not signed in', 'unauthorized')
})
on('POST', '/api/auth/login', async (_m, _q, b) => {
  await delay(350)
  const u = users.find((x) => x.email.toLowerCase() === String(b.email).toLowerCase())
  if (!u || u.password !== b.password) return fail(401, 'Incorrect email or password', 'unauthorized')
  const { password: _p, ...user } = u
  localStorage.setItem(AUTH_KEY, JSON.stringify(user))
  return json({ user, workspaces })
})
on('POST', '/api/auth/signup', async (_m, _q, b) => {
  await delay(450)
  if (users.some((x) => x.email.toLowerCase() === String(b.email).toLowerCase())) return fail(409, 'An account with this email already exists', 'conflict')
  const user: User = { id: nid('u'), email: String(b.email), name: String(b.name), avatarColor: '#ffc24d', createdAt: Date.now() }
  users.push({ ...user, password: String(b.password) })
  localStorage.setItem(AUTH_KEY, JSON.stringify(user))
  return json({ user, workspaces })
})
on('POST', '/api/auth/logout', () => {
  localStorage.removeItem(AUTH_KEY)
  return json({ ok: true })
})

// appearance preferences (per mock session, in memory)
let mockPrefs: { preferences: Record<string, unknown>; updatedAt: number | null } = { preferences: { theme: 'system', textSize: 'md', accent: 'coral', density: 'comfortable', reduceMotion: false }, updatedAt: null }
on('GET', '/api/me/preferences', () => (currentUser() ? json(mockPrefs) : fail(401, 'Not signed in', 'unauthorized')))
on('PUT', '/api/me/preferences', (_m, _q, b) => {
  if (!currentUser()) return fail(401, 'Not signed in', 'unauthorized')
  mockPrefs = { preferences: { ...mockPrefs.preferences, ...(b as Record<string, unknown>) }, updatedAt: Date.now() }
  return json(mockPrefs)
})

on('GET', '/api/workspaces', () => json(workspaces))
on('POST', '/api/workspaces', async (_m, _q, b) => {
  await delay(300)
  const w: Workspace = { id: nid('ws'), name: String(b.name), role: 'owner', personal: false, memberCount: 1 }
  workspaces.push(w)
  const u = currentUser() ?? demoUser
  members[w.id] = [{ userId: u.id, name: u.name, email: u.email, role: 'owner' }]
  brands[w.id] = { name: w.name, colors: ['#ff5a5f', '#35e0ff'], fonts: { headline: 'Space Grotesk', body: 'Inter' } }
  // like the server: a new space starts with a sample project (A-6)
  projects.unshift(mkProject({ name: 'Sample project', workspaceId: w.id, width: 1920, height: 1080, duration: 11, updatedAt: Date.now(), createdAt: Date.now() }))
  return json(w)
})
on('PATCH', '/api/workspaces/([^/]+)', async (m, _q, b) => {
  await delay(200)
  const w = workspaces.find((x) => x.id === m[1])
  if (!w) return fail(404, 'Not found', 'not_found')
  if (w.role !== 'owner') return fail(403, 'Only workspace owners can do that', 'forbidden')
  const name = String(b.name ?? '').trim()
  if (!name) return fail(400, 'name: Too small', 'invalid')
  w.name = name.slice(0, 80)
  return json(w)
})
on('DELETE', '/api/workspaces/([^/]+)', async (m) => {
  await delay(300)
  const i = workspaces.findIndex((x) => x.id === m[1])
  if (i < 0) return fail(404, 'Not found', 'not_found')
  if (workspaces[i].role !== 'owner') return fail(403, 'Only workspace owners can do that', 'forbidden')
  if (workspaces[i].personal) return fail(409, 'Personal spaces can’t be deleted', 'conflict')
  workspaces.splice(i, 1)
  for (let j = projects.length - 1; j >= 0; j--) if (projects[j].workspaceId === m[1]) projects.splice(j, 1)
  for (let j = assets.length - 1; j >= 0; j--) if (assets[j].workspaceId === m[1]) assets.splice(j, 1)
  delete members[m[1]]
  delete brands[m[1]]
  return json({ ok: true })
})
on('GET', '/api/workspaces/([^/]+)/members', (m) => json(members[m[1]] ?? []))
// like the server: owners change roles and remove people, anyone leaves; a space keeps at least one owner
on('PATCH', '/api/workspaces/([^/]+)/members/([^/]+)', (m, _q, b) => {
  const denied = ownerOnly(m[1])
  if (denied) return denied
  const list = members[m[1]] ?? []
  const target = list.find((x) => x.userId === m[2])
  if (!target) return fail(404, 'This person is not a member of the space', 'not_found')
  if (target.role === 'owner' && b.role !== 'owner' && list.filter((x) => x.role === 'owner').length <= 1) return fail(409, 'A space needs at least one owner. Make someone else an owner first.', 'conflict')
  target.role = b.role as Member['role']
  return json({ ok: true, role: target.role })
})
on('DELETE', '/api/workspaces/([^/]+)/members/([^/]+)', (m) => {
  const self = currentUser()?.id === m[2]
  if (!self) {
    const denied = ownerOnly(m[1])
    if (denied) return denied
  }
  const list = members[m[1]] ?? []
  const target = list.find((x) => x.userId === m[2])
  if (!target) return fail(404, 'This person is not a member of the space', 'not_found')
  if (target.role === 'owner' && list.filter((x) => x.role === 'owner').length <= 1) return fail(409, 'A space needs at least one owner.', 'conflict')
  members[m[1]] = list.filter((x) => x.userId !== m[2])
  const w = workspaces.find((x) => x.id === m[1])
  if (w) w.memberCount = Math.max(1, w.memberCount - 1)
  return json({ ok: true })
})
// like the server: an invite is a pending link for one address (owners only) until that account accepts it
// like the server's requireRole(…, 'editor'): viewers look, they don't change anything
const editorOnly = (wsId: string | undefined) =>
  ['owner', 'editor'].includes(workspaces.find((x) => x.id === wsId)?.role ?? '') ? null : fail(403, 'Viewers cannot make changes in this workspace', 'forbidden')
const projectWs = (id: string) => projects.find((x) => x.id === id)?.workspaceId
const assetWs = (id: string) => assets.find((x) => x.asset.id === id)?.workspaceId

const mockInvites: Array<{ token: string; workspaceId: string; email: string; role: Member['role']; createdAt: number; expiresAt: number; acceptedAt?: number; revokedAt?: number; sentAt?: number }> = []
const ownerOnly = (wsId: string) => (workspaces.find((x) => x.id === wsId)?.role === 'owner' ? null : fail(403, 'Only workspace owners can do that', 'forbidden'))
on('POST', '/api/workspaces/([^/]+)/invites', async (m, _q, b) => {
  await delay(300)
  const denied = ownerOnly(m[1])
  if (denied) return denied
  const token = Math.random().toString(36).slice(2, 12)
  const now = Date.now()
  const expiresAt = now + INVITE_TTL_MS
  mockInvites.push({ token, workspaceId: m[1], email: String(b.email).toLowerCase(), role: (b.role as Member['role']) ?? 'editor', createdAt: now, expiresAt, ...(mockMail() ? { sentAt: now } : {}) })
  return json({ ok: true, inviteUrl: `${location.origin}/invite/${token}`, expiresAt, emailed: mockMail() })
})
on('GET', '/api/workspaces/([^/]+)/invites', (m) => {
  const denied = ownerOnly(m[1])
  if (denied) return denied
  return json(
    mockInvites
      .filter((i) => i.workspaceId === m[1] && !i.acceptedAt && !i.revokedAt && i.expiresAt > Date.now() - 30 * DAY)
      .map((i) => ({ token: i.token, email: i.email, role: i.role, createdAt: i.createdAt, expiresAt: i.expiresAt, inviteUrl: `${location.origin}/invite/${i.token}`, status: i.expiresAt > Date.now() ? 'pending' : 'expired', ...(i.sentAt ? { sentAt: i.sentAt } : {}) })),
  )
})
on('DELETE', '/api/workspaces/([^/]+)/invites/([^/]+)', (m) => {
  const denied = ownerOnly(m[1])
  if (denied) return denied
  const inv = mockInvites.find((i) => i.workspaceId === m[1] && i.token === m[2] && !i.acceptedAt)
  if (!inv) return fail(404, 'Invite not found, or it was already used', 'not_found')
  inv.revokedAt = Date.now()
  return json({ ok: true })
})
on('GET', '/api/invites/([^/]+)', (m) => {
  const inv = mockInvites.find((i) => i.token === m[1])
  const u = currentUser()
  if (!inv || !u) return fail(404, 'Invite not found', 'not_found')
  const ws = workspaces.find((w) => w.id === inv.workspaceId)
  const status = inv.acceptedAt ? 'accepted' : inv.revokedAt ? 'revoked' : inv.expiresAt <= Date.now() ? 'expired' : 'pending'
  return json({ workspaceId: inv.workspaceId, workspaceName: ws?.name ?? '', role: inv.role, email: inv.email, status, expiresAt: inv.expiresAt, acceptedAt: inv.acceptedAt, forYou: inv.email === u.email.toLowerCase(), member: !!ws })
})
on('POST', '/api/invites/([^/]+)/accept', (m) => {
  const inv = mockInvites.find((i) => i.token === m[1])
  const u = currentUser()
  if (!inv || !u) return fail(404, 'Invite not found', 'not_found')
  if (inv.email !== u.email.toLowerCase()) return fail(403, `This invite is for ${inv.email}. Sign in with that address to accept it.`, 'forbidden')
  if (inv.acceptedAt) return fail(409, 'This invite has already been used', 'conflict')
  if (inv.revokedAt || inv.expiresAt <= Date.now()) return fail(410, 'This invite has expired or was withdrawn', 'conflict')
  inv.acceptedAt = Date.now()
  const ws = workspaces.find((w) => w.id === inv.workspaceId)
  if (ws) {
    ws.memberCount++
    ;(members[ws.id] ??= []).push({ userId: u.id, name: u.name, email: u.email, role: inv.role })
  }
  return json(ws)
})
on('GET', '/api/workspaces/([^/]+)/brand', (m) => json(brands[m[1]] ?? { name: '', colors: [], fonts: { headline: 'Space Grotesk', body: 'Inter' } }))
on('PUT', '/api/workspaces/([^/]+)/brand', async (m, _q, b) => {
  await delay(250)
  const denied = editorOnly(m[1])
  if (denied) return denied
  brands[m[1]] = b as unknown as BrandKitDoc
  return json(brands[m[1]])
})
// brand kits, templates, onboarding, Voice Studio and Producer additions (R3-C)
registerR3cMocks({
  on,
  json,
  fail,
  delay,
  editorOnly,
  memberOf: (ws) => workspaces.some((w) => w.id === ws),
  brands,
  templates,
  addTemplate: (ws, name, width, height) => {
    const p = mkProject({ name, workspaceId: ws, width, height, isTemplate: true, duration: 11, updatedAt: Date.now(), createdAt: Date.now() })
    projects.unshift(p)
    return { id: p.id, name, category: 'Team', aspect: width === height ? '1:1' : width > height ? '16:9' : '9:16', duration: p.duration, builtIn: false, clipCount: 0, textCount: 4 }
  },
  spaceFacts: (ws) => ({
    uploads: assets.filter((a) => a.workspaceId === ws && a.origin === 'upload').length,
    members: workspaces.find((w) => w.id === ws)?.memberCount ?? 1,
    producerVideos: projects.filter((p) => p.workspaceId === ws && p.kind === 'producer' && !p.trashed).length,
    sampleProjectId: projects.find((p) => p.workspaceId === ws && p.name === 'Sample project' && !p.trashed)?.id,
  }),
  scriptOf: (id) => {
    const p = projects.find((x) => x.id === id)
    if (!p) return undefined
    const scenes = p.doc?.ai?.script?.scenes
    if (!scenes?.length) return null
    return { versionId: `pv_${p.id}_${p.version}`, version: p.version, createdAt: p.updatedAt, label: 'autosave', ...(p.doc?.ai?.brief ? { brief: p.doc.ai.brief } : {}), scenes, words: scenes.reduce((t, s) => t + s.narration.split(/\s+/).filter(Boolean).length, 0) }
  },
})

on('GET', '/api/projects', async (_m, q) => {
  await delay(280)
  const ws = q.get('workspaceId')
  const trashed = q.get('trashed') === '1'
  const tpl = q.get('templates') === '1'
  return json(projects.filter((p) => p.workspaceId === ws && p.trashed === trashed && (!tpl || p.isTemplate)).map(summary))
})
on('POST', '/api/projects', async (_m, _q, b) => {
  await delay(300)
  const denied = editorOnly(String(b.workspaceId))
  if (denied) return denied
  const tpl = b.templateId ? templates.find((t) => t.id === b.templateId) ?? projects.find((p) => p.id === b.templateId) : undefined
  let width = Number(b.width) || 1920
  let height = Number(b.height) || 1080
  if (tpl && 'aspect' in tpl) {
    const [aw, ah] = tpl.aspect.split(':').map(Number)
    width = aw >= ah ? 1920 : 1080
    height = Math.round((width * ah) / aw)
  } else if (tpl) {
    width = tpl.width
    height = tpl.height
  }
  const p = mkProject({ name: String(b.name ?? (tpl ? `${tpl.name} copy` : 'Untitled project')), workspaceId: String(b.workspaceId), width, height, kind: (b.kind as 'edit' | 'producer') ?? 'edit', duration: tpl ? tpl.duration : 0, updatedAt: Date.now(), createdAt: Date.now() })
  p.thumbnailUrl = undefined
  projects.unshift(p)
  return json({ summary: summary(p), project: docFor(p), version: p.version })
})
on('GET', '/api/projects/([^/]+)', (m) => {
  const p = projects.find((x) => x.id === m[1])
  return p ? json({ summary: summary(p), project: docFor(p), version: p.version }) : fail(404, 'Project not found', 'not_found')
})
on('PUT', '/api/projects/([^/]+)', (m, _q, b) => {
  const p = projects.find((x) => x.id === m[1])
  if (!p) return fail(404, 'Project not found', 'not_found')
  const denied = editorOnly(p.workspaceId)
  if (denied) return denied
  p.doc = b.project as Project
  p.version++
  p.updatedAt = Date.now()
  keepVersion(p)
  return json({ version: p.version, updatedAt: p.updatedAt })
})

// version history (P-15), like the server's: every save kept, viewers read, editors name and restore
const mockVersions = new Map<string, Array<{ s: ProjectVersionSummary; doc: Project }>>()
function keepVersion(p: MockProject, label: ProjectVersionSummary['label'] = 'autosave', extra: Partial<ProjectVersionSummary> = {}) {
  const doc = structuredClone(docFor(p))
  const list = mockVersions.get(p.id) ?? []
  list.unshift({ s: { id: `pv_${Math.random().toString(36).slice(2, 10)}`, version: p.version, label, sizeBytes: JSON.stringify(doc).length, createdAt: Date.now(), authorName: currentUser()?.name ?? 'You', ...extra }, doc })
  mockVersions.set(p.id, list.slice(0, 50))
  return list[0]
}
const versionsOf = (p: MockProject) => (mockVersions.get(p.id) ?? []).map((v) => (v.s.version === p.version ? { ...v.s, current: true as const } : v.s))
on('GET', '/api/projects/([^/]+)/versions', (m) => {
  const p = projects.find((x) => x.id === m[1])
  return p ? json(versionsOf(p)) : fail(404, 'Project not found', 'not_found')
})
on('GET', '/api/projects/([^/]+)/versions/at/(\\d+)', (m) => {
  const v = mockVersions.get(m[1])?.find((x) => x.s.version === Number(m[2]))
  return v ? json({ summary: v.s, project: v.doc }) : fail(404, 'That version is no longer in the history', 'not_found')
})
on('GET', '/api/projects/([^/]+)/versions/([^/]+)', (m) => {
  const v = mockVersions.get(m[1])?.find((x) => x.s.id === m[2])
  return v ? json({ summary: v.s, project: v.doc }) : fail(404, 'Version not found', 'not_found')
})
on('POST', '/api/projects/([^/]+)/versions', (m, _q, b) => {
  const p = projects.find((x) => x.id === m[1])
  if (!p) return fail(404, 'Project not found', 'not_found')
  const denied = editorOnly(p.workspaceId)
  if (denied) return denied
  const at = mockVersions.get(p.id)?.find((x) => x.s.version === p.version) ?? keepVersion(p)
  at.s = { ...at.s, label: 'named', name: String(b.name) }
  return json({ ...at.s, current: true })
})
on('PATCH', '/api/projects/([^/]+)/versions/([^/]+)', (m, _q, b) => {
  const p = projects.find((x) => x.id === m[1])
  const v = mockVersions.get(m[1])?.find((x) => x.s.id === m[2])
  if (!p || !v) return fail(404, 'Version not found', 'not_found')
  const denied = editorOnly(p.workspaceId)
  if (denied) return denied
  const name = typeof b.name === 'string' && b.name.trim() ? b.name.trim() : undefined
  v.s = { ...v.s, name, label: name ? 'named' : v.s.label === 'named' ? 'autosave' : v.s.label }
  return json(v.s)
})
on('POST', '/api/projects/([^/]+)/versions/([^/]+)/restore', (m, _q, b) => {
  const p = projects.find((x) => x.id === m[1])
  const v = mockVersions.get(m[1])?.find((x) => x.s.id === m[2])
  if (!p || !v) return fail(404, 'Version not found', 'not_found')
  const denied = editorOnly(p.workspaceId)
  if (denied) return denied
  if (typeof b.baseVersion === 'number' && b.baseVersion !== p.version) return fail(409, 'The project was changed elsewhere. Reload to get the latest version.', 'conflict')
  const cur = mockVersions.get(p.id)?.find((x) => x.s.version === p.version)
  if (cur && cur.s.label === 'autosave') cur.s = { ...cur.s, label: 'before-restore' }
  p.doc = { ...structuredClone(v.doc), id: p.id }
  p.version++
  p.updatedAt = Date.now()
  keepVersion(p, 'autosave', { note: `Restored from version ${v.s.version}` })
  return json({ version: p.version, updatedAt: p.updatedAt })
})
on('PATCH', '/api/projects/([^/]+)', async (m, _q, b) => {
  await delay(200)
  const p = projects.find((x) => x.id === m[1])
  if (!p) return fail(404, 'Project not found', 'not_found')
  const denied = editorOnly(p.workspaceId)
  if (denied) return denied
  if (typeof b.name === 'string') p.name = b.name
  if (typeof b.trashed === 'boolean') p.trashed = b.trashed
  if (typeof b.isTemplate === 'boolean') p.isTemplate = b.isTemplate
  if (Array.isArray(b.tags)) {
    const tags = normalizeTags(b.tags as string[])
    p.tags = tags.length ? tags : undefined
    p.version++
  }
  p.updatedAt = Date.now()
  return json({ ...summary(p), version: p.version })
})
// like the server (A-13): a copy in another space the person edits; `move` also trashes the original
on('POST', '/api/projects/([^/]+)/copy', async (m, _q, b) => {
  await delay(300)
  const p = projects.find((x) => x.id === m[1])
  if (!p) return fail(404, 'Project not found', 'not_found')
  const to = String(b.workspaceId)
  const denied = editorOnly(p.workspaceId) ?? editorOnly(to)
  if (denied) return denied
  if (to === p.workspaceId) return fail(400, 'Pick another space to copy it to', 'invalid')
  const c = mkProject({ ...p, id: undefined, workspaceId: to, updatedAt: Date.now(), createdAt: Date.now(), doc: undefined, trashed: false })
  c.thumbnailUrl = p.thumbnailUrl
  projects.unshift(c)
  if (b.move) p.trashed = true
  return json({ ...summary(c), missingMedia: 0 })
})
on('POST', '/api/projects/([^/]+)/duplicate', async (m) => {
  await delay(300)
  const p = projects.find((x) => x.id === m[1])
  if (!p) return fail(404, 'Project not found', 'not_found')
  const denied = editorOnly(p.workspaceId)
  if (denied) return denied
  const c = mkProject({ ...p, id: undefined, name: `${p.name} (copy)`, updatedAt: Date.now(), createdAt: Date.now(), doc: undefined, isTemplate: false })
  c.thumbnailUrl = p.thumbnailUrl
  projects.unshift(c)
  return json(summary(c))
})
on('DELETE', '/api/projects/([^/]+)', (m) => {
  const i = projects.findIndex((x) => x.id === m[1])
  if (i < 0) return fail(404, 'Project not found', 'not_found')
  const denied = editorOnly(projects[i].workspaceId)
  if (denied) return denied
  if (!projects[i].trashed) return fail(409, 'Move the project to trash first', 'conflict')
  projects.splice(i, 1)
  return json({ ok: true })
})

on('POST', '/api/uploads', async (_m, _q, b) => {
  await delay(150)
  const denied = editorOnly(String(b.workspaceId))
  if (denied) return denied
  const mime = String(b.mime)
  const kind = mime.startsWith('audio') ? 'audio' : mime.startsWith('image') ? 'image' : 'video'
  const a = mkAsset(String(b.workspaceId), kind, String(b.filename), 'upload', { sizeBytes: Number(b.size), duration: kind === 'image' ? undefined : 45 + Math.round(Math.random() * 120) }, 0, seq)
  a.status = 'uploading'
  a.createdAt = Date.now()
  assets.unshift(a)
  return json({ assetId: a.asset.id, url: `/api/__mock_upload/${a.asset.id}`, method: 'PUT', headers: {} })
})
on('POST', '/api/assets/([^/]+)/complete', (m) => {
  const a = assets.find((x) => x.asset.id === m[1])
  if (!a) return fail(404, 'Asset not found', 'not_found')
  a.status = 'processing'
  startJob('asset.process', a.workspaceId, 2600, {
    message: `Processing ${a.asset.name}`,
    onDone: () => {
      a.status = 'ready'
      emit('asset', pub(a))
      return { assetId: a.asset.id }
    },
  })
  return json(pub(a))
})
on('GET', '/api/assets', async (_m, q) => {
  await delay(250)
  const ws = q.get('workspaceId')
  const kind = q.get('kind')
  const trashed = q.get('trashed') === '1'
  return json(assets.filter((a) => a.workspaceId === ws && (!kind || a.asset.kind === kind) && !!a.trashedAt === trashed).map(pub))
})
on('GET', '/api/assets/([^/]+)', (m) => {
  const a = assets.find((x) => x.asset.id === m[1])
  return a ? json(pub(a)) : fail(404, 'Asset not found', 'not_found')
})
on('PATCH', '/api/assets/([^/]+)', (m, _q, b) => {
  const a = assets.find((x) => x.asset.id === m[1])
  if (!a) return fail(404, 'Asset not found', 'not_found')
  const denied = editorOnly(a.workspaceId)
  if (denied) return denied
  if (b.name !== undefined) a.asset.name = String(b.name)
  if (b.transcript) a.asset.transcript = b.transcript as AssetRecord['asset']['transcript']
  return json(pub(a))
})
// like the server (A-14): a delete puts the clip in the media trash; only Empty trash removes it
const usageOf = (id: string) => ({ assetId: id, projects: projects.filter((p) => p.workspaceId === assetWs(id) && !!docFor(p).assets[id]).map((p) => ({ id: p.id, name: p.name, trashed: p.trashed })) })
on('POST', '/api/assets/trash/empty', (_m, _q, b) => {
  const ws = String(b.workspaceId)
  const denied = editorOnly(ws)
  if (denied) return denied
  const ids = Array.isArray(b.ids) ? (b.ids as string[]) : undefined
  const gone = assets.filter((a) => a.workspaceId === ws && a.trashedAt && (!ids || ids.includes(a.asset.id)))
  if (ids && gone.length !== new Set(ids).size) return fail(409, 'Only clips in the trash can be deleted for good. Move them to the trash first.', 'conflict')
  for (const a of gone) assets.splice(assets.indexOf(a), 1)
  return json({ removed: gone.length, exports: 0 })
})
on('DELETE', '/api/assets/([^/]+)', (m) => {
  const denied = editorOnly(assetWs(m[1]))
  if (denied) return denied
  const a = assets.find((x) => x.asset.id === m[1])
  if (!a) return fail(404, 'Asset not found', 'not_found')
  a.trashedAt ??= Date.now()
  return json({ ok: true, trashedAt: a.trashedAt, usedIn: usageOf(a.asset.id).projects.length })
})
on('POST', '/api/assets/([^/]+)/restore', (m) => {
  const a = assets.find((x) => x.asset.id === m[1])
  if (!a) return fail(404, 'Asset not found', 'not_found')
  const denied = editorOnly(a.workspaceId)
  if (denied) return denied
  delete a.trashedAt
  return json(pub(a))
})
on('GET', '/api/assets/([^/]+)/usage', (m) => (assetWs(m[1]) ? json(usageOf(m[1])) : fail(404, 'Asset not found', 'not_found')))
on('POST', '/api/assets/([^/]+)/copy', (m, _q, b) => {
  const a = assets.find((x) => x.asset.id === m[1])
  if (!a) return fail(404, 'Asset not found', 'not_found')
  const denied = editorOnly(a.workspaceId) ?? editorOnly(String(b.workspaceId))
  if (denied) return denied
  const copy: MockAsset = { ...structuredClone(a), workspaceId: String(b.workspaceId), createdAt: Date.now() }
  copy.asset.id = nid('as')
  assets.unshift(copy)
  if (b.move) a.trashedAt = Date.now()
  return json(pub(copy))
})
on('POST', '/api/assets/([^/]+)/replace', (m, _q, b) => {
  const a = assets.find((x) => x.asset.id === m[1])
  if (!a) return fail(404, 'Asset not found', 'not_found')
  const denied = editorOnly(a.workspaceId)
  if (denied) return denied
  const mime = String(b.mime ?? '')
  if (!mime.startsWith(`${a.asset.kind}/`)) return fail(400, `Replace a ${a.asset.kind} with another ${a.asset.kind}: projects use this clip as one.`, 'invalid')
  return json({ assetId: a.asset.id, url: `/api/__mock_upload/${a.asset.id}`, method: 'PUT', headers: {} })
})
on('POST', '/api/assets/([^/]+)/replace/complete', (m) => {
  const a = assets.find((x) => x.asset.id === m[1])
  if (!a) return fail(404, 'Asset not found', 'not_found')
  return json(pub(a))
})

// queue, job history and usage (A-9, A-8, A-18, P-1): registered before /api/jobs/:id so they match first
const memberOf = (wsId: string | null) => (workspaces.some((w) => w.id === wsId) ? null : fail(404, 'Not found', 'not_found'))
on('GET', '/api/jobs/queue', (_m, q) => {
  const ws = q.get('workspaceId')
  const denied = memberOf(ws)
  if (denied) return denied
  const waiting = jobs.filter((j) => j.workspaceId === ws && j.status === 'queued').sort((a, b) => a.createdAt - b.createdAt)
  const out: Json = {}
  waiting.forEach((j, i) => {
    const wait = Math.max(0, j.startedAt - Date.now())
    out[j.id] = i === 0 && wait < 1000 ? { position: 1, waitMs: 0, reason: 'next', detail: 'Starting in a moment' } : { position: i + 1, waitMs: wait, reason: i ? 'behind' : 'lane-full', detail: i ? `${i} job${i === 1 ? '' : 's'} ahead of it` : 'Next in line: waiting for a free slot' }
  })
  return json({ jobs: out })
})
on('GET', '/api/jobs/history', (_m, q) => {
  const ws = q.get('workspaceId')
  const denied = memberOf(ws)
  if (denied) return denied
  const status = q.get('status')
  if (status && !['done', 'error', 'cancelled'].includes(status)) return fail(400, 'status must be done, error or cancelled', 'invalid')
  const items = jobs
    .filter((j) => j.workspaceId === ws && ['done', 'error', 'cancelled'].includes(j.status) && (!status || j.status === status))
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .map((j) => ({ ...publicJob(j), startedAt: j.startedAt, result: undefined }))
  return json({ items })
})
on('POST', '/api/jobs/([^/]+)/retry', (m) => {
  const j = jobs.find((x) => x.id === m[1])
  if (!j) return fail(404, 'Job not found', 'not_found')
  const denied = editorOnly(j.workspaceId)
  if (denied) return denied
  if (j.status !== 'error' && j.status !== 'cancelled') return fail(409, 'Only a failed or cancelled job can be retried.', 'conflict')
  if (j.kind === 'asset.process') return fail(409, 'Retry this clip from the Library: its Retry button checks the file first.', 'conflict')
  const again = startJob(j.kind, j.workspaceId, j.runMs, { projectId: j.projectId, message: 'Queued again', onDone: j.onDone })
  return json(publicJob(again))
})
const mockBuiltinAi: Record<string, boolean> = { ws_personal: true, ws_team: true, ws_client: false }
on('GET', '/api/usage', (_m, q) => {
  const ws = q.get('workspaceId') ?? ''
  const denied = memberOf(ws)
  if (denied) return denied
  const days = Math.min(400, Math.max(1, Number(q.get('days') ?? 30) || 30))
  const role = workspaces.find((w) => w.id === ws)?.role
  const scale = days / 30
  const providers = [
    { provider: 'anthropic-api', model: 'claude-opus-5', requests: Math.round(42 * scale), inputTokens: Math.round(310_000 * scale), outputTokens: Math.round(52_000 * scale) },
    { provider: 'openai', model: 'gpt-5.5', requests: Math.round(9 * scale), inputTokens: Math.round(40_000 * scale), outputTokens: Math.round(8_000 * scale) },
  ].map((p) => ({ ...p, estCostUsd: (p.inputTokens * (p.provider === 'openai' ? 1.25 : 5) + p.outputTokens * (p.provider === 'openai' ? 10 : 25)) / 1e6 }))
  const sum = (k: 'requests' | 'inputTokens' | 'outputTokens' | 'estCostUsd') => providers.reduce((t, p) => t + p[k], 0)
  const bytesOf = (id: string) => assets.filter((a) => a.workspaceId === id).length * 48 * 1024 * 1024
  return json({
    workspaceId: ws,
    from: Date.now() - (days - 1) * DAY,
    to: Date.now(),
    days,
    ai: { providers, requests: sum('requests'), inputTokens: sum('inputTokens'), outputTokens: sum('outputTokens'), estCostUsd: sum('estCostUsd'), estimate: true },
    jobs: { minutes: 37.5, byKind: [{ kind: 'export.render', minutes: 31, runs: 6 }, { kind: 'asset.process', minutes: 6.5, runs: 14 }] },
    storage: { bytes: bytesOf(ws), files: assets.filter((a) => a.workspaceId === ws).length, byKind: [{ kind: 'video', bytes: bytesOf(ws), files: assets.filter((a) => a.workspaceId === ws).length }] },
    spaces: workspaces.map((w) => ({ id: w.id, name: w.name, bytes: bytesOf(w.id) })),
    ...(role === 'owner' ? { members: [{ userId: 'u_demo', name: 'Alex Rivera', aiRequests: sum('requests'), tokens: sum('inputTokens') + sum('outputTokens'), jobMinutes: 37.5 }] } : {}),
    limits: [
      { label: 'Your AI requests today', used: 12, limit: 200, unit: 'requests' },
      { label: 'This space’s AI requests today', used: 12, limit: 0, unit: 'requests' },
      { label: 'This space’s AI tokens this month', used: sum('inputTokens') + sum('outputTokens'), limit: 2_000_000, unit: 'tokens' },
      { label: 'Your AI tokens this month', used: sum('inputTokens') + sum('outputTokens'), limit: 0, unit: 'tokens' },
      { label: 'Processing minutes this month', used: 37.5, limit: 0, unit: 'minutes' },
      { label: 'Exports, voiceovers and AI runs waiting', used: jobs.filter((j) => j.workspaceId === ws && !j.finished).length, limit: 10, unit: 'jobs' },
      { label: 'Storage', used: bytesOf(ws), limit: 0, unit: 'bytes' },
    ],
    builtinAi: { enabled: mockBuiltinAi[ws] ?? false, available: true, canChange: role === 'owner' },
  })
})
on('PUT', '/api/usage/builtin-ai', (_m, _q, b) => {
  const ws = String(b.workspaceId)
  const denied = memberOf(ws) ?? ownerOnly(ws)
  if (denied) return denied
  mockBuiltinAi[ws] = Boolean(b.enabled)
  return json({ enabled: mockBuiltinAi[ws] })
})

on('GET', '/api/jobs/([^/]+)', (m) => {
  const j = jobs.find((x) => x.id === m[1])
  return j ? json(publicJob(j)) : fail(404, 'Job not found', 'not_found')
})
on('GET', '/api/jobs', (_m, q) => json(jobs.filter((j) => (!q.get('workspaceId') || j.workspaceId === q.get('workspaceId')) && (!q.get('projectId') || j.projectId === q.get('projectId'))).map(publicJob)))
on('POST', '/api/jobs/([^/]+)/cancel', (m) => {
  const j = jobs.find((x) => x.id === m[1])
  if (!j) return fail(404, 'Job not found', 'not_found')
  if (!j.finished) {
    j.status = 'cancelled'
    j.message = 'Cancelled'
    j.updatedAt = Date.now()
    emit('job', publicJob(j))
  }
  return json(publicJob(j))
})

const wsOfAsset = (id: string) => assets.find((a) => a.asset.id === id)?.workspaceId ?? 'ws_personal'
on('POST', '/api/ai/transcribe', (_m, _q, b) => {
  const id = String(b.assetId)
  const j = startJob('ai.transcribe', wsOfAsset(id), 2800, {
    message: 'Transcribing',
    onDone: () => ({ assetId: id, transcript: { language: 'en', engine: 'mock', segments: [{ start: 0, end: 4, text: 'Hi, this is a quick walkthrough.', words: [] }] } }),
  })
  return json(publicJob(j))
})
on('POST', '/api/ai/tts', (_m, _q, b) => {
  const voice = VOICES.find((v) => v.id === b.voice)
  const text = String(b.text)
  const dur = Math.max(2, Math.round((text.split(/\s+/).length / 2.6) / (Number(b.speed) || 1)))
  const ws = String(b.workspaceId)
  const j = startJob('ai.tts', ws, 3200, {
    projectId: b.projectId as string | undefined,
    message: `Voiceover with ${voice?.name ?? b.voice}`,
    onDone: () => {
      const a = mkAsset(ws, 'audio', String(b.name || `${text.slice(0, 32)}… — ${voice?.name ?? b.voice}`), 'tts', { duration: dur, sizeBytes: dur * 24000 }, 0)
      a.createdAt = Date.now()
      assets.unshift(a)
      emit('asset', pub(a))
      return { asset: pub(a), duration: dur }
    },
  })
  return json(publicJob(j))
})
on('GET', '/api/ai/voices', () => json(VOICES.map((v) => ({ ...v }))))
on('GET', '/api/voice/profiles', () => json([]))
on('POST', '/api/ai/write', async (_m, _q, b) => {
  await delay(300)
  return writeStream(String(b.prompt ?? ''), String(b.kind ?? 'voiceover'))
})
// like the server for a space with no AI image/video key and no stock key: animated text and diagrams only
on('GET', '/api/ai/produce/capabilities', () => json({ stock: false, kinds: ['motion', 'diagram'], maxAiClips: 3 }))
function fakeIdeaScenes(title: string): ScriptScene[] {
  const t = title || 'Your idea'
  return [
    { id: 's01', title: 'Hook', headline: t, narration: `Here is ${t.toLowerCase()} in under a minute.`, footage: [], visual: { kind: 'motion', points: ['Clear', 'Quick', 'Yours'] } },
    { id: 's02', title: 'How it works', headline: 'Three steps', narration: 'Plan it, build it, then ship it.', footage: [], visual: { kind: 'diagram', diagram: { type: 'steps', items: ['Plan', 'Build', 'Ship'] } } },
    { id: 's03', title: 'Why it matters', headline: 'Faster', narration: 'Teams finish three times faster.', footage: [], visual: { kind: 'diagram', diagram: { type: 'stat', value: '3x', label: 'faster' } } },
    { id: 's04', title: 'Close', headline: 'Start today', narration: 'Start today.', footage: [], visual: { kind: 'motion', points: [] } },
  ]
}
on('POST', '/api/ai/produce/script', (_m, _q, b) => {
  const p = projects.find((x) => x.id === b.projectId)
  const brief = b.brief as { title?: string }
  const j = startJob('ai.produce.script', p?.workspaceId ?? 'ws_personal', 5200, {
    projectId: String(b.projectId),
    message: 'Writing script',
    onDone: () => {
      const scenes = (b.brief as { source?: string }).source === 'idea' ? fakeIdeaScenes(brief?.title ?? '') : fakeScenes(b.assetIds as string[], brief?.title ?? '')
      if (p) {
        const d = docFor(p)
        d.ai = { ...(d.ai ?? {}), brief: b.brief as NonNullable<Project['ai']>['brief'], script: { scenes }, status: 'scripted' }
      }
      return { script: { scenes } }
    },
  })
  return json(publicJob(j))
})
on('POST', '/api/ai/produce/assemble', (_m, _q, b) => {
  const p = projects.find((x) => x.id === b.projectId)
  const scenes = b.scenes as ScriptScene[]
  const j = startJob('ai.produce.assemble', p?.workspaceId ?? 'ws_personal', 6500, {
    projectId: String(b.projectId),
    message: 'Assembling video',
    onDone: () => {
      if (p) {
        p.version++
        p.duration = scenes.reduce((s, sc) => s + sc.footage.reduce((a, f) => a + (f.end - f.start), 0), 0)
        p.thumbnailUrl = thumbSvg(p.id, 320, (320 * p.height) / p.width)
        p.updatedAt = Date.now()
        const d = docFor(p)
        // like the server: the brief sent with Assemble is the one used
        d.ai = { ...(d.ai ?? {}), ...(b.brief ? { brief: b.brief as NonNullable<Project['ai']>['brief'] } : {}), script: { ...(d.ai?.script ?? {}), scenes }, status: 'assembled' }
        emit('project', { id: p.id, version: p.version, workspaceId: p.workspaceId })
      }
      return { version: p?.version ?? 1 }
    },
  })
  return json(publicJob(j))
})

// like the server: the wizard's brief and script edits are saved onto the project's `ai`
on('PUT', '/api/ai/produce/draft', (_m, _q, b) => {
  const p = projects.find((x) => x.id === b.projectId)
  if (!p) return fail(404, 'Project not found', 'not_found')
  const d = docFor(p)
  const scenes = b.scenes as ScriptScene[]
  d.ai = { ...(d.ai ?? {}), brief: b.brief as NonNullable<Project['ai']>['brief'], script: { ...(d.ai?.script ?? {}), scenes, ...(b.scriptBrief ? { brief: b.scriptBrief as NonNullable<Project['ai']>['brief'] } : {}) } }
  p.version++
  return json({ version: p.version })
})

on('GET', '/api/exports', (_m, q) => {
  const ws = q.get('workspaceId')
  if (!ws || q.get('projectId')) return json(exportsByProject[q.get('projectId') ?? ''] ?? [])
  // the space's exports, newest first (A-19): one page, filtered like the server
  const words = searchWords(q.get('q') ?? '')
  const formats = (q.get('format') ?? '').split(',').filter(Boolean)
  const items = projects
    .filter((p) => p.workspaceId === ws && !p.trashed)
    .flatMap((p) => (exportsByProject[p.id] ?? []).map((e) => ({ ...e, projectName: p.name, projectThumbnailUrl: p.thumbnailUrl, assetId: `as_${e.exportId}`, shares: Object.values(shares).filter((s) => s.exportId === e.exportId).length })))
    .filter((e) => (!formats.length || formats.includes(e.format ?? 'mp4')) && words.every((w) => `${e.name} ${e.projectName}`.toLowerCase().includes(w)))
    .sort((a, b) => b.createdAt - a.createdAt)
  return json({ items })
})
on('DELETE', '/api/exports/([^/]+)', (m) => {
  for (const [pid, list] of Object.entries(exportsByProject)) {
    const i = list.findIndex((e) => e.exportId === m[1])
    if (i < 0) continue
    const denied = editorOnly(projectWs(pid))
    if (denied) return denied
    list.splice(i, 1)
    let links = 0
    for (const t of Object.keys(shares)) if (shares[t].exportId === m[1]) (delete shares[t], links++)
    return json({ ok: true, links, keptFile: false })
  }
  return fail(404, 'Export not found', 'not_found')
})
// like the server's search (A-11): names, tags, words said in clips and voiceover text, voices, exports, members
on('GET', '/api/search', async (_m, q) => {
  await delay(120)
  const ws = q.get('workspaceId') ?? ''
  const words = searchWords(q.get('q') ?? '')
  const has = (text: string) => words.length > 0 && words.every((w) => text.toLowerCase().includes(w))
  const hits: SearchHit[] = []
  for (const p of projects) if (p.workspaceId === ws && !p.trashed && has(`${p.name} ${(p.tags ?? []).join(' ')}`)) hits.push({ kind: p.isTemplate ? 'template' : 'project', id: p.id, title: p.name, project: summary(p) })
  for (const a of assets) {
    if (a.workspaceId !== ws || a.trashedAt) continue
    const seg = a.asset.transcript?.segments.find((s) => has(s.text))
    if (has(a.asset.name)) hits.push({ kind: 'media', id: a.asset.id, title: a.asset.name, assetId: a.asset.id, asset: pub(a) })
    else if (seg) hits.push({ kind: 'media', id: a.asset.id, title: a.asset.name, assetId: a.asset.id, asset: pub(a), detail: 'Said in the clip', snippet: searchSnippet(seg.text, words), at: seg.start })
  }
  for (const v of VOICES) if (has(`${v.name} ${v.lang} ${v.style}`)) hits.push({ kind: 'voice', id: v.id, title: v.name, detail: `${v.style} · ${v.lang}` })
  for (const p of projects) for (const e of exportsByProject[p.id] ?? []) if (p.workspaceId === ws && has(`${e.name} ${p.name}`)) hits.push({ kind: 'export', id: e.exportId, title: e.name || p.name, projectId: p.id })
  for (const mem of members[ws] ?? []) if (has(`${mem.name} ${mem.email}`)) hits.push({ kind: 'member', id: mem.userId, title: mem.name, detail: `${mem.email} · ${mem.role}` })
  return json({ q: q.get('q') ?? '', hits })
})
// like the server: editors export (a range, audio only, captions burned in or as a file, a draft preview); the
// render "finishes" after a few seconds with one of the demo clips
const mockCaptions: Record<string, string> = {}
on('POST', '/api/projects/([^/]+)/export', async (m, _q, b) => {
  await delay(200)
  const denied = editorOnly(projectWs(m[1]))
  if (denied) return denied
  const p = projects.find((x) => x.id === m[1])
  if (!p) return fail(404, 'Project not found', 'not_found')
  const range = b.range as { from: number; to: number } | undefined
  if (range && (range.to - range.from < 0.1 || range.from >= p.duration)) return fail(400, 'That range is not on the timeline', 'invalid')
  const duration = range ? range.to - range.from : p.duration
  const format = String(b.format ?? 'mp4')
  const j = startJob('export.render', p.workspaceId, b.preview ? 2500 : 6000, {
    projectId: p.id,
    message: b.preview ? 'Waiting to render the draft' : 'Waiting to render',
    onDone: (job) => {
      if (b.preview) return { previewUrl: DEMO.clips[0].file, sizeBytes: 900_000, duration }
      const exportId = nid('ex')
      const audio = format === 'mp3' || format === 'wav'
      const sidecar = b.captions === 'sidecar' && !audio
      if (sidecar) mockCaptions[exportId] = b.captionFormat === 'vtt' ? 'WEBVTT\n\n00:00:00.000 --> 00:00:02.000\nDemo caption\n' : '1\n00:00:00,000 --> 00:00:02,000\nDemo caption\n'
      const rec: ExportRecord = {
        exportId,
        projectId: p.id,
        name: String(b.name || p.name),
        url: audio ? DEMO.audio : DEMO.clips[0].file,
        sizeBytes: Math.round(duration * (audio ? 24_000 : 500_000)),
        duration,
        resolution: audio ? 'audio' : String(b.resolution ?? '1080p'),
        fps: Number(b.fps ?? 30),
        format: format as ExportRecord['format'],
        createdAt: job.updatedAt,
        ...(sidecar ? { captionsUrl: `/api/exports/${exportId}/captions` } : {}),
      }
      ;(exportsByProject[p.id] ??= []).unshift(rec)
      const { projectId: _p, name: _n, resolution: _r, fps: _f, createdAt: _c, ...result } = rec
      return result
    },
  })
  return json(publicJob(j))
})
on('GET', '/api/exports/([^/]+)/captions', (m) => {
  const text = mockCaptions[m[1]]
  if (!text) return fail(404, 'This export has no caption file', 'not_found')
  return new Response(text, { status: 200, headers: { 'Content-Type': text.startsWith('WEBVTT') ? 'text/vtt' : 'application/x-subrip' } })
})
// scene detection: editors; cuts every few seconds of the clip
on('POST', '/api/assets/([^/]+)/scenes', (m, _q, b) => {
  const denied = editorOnly(assetWs(m[1]))
  if (denied) return denied
  const a = assets.find((x) => x.asset.id === m[1])?.asset
  if (!a) return fail(404, 'Asset not found', 'not_found')
  if (a.kind !== 'video') return fail(400, 'Scene detection works on video clips', 'invalid')
  const from = Number(b.from ?? 0)
  const to = Number(b.to ?? a.duration ?? 10)
  const cuts: number[] = []
  for (let t = Math.floor(from / 3) * 3 + 3; t < to; t += 3) cuts.push(t)
  const j = startJob('media.scenes', assetWs(m[1]) ?? 'ws_personal', 1500, { message: `Finding scene changes in ${a.name}`, onDone: () => ({ assetId: a.id, cuts }) })
  return json(publicJob(j))
})
// smart tools (E-21): like a server whose ffmpeg has every tool and no background removal command set up
on('GET', '/api/smart-tools', () =>
  json({ stabilise: { method: 'vidstab' }, denoise: { audio: ['afftdn'], video: ['hqdn3d', 'nlmeans'] }, removeBackground: { available: false }, why: { removeBackground: 'Background removal is not set up on this server: the owner sets BG_REMOVAL_CMD to a removal tool installed there.' } }),
)
on('POST', '/api/assets/([^/]+)/(stabilise|denoise|remove-background)', (m, _q, b) => {
  const denied = editorOnly(assetWs(m[1]))
  if (denied) return denied
  const src = assets.find((x) => x.asset.id === m[1])
  if (!src) return fail(404, 'Asset not found', 'not_found')
  const tool = m[2] === 'remove-background' ? 'removeBackground' : (m[2] as 'stabilise' | 'denoise')
  if (tool === 'removeBackground') return fail(501, 'Background removal is not set up on this server: the owner sets BG_REMOVAL_CMD to a removal tool installed there.', 'server')
  if (tool === 'stabilise' && src.asset.kind !== 'video') return fail(400, 'Stabilisation works on video clips', 'invalid')
  if (tool === 'denoise' && src.asset.kind === 'image') return fail(400, 'Denoising works on video and sound clips', 'invalid')
  if (b.from !== undefined && b.to !== undefined && Number(b.to) <= Number(b.from)) return fail(400, 'The range must end after it starts', 'invalid')
  const ws = src.workspaceId
  const offset = b.target === 'audio' ? 0 : Number(b.from ?? 0)
  const length = b.target === 'audio' ? src.asset.duration : Number(b.to ?? src.asset.duration ?? 10) - offset
  const soundOnly = src.asset.kind === 'audio' || b.soundOnly === true
  const j = startJob(tool === 'stabilise' ? 'media.stabilise' : 'media.denoise', ws, 2500, {
    message: `${tool === 'stabilise' ? 'Stabilising' : 'Denoising'} ${src.asset.name}`,
    onDone: () => {
      const name = `${src.asset.name.replace(/\.[a-z0-9]+$/i, '')} (${tool === 'stabilise' ? 'stabilised' : 'denoised'})`
      const a = mkAsset(ws, soundOnly ? 'audio' : src.asset.kind, name, 'smart', { duration: length, width: src.asset.width, height: src.asset.height, hasAudio: src.asset.hasAudio }, 0)
      a.demo = src.demo
      a.createdAt = Date.now()
      assets.unshift(a)
      emit('asset', pub(a))
      return { tool, asset: pub(a), offset, sourceAssetId: src.asset.id }
    },
  })
  return json(publicJob(j))
})
// smooth slow motion (E-17): editors; a copy of the stretch at the frame rate asked for, added to the library
on('POST', '/api/assets/([^/]+)/smooth', (m, _q, b) => {
  const denied = editorOnly(assetWs(m[1]))
  if (denied) return denied
  const rec = assets.find((x) => x.asset.id === m[1])
  const a = rec?.asset
  if (!a) return fail(404, 'Asset not found', 'not_found')
  if (a.kind !== 'video') return fail(400, 'Smooth slow motion works on video clips', 'invalid')
  const from = Number(b.from)
  const to = Math.min(Number(b.to), a.duration ?? Infinity)
  const fps = Number(b.fps)
  if (!(to > from) || to - from > 120) return fail(400, 'The range must end after it starts, and be at most two minutes', 'invalid')
  if (!(fps >= 2 && fps <= 120)) return fail(400, 'Invalid frame rate', 'invalid')
  const j = startJob('media.smooth', assetWs(m[1]) ?? 'ws_personal', 3000, {
    message: `Smoothing the slow motion of ${a.name}`,
    onDone: () => {
      const copy = { ...rec!, asset: { ...a, id: nid('as'), name: `${a.name.replace(/\.[^.]+$/, '')} · smooth ${Math.round(fps)} fps`, duration: to - from, fps: Math.round(fps), transcript: undefined }, status: 'ready', origin: 'smooth' } as (typeof assets)[number]
      assets.push(copy)
      emit('asset', pub(copy))
      return { asset: copy.asset, from, to, fps: Math.round(fps) }
    },
  })
  return json(publicJob(j))
})
// like the server: one link per export (reused unless `new`), nothing to share before an export; links have
// settings (expiry, password, downloads, comments), views, and can be changed or revoked by editors (A-16)
const linkDto = (token: string) => {
  const s = shares[token]
  const p = projects.find((x) => x.id === s.projectId)
  const ex = (exportsByProject[s.projectId] ?? []).find((e) => e.exportId === s.exportId)
  return {
    token,
    url: `${location.origin}/r/${token}`,
    exportId: s.exportId,
    createdAt: s.createdAt ?? now - HOUR,
    projectId: s.projectId,
    projectName: p?.name ?? '',
    exportName: ex?.name,
    createdBy: { id: s.createdBy ?? demoUser.id, name: users.find((u) => u.id === (s.createdBy ?? demoUser.id))?.name ?? demoUser.name },
    views: s.views ?? 0,
    lastViewedAt: s.lastViewedAt,
    expiresAt: s.expiresAt ?? null,
    expired: s.expiresAt != null && s.expiresAt <= Date.now(),
    hasPassword: !!s.password,
    allowDownload: s.allowDownload ?? true,
    allowComments: s.allowComments ?? false,
  }
}
const activityLog: Array<Json & { id: string; workspaceId: string; createdAt: number }> = []
const logActivity = (workspaceId: string, kind: string, data: Json = {}, actor = currentUser()?.name ?? 'Someone') =>
  activityLog.unshift({ id: nid('act'), workspaceId, kind, data, actor: { name: actor }, createdAt: Date.now() })
const applySettings = (token: string, b: Json) => {
  const s = shares[token]
  if (b.expiresAt !== undefined) s.expiresAt = b.expiresAt as number | null
  if (b.password !== undefined) s.password = (b.password as string | null) ?? undefined
  if (b.allowDownload !== undefined) s.allowDownload = !!b.allowDownload
  if (b.allowComments !== undefined) s.allowComments = !!b.allowComments
}
on('POST', '/api/projects/([^/]+)/share', async (m, _q, b) => {
  await delay(200)
  const denied = editorOnly(projectWs(m[1]))
  if (denied) return denied
  const exportId = (b.exportId as string | undefined) ?? exportsByProject[m[1]]?.[0]?.exportId
  if (!exportId) return fail(409, 'Export the video first: a share link shows a finished export.', 'conflict')
  let token = b.new ? undefined : Object.keys(shares).find((t) => shares[t].projectId === m[1] && shares[t].exportId === exportId)
  if (!token) {
    token = Math.random().toString(36).slice(2, 10)
    shares[token] = { projectId: m[1], exportId, createdAt: Date.now(), createdBy: currentUser()?.id }
    applySettings(token, b)
    logActivity(projectWs(m[1]) ?? '', 'share.created', { project: projects.find((p) => p.id === m[1])?.name })
  }
  return json(linkDto(token))
})
on('GET', '/api/projects/([^/]+)/shares', (m) => json(Object.keys(shares).filter((t) => shares[t].projectId === m[1] && shares[t].exportId).map(linkDto)))
on('GET', '/api/workspaces/([^/]+)/shares', (m) => json(Object.keys(shares).filter((t) => shares[t].exportId && projectWs(shares[t].projectId) === m[1]).map(linkDto)))
on('PATCH', '/api/share/([^/]+)', (m, _q, b) => {
  if (!shares[m[1]]) return fail(404, 'This link is invalid or has been removed', 'not_found')
  const denied = editorOnly(projectWs(shares[m[1]].projectId))
  if (denied) return denied
  if (typeof b.password === 'string' && b.password.length < 4) return fail(400, 'password: A password needs at least 4 characters', 'invalid')
  applySettings(m[1], b)
  logActivity(projectWs(shares[m[1]].projectId) ?? '', 'share.changed', { project: projects.find((p) => p.id === shares[m[1]].projectId)?.name })
  return json(linkDto(m[1]))
})
on('DELETE', '/api/share/([^/]+)', (m) => {
  if (!shares[m[1]]) return fail(404, 'This link is invalid or has been removed', 'not_found')
  const denied = editorOnly(projectWs(shares[m[1]].projectId))
  if (denied) return denied
  logActivity(projectWs(shares[m[1]].projectId) ?? '', 'share.revoked', { project: projects.find((p) => p.id === shares[m[1]].projectId)?.name })
  delete shares[m[1]]
  return json({ ok: true })
})
/** The public page: expired → 410, a password → 401 until /unlock's key comes back as X-Share-Key. */
const shareGate = (token: string, key: string | null) => {
  const s = shares[token]
  const p = s && projects.find((x) => x.id === s.projectId)
  if (!p) return { error: fail(404, 'This link has expired or does not exist', 'not_found') }
  if (s.expiresAt != null && s.expiresAt <= Date.now()) return { error: fail(410, 'This link has expired. Ask whoever sent it for a new one.', 'not_found') }
  if (s.password && key !== `key:${s.password}`) return { error: json({ error: 'This video is protected by a password.', code: 'unauthorized', details: { password: true } }, 401) }
  return { s, p }
}
on('POST', '/api/share/([^/]+)/unlock', (m, _q, b) => {
  const s = shares[m[1]]
  if (!s) return fail(404, 'This link is invalid or has been removed', 'not_found')
  if (s.password && b.password !== s.password) return fail(403, 'That password isn’t right.', 'forbidden')
  return json({ key: s.password ? `key:${s.password}` : '' })
})
on('GET', '/api/share/([^/]+)', async (m) => {
  await delay(300)
  const g = shareGate(m[1], requestHeaders.get('x-share-key'))
  if (g.error) return g.error
  const { s, p } = g
  s.views = (s.views ?? 0) + 1
  s.lastViewedAt = Date.now()
  const ex = (exportsByProject[p.id] ?? []).find((e) => e.exportId === s.exportId) ?? exportsByProject[p.id]?.[0]
  const sp = summary(p)
  return json({
    project: { name: sp.name, width: sp.width, height: sp.height, duration: sp.duration, updatedAt: sp.updatedAt },
    videoUrl: ex?.url,
    allowDownload: s.allowDownload ?? true,
    allowComments: s.allowComments ?? false,
    ...(ex && (s.allowDownload ?? true) ? { downloadUrl: ex.url } : {}),
  })
})

// review comments (E-22): members (viewers too) and, when the link allows, share-page visitors with a name
const mockComments: Array<Json & { id: string; projectId: string; createdAt: number }> = []
const commentEvent = (projectId: string, data: Json) => {
  const ws = projectWs(projectId)
  for (const src of sources) if (src.workspaceId === ws) src.dispatch('comment', { projectId, ...data })
}
const newComment = (projectId: string, b: Json, author: Json) => {
  const parent = b.parentId ? mockComments.find((c) => c.id === b.parentId) : undefined
  const root = parent ? ((parent.parentId as string | undefined) ?? parent.id) : undefined
  const c = { id: nid('cm'), projectId, ...(root ? { parentId: root } : { at: b.at, x: b.x, y: b.y }), author, body: String(b.body ?? '').trim(), createdAt: Date.now(), updatedAt: Date.now(), canEdit: !!author.id, canDelete: !!author.id }
  mockComments.push(c)
  logActivity(projectWs(projectId) ?? '', 'comment.added', { project: projects.find((p) => p.id === projectId)?.name, reply: !!root, guest: !author.id }, String(author.name))
  commentEvent(projectId, { comment: c })
  return c
}
on('GET', '/api/projects/([^/]+)/comments', (m) => json(mockComments.filter((c) => c.projectId === m[1])))
on('POST', '/api/projects/([^/]+)/comments', (m, _q, b) => {
  if (!String(b.body ?? '').trim()) return fail(400, 'body: Write something first', 'invalid')
  const u = currentUser()
  return json(newComment(m[1], b, { id: u?.id, name: u?.name ?? 'You', color: u?.avatarColor, guest: false }))
})
on('PATCH', '/api/comments/([^/]+)', (m, _q, b) => {
  const c = mockComments.find((x) => x.id === m[1])
  if (!c) return fail(404, 'This comment was removed', 'not_found')
  const mine = (c.author as Json).id === currentUser()?.id
  if (b.resolved !== undefined && !mine && editorOnly(projectWs(c.projectId))) return fail(403, 'Only editors of this space, or whoever wrote it, can resolve a comment.', 'forbidden')
  if (b.body !== undefined) c.body = b.body
  if (b.resolved !== undefined) c.resolved = b.resolved ? { at: Date.now(), by: currentUser()?.name } : undefined
  c.updatedAt = Date.now()
  commentEvent(c.projectId, { comment: c })
  return json(c)
})
on('DELETE', '/api/comments/([^/]+)', (m) => {
  const c = mockComments.find((x) => x.id === m[1])
  if (!c) return fail(404, 'This comment was removed', 'not_found')
  if ((c.author as Json).id !== currentUser()?.id && editorOnly(projectWs(c.projectId))) return fail(403, 'Only editors of this space, or whoever wrote it, can remove a comment.', 'forbidden')
  const removed = mockComments.filter((x) => x.id === c.id || x.parentId === c.id).map((x) => x.id)
  for (const id of removed) mockComments.splice(mockComments.findIndex((x) => x.id === id), 1)
  commentEvent(c.projectId, { removed })
  return json({ ok: true, removed })
})
const shareComments = (m: RegExpMatchArray, b?: Json) => {
  const g = shareGate(m[1], requestHeaders.get('x-share-key'))
  if (g.error) return g.error
  if (!(g.s.allowComments ?? false)) return fail(403, 'Comments are turned off for this link.', 'forbidden')
  if (!b) return json(mockComments.filter((c) => c.projectId === g.p.id).map((c) => ({ ...c, canEdit: false, canDelete: false })))
  if (!String(b.name ?? '').trim()) return fail(400, 'Add your name so the team knows who commented.', 'invalid')
  return json({ ...newComment(g.p.id, b, { name: String(b.name).trim(), color: '#ffc24d', guest: true }), canEdit: false, canDelete: false })
}
on('GET', '/api/share/([^/]+)/comments', (m) => shareComments(m))
on('POST', '/api/share/([^/]+)/comments', (m, _q, b) => shareComments(m, b))

// presence and activity (A-23): in the mock you are the only one here
on('GET', '/api/projects/([^/]+)/presence', (m) => json({ projectId: m[1], people: [] }))
on('POST', '/api/projects/([^/]+)/presence', (m, _q, b) => {
  const u = currentUser()
  const role = workspaces.find((w) => w.id === projectWs(m[1]))?.role
  return json({ projectId: m[1], people: b.open === false || !u ? [] : [{ userId: u.id, name: u.name, color: u.avatarColor, role, since: Date.now() }] })
})
on('GET', '/api/workspaces/([^/]+)/activity', (m, q) => {
  const all = activityLog.filter((e) => e.workspaceId === m[1])
  const start = Number(q.get('cursor') ?? 0)
  const limit = Number(q.get('limit') ?? 50)
  const items = all.slice(start, start + limit)
  return json({ items, ...(start + limit < all.length ? { nextCursor: String(start + limit) } : {}) })
})
on('GET', '/api/templates', async (_m, q) => {
  await delay(300)
  const ws = q.get('workspaceId')
  const mine: TemplateSummary[] = projects
    .filter((p) => p.workspaceId === ws && p.isTemplate && !p.trashed)
    .map((p) => ({ id: p.id, name: p.name, category: 'Team', aspect: `${p.width / 120}:${p.height / 120}`.replace('16:9', '16:9'), duration: p.duration, builtIn: false, clipCount: 3, textCount: 2, thumbnailUrl: p.thumbnailUrl }))
  mine.forEach((t) => {
    const p = projects.find((x) => x.id === t.id)!
    t.aspect = p.width === p.height ? '1:1' : p.width > p.height ? '16:9' : '9:16'
  })
  return json([...templates, ...mine])
})

// ---------------- system / desktop / sync ----------------
// Mode: localStorage.psMockMode = 'desktop' | 'cloud' (default cloud).
const mockMode = (() => {
  try {
    return localStorage.getItem('psMockMode') === 'desktop' ? 'desktop' : 'cloud'
  } catch {
    return 'cloud'
  }
})()
const desktopSettings: DesktopSettings = { claudePath: '', claudeModel: '', dataDir: 'C:\\Users\\alex\\AppData\\Roaming\\Producer Studio\\data', mediaSync: 'on-demand', autoSync: true, voiceStudioDir: '', voiceStudioAutoStart: true, dictationGlobal: false, dictationShortcut: 'CommandOrControl+Alt+D', dictationPaste: true, dictationModel: '' }
const sync: SyncStatus = {
  linked: true,
  cloudUrl: 'https://producerstudio.app',
  account: 'alex@example.com',
  state: 'idle',
  lastSyncAt: now - 2 * MIN,
  pending: 2,
  conflicts: [{ projectId: 'p_onboard', name: 'Onboarding walkthrough v2', localVersion: 7, cloudVersion: 9 }],
  failures: [{ kind: 'asset', id: 'as_huge', name: 'Drone pass 8K.mov', error: 'File is larger than the 4096 MB upload limit', attempts: 3, skipped: false, at: now - 4 * MIN, nextAt: now + 4 * MIN }],
  notices: [
    { id: 'n_kept', message: '“Spring promo” was deleted here, but edited in the cloud since. The cloud version was kept and is back in your projects; delete it again if you still want it gone.', at: now - 30 * MIN },
    { id: 'n_brand', message: 'The brand kit “Alex’s colours” made on this computer before linking wasn’t used, because “Alex’s space” already has one in the cloud. It was kept aside.', at: now - 2 * DAY, action: 'Use this computer’s kit' },
  ],
}
const devices: Device[] = [
  { id: 'dev_1', name: 'Alex’s MacBook Pro', createdAt: now - 12 * DAY, lastSeenAt: now - 20 * MIN },
  { id: 'dev_2', name: 'Studio PC (Windows)', createdAt: now - 3 * DAY, lastSeenAt: now - 2 * DAY },
]
const systemInfo = (): SystemInfo =>
  mockMode === 'desktop'
    ? {
        mode: 'desktop',
        version: '0.1.0-mock',
        ai: desktopSettings.claudePath === 'missing'
          ? { provider: 'claude-cli', available: false, detail: 'Claude Code CLI not found at "missing". Install it or clear the path to auto-detect.' }
          : { provider: 'claude-cli', available: true, detail: `Claude Code 2.1.0 at ${desktopSettings.claudePath || 'C:\\Users\\alex\\.local\\bin\\claude.exe (auto-detected)'} · signed in`, model: desktopSettings.claudeModel || undefined },
        capabilities: { transcribe: true, tts: true, render: true },
        sync: { ...sync },
      }
    : { mode: 'cloud', version: '0.1.0-mock', ai: { provider: 'anthropic-api', available: true, detail: 'Anthropic API · server key configured', model: 'claude-opus-5' }, capabilities: { transcribe: true, tts: true, render: true }, mail: mockMail() }
const emitSync = () => emit('sync', { ...sync })
const desktopOnly = (h: Handler): Handler => (m, q, b) => (mockMode === 'desktop' ? h(m, q, b) : fail(404, 'Not available in cloud mode', 'not_found'))

on('GET', '/api/system', async () => {
  await delay(120)
  return json(systemInfo())
})
on('GET', '/api/settings', desktopOnly(() => json(desktopSettings)))
on('PUT', '/api/settings', desktopOnly(async (_m, _q, b) => {
  await delay(200)
  Object.assign(desktopSettings, b)
  return json(desktopSettings)
}))
on('GET', '/api/sync/status', desktopOnly(() => json(sync)))
on('POST', '/api/sync/now', desktopOnly(() => {
  if (!sync.linked) return fail(409, 'Link a cloud account first', 'conflict')
  sync.state = 'syncing'
  emitSync()
  setTimeout(() => {
    sync.state = 'idle'
    sync.pending = 0
    sync.lastSyncAt = Date.now()
    emitSync()
  }, 2200)
  return json(sync)
}))
on('POST', '/api/sync/link', desktopOnly(async (_m, _q, b) => {
  await delay(700)
  if (String(b.password).length < 8) return fail(401, 'Invalid email or password', 'unauthorized')
  Object.assign(sync, { linked: true, cloudUrl: String(b.cloudUrl), account: String(b.email), state: 'syncing', pending: 0, error: undefined })
  setTimeout(() => {
    sync.state = 'idle'
    sync.lastSyncAt = Date.now()
    emitSync()
  }, 2000)
  return json(sync)
}))
on('POST', '/api/sync/unlink', desktopOnly(async () => {
  await delay(300)
  Object.assign(sync, { linked: false, cloudUrl: undefined, account: undefined, state: 'unlinked', lastSyncAt: undefined, conflicts: [] })
  return json(sync)
}))
on('POST', '/api/sync/failures/([^/]+)/([^/]+)', desktopOnly(async (m, _q, b) => {
  await delay(400)
  const f = sync.failures?.find((x) => x.kind === m[1] && x.id === decodeURIComponent(m[2]))
  if (!f) return fail(404, 'That item is no longer waiting to sync', 'not_found')
  if (b.action === 'skip') Object.assign(f, { skipped: true, nextAt: undefined })
  else Object.assign(f, { skipped: false, attempts: f.attempts + 1, at: Date.now(), nextAt: Date.now() + 8 * MIN })
  return json(sync)
}))
on('POST', '/api/sync/notices/([^/]+)', desktopOnly(async (m) => {
  await delay(200)
  sync.notices = sync.notices?.filter((n) => n.id !== decodeURIComponent(m[1]))
  return json(sync)
}))
on('POST', '/api/projects/([^/]+)/sync', desktopOnly(async (m, _q, b) => {
  await delay(400)
  const c = sync.conflicts.find((x) => x.projectId === m[1])
  sync.conflicts = sync.conflicts.filter((x) => x.projectId !== m[1])
  if (c && b.mode === 'keep-both') {
    const p = projects.find((x) => x.id === m[1])
    if (p) projects.unshift(mkProject({ ...p, id: undefined, name: `${p.name} (cloud copy)`, updatedAt: Date.now(), doc: undefined }))
  }
  return json(sync)
}))
on('GET', '/api/devices', async () => {
  await delay(200)
  return json(devices)
})
on('DELETE', '/api/devices/([^/]+)', (m) => {
  const i = devices.findIndex((d) => d.id === m[1])
  if (i >= 0) devices.splice(i, 1)
  return json({ ok: true })
})
// account page, password reset, email checks, invite resend, hand-over (R3-A)
installAccountMocks({
  on,
  json,
  fail,
  currentUser,
  setUser: (u) => (u ? localStorage.setItem(AUTH_KEY, JSON.stringify(u)) : localStorage.removeItem(AUTH_KEY)),
  users,
  workspaces,
  members,
  invites: mockInvites,
  devices,
})

// ---------------- media URL rewriting ----------------
function rewriteMedia(url: string): string {
  const m = /\/api\/media\/([^/]+)\/(\w+)/.exec(url)
  if (m) {
    const a = assets.find((x) => x.asset.id === decodeURIComponent(m[1]))
    const variant = m[2]
    if (!a) return variant === 'thumb' ? DEMO.clips[0].thumb : DEMO.clips[0].file
    if (variant === 'thumb') return a.demoThumb ?? (a.asset.kind === 'audio' ? '' : DEMO.image.thumb)
    if (variant === 'filmstrip') return DEMO.clips[0].strip
    if (variant === 'audio') return DEMO.audio
    return a.demo
  }
  if (/\/api\/ai\/voices\/[^/]+\/sample/.test(url)) return DEMO.audio
  return url
}

  const realFetch = window.fetch.bind(window)
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    const u = new URL(url, location.origin)
    if (u.origin !== location.origin || !u.pathname.startsWith('/api/')) return realFetch(input, init)
    const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase()
    let body: Json = {}
    if (init?.body && typeof init.body === 'string') {
      try {
        body = JSON.parse(init.body)
      } catch {
        /* not JSON */
      }
    }
    requestHeaders = new Headers(init?.headers)
    for (const [m, re, h] of routes) {
      if (m !== method) continue
      const match = u.pathname.match(re)
      if (match) {
        try {
          return await h(match, u.searchParams, body)
        } catch (e) {
          return fail(500, e instanceof Error ? e.message : 'Mock error', 'server')
        }
      }
    }
    console.warn('[psMock] unhandled', method, u.pathname)
    return fail(404, `Mock: no handler for ${method} ${u.pathname}`, 'not_found')
  }

  ;(window as unknown as { EventSource: unknown }).EventSource = MockEventSource

  // Fake the presigned PUT upload with progress events.
  const RealXHR = window.XMLHttpRequest
  class MockXHR extends RealXHR {
    private mockUrl?: string
    private _status = 0
    open(method: string, url: string | URL, ...rest: unknown[]) {
      const s = String(url)
      if (s.includes('/api/__mock_upload/')) this.mockUrl = s
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (super.open as any)(method, url, ...(rest.length ? rest : [true]))
    }
    setRequestHeader(k: string, v: string) {
      if (!this.mockUrl) super.setRequestHeader(k, v)
    }
    get status() {
      return this.mockUrl ? this._status : super.status
    }
    send(body?: Document | XMLHttpRequestBodyInit | null) {
      if (!this.mockUrl) return super.send(body)
      const total = body instanceof Blob ? body.size : 1_000_000
      const steps = 12
      let i = 0
      const tick = () => {
        i++
        const loaded = Math.min(total, Math.round((total * i) / steps))
        this.upload.onprogress?.call(this, new ProgressEvent('progress', { lengthComputable: true, loaded, total }))
        if (i < steps) setTimeout(tick, 120)
        else {
          const id = this.mockUrl!.split('/').pop()!
          const a = assets.find((x) => x.asset.id === id)
          if (a && body instanceof File) a.demo = body.type.startsWith('video') || body.type.startsWith('image') || body.type.startsWith('audio') ? URL.createObjectURL(body) : a.demo
          if (a && body instanceof File && body.type.startsWith('image')) a.demoThumb = a.demo
          this._status = 200
          this.onload?.call(this, new ProgressEvent('load'))
        }
      }
      setTimeout(tick, 80)
    }
  }
  window.XMLHttpRequest = MockXHR as unknown as typeof XMLHttpRequest

  // Point media elements at bundled demo files.
  const origSetAttr = Element.prototype.setAttribute
  Element.prototype.setAttribute = function (name: string, value: string) {
    if ((name === 'src' || (name === 'href' && this instanceof HTMLAnchorElement)) && typeof value === 'string' && value.includes('/api/')) value = rewriteMedia(value)
    return origSetAttr.call(this, name, value)
  }
  for (const proto of [HTMLImageElement.prototype, HTMLMediaElement.prototype, HTMLSourceElement.prototype]) {
    const desc = Object.getOwnPropertyDescriptor(proto, 'src')
    if (!desc?.set) continue
    Object.defineProperty(proto, 'src', {
      ...desc,
      set(v: string) {
        desc.set!.call(this, typeof v === 'string' && v.includes('/api/') ? rewriteMedia(v) : v)
      },
    })
  }
  setInterval(tickJobs, 450)
  console.info('%c[psMock] Mock API active — sign in with alex@example.com / password123. Disable: delete localStorage.psMock', 'color:#ffc24d')
}

export function isMockActive() {
  return installed
}
