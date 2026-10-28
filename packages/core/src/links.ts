// Linked groups (E-1): items sharing a `linkId` (a video and its separated audio, or clips attached with Link) split,
// trim, move and delete together. Split carries links in `splitItem`; this file has the rest, used by the timeline,
// the keyboard, the clip menu and the assistant's tools alike.
import { editable, findItem, itemEnd, moveItem, trimItem } from './ops'
import type { Item, Project, Track } from './types'
import { EPS, uid } from './util'

/** The other items in `itemId`'s link group, with their tracks. */
export function linkedPartners(p: Project, itemId: string): Array<{ item: Item; track: Track }> {
  const f = findItem(p, itemId)
  const link = f?.item.linkId
  if (!link) return []
  const out: Array<{ item: Item; track: Track }> = []
  for (const track of p.tracks) for (const item of track.items) if (item.linkId === link && item.id !== itemId) out.push({ item, track })
  return out
}

/** `ids` and every item linked to one of them (selection order first, partners after). */
export function withLinked(p: Project, ids: string[]): string[] {
  const out = new Set(ids)
  for (const id of ids) for (const { item } of linkedPartners(p, id)) out.add(item.id)
  return [...out]
}

/** Whether the items form exactly one link group of two or more (Unlink applies, Link would change nothing). */
export function isLinkedGroup(p: Project, ids: string[]): boolean {
  const items = ids.map((id) => findItem(p, id)?.item)
  const link = items[0]?.linkId
  return !!link && items.length >= 2 && items.every((i) => i?.linkId === link)
}

/** Link the items (at least two, all editable) into one new group; they leave any group they were in. */
export function linkItems(p0: Project, ids: string[]): Project {
  const found = [...new Set(ids)].map((id) => findItem(p0, id))
  if (found.length < 2 || !found.every(editable)) return p0
  const p = structuredClone(p0)
  const link = uid('l')
  for (const id of new Set(ids)) findItem(p, id)!.item.linkId = link
  dropSingletons(p)
  p.updatedAt = Date.now()
  return p
}

/** Take the items out of their groups; a group left with one member is gone too. */
export function unlinkItems(p0: Project, ids: string[]): Project {
  const targets = ids.map((id) => findItem(p0, id)).filter((f) => editable(f) && f.item.linkId)
  if (!targets.length) return p0
  const p = structuredClone(p0)
  for (const f of targets) delete findItem(p, f!.item.id)!.item.linkId
  dropSingletons(p)
  p.updatedAt = Date.now()
  return p
}

function dropSingletons(p: Project) {
  const count = new Map<string, number>()
  for (const t of p.tracks) for (const i of t.items) if (i.linkId) count.set(i.linkId, (count.get(i.linkId) ?? 0) + 1)
  for (const t of p.tracks) for (const i of t.items) if (i.linkId && count.get(i.linkId) === 1) delete i.linkId
}

/**
 * Move an item and its group. `moveItem` already carries partners on other tracks along with a clip; a clip whose
 * partner sits on the magnetic main track (separated audio) can't drift on its own, so the main-track clip is moved by
 * the same amount instead and the clip follows it. A change of track applies to the item itself.
 */
export function moveLinked(p: Project, itemId: string, to: { start: number; trackId?: string }): Project {
  const f = findItem(p, itemId)
  if (!editable(f)) return p
  const lead = f.track.main ? undefined : linkedPartners(p, itemId).find((x) => x.track.main && editable(findItem(p, x.item.id)))
  if (!lead) return moveItem(p, itemId, to)
  let q = p
  if (to.trackId && to.trackId !== f.track.id) q = moveItem(q, itemId, { start: f.item.start, trackId: to.trackId })
  const delta = to.start - f.item.start
  if (Math.abs(delta) > EPS) q = moveItem(q, lead.item.id, { start: Math.max(0, lead.item.start + delta) })
  return q
}

/**
 * Trim an item's edge and the same edge of every partner that ended (or began) there with it. The edge lands where the
 * item's own trim lets it (source bounds, neighbours); partners on other tracks are trimmed before main-track ones,
 * because a main-track trim re-packs and carries its partners along.
 */
export function trimLinked(p: Project, itemId: string, edge: 'start' | 'end', t: number): Project {
  const f = findItem(p, itemId)
  if (!editable(f)) return p
  const partners = linkedPartners(p, itemId)
  if (!partners.length) return trimItem(p, itemId, edge, t)
  const it = f.item
  const old = edge === 'start' ? it.start : itemEnd(it)
  const frame = 1 / p.fps
  const together = partners.filter(({ item }) => Math.abs((edge === 'start' ? item.start : itemEnd(item)) - old) < frame / 2 + EPS && editable(findItem(p, item.id)))
  if (!together.length) return trimItem(p, itemId, edge, t)
  // where the item's own edge goes, before a main track re-packs it
  const trial = findItem(trimItem(p, itemId, edge, t), itemId)!.item
  const at = edge === 'start' ? itemEnd(it) - trial.duration : it.start + trial.duration
  const group = [{ item: it, track: f.track }, ...together].sort((a, b) => Number(!!a.track.main) - Number(!!b.track.main))
  let q = p
  for (const { item } of group) q = trimItem(q, item.id, edge, at)
  return q
}
