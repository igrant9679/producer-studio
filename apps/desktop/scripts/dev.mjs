// Dev: build the web app (skip with --no-web), build main/preload, and run Electron against the TypeScript server
// (apps/server/src via tsx, Electron's Node). User data goes to the normal Producer Studio userData folder unless
// PS_USER_DATA is set (handy for a throwaway profile).
import { spawn, spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const repo = path.resolve(root, '..', '..')
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const run = (cmd, args, cwd, shell = false) => {
  const r = spawnSync(cmd, args, { cwd, stdio: 'inherit', shell })
  if (r.status !== 0) process.exit(r.status ?? 1)
}

if (!process.argv.includes('--no-web')) run(npm, ['run', 'build', '-w', '@producer/web'], repo, process.platform === 'win32')
run(process.execPath, [path.join(root, 'scripts', 'build.mjs')], root)

const electron = createRequire(import.meta.url)('electron')
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
const child = spawn(electron, ['.'], { cwd: root, stdio: 'inherit', env })
child.on('exit', (code) => process.exit(code ?? 0))
