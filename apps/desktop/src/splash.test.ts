import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { SLOW_NOTE, splashUrl } from './splash'

const html = fs.readFileSync(path.join(__dirname, 'splash.html'), 'utf8')
const page = (url: string) => decodeURIComponent(url.slice(url.indexOf(',') + 1))

describe('the splash page', () => {
  it('is handed over whole as a data: URL, so nothing is loaded from inside the asar', () => {
    const url = splashUrl(html)
    expect(url.startsWith('data:text/html;charset=utf-8,')).toBe(true)
    expect(page(url)).toBe(html)
    // self-contained: no file it would have to load next to it
    expect(html).not.toMatch(/\b(?:src|href)=/)
  })

  it('can say the start is slow in place of its status line, escaped', () => {
    const slow = page(splashUrl(html, SLOW_NOTE))
    expect(slow).toContain(`<p>${SLOW_NOTE}</p>`)
    expect(slow).not.toContain('Starting the local engine')
    expect(page(splashUrl(html, 'a <b> & c'))).toContain('<p>a &lt;b&gt; &amp; c</p>')
  })
})
