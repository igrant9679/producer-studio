// Builds vendor/peeps/peeps.json, the Open Peeps character art the drawing sandbox's rigged 2D characters are drawn
// from (sandbox/peeps.js), out of react-peeps' source (github.com/CeamKrier/react-peeps, MIT), which holds Pablo
// Stanley's Open Peeps drawings (openpeeps.com, CC0) as React components.
//
//   node scripts/build-peeps.mjs <path to react-peeps/src/peeps>          writes vendor/peeps/peeps.json
//   node scripts/build-peeps.mjs <path> --check                           exits 1 if the file differs
//
// The art is simple: groups translated by (x y) holding paths filled with the stroke colour ("ink"), the background
// colour ("paper") or a literal colour. Each part becomes a list of { d, fill, rule?, x, y } (x, y: the summed
// translation), drawn with Path2D. Head parts get their place on the head from react-peeps' head layout; every part
// also gets a rough bounding box, measured from the path's absolute coordinates (the rig's pivots and placing use it).
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const OUT = path.join(here, '..', 'vendor', 'peeps', 'peeps.json')

/** Where react-peeps' Head puts each head part (src/peeps/head/index.tsx: translate(225 0) and the inner groups). */
const HEAD = { hair: [225, 0], face: [225 + 159, 186], facialHair: [225 + 123, 338], accessories: [225 + 47, 241] }

function parsePart(src) {
  const out = []
  const stack = [[0, 0]]
  const re = /<g\b([^>]*)>|<\/g>|<path\b([\s\S]*?)\/>/g
  let m
  while ((m = re.exec(src))) {
    if (m[0].startsWith('</g')) {
      if (stack.length > 1) stack.pop()
      continue
    }
    if (m[0].startsWith('<g')) {
      const tr = /transform=['"]translate\(\s*(-?[\d.]+)[\s,]+(-?[\d.]+)\s*\)['"]/.exec(m[1] || '')
      const top = stack[stack.length - 1]
      stack.push(tr ? [top[0] + Number(tr[1]), top[1] + Number(tr[2])] : top)
      continue
    }
    const attrs = m[2]
    const d = /\bd=['"]([^'"]+)['"]/.exec(attrs)?.[1]
    if (!d) continue
    let fill = 'ink'
    const f = /\bfill=(?:\{([^}]*)\}|['"]([^'"]*)['"])/.exec(attrs)
    if (f) {
      if (f[1] !== undefined) fill = /background/i.test(f[1]) ? 'paper' : 'ink'
      else fill = f[2]
    }
    if (fill === 'none') continue
    const rule = /fillRule=['"]evenodd['"]/.test(attrs) ? 'evenodd' : undefined
    const [x, y] = stack[stack.length - 1]
    out.push({ d: d.replace(/\s+/g, ' ').trim(), fill, ...(rule ? { rule } : {}), x, y })
  }
  return out
}

/** The points of an SVG path (end and control points, absolute and relative commands): its box contains the shape. */
export function pathPoints(d) {
  const toks = d.match(/[a-zA-Z]|-?(?:\d+\.?\d*|\.\d+)(?:e-?\d+)?/g) ?? []
  const pts = []
  let i = 0
  let cmd = ''
  let cx = 0
  let cy = 0
  let sx = 0
  let sy = 0
  const num = () => Number(toks[i++])
  const ARGS = { m: 2, l: 2, h: 1, v: 1, c: 6, s: 4, q: 4, t: 2, a: 7, z: 0 }
  while (i < toks.length) {
    if (/[a-zA-Z]/.test(toks[i])) cmd = toks[i++]
    const lower = cmd.toLowerCase()
    const rel = cmd !== cmd.toUpperCase()
    if (lower === 'z') {
      cx = sx
      cy = sy
      continue
    }
    if (!(lower in ARGS) || i + ARGS[lower] > toks.length) break
    const ox = rel ? cx : 0
    const oy = rel ? cy : 0
    if (lower === 'h') cx = num() + (rel ? cx : 0)
    else if (lower === 'v') cy = num() + (rel ? cy : 0)
    else if (lower === 'a') {
      i += 5
      cx = num() + ox
      cy = num() + oy
    } else {
      const n = ARGS[lower]
      for (let k = 0; k < n; k += 2) {
        const x = num() + ox
        const y = num() + oy
        pts.push([x, y])
        if (k === n - 2) {
          cx = x
          cy = y
        }
      }
    }
    pts.push([cx, cy])
    if (lower === 'm') {
      sx = cx
      sy = cy
      // a moveto's further pairs are linetos
      cmd = rel ? 'l' : 'L'
    }
  }
  return pts
}

/** The box of a part's paths (the rig's pivots and placing use it). */
function box(paths) {
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -Infinity
  let y1 = -Infinity
  for (const p of paths) {
    for (const [px, py] of pathPoints(p.d)) {
      x0 = Math.min(x0, px + p.x)
      y0 = Math.min(y0, py + p.y)
      x1 = Math.max(x1, px + p.x)
      y1 = Math.max(y1, py + p.y)
    }
  }
  const r = (v) => Math.round(v)
  return Number.isFinite(x0) ? [r(x0), r(y0), r(x1), r(y1)] : [0, 0, 0, 0]
}

/** A body's collar: the middle of its topmost points (where the neck meets the clothes; the head goes above it). */
function collar(paths) {
  const pts = []
  for (const p of paths) for (const [px, py] of pathPoints(p.d)) pts.push([px + p.x, py + p.y])
  const top = Math.min(...pts.map((q) => q[1]))
  const near = pts.filter((q) => q[1] <= top + 60)
  const x = near.reduce((n, q) => n + q[0], 0) / near.length
  return [Math.round(x), Math.round(top)]
}

function readDir(dir, offset = [0, 0], isBody = false) {
  const out = {}
  for (const f of fs.readdirSync(dir).sort()) {
    // Bike: a bicycle drawn into the pose, and its handlebar sits where shoulders would (the head can't be placed)
    if (!f.endsWith('.tsx') || f === 'index.tsx' || f === 'z_options.tsx' || f === 'Bike.tsx') continue
    const paths = parsePart(fs.readFileSync(path.join(dir, f), 'utf8')).map((p) => ({ ...p, x: p.x + offset[0], y: p.y + offset[1] }))
    if (paths.length) out[f.replace(/\.tsx$/, '')] = { box: box(paths), ...(isBody ? { collar: collar(paths) } : {}), paths }
  }
  return out
}

export function buildPeeps(src) {
  const data = {
    source: 'Open Peeps by Pablo Stanley (openpeeps.com, CC0), from react-peeps (github.com/CeamKrier/react-peeps, MIT)',
    // the canvas react-peeps draws a standing person on (feet at the bottom)
    frame: [850, 1200],
    face: readDir(path.join(src, 'face'), HEAD.face),
    hair: readDir(path.join(src, 'hair'), HEAD.hair),
    facialHair: readDir(path.join(src, 'facialHair'), HEAD.facialHair),
    accessories: readDir(path.join(src, 'accessories'), HEAD.accessories),
    standing: readDir(path.join(src, 'pose', 'standing'), [0, 0], true),
    sitting: readDir(path.join(src, 'pose', 'sitting'), [0, 0], true),
    bust: readDir(path.join(src, 'pose', 'bust'), [0, 0], true),
  }
  return JSON.stringify(data)
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const src = process.argv[2]
  if (!src) {
    console.error('usage: node scripts/build-peeps.mjs <react-peeps/src/peeps> [--check]')
    process.exit(2)
  }
  const json = buildPeeps(src)
  if (process.argv.includes('--check')) {
    const same = fs.existsSync(OUT) && fs.readFileSync(OUT, 'utf8') === json
    console.log(same ? 'peeps.json is up to date' : 'peeps.json differs from the source')
    process.exit(same ? 0 : 1)
  }
  fs.mkdirSync(path.dirname(OUT), { recursive: true })
  fs.writeFileSync(OUT, json)
  const d = JSON.parse(json)
  console.log(`wrote ${OUT}: ${(json.length / 1024).toFixed(0)} KB;`, Object.entries(d).filter(([, v]) => v && typeof v === 'object' && !Array.isArray(v)).map(([k, v]) => `${k} ${Object.keys(v).length}`).join(', '))
}
