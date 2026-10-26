// Abuse brakes (cloud only): request rates per user or client IP, and how much slow work one workspace can queue.
// Counters live in memory per process — a brake, not billing; several API replicas would each allow the full amount.
import { and, eq, inArray, sql } from 'drizzle-orm'
import type { JobKind } from '@producer/core'
import { ctx } from './context'
import { jobs } from './db/schema'
import { HttpError } from './http'

const windows = new Map<string, { n: number; resetAt: number }>()

function inWords(ms: number): string {
  const s = Math.max(1, Math.ceil(ms / 1000))
  if (s < 90) return `${s} seconds`
  const m = Math.ceil(s / 60)
  if (m < 90) return `${m} minutes`
  return `${Math.ceil(m / 60)} hours`
}

interface Rule {
  key: string
  /** 0 = no limit */
  limit: number
  windowMs: number
  /** First sentence of the 429 message. */
  message: string
}

/** Count one request against every rule, or throw 429 (counting nothing) when any of them is already full. */
export function hit(rules: Rule[]) {
  if (ctx().config.mode !== 'cloud') return
  const now = Date.now()
  const live = rules.filter((r) => r.limit > 0)
  for (const r of live) {
    const w = windows.get(r.key)
    if (w && w.resetAt > now && w.n >= r.limit) throw new HttpError(429, 'quota', `${r.message} Try again in ${inWords(w.resetAt - now)}.`)
  }
  for (const r of live) {
    const w = windows.get(r.key)
    if (!w || w.resetAt <= now) windows.set(r.key, { n: 1, resetAt: now + r.windowMs })
    else w.n++
  }
  if (windows.size > 50_000) for (const [k, w] of windows) if (w.resetAt <= now) windows.delete(k)
}

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/** AI writing on the server's or the workspace's key: the writer, the assistant, Producer AI's script. */
export function limitAi(userId: string) {
  const l = ctx().config.limits
  hit([
    { key: `ai:day:${userId}`, limit: l.aiPerDay, windowMs: DAY, message: `You've used today's ${l.aiPerDay} AI requests.` },
    { key: `ai:min:${userId}`, limit: l.aiPerMinute, windowMs: MINUTE, message: 'Too many AI requests in a row.' },
  ])
}

export function limitSignup(ip: string) {
  const l = ctx().config.limits
  hit([
    { key: `signup:ip:${ip}`, limit: l.signupsPerHourPerIp, windowMs: HOUR, message: 'Too many accounts were created from this network.' },
    { key: 'signup:all', limit: l.signupsPerHour, windowMs: HOUR, message: 'Sign-ups are paused for a moment.' },
  ])
}

export function limitDevices(userId: string) {
  const l = ctx().config.limits
  hit([{ key: `devices:${userId}`, limit: l.devicesPerHour, windowMs: HOUR, message: 'Too many apps were linked to this account.' }])
}

/** Slow work a person starts by hand. Upload processing isn't counted: a folder of clips must always go through. */
const QUEUED_KINDS: JobKind[] = ['export.render', 'ai.tts', 'ai.transcribe', 'ai.produce.script', 'ai.produce.assemble', 'voice.relay']

/** Refuse a new export / voiceover / transcription / Producer AI run when the workspace already has its share waiting. */
export async function assertQueueRoom(workspaceId: string) {
  const limit = ctx().config.limits.queuedJobsPerWorkspace
  if (ctx().config.mode !== 'cloud' || !limit) return
  const [row] = await ctx()
    .db.select({ n: sql<number>`count(*)::int` })
    .from(jobs)
    .where(and(eq(jobs.workspaceId, workspaceId), inArray(jobs.status, ['queued', 'running']), inArray(jobs.kind, QUEUED_KINDS)))
  if (Number(row?.n ?? 0) >= limit)
    throw new HttpError(429, 'quota', `This space already has ${limit} exports, voiceovers or AI runs waiting. Let one finish, or cancel one from the jobs list.`)
}

/** Tests: start from empty counters. */
export function resetLimits() {
  windows.clear()
}
