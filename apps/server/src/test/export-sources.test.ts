// The files an export renders from (P-18, and the colour fix carried from R3): a long source used a little is cut to
// the windows the edit uses, with the clips' in-points moved so each frame is the one it was; a BT.709 source is
// converted to BT.601 values (what HyperFrames' JPEG frames are read as). From real files made with ffmpeg.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { addAsset, addItem, createProject, createVideoItem, type Asset } from '@producer/core'
import { beforeAll, describe, expect, it } from 'vitest'
import { ffmpeg } from '../media/proc'
import { probe } from '../media/process'
import { needsColourConversion, pointAtPrepared, prepareVideoSource, shownMatrix, usedWindows, worthTrimming } from '../render/sources'
import { setup } from './helpers'

let dir = ''
beforeAll(async () => {
  await setup()
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-src-'))
  fs.mkdirSync(path.join(dir, 'assets'))
})

const clip = (id: string, duration: number): Asset => ({ id, kind: 'video', name: `${id}.mp4`, src: `/api/media/${id}/source`, duration, width: 320, height: 180, hasAudio: true })

/** The frame number burned into a test file at time `t` of `file`: its picture is a grey level per second. */
async function grey(file: string, t: number): Promise<number> {
  const out = path.join(dir, `g-${Math.random().toString(36).slice(2)}.gray`)
  await ffmpeg(['-ss', String(t), '-i', file, '-frames:v', '1', '-vf', 'scale=8:8,format=gray', '-f', 'rawvideo', out])
  const b = fs.readFileSync(out)
  return Math.round(b.reduce((s, v) => s + v, 0) / b.length)
}

describe('the source windows an edit uses (P-18)', () => {
  it('each clip’s window with padding, joined where they touch; a reversed or smooth clip keeps its source whole', () => {
    let p = createProject({ name: 'w' })
    const a = clip('a', 600)
    p = addAsset(p, a)
    p = addItem(p, createVideoItem(a, 0, { in: 100, duration: 5 }))
    p = addItem(p, createVideoItem(a, 5, { in: 103, duration: 4 }))
    p = addItem(p, createVideoItem(a, 9, { in: 400, duration: 2 }))
    const w = usedWindows(p).get('a')!
    expect(w).toEqual([{ from: 98.5, to: 108.5 }, { from: 398.5, to: 403.5 }])
    expect(worthTrimming(w, 600)).toBe(true)
    // most of a source used, or a short one: used whole
    expect(worthTrimming([{ from: 0, to: 50 }], 60)).toBe(false)
    expect(worthTrimming([{ from: 0, to: 10 }], 30)).toBe(false)
    const r = createVideoItem(a, 11, { in: 200, duration: 2 })
    p = addItem(p, { ...r, reverse: true })
    expect(usedWindows(p).has('a')).toBe(false)
  })

  it('clips are pointed at the window holding them, in-points moved by where it starts', () => {
    let p = createProject({ name: 'w' })
    const a = clip('a', 600)
    p = addAsset(p, a)
    p = addItem(p, createVideoItem(a, 0, { in: 100, duration: 5 }))
    p = addItem(p, createVideoItem(a, 5, { in: 400, duration: 2 }))
    const out = pointAtPrepared(p, new Map([['a', [{ name: 'a~1.mp4', offset: 98, window: { from: 98.5, to: 108.5 } }, { name: 'a~2.mp4', offset: 397.9, window: { from: 398.5, to: 403.5 } }]]]))
    const items = out.tracks[0].items as Array<{ assetId: string; in: number }>
    expect(items.map((i) => [i.assetId, Math.round(i.in * 100) / 100])).toEqual([['a~1', 2], ['a~2', 2.1]])
    expect(out.assets['a~2']).toMatchObject({ id: 'a~2', duration: 403.5 - 397.9 })
    // the document itself is untouched
    expect((p.tracks[0].items[0] as { in: number }).in).toBe(100)
  })
})

describe('cutting and converting a source for the export (P-18, colour)', () => {
  let long = ''
  beforeAll(async () => {
    // 80 s; each second a different grey (so a frame says where in the source it came from), keyframes every 2 s
    long = path.join(dir, 'long.mp4')
    await ffmpeg(['-f', 'lavfi', '-i', "color=c=black:s=160x90:r=10,geq=lum='mod(floor(T)*3,240)+8':cb=128:cr=128", '-f', 'lavfi', '-i', 'sine=frequency=440', '-t', '80', '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '20', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', long])
  })

  it('cuts the windows used out of a long file; every frame a clip plays is the one it played from the whole file', async () => {
    const info = (await probe(long))!
    const windows = [{ from: 30.5, to: 36 }, { from: 60, to: 64 }]
    const ps = (await prepareVideoSource(long, 'lng', windows, dir, { info, matrix: 'smpte170m', ext: '.mp4', quality: 'standard' }))!
    expect(ps).toHaveLength(2)
    // a stream copy starts on a keyframe at or before the window
    expect(ps[0].offset).toBeLessThanOrEqual(30.5)
    expect(ps[0].offset).toBeGreaterThan(27)
    for (const [k, srcT] of [[0, 31.5], [0, 34.2], [1, 61.3]] as const) {
      const file = path.join(dir, 'assets', ps[k].name)
      expect(await grey(file, srcT - ps[k].offset)).toBe(await grey(long, srcT))
    }
    // much smaller than the source
    const size = ps.reduce((s, x) => s + fs.statSync(path.join(dir, 'assets', x.name)).size, 0)
    expect(size).toBeLessThan(fs.statSync(long).size / 3)
  })

  it('a source already in BT.601 and used whole is used as it is', async () => {
    const info = (await probe(long))!
    expect(await prepareVideoSource(long, 'same', [{ from: 0, to: 80 }], dir, { info, matrix: 'smpte170m', ext: '.mp4', quality: 'standard' })).toBeUndefined()
  })

  it('a BT.709 source is converted to BT.601 values, so the frames HyperFrames reads show the same colours', async () => {
    const src = path.join(dir, 'cam.mp4')
    await ffmpeg(['-f', 'lavfi', '-i', 'color=c=0xff0000:s=160x90:r=10', '-t', '2', '-vf', 'scale=out_color_matrix=bt709:out_range=tv,format=yuv420p', '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-c:v', 'libx264', '-crf', '10', src])
    const info = (await probe(src))!
    const matrix = shownMatrix(info, { proxy: false })
    expect(matrix).toBe('bt709')
    expect(needsColourConversion(info, matrix)).toBe(true)
    const [ps] = (await prepareVideoSource(src, 'cam', undefined, dir, { info, matrix, ext: '.mp4', quality: 'high' }))!
    expect(ps.offset).toBe(0)
    // read as a JPEG frame is read: YUV straight to JPEG, then BT.601
    const red = async (f: string) => {
      const jpg = path.join(dir, `f-${Math.random().toString(36).slice(2)}.jpg`)
      await ffmpeg(['-i', f, '-frames:v', '1', '-q:v', '2', jpg])
      const raw = `${jpg}.rgb`
      await ffmpeg(['-i', jpg, '-vf', 'crop=2:2:80:45,format=rgb24', '-f', 'rawvideo', raw])
      return fs.readFileSync(raw)[0]
    }
    expect(await red(src)).toBeLessThan(240) // as HyperFrames read it before: BT.709 values decoded as BT.601
    expect(await red(path.join(dir, 'assets', ps.name))).toBeGreaterThan(245)
    expect((await probe(path.join(dir, 'assets', ps.name))).colorSpace).toBe('smpte170m')
  })

  it('an edit proxy made before proxies were tagged is taken as the browser showed it', () => {
    expect(shownMatrix({ width: 1280, height: 720 }, { proxy: true })).toBe('bt709')
    expect(shownMatrix({ width: 640, height: 360 }, { proxy: true })).toBe('smpte170m')
    expect(shownMatrix({ colorSpace: 'smpte170m', width: 1280, height: 720 }, { proxy: true })).toBe('smpte170m')
    expect(shownMatrix({ encoder: 'Lavf60', width: 1280, height: 720 }, { proxy: false, recorded: 'bt709' })).toBe('bt709')
  })

  it('the renderer keeps its extracted frames on the data volume, and gets an explicit worker count', async () => {
    const { hfEnv, renderArgs } = await import('../render/export')
    const { ctx } = await import('../context')
    expect(hfEnv().HYPERFRAMES_EXTRACT_CACHE_DIR).toBe(ctx().config.renderCacheDir)
    expect(ctx().config.renderCacheDir.startsWith(ctx().config.dataDir)).toBe(true)
    const args = renderArgs('dir', 'out.mp4', { fps: 30, quality: 'standard', format: 'mp4', workers: 3 })
    expect(args.slice(args.indexOf('--workers'), args.indexOf('--workers') + 2)).toEqual(['--workers', '3'])
  })

  it('stays inside the render folder', () => {
    expect(fs.readdirSync(path.join(dir, 'assets')).every((f) => f.includes('~'))).toBe(true)
  })
})

