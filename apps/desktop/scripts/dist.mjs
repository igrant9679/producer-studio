// Full installer build: web → main/preload → stage (server bundle, node_modules closure, web, tools) → NSIS.
// Flags: --no-web (reuse apps/web/dist), --dir (unpacked build only, no installer), --download (CI: fetch tools).
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const repo = path.resolve(root, '..', '..')
const win = process.platform === 'win32'
const args = process.argv.slice(2)
const run = (cmd, a, cwd, shell = false) => {
  const r = spawnSync(cmd, a, { cwd, stdio: 'inherit', shell, env: process.env })
  if (r.status !== 0) process.exit(r.status ?? 1)
}

if (!args.includes('--no-web')) run(win ? 'npm.cmd' : 'npm', ['run', 'build', '-w', '@producer/web'], repo, win)
run(process.execPath, [path.join(root, 'scripts', 'build.mjs')], root)
run(process.execPath, [path.join(root, 'scripts', 'fetch-tools.mjs'), ...(args.includes('--download') ? ['--download'] : [])], root)
run(process.execPath, [path.join(root, 'scripts', 'stage.mjs')], root)
const cli = path.join(repo, 'node_modules', 'electron-builder', 'cli.js')
run(process.execPath, [cli, '--config', 'electron-builder.yml', '--win', ...(args.includes('--dir') ? ['--dir'] : ['nsis']), '--publish', 'never'], root)
