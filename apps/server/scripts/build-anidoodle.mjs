// Bundles the vendored anidoodle modules (vendor/anidoodle/src, Apache-2.0) into vendor/anidoodle/anidoodle.js: one
// browser script, no imports, that the AI-drawing sandbox loads as `window.anidoodle`. The bundle is committed, so
// neither the server nor the desktop app needs esbuild at run time; a test checks it matches the sources.
//   node apps/server/scripts/build-anidoodle.mjs            write the bundle
//   node apps/server/scripts/build-anidoodle.mjs --check    exit 1 when the committed bundle is stale
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'vendor', 'anidoodle')
const out = path.join(dir, 'anidoodle.js')

export async function bundleAnidoodle() {
  const r = await build({
    entryPoints: [path.join(dir, 'entry.ts')],
    bundle: true,
    write: false,
    format: 'iife',
    globalName: 'anidoodle',
    platform: 'browser',
    target: 'es2020',
    minify: true,
    legalComments: 'none',
    banner: { js: '/* anidoodle (github.com/alexgreensh/anidoodle), Copyright 2026 Alex Greenshpun, Apache License 2.0: see LICENSE and NOTICE beside this file. Bundled unmodified by scripts/build-anidoodle.mjs. */' },
    logLevel: 'warning',
  })
  return r.outputFiles[0].text.replace(/\r\n/g, '\n')
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const text = await bundleAnidoodle()
  if (process.argv.includes('--check')) {
    const cur = fs.existsSync(out) ? fs.readFileSync(out, 'utf8').replace(/\r\n/g, '\n') : ''
    if (cur !== text) {
      console.error('vendor/anidoodle/anidoodle.js is out of date: run node apps/server/scripts/build-anidoodle.mjs')
      process.exit(1)
    }
    console.log('anidoodle.js is up to date')
  } else {
    fs.writeFileSync(out, text)
    console.log(`wrote ${path.relative(process.cwd(), out)} (${(text.length / 1024).toFixed(1)} KB)`)
  }
}
