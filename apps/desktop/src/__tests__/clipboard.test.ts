// Dictation puts the person's clipboard back only after the paste has happened, with every format (DSK-15).
import { describe, expect, it } from 'vitest'
import { type ClipboardLike, pasteKeepingClipboard } from '../clipboard'

type Data = Record<string, unknown>

/** A stand-in for Electron's asynchronous clipboard: items with several formats each, read lazily like the real one. */
class FakeClipboard implements ClipboardLike<Data> {
  items: Data[] = []
  async read() {
    // the data is fetched when asked for, from whatever the clipboard holds then
    return this.items.map((_, i) => ({ types: Object.keys(this.items[i]), getType: async (t: string) => this.items[i]?.[t] }))
  }
  async write(items: Data[]) {
    this.items = items.map((d) => ({ ...d }))
  }
  async readText() {
    return String(this.items[0]?.['text/plain'] ?? '')
  }
  async writeText(text: string) {
    this.items = [{ 'text/plain': text }]
  }
  clear() {
    this.items = []
  }
  item(data: Data) {
    return data
  }
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe('dictation and the clipboard (DSK-15)', () => {
  it('a paste that starts slowly (past 1.5 s) still pastes the dictated text, never the previous clipboard', async () => {
    const cb = new FakeClipboard()
    await cb.writeText('hunter2')
    let pasted = ''
    // a cold PowerShell: the keystroke reaches the app 2 s after it was asked for
    const paste = async () => {
      await wait(2000)
      pasted = await cb.readText()
    }
    await pasteKeepingClipboard(cb, 'Dictated words.', paste, 50)
    expect(pasted).toBe('Dictated words.')
    expect(await cb.readText()).toBe('hunter2')
  })

  it('brings back rich text, pictures and files, not only plain text', async () => {
    const cb = new FakeClipboard()
    const png = new Blob([new Uint8Array([137, 80, 78, 71])], { type: 'image/png' })
    await cb.write([{ 'text/plain': 'Title', 'text/html': '<b>Title</b>', 'text/rtf': '{\\rtf1 Title}', 'image/png': png }, { 'text/uri-list': 'file:///C:/a.txt' }])
    await pasteKeepingClipboard(cb, 'hello', async () => undefined, 10)
    expect(cb.items).toEqual([{ 'text/plain': 'Title', 'text/html': '<b>Title</b>', 'text/rtf': '{\\rtf1 Title}', 'image/png': png }, { 'text/uri-list': 'file:///C:/a.txt' }])
  })

  it('leaves alone something the person copied in the meantime, and an empty clipboard stays empty', async () => {
    const cb = new FakeClipboard()
    await cb.writeText('old')
    await pasteKeepingClipboard(cb, 'hello', async () => cb.writeText('copied meanwhile'), 10)
    expect(await cb.readText()).toBe('copied meanwhile')
    const empty = new FakeClipboard()
    await pasteKeepingClipboard(empty, 'hello', async () => undefined, 10)
    expect(empty.items).toEqual([])
  })
})
