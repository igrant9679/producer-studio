// The text-to-speech draft (A-20, APP-20): a store, not component state, so the script and a generation in progress
// survive Voice Studio's own tabs and other pages. Kept per space: switching spaces puts the draft away with its
// space and brings that space's back; each person's draft and favourite voices are also saved to the server for the
// space, so another tab or device finds them.
import type { AssetRecord, VoiceDraft } from '@producer/core'
import { create } from 'zustand'
import { onUserReset } from '../../lib/session'
import { voiceApi } from '../../lib/studioApi'

export interface TtsDraft {
  /** The space the draft on screen belongs to. */
  ws?: string
  text: string
  name: string
  speed: number
  /** The voice picked for it (unset: the brand kit's default). */
  voice?: string
  gen?: { progress: number; message: string }
  /** The last voiceover generated, for the History list. */
  made?: AssetRecord
  /** How many Voice Studio pages are on screen: a voiceover finishing later plays only then. */
  shown: number
  /** Other spaces' drafts, while they're away. */
  byWs: Record<string, VoiceDraft>
  /** Favourite voice ids per space. */
  favourites: Record<string, string[]>
  /** Spaces whose saved draft and favourites were read. */
  loaded: Record<string, boolean>
  set: (p: Partial<TtsDraft> | ((s: TtsDraft) => Partial<TtsDraft>)) => void
}

const EMPTY = { text: '', name: '', speed: 1, voice: undefined as string | undefined }

export const useTtsDraft = create<TtsDraft>((set) => ({ ...EMPTY, shown: 0, byWs: {}, favourites: {}, loaded: {}, set: (p) => set(p) }))
onUserReset(() => useTtsDraft.setState({ ...EMPTY, ws: undefined, gen: undefined, made: undefined, byWs: {}, favourites: {}, loaded: {} }))

const draftOf = (s: Pick<TtsDraft, 'text' | 'name' | 'speed' | 'voice'>): VoiceDraft => ({ text: s.text, name: s.name, speed: s.speed, ...(s.voice ? { voice: s.voice } : {}) })

/** Show `ws`'s draft: the one on screen is put away with its own space first. Then the server's copy is read once. */
export function showDraftSpace(ws: string | undefined) {
  const s = useTtsDraft.getState()
  if (!ws || s.ws === ws) return
  const byWs = { ...s.byWs }
  if (s.ws) byWs[s.ws] = draftOf(s)
  const next = byWs[ws] ?? EMPTY
  delete byWs[ws]
  useTtsDraft.setState({ ws, byWs, text: next.text, name: next.name, speed: next.speed, voice: next.voice })
}

/** Read the space's saved draft and favourites once: a draft typed here meanwhile wins. */
export async function loadSaved(ws: string) {
  if (useTtsDraft.getState().loaded[ws]) return
  try {
    const p = await voiceApi.prefs(ws)
    const s = useTtsDraft.getState()
    const patch: Partial<TtsDraft> = { loaded: { ...s.loaded, [ws]: true }, favourites: { ...s.favourites, [ws]: p.favourites ?? [] } }
    if (p.draft && s.ws === ws && !s.text && !s.name) Object.assign(patch, { text: p.draft.text, name: p.draft.name, speed: p.draft.speed, voice: p.draft.voice ?? s.voice })
    useTtsDraft.setState(patch)
  } catch {
    /* an older server, or offline: the draft stays in this tab only */
  }
}

let timer: ReturnType<typeof setTimeout> | undefined
// a draft edit is saved for its space shortly after typing stops
useTtsDraft.subscribe((s, prev) => {
  if (!s.ws || s.ws !== prev.ws || !s.loaded[s.ws]) return
  if (s.text === prev.text && s.name === prev.name && s.speed === prev.speed && s.voice === prev.voice) return
  clearTimeout(timer)
  const ws = s.ws
  const draft = s.text.trim() || s.name.trim() ? draftOf(s) : null
  timer = setTimeout(() => void voiceApi.savePrefs(ws, { draft }).catch(() => undefined), 1200)
})

export async function toggleFavourite(ws: string, voiceId: string) {
  const s = useTtsDraft.getState()
  const cur = s.favourites[ws] ?? []
  const next = cur.includes(voiceId) ? cur.filter((v) => v !== voiceId) : [...cur, voiceId]
  useTtsDraft.setState({ favourites: { ...s.favourites, [ws]: next } })
  try {
    await voiceApi.savePrefs(ws, { favourites: next })
  } catch (e) {
    useTtsDraft.setState((st) => ({ favourites: { ...st.favourites, [ws]: cur } }))
    throw e
  }
}
