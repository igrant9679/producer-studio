// Bundles three.js (MIT, the `three` dev dependency) with the two examples vendor/three/entry.js names into
// vendor/three/three.js: one browser script, no imports, that the AI-drawing sandbox loads as `window.THREE` for
// drawings that use 3D. The bundle is committed, so neither the server nor the desktop app needs three or esbuild at
// run time; a test checks it matches the installed version.
//   node apps/server/scripts/build-three.mjs            write the bundle
//   node apps/server/scripts/build-three.mjs --check    exit 1 when the committed bundle is stale
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'vendor', 'three')
const out = path.join(dir, 'three.js')

export async function bundleThree() {
  const pkg = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'node_modules', 'three', 'package.json')
  const version = JSON.parse(fs.readFileSync(pkg, 'utf8')).version
  const r = await build({
    entryPoints: [path.join(dir, 'entry.js')],
    bundle: true,
    write: false,
    format: 'iife',
    globalName: 'THREE',
    platform: 'browser',
    target: 'es2020',
    minify: true,
    legalComments: 'none',
    banner: { js: `/* three.js r${version.split('.')[1]} (threejs.org), Copyright 2010-2026 three.js authors, MIT License: see LICENSE beside this file. Bundled unmodified by scripts/build-three.mjs. */` },
    logLevel: 'warning',
  })
  return r.outputFiles[0].text.replace(/\r\n/g, '\n')
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const text = await bundleThree()
  if (process.argv.includes('--check')) {
    const cur = fs.existsSync(out) ? fs.readFileSync(out, 'utf8').replace(/\r\n/g, '\n') : ''
    if (cur !== text) {
      console.error('vendor/three/three.js is out of date: run node apps/server/scripts/build-three.mjs')
      process.exit(1)
    }
    console.log('three.js is up to date')
  } else {
    fs.writeFileSync(out, text)
    console.log(`wrote ${path.relative(process.cwd(), out)} (${(text.length / 1024).toFixed(1)} KB)`)
  }
}
