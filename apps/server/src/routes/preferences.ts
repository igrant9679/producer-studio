// Per-user appearance preferences (mounted under /api/me). Cloud: per signed-in user; desktop: the one local user.
// Stored as a JSON document in user_preferences; reads always return a complete, normalized object.
import { Hono } from 'hono'
import { eq } from 'drizzle-orm'
import * as z from 'zod/v4'
import { ACCENT_PRESETS, DENSITIES, DEFAULT_PREFERENCES, TEXT_SIZES, THEME_PREFERENCES, normalizePreferences, type PreferencesResponse } from '@producer/core'
import { type AppEnv, requireUser } from '../auth'
import { ctx } from '../context'
import { userPreferences } from '../db/schema'
import { body } from '../http'

const enumOf = <T extends string>(list: readonly T[]) => z.enum(list as unknown as [T, ...T[]])

/** Partial update: every field optional, unknown keys rejected. */
export const PreferencesPatch = z
  .object({
    theme: enumOf(THEME_PREFERENCES),
    textSize: enumOf(TEXT_SIZES),
    accent: enumOf(ACCENT_PRESETS),
    density: enumOf(DENSITIES),
    reduceMotion: z.boolean(),
  })
  .partial()
  .strict()

export async function loadPreferences(userId: string): Promise<PreferencesResponse> {
  const row = (await ctx().db.select().from(userPreferences).where(eq(userPreferences.userId, userId)).limit(1))[0]
  if (!row) return { preferences: { ...DEFAULT_PREFERENCES }, updatedAt: null }
  return { preferences: normalizePreferences(row.doc), updatedAt: row.updatedAt }
}

export const preferenceRoutes = new Hono<AppEnv>()

preferenceRoutes.get('/preferences', async (c) => {
  const u = requireUser(c)
  return c.json(await loadPreferences(u.id))
})

preferenceRoutes.put('/preferences', async (c) => {
  const u = requireUser(c)
  const patch = await body(c, PreferencesPatch)
  const cur = await loadPreferences(u.id)
  const doc = normalizePreferences({ ...cur.preferences, ...patch })
  const now = Date.now()
  await ctx()
    .db.insert(userPreferences)
    .values({ userId: u.id, doc: { ...doc }, updatedAt: now })
    .onConflictDoUpdate({ target: userPreferences.userId, set: { doc: { ...doc }, updatedAt: now } })
  return c.json({ preferences: doc, updatedAt: now } satisfies PreferencesResponse)
})
