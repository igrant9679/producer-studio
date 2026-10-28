// Dictation pastes through the clipboard: the person's clipboard is saved first, every format of every item (rich
// text, HTML, pictures, files), and put back only after the paste has happened, never on a timer that a slow paste can
// outlast (it could paste the previous clipboard, a password say). No Electron here, so it can be tested with a
// stand-in clipboard.

interface ReadItem {
  readonly types: string[]
  getType(type: string): Promise<unknown>
}

/** The part of Electron's (asynchronous) clipboard this uses, and a way to make a ClipboardItem. */
export interface ClipboardLike<Item = unknown> {
  read(): Promise<ReadItem[]>
  write(items: Item[]): Promise<void>
  readText(): Promise<string>
  writeText(text: string): Promise<void>
  clear(): void
  item(data: Record<string, unknown>): Item
}

/** Every item with each of its formats' data, read out now (a read item's data would follow the clipboard). */
export type ClipboardSnapshot = Array<Record<string, unknown>>

export async function snapshotClipboard(cb: ClipboardLike): Promise<ClipboardSnapshot> {
  const items = await cb.read()
  const out: ClipboardSnapshot = []
  for (const it of items) {
    const data: Record<string, unknown> = {}
    for (const t of it.types) {
      const v = await it.getType(t).catch(() => undefined)
      if (v !== undefined) data[t] = v
    }
    if (Object.keys(data).length) out.push(data)
  }
  return out
}

const COMMON = ['text/plain', 'text/html', 'text/rtf', 'image/png']

export async function restoreClipboard(cb: ClipboardLike, saved: ClipboardSnapshot) {
  if (!saved.length) return cb.clear()
  try {
    await cb.write(saved.map((d) => cb.item(d)))
  } catch {
    // a format this platform won't take back: at least the common ones
    const common = saved.map((d) => Object.fromEntries(Object.entries(d).filter(([t]) => COMMON.includes(t)))).filter((d) => Object.keys(d).length)
    if (common.length) await cb.write(common.map((d) => cb.item(d)))
    else cb.clear()
  }
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

/**
 * Put `text` on the clipboard, run `paste` (resolves once the keystroke has been sent, i.e. its process exited), give
 * the target app `settleMs` to read it, then put the person's clipboard back, unless something else was copied
 * meanwhile.
 */
export async function pasteKeepingClipboard(cb: ClipboardLike, text: string, paste: () => Promise<void>, settleMs = 400): Promise<void> {
  const saved = await snapshotClipboard(cb)
  await cb.writeText(text)
  try {
    await paste()
  } finally {
    await wait(settleMs)
    if ((await cb.readText()) === text) await restoreClipboard(cb, saved)
  }
}
