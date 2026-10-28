import { describe, expect, it } from 'vitest'
import { applyPronunciations, hasMarkup, parseCsv, parseScript, parseVoiceCsv, plainScript, scriptSeconds } from './voice'

describe('voice script markup (A-20)', () => {
  it('splits a script into what is said, emphasis runs and pauses', () => {
    expect(parseScript('Welcome back. [pause] This week is *really* big. [pause 2s][pause 500ms] Let’s go.')).toEqual([
      { kind: 'say', text: 'Welcome back.' },
      { kind: 'pause', seconds: 0.6 },
      { kind: 'say', text: 'This week is' },
      { kind: 'say', text: 'really', emphasis: true },
      { kind: 'say', text: 'big.' },
      { kind: 'pause', seconds: 2.5 },
      { kind: 'say', text: 'Let’s go.' },
    ])
    expect(parseScript('[PAUSE 99s] hi')).toEqual([{ kind: 'pause', seconds: 10 }, { kind: 'say', text: 'hi' }])
    expect(parseScript('5 * 3 = 15')).toEqual([{ kind: 'say', text: '5 * 3 = 15' }])
    expect(hasMarkup('plain text')).toBe(false)
    expect(hasMarkup('a [pause] b')).toBe(true)
    expect(hasMarkup('so *very* nice')).toBe(true)
  })

  it('gives the plain words for voices that can’t pause, and estimates the length with the pauses', () => {
    expect(plainScript('Hello. [pause 2s] It is *done*.')).toBe('Hello.… It is done.')
    expect(scriptSeconds('one two three four five [pause 2s]', 1)).toBe(4)
    expect(scriptSeconds('one two three four five', 2)).toBe(1)
  })

  it('applies the pronunciation dictionary to whole words in any case, longest first', () => {
    const dict = [
      { word: 'SQL', say: 'sequel' },
      { word: 'Kubernetes', say: 'koo-ber-net-eez' },
      { word: 'Acme Cloud', say: 'Ack-me Cloud' },
      { word: 'Acme', say: 'Ack-me' },
    ]
    expect(applyPronunciations('Run sql on kubernetes in Acme Cloud — Acme, not SQLite.', dict)).toBe('Run sequel on koo-ber-net-eez in Ack-me Cloud — Ack-me, not SQLite.')
    expect(applyPronunciations('nothing here', [])).toBe('nothing here')
    expect(applyPronunciations('a (b) c', [{ word: '(b)', say: 'bee' }])).toBe('a bee c')
  })

  it('reads voiceovers from a CSV: header or not, quotes and newlines, voices and speeds checked', () => {
    expect(parseCsv('"a, b",c\n"say ""hi""\nthere",d\r\n\n')).toEqual([['a, b', 'c'], ['say "hi"\nthere', 'd']])
    expect(parseCsv('text;voice\nHallo;af_heart')).toEqual([['text', 'voice'], ['Hallo', 'af_heart']])
    const voices = new Set(['af_heart', 'am_eric'])
    const rows = parseVoiceCsv('name,text,voice,speed\nIntro,"Hi, I am the intro",am_eric,1.2\nBad,Nope,zz_robot,\nSlow,Too slow,,0.1\nEmpty,,,', voices)
    expect(rows).toEqual([
      { line: 2, name: 'Intro', text: 'Hi, I am the intro', voice: 'am_eric', speed: 1.2 },
      { line: 3, name: 'Bad', text: 'Nope', voice: 'zz_robot', error: 'Unknown voice “zz_robot”' },
      { line: 4, name: 'Slow', text: 'Too slow', speed: 0.1, error: 'Speed must be 0.5 to 2' },
      { line: 5, name: 'Empty', text: '', error: 'No text' },
    ])
    expect(parseVoiceCsv('First line\nSecond line', voices).map((r) => [r.line, r.text])).toEqual([[1, 'First line'], [2, 'Second line']])
    const many = Array.from({ length: 52 }, (_, i) => `line ${i}`).join('\n')
    expect(parseVoiceCsv(many, voices).filter((r) => r.error).map((r) => r.line)).toEqual([51, 52])
  })
})
