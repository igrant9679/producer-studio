// Full installer build: web → main/preload → tools → stage (server bundle, node_modules closure, web, tools) →
// electron-builder, through its API so scripts/release.mjs can lay the fuses and the signing settings from the
// environment over electron-builder.yml (docs/desktop.md, "Code signing"). Unsigned when nothing is set.
// Flags: --no-web (reuse apps/web/dist), --dir (unpacked build only, no installer), --download (CI: fetch tools).
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { releaseConfig } from './release.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const repo = path.resolve(root, '..', '..')
const win = process.platform === 'win32'
const args = process.argv.slice(2)
const run = (cmd, a, cwd, shell = false, env = process.env) => {
  const r = spawnSync(cmd, a, { cwd, stdio: 'inherit', shell, env })
  if (r.status !== 0) process.exit(r.status ?? 1)
}

let release
try {
  release = releaseConfig({ env: process.env, platform: 'win32' })
} catch (err) {
  console.error(`desktop build: ${err.message}`)
  process.exit(1)
}
for (const n of release.notes) console.log(`desktop build: ${n}`)
if (!args.includes('--no-web')) run(win ? 'npm.cmd' : 'npm', ['run', 'build', '-w', '@producer/web'], repo, win)
// build-info.json records whether this build is signed (the app offers update checks only then)
run(process.execPath, [path.join(root, 'scripts', 'build.mjs')], root, false, { ...process.env, PS_BUILD_SIGNED: release.signed ? '1' : '0' })
run(process.execPath, [path.join(root, 'scripts', 'fetch-tools.mjs'), ...(args.includes('--download') ? ['--download'] : [])], root)
run(process.execPath, [path.join(root, 'scripts', 'stage.mjs')], root)
// electron-builder is hoisted to the repo root; `config` is merged over electron-builder.yml, which it still loads
const builder = createRequire(path.join(repo, 'package.json'))('electron-builder')
await builder.build({ projectDir: root, config: release.config, win: args.includes('--dir') ? ['dir'] : release.targets, publish: 'never' })
