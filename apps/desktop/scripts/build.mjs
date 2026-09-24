// Build the Electron main process and preload (esbuild → CommonJS in dist/), plus the static splash page.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const dist = path.join(root, 'dist')
fs.rmSync(dist, { recursive: true, force: true })
fs.mkdirSync(dist, { recursive: true })

const common = { bundle: true, platform: 'node', format: 'cjs', target: 'node22', external: ['electron'], logLevel: 'warning', sourcemap: false, legalComments: 'none' }
await build({ ...common, entryPoints: [path.join(root, 'src', 'main.ts')], outfile: path.join(dist, 'main.cjs') })
// sandboxed preload: may only require('electron'); everything else is inlined
await build({ ...common, entryPoints: [path.join(root, 'src', 'preload.ts')], outfile: path.join(dist, 'preload.cjs') })
fs.copyFileSync(path.join(root, 'src', 'splash.html'), path.join(dist, 'splash.html'))
console.log('built apps/desktop/dist (main.cjs, preload.cjs, splash.html)')
