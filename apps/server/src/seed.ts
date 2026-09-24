// Dev seed: demo user + workspace, two generated sample videos (processed), a sample project and a starter
// project from the Studio Dark look. Idempotent. Run with the server stopped when using PGlite (single process):
//   npm run seed -w @producer/server
import fs from 'node:fs'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import { addAsset, addItem, createProject, createTextItem, createVideoItem, uid, type Project } from '@producer/core'
import { loadConfig } from './config'
import { initCtx } from './context'
import { assets, memberships, projects, users } from './db/schema'
import { assetDoc } from './dto'
import { inlineContext } from './jobs/worker'
import { log } from './log'
import { ffmpeg } from './media/proc'
import { processAsset } from './media/process'
import { createUser } from './routes/auth'
import { createAssetFromFile, tmpDir } from './services/assets'
import { getLook, starterProject } from './services/looks'
import { insertProject } from './services/projects'

const EMAIL = 'demo@producer.studio'
const PASSWORD = 'demo-password-1'

const c = await initCtx(loadConfig())
const db = c.db

let user = (await db.select().from(users).where(eq(users.email, EMAIL)).limit(1))[0]
if (!user) {
  await createUser(EMAIL, PASSWORD, 'Demo Producer')
  user = (await db.select().from(users).where(eq(users.email, EMAIL)).limit(1))[0]
  log.info('seed: created user', { email: EMAIL })
}
const ws = (await db.select().from(memberships).where(eq(memberships.userId, user.id)).limit(1))[0].workspaceId

const existing = await db.select().from(projects).where(eq(projects.workspaceId, ws))
if (existing.some((p) => p.name === 'Sample project')) {
  log.info('seed: already seeded', { workspaceId: ws })
} else {
  const work = tmpDir('seed')
  const specs = [
    { name: 'Sample A — test pattern.mp4', src: 'testsrc2=size=1280x720:rate=30', freq: 220, dur: 8 },
    { name: 'Sample B — colour bars.mp4', src: 'smptehdbars=size=1280x720:rate=30', freq: 330, dur: 6 },
  ]
  const rows = []
  for (const s of specs) {
    const file = path.join(work, `${uid('seed')}.mp4`)
    // a "voice-like" track: a sine with a slow tremolo and two pauses, so waveform + silence detection have something to find
    await ffmpeg([
      '-f', 'lavfi', '-i', s.src,
      '-f', 'lavfi', '-i', `sine=frequency=${s.freq}:sample_rate=48000,volume='if(between(mod(t,4),2.6,3.4),0,0.6*(0.6+0.4*sin(2*PI*1.5*t)))':eval=frame`,
      '-t', String(s.dur), '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', file,
    ])
    const row = await createAssetFromFile({ workspaceId: ws, userId: user.id, filePath: file, name: s.name, mime: 'video/mp4', kind: 'video', origin: 'upload' })
    rows.push(await processAsset(row.id, inlineContext({ id: 'seed', kind: 'asset.process', workspaceId: ws, userId: user.id, projectId: null, input: {} })))
    log.info('seed: sample video ready', { assetId: row.id })
  }
  fs.rmSync(work, { recursive: true, force: true })

  let p: Project = createProject({ name: 'Sample project', width: 1920, height: 1080 })
  const [a, b] = rows.map(assetDoc)
  p = addAsset(addAsset(p, a), b)
  p = addItem(p, createVideoItem(a, 0, { duration: 5, transitionOut: { type: 'crossfade', duration: 0.6 } }))
  p = addItem(p, createVideoItem(b, 5, { in: 0.5, duration: 4.5 }))
  p = addItem(p, createTextItem(0.3, 'title-bold', { text: 'Producer Studio', duration: 3.2 }))
  const lt = createTextItem(5.4, 'lower-third', { text: 'Sample B · colour bars', duration: 3.5 })
  lt.transform = { ...lt.transform, x: -420, y: 330 }
  p = addItem(p, lt)
  await insertProject({ workspaceId: ws, userId: user.id, doc: p })
  const look = getLook('studio-dark')
  await insertProject({ workspaceId: ws, userId: user.id, doc: { ...starterProject(look, { name: 'Studio Dark starter' }), id: uid('p') } })
  log.info('seed: projects created', { workspaceId: ws })
}

const nAssets = (await db.select({ id: assets.id }).from(assets).where(eq(assets.workspaceId, ws))).length
console.log(`\nSeed complete.\n  login:     ${EMAIL} / ${PASSWORD}\n  workspace: ${ws}\n  assets:    ${nAssets}\n`)
await c.database.close()
process.exit(0)
