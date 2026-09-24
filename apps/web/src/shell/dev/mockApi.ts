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
  ScriptScene,
  SyncStatus,
  SystemInfo,
  TemplateSummary,
  User,
  Workspace,
} from '@producer/core'
import { VOICES, createProject as coreCreateProject } from '@producer/core'

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
]

const members: Record<string, Member[]> = {
  ws_personal: [{ userId: 'u_demo', name: 'Alex Rivera', email: 'alex@example.com', role: 'owner' }],
  ws_team: [
    { userId: 'u_2', name: 'Priya Natarajan', email: 'priya@northwind.test', role: 'owner' },
    { userId: 'u_demo', name: 'Alex Rivera', email: 'alex@example.com', role: 'editor' },
    { userId: 'u_3', name: 'Marcus Oyelaran', email: 'marcus@northwind.test', role: 'editor' },
    { userId: 'u_4', name: 'Dana Whitfield', email: 'dana@northwind.test', role: 'viewer' },
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
const shares: Record<string, { projectId: string; exportId?: string }> = { demo: { projectId: 'p_launch', exportId: 'ex_1' } }

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

on('GET', '/api/workspaces', () => json(workspaces))
on('POST', '/api/workspaces', async (_m, _q, b) => {
  await delay(300)
  const w: Workspace = { id: nid('ws'), name: String(b.name), role: 'owner', personal: false, memberCount: 1 }
  workspaces.push(w)
  const u = currentUser() ?? demoUser
  members[w.id] = [{ userId: u.id, name: u.name, email: u.email, role: 'owner' }]
  brands[w.id] = { name: w.name, colors: ['#ff5a5f', '#35e0ff'], fonts: { headline: 'Space Grotesk', body: 'Inter' } }
  return json(w)
})
on('GET', '/api/workspaces/([^/]+)/members', (m) => json(members[m[1]] ?? []))
on('POST', '/api/workspaces/([^/]+)/invites', async (m, _q, b) => {
  await delay(300)
  const token = Math.random().toString(36).slice(2, 12)
  const w = workspaces.find((x) => x.id === m[1])
  if (w) w.memberCount++
  ;(members[m[1]] ??= []).push({ userId: nid('u'), name: String(b.email).split('@')[0], email: String(b.email), role: (b.role as Member['role']) ?? 'editor' })
  return json({ ok: true, inviteUrl: `${location.origin}/invite/${token}` })
})
on('GET', '/api/workspaces/([^/]+)/brand', (m) => json(brands[m[1]] ?? { name: '', colors: [], fonts: { headline: 'Space Grotesk', body: 'Inter' } }))
on('PUT', '/api/workspaces/([^/]+)/brand', async (m, _q, b) => {
  await delay(250)
  brands[m[1]] = b as unknown as BrandKitDoc
  return json(brands[m[1]])
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
  p.doc = b.project as Project
  p.version++
  p.updatedAt = Date.now()
  return json({ version: p.version, updatedAt: p.updatedAt })
})
on('PATCH', '/api/projects/([^/]+)', async (m, _q, b) => {
  await delay(200)
  const p = projects.find((x) => x.id === m[1])
  if (!p) return fail(404, 'Project not found', 'not_found')
  if (typeof b.name === 'string') p.name = b.name
  if (typeof b.trashed === 'boolean') p.trashed = b.trashed
  if (typeof b.isTemplate === 'boolean') p.isTemplate = b.isTemplate
  p.updatedAt = Date.now()
  return json(summary(p))
})
on('POST', '/api/projects/([^/]+)/duplicate', async (m) => {
  await delay(300)
  const p = projects.find((x) => x.id === m[1])
  if (!p) return fail(404, 'Project not found', 'not_found')
  const c = mkProject({ ...p, id: undefined, name: `${p.name} (copy)`, updatedAt: Date.now(), createdAt: Date.now(), doc: undefined, isTemplate: false })
  c.thumbnailUrl = p.thumbnailUrl
  projects.unshift(c)
  return json(summary(c))
})
on('DELETE', '/api/projects/([^/]+)', (m) => {
  const i = projects.findIndex((x) => x.id === m[1])
  if (i < 0) return fail(404, 'Project not found', 'not_found')
  if (!projects[i].trashed) return fail(409, 'Move the project to trash first', 'conflict')
  projects.splice(i, 1)
  return json({ ok: true })
})

on('POST', '/api/uploads', async (_m, _q, b) => {
  await delay(150)
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
  return json(assets.filter((a) => a.workspaceId === ws && (!kind || a.asset.kind === kind)).map(pub))
})
on('GET', '/api/assets/([^/]+)', (m) => {
  const a = assets.find((x) => x.asset.id === m[1])
  return a ? json(pub(a)) : fail(404, 'Asset not found', 'not_found')
})
on('PATCH', '/api/assets/([^/]+)', (m, _q, b) => {
  const a = assets.find((x) => x.asset.id === m[1])
  if (!a) return fail(404, 'Asset not found', 'not_found')
  a.asset.name = String(b.name)
  return json(pub(a))
})
on('DELETE', '/api/assets/([^/]+)', (m) => {
  const i = assets.findIndex((x) => x.asset.id === m[1])
  if (i >= 0) assets.splice(i, 1)
  return json({ ok: true })
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
on('POST', '/api/ai/write', async (_m, _q, b) => {
  await delay(300)
  return writeStream(String(b.prompt ?? ''), String(b.kind ?? 'voiceover'))
})
on('POST', '/api/ai/produce/script', (_m, _q, b) => {
  const p = projects.find((x) => x.id === b.projectId)
  const brief = b.brief as { title?: string }
  const j = startJob('ai.produce.script', p?.workspaceId ?? 'ws_personal', 5200, {
    projectId: String(b.projectId),
    message: 'Writing script',
    onDone: () => {
      const scenes = fakeScenes(b.assetIds as string[], brief?.title ?? '')
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
        d.ai = { ...(d.ai ?? {}), script: { scenes }, status: 'assembled' }
        emit('project', { id: p.id, version: p.version, workspaceId: p.workspaceId })
      }
      return { version: p?.version ?? 1 }
    },
  })
  return json(publicJob(j))
})

on('GET', '/api/exports', (_m, q) => json(exportsByProject[q.get('projectId') ?? ''] ?? []))
on('POST', '/api/projects/([^/]+)/share', async (m, _q, b) => {
  await delay(200)
  const token = Math.random().toString(36).slice(2, 10)
  shares[token] = { projectId: m[1], exportId: b.exportId as string | undefined }
  return json({ url: `${location.origin}/r/${token}`, token })
})
on('GET', '/api/share/([^/]+)', async (m) => {
  await delay(300)
  const s = shares[m[1]]
  const p = s && projects.find((x) => x.id === s.projectId)
  if (!p) return fail(404, 'This link has expired or does not exist', 'not_found')
  const ex = (exportsByProject[p.id] ?? []).find((e) => e.exportId === s.exportId) ?? exportsByProject[p.id]?.[0]
  return json({ project: summary(p), videoUrl: ex?.url })
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
const desktopSettings: DesktopSettings = { claudePath: '', claudeModel: '', dataDir: 'C:\\Users\\alex\\AppData\\Roaming\\Producer Studio\\data', mediaSync: 'on-demand', autoSync: true }
const sync: SyncStatus = {
  linked: true,
  cloudUrl: 'https://studio.meyousocial.com',
  account: 'alex@example.com',
  state: 'idle',
  lastSyncAt: now - 2 * MIN,
  pending: 2,
  conflicts: [{ projectId: 'p_onboard', name: 'Onboarding walkthrough v2', localVersion: 7, cloudVersion: 9 }],
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
    : { mode: 'cloud', version: '0.1.0-mock', ai: { provider: 'anthropic-api', available: true, detail: 'Anthropic API · server key configured', model: 'claude-opus-5' }, capabilities: { transcribe: true, tts: true, render: true } }
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
