// Drizzle table definitions. Timestamps are epoch milliseconds stored as double precision so both
// drivers (PGlite, postgres-js) hand back plain JS numbers. DDL lives in migrate.ts (idempotent SQL).
import { bigint, boolean, doublePrecision, integer, jsonb, pgTable, primaryKey, text } from 'drizzle-orm/pg-core'
import type { Project } from '@producer/core'

const ms = (name: string) => doublePrecision(name)
/** Set by DB triggers from the global `change_seq` sequence on every insert/update (sync change feed). */
const seq = () => bigint('change_seq', { mode: 'number' })

export const users = pgTable('users', {
  id: text('id').primaryKey(),
  email: text('email').notNull().unique(),
  name: text('name').notNull(),
  passwordHash: text('password_hash').notNull(),
  avatarColor: text('avatar_color').notNull(),
  createdAt: ms('created_at').notNull(),
})

export const sessions = pgTable('sessions', {
  id: text('id').primaryKey(), // sha256(token) hex
  userId: text('user_id').notNull(),
  expiresAt: ms('expires_at').notNull(),
  createdAt: ms('created_at').notNull(),
  userAgent: text('user_agent'),
})

export const workspaces = pgTable('workspaces', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  personal: boolean('personal').notNull().default(false),
  createdBy: text('created_by').notNull(),
  createdAt: ms('created_at').notNull(),
  changeSeq: seq(),
})

export const memberships = pgTable(
  'memberships',
  {
    workspaceId: text('workspace_id').notNull(),
    userId: text('user_id').notNull(),
    role: text('role').notNull(),
    createdAt: ms('created_at').notNull(),
    changeSeq: seq(),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.userId] })],
)

export const invites = pgTable('invites', {
  token: text('token').primaryKey(),
  workspaceId: text('workspace_id').notNull(),
  email: text('email').notNull(),
  role: text('role').notNull(),
  createdBy: text('created_by').notNull(),
  createdAt: ms('created_at').notNull(),
  acceptedAt: ms('accepted_at'),
  acceptedBy: text('accepted_by'),
})

export const projects = pgTable('projects', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id').notNull(),
  name: text('name').notNull(),
  kind: text('kind').notNull().default('edit'),
  doc: jsonb('doc').$type<Project>().notNull(),
  version: integer('version').notNull().default(1),
  thumbnail: text('thumbnail'),
  duration: doublePrecision('duration').notNull().default(0),
  width: integer('width').notNull(),
  height: integer('height').notNull(),
  isTemplate: boolean('is_template').notNull().default(false),
  trashedAt: ms('trashed_at'),
  createdBy: text('created_by').notNull(),
  createdAt: ms('created_at').notNull(),
  updatedAt: ms('updated_at').notNull(),
  changeSeq: seq(),
})

export interface AssetMeta {
  duration?: number
  width?: number
  height?: number
  fps?: number
  hasAudio?: boolean
  filmstrip?: { frames: number; frameWidth: number; frameHeight: number }
  waveform?: number[]
  transcript?: import('@producer/core').Transcript
  silences?: Array<{ start: number; end: number }>
  tts?: { text: string; voice: string; speed: number }
  codec?: string
}

export const assets = pgTable('assets', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id').notNull(),
  projectId: text('project_id'),
  kind: text('kind').notNull(),
  name: text('name').notNull(),
  mime: text('mime').notNull(),
  size: doublePrecision('size').notNull().default(0),
  status: text('status').notNull(),
  origin: text('origin').notNull().default('upload'),
  error: text('error'),
  sourceKey: text('source_key').notNull(),
  proxyKey: text('proxy_key'),
  thumbKey: text('thumb_key'),
  filmstripKey: text('filmstrip_key'),
  audioKey: text('audio_key'),
  meta: jsonb('meta').$type<AssetMeta>().notNull().default({}),
  sha256: text('sha256'),
  createdBy: text('created_by').notNull(),
  createdAt: ms('created_at').notNull(),
  updatedAt: ms('updated_at').notNull(),
  changeSeq: seq(),
})

export const jobs = pgTable('jobs', {
  id: text('id').primaryKey(),
  kind: text('kind').notNull(),
  status: text('status').notNull(),
  progress: doublePrecision('progress').notNull().default(0),
  message: text('message').notNull().default(''),
  input: jsonb('input').$type<Record<string, unknown>>().notNull(),
  result: jsonb('result'),
  error: text('error'),
  projectId: text('project_id'),
  workspaceId: text('workspace_id').notNull(),
  userId: text('user_id').notNull(),
  attempts: integer('attempts').notNull().default(0),
  cancelRequested: boolean('cancel_requested').notNull().default(false),
  lockedBy: text('locked_by'),
  lockedAt: ms('locked_at'),
  createdAt: ms('created_at').notNull(),
  updatedAt: ms('updated_at').notNull(),
})

export const exportsTable = pgTable('exports', {
  id: text('id').primaryKey(),
  projectId: text('project_id').notNull(),
  workspaceId: text('workspace_id').notNull(),
  assetId: text('asset_id').notNull(),
  jobId: text('job_id'),
  name: text('name').notNull(),
  resolution: text('resolution').notNull(),
  fps: integer('fps').notNull(),
  format: text('format').notNull(),
  sizeBytes: doublePrecision('size_bytes').notNull(),
  duration: doublePrecision('duration').notNull(),
  createdBy: text('created_by').notNull(),
  createdAt: ms('created_at').notNull(),
})

export const shareLinks = pgTable('share_links', {
  token: text('token').primaryKey(),
  projectId: text('project_id').notNull(),
  exportId: text('export_id'),
  createdBy: text('created_by').notNull(),
  createdAt: ms('created_at').notNull(),
})

export const brandKits = pgTable('brand_kits', {
  workspaceId: text('workspace_id').primaryKey(),
  doc: jsonb('doc').$type<import('@producer/core').BrandKitDoc>().notNull(),
  updatedAt: ms('updated_at').notNull(),
  changeSeq: seq(),
})

export const tombstones = pgTable('tombstones', {
  kind: text('kind').notNull(),
  id: text('id').notNull(),
  workspaceId: text('workspace_id').notNull(),
  changeSeq: bigint('change_seq', { mode: 'number' }).notNull(),
  deletedAt: ms('deleted_at').notNull(),
})

export const devices = pgTable('devices', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull(),
  name: text('name').notNull(),
  tokenHash: text('token_hash').notNull(),
  createdAt: ms('created_at').notNull(),
  lastSeenAt: ms('last_seen_at'),
})

/** Non-secret AI settings per workspace (AiSettingsDoc in ai/store.ts). Not synced. */
export const workspaceAiSettings = pgTable('workspace_ai_settings', {
  workspaceId: text('workspace_id').primaryKey(),
  doc: jsonb('doc').$type<Record<string, unknown>>().notNull(),
  updatedAt: ms('updated_at').notNull(),
})

/** Provider API keys, AES-256-GCM (base64 fields). Never returned by any API; not synced. */
export const aiKeys = pgTable(
  'ai_keys',
  {
    workspaceId: text('workspace_id').notNull(),
    provider: text('provider').notNull(),
    ciphertext: text('ciphertext').notNull(),
    iv: text('iv').notNull(),
    tag: text('tag').notNull(),
    last4: text('last4').notNull(),
    updatedAt: ms('updated_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.provider] })],
)

/** Appearance preferences per user (UserPreferences). Not synced. */
export const userPreferences = pgTable('user_preferences', {
  userId: text('user_id').primaryKey(),
  doc: jsonb('doc').$type<Record<string, unknown>>().notNull(),
  updatedAt: ms('updated_at').notNull(),
})

export const schema = { users, sessions, workspaces, memberships, invites, projects, assets, jobs, exportsTable, shareLinks, brandKits, tombstones, devices, workspaceAiSettings, aiKeys, userPreferences }
