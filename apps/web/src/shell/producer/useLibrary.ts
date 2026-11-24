// The shared media library as Producer's wizard shows it (23 Nov 2026): the songs a brief can play and the clips a
// scene can show. Listed once per page load (the list is the same for every space); a failed list is asked again the
// next time it is needed.
import { useEffect, useState } from 'react'
import type { LibraryClip, LibraryEntry, LibraryTrack } from '@producer/core'
import { api } from '../../lib/api'

let songs: Promise<Array<LibraryEntry<LibraryTrack>>> | undefined
let clips: Promise<Array<LibraryEntry<LibraryClip>>> | undefined

function cached<T>(get: () => Promise<T[]>, read: () => Promise<T[]> | undefined, keep: (p: Promise<T[]> | undefined) => void): Promise<T[]> {
  const had = read()
  if (had) return had
  // anything but a list (an answer from something else than this server) is no library
  const p = get()
    .then((l) => (Array.isArray(l) ? l : []))
    .catch(() => {
      keep(undefined)
      return [] as T[]
    })
  keep(p)
  return p
}

/** Forget the lists (tests). */
export function forgetLibraryLists() {
  songs = undefined
  clips = undefined
}

function useList<T extends { ready: boolean }>(load: () => Promise<T[]>): T[] | undefined {
  const [list, setList] = useState<T[]>()
  useEffect(() => {
    let live = true
    void load().then((l) => live && setList(l.filter((x) => x.ready)))
    return () => {
      live = false
    }
  }, [load])
  return list
}

const loadSongs = () =>
  cached(
    () => api.musicLibrary(),
    () => songs,
    (p) => (songs = p),
  )
const loadClips = () =>
  cached(
    () => api.clipLibrary(),
    () => clips,
    (p) => (clips = p),
  )

/** The library songs that have been made (undefined while listing). */
export const useLibrarySongs = () => useList(loadSongs)
/** The library clips that have been made (undefined while listing). */
export const useLibraryClips = () => useList(loadClips)
