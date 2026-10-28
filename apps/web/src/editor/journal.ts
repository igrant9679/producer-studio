// The local journal of unsaved edits (E-2): while the editor has changes the server doesn't, they are written to
// this browser's storage per person and project, so closing the tab, a crash or a reload doesn't lose them. Opening
// the project again offers them back ("Restore unsaved changes / Discard"); a save the server accepts clears them.
import type { Project } from '@producer/core'

export interface JournalEntry {
  v: 1
  projectId: string
  userId: string
  /** The server version the changes were made on. */
  baseVersion: number
  savedAt: number
  project: Project
}

const PREFIX = 'ps.journal.'
const key = (userId: string, projectId: string) => `${PREFIX}${userId}.${projectId}`

/** Keep the changes. 'full': the browser's storage had no room (they stay only in this tab). */
export function writeJournal(e: Omit<JournalEntry, 'v' | 'savedAt'>, now = Date.now()): 'ok' | 'full' | 'unavailable' {
  const entry: JournalEntry = { v: 1, ...e, savedAt: now }
  try {
    localStorage.setItem(key(e.userId, e.projectId), JSON.stringify(entry))
    return 'ok'
  } catch (err) {
    // a stale half-written copy is worse than none
    try {
      localStorage.removeItem(key(e.userId, e.projectId))
    } catch {
      /* storage unavailable */
    }
    return err instanceof DOMException && /quota/i.test(err.name + err.message) ? 'full' : 'unavailable'
  }
}

export function readJournal(userId: string, projectId: string): JournalEntry | null {
  try {
    const raw = localStorage.getItem(key(userId, projectId))
    if (!raw) return null
    const e = JSON.parse(raw) as JournalEntry
    if (e?.v !== 1 || e.projectId !== projectId || e.userId !== userId || !e.project || typeof e.baseVersion !== 'number') return null
    return e
  } catch {
    return null
  }
}

export function clearJournal(userId: string, projectId: string) {
  try {
    localStorage.removeItem(key(userId, projectId))
  } catch {
    /* storage unavailable */
  }
}
