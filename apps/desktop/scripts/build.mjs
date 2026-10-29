// Build the Electron main process and preload (esbuild → CommonJS in dist/), plus the static splash page and
// build-info.json (the schema version the engine migrates to, whether the build is signed, the update feed).
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { buildInfo } from './release.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const repo = path.resolve(root, '..', '..')
const dist = path.join(root, 'dist')
fs.rmSync(dist, { recursive: true, force: true })
fs.mkdirSync(dist, { recursive: true })

const common = { bundle: true, platform: 'node', format: 'cjs', target: 'node22', external: ['electron'], logLevel: 'warning', sourcemap: false, legalComments: 'none' }
await build({ ...common, entryPoints: [path.join(root, 'src', 'main.ts')], outfile: path.join(dist, 'main.cjs') })
// sandboxed preload: may only require('electron'); everything else is inlined
await build({ ...common, entryPoints: [path.join(root, 'src', 'preload.ts')], outfile: path.join(dist, 'preload.cjs') })
fs.copyFileSync(path.join(root, 'src', 'splash.html'), path.join(dist, 'splash.html'))
const { version } = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
const info = buildInfo({ version, migrateSource: fs.readFileSync(path.join(repo, 'apps', 'server', 'src', 'db', 'migrate.ts'), 'utf8'), env: process.env })
fs.writeFileSync(path.join(dist, 'build-info.json'), JSON.stringify(info, null, 2))
console.log(`built apps/desktop/dist (main.cjs, preload.cjs, splash.html, build-info.json: schema ${info.schemaVersion ?? '?'}, ${info.signed ? 'signed' : 'unsigned'})`)
