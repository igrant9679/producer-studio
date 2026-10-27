// Three-way merge of project documents, for results that arrive after a wait (the AI assistant): `theirs` was made
// from `base`, `mine` is the editor's document now. Their changes are applied to mine item by item, track by track
// and field by field; when both sides changed the same thing, or the result wouldn't be a valid timeline, there is
// no merge and the caller warns instead of overwriting.
import type { Item, Project, Track } from '@producer/core'

/** Structural equality of JSON-like values; a key holding undefined counts as absent (as after a JSON round trip). */
export function same(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
    return a.every((x, i) => same(x, b[i]))
  }
  const ra = a as Record<string, unknown>
  const rb = b as Record<string, unknown>
  const ka = Object.keys(ra).filter((k) => ra[k] !== undefined)
  const kb = Object.keys(rb).filter((k) => rb[k] !== undefined)
  return ka.length === kb.length && ka.every((k) => same(ra[k], rb[k]))
}

class Conflict extends Error {}

/** The three-way rule for one value (undefined = absent): whoever changed it wins; both, differently, conflicts. */
function pick<T>(base: T, theirs: T, mine: T): T {
  if (same(theirs, base)) return mine
  if (same(mine, base) || same(mine, theirs)) return theirs
  throw new Conflict()
}

const keysOf = (...objs: object[]) => [...new Set(objs.flatMap((o) => Object.keys(o)))]

type Placed = { track: string; item: Item }

function placed(p: Project): Map<string, Placed> {
  const m = new Map<string, Placed>()
  for (const t of p.tracks) for (const item of t.items) m.set(item.id, { track: t.id, item })
  return m
}

function shells(p: Project): Map<string, Omit<Track, 'items'>> {
  const m = new Map<string, Omit<Track, 'items'>>()
  for (const { items: _items, ...shell } of p.tracks) m.set(shell.id, shell)
  return m
}

/** Track order: whoever reordered the tracks they share wins; tracks only one side added keep their neighbour above. */
function trackOrder(base: Project, theirs: Project, mine: Project, keep: Set<string>): string[] {
  const ids = (p: Project) => p.tracks.map((t) => t.id).filter((id) => keep.has(id))
  const inBase = new Set(base.tracks.map((t) => t.id))
  const inTheirs = new Set(theirs.tracks.map((t) => t.id))
  const inMine = new Set(mine.tracks.map((t) => t.id))
  const shared = (p: Project) => ids(p).filter((id) => inBase.has(id) && inTheirs.has(id) && inMine.has(id))
  const [b, t, m] = [shared(base), shared(theirs), shared(mine)]
  let order: string[]
  let extra: Project
  if (same(t, b) || same(t, m)) [order, extra] = [ids(mine), theirs]
  else if (same(m, b)) [order, extra] = [ids(theirs), mine]
  else throw new Conflict()
  const extraIds = ids(extra)
  for (let i = extraIds.length - 1; i >= 0; i--) {
    const id = extraIds[i]
    if (order.includes(id)) continue
    // just below the track that sat above it there (a new caption track stays on top)
    const above = extraIds.slice(i + 1).find((x) => order.includes(x))
    order.splice(above === undefined ? order.length : order.indexOf(above), 0, id)
  }
  return order
}

const EPS = 1e-3
const end = (i: Item) => i.start + i.duration

function overlapping(items: Item[]): boolean {
  const s = [...items].sort((a, b) => a.start - b.start)
  return s.some((it, i) => i > 0 && it.start < end(s[i - 1]) - EPS)
}

/** The main track is magnetic: its clips sit edge to edge from 0. */
function packed(items: Item[]): boolean {
  let t = 0
  for (const it of [...items].sort((a, b) => a.start - b.start)) {
    if (Math.abs(it.start - t) > EPS) return false
    t = end(it)
  }
  return true
}

/** `mine` with the changes `theirs` made to `base`, or null when they can't be applied cleanly. */
export function rebase(base: Project, theirs: Project, mine: Project): Project | null {
  if (same(theirs, base)) return mine
  if (same(mine, base)) return theirs
  try {
    const out = { ...mine } as Record<string, unknown>
    const b = base as unknown as Record<string, unknown>
    const t = theirs as unknown as Record<string, unknown>
    const m = mine as unknown as Record<string, unknown>
    for (const k of keysOf(base, theirs, mine)) {
      if (k === 'tracks' || k === 'assets' || k === 'updatedAt') continue
      const v = pick(b[k], t[k], m[k])
      if (v === undefined) delete out[k]
      else out[k] = v
    }

    // media records: ours are the freshest from the server, so on both sides changing one, ours wins
    const assets: Project['assets'] = {}
    for (const id of keysOf(base.assets, theirs.assets, mine.assets)) {
      const [ba, ta, ma] = [base.assets[id], theirs.assets[id], mine.assets[id]]
      const v = same(ta, ba) ? ma : ma === undefined || same(ma, ba) ? ta : { ...ta, ...ma }
      if (v) assets[id] = v
    }

    const [bs, ts, ms] = [shells(base), shells(theirs), shells(mine)]
    const tracks = new Map<string, Track>()
    for (const id of keysOf(Object.fromEntries(bs), Object.fromEntries(ts), Object.fromEntries(ms))) {
      const shell = pick(bs.get(id), ts.get(id), ms.get(id))
      if (shell) tracks.set(id, { ...shell, items: [] })
    }
    const [bi, ti, mi] = [placed(base), placed(theirs), placed(mine)]
    for (const id of new Set([...bi.keys(), ...ti.keys(), ...mi.keys()])) {
      const p = pick(bi.get(id), ti.get(id), mi.get(id))
      if (!p) continue
      const track = tracks.get(p.track)
      if (!track) throw new Conflict()
      track.items.push(p.item)
    }
    const before = (p: Project, id: string) => p.tracks.find((x) => x.id === id)?.items ?? []
    for (const track of tracks.values()) {
      track.items.sort((x, y) => x.start - y.start)
      // a timeline neither side would have made: clips on top of each other, or a gap in the magnetic track
      if (overlapping(track.items) && !overlapping(before(mine, track.id)) && !overlapping(before(theirs, track.id))) throw new Conflict()
      if (track.main && !packed(track.items) && packed(before(mine, track.id))) throw new Conflict()
    }
    out.tracks = trackOrder(base, theirs, mine, new Set(tracks.keys())).map((id) => tracks.get(id)!)
    out.assets = assets
    out.updatedAt = Math.max(mine.updatedAt, theirs.updatedAt)
    return out as unknown as Project
  } catch (e) {
    if (e instanceof Conflict) return null
    throw e
  }
}
