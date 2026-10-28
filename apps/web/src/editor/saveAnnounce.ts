// Where saving stands, for screen readers: said once when it changes in a way that matters (offline, a conflict,
// and saved again after one of those), never on each autosave. A refused save has its own alert banner.
import { announce } from '../lib/announce'
import { useEditor, type SaveState } from './store'

type Said = 'saved' | 'offline' | 'conflict' | 'error'

/** What a save state means to the person; saving in progress changes nothing they need to hear. */
function meaning(s: SaveState): Said | undefined {
  if (s === 'saved') return 'saved'
  if (s === 'offline' || s === 'conflict' || s === 'error') return s
  return undefined
}

const WORDS: Partial<Record<Said, string>> = {
  saved: 'All changes saved',
  offline: 'Offline: your changes are kept in this browser and saved when the server is back',
  conflict: 'This project was saved somewhere else meanwhile: choose which version to keep',
}

export function startSaveAnnouncements(): () => void {
  let said: Said = meaning(useEditor.getState().saveState) ?? 'saved'
  return useEditor.subscribe((s, prev) => {
    if (s.saveState === prev.saveState) return
    // a new project loaded: start over, quietly
    if (s.projectId !== prev.projectId) {
      said = meaning(s.saveState) ?? 'saved'
      return
    }
    const now = meaning(s.saveState)
    if (!now || now === said) return
    said = now
    const words = WORDS[now]
    if (words) announce(words)
  })
}
