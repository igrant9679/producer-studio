// A stand-in background removal tool for tests (BG_REMOVAL_CMD): keys out pure green with ffmpeg. Arguments:
// <ffmpeg> <in> <out folder> [frames|webm|fail]. `frames` writes one PNG per frame, `webm` writes out.webm with alpha.
import { spawnSync } from 'node:child_process'
import path from 'node:path'

const [ffmpeg, input, out, mode = 'frames'] = process.argv.slice(2)
if (mode === 'fail') {
  process.stderr.write('no model loaded\n')
  process.exit(3)
}
const key = ['-vf', 'colorkey=0x00ff00:0.3:0.05,format=rgba']
const args =
  mode === 'webm'
    ? ['-y', '-i', input, ...key, '-an', '-c:v', 'libvpx-vp9', '-pix_fmt', 'yuva420p', '-b:v', '0', '-crf', '30', '-deadline', 'realtime', '-cpu-used', '8', '-auto-alt-ref', '0', path.join(out, 'out.webm')]
    : ['-y', '-i', input, ...key, path.join(out, 'mask_%d.png')]
const r = spawnSync(ffmpeg, args, { stdio: ['ignore', 'ignore', 'pipe'] })
if (r.status !== 0) {
  process.stderr.write(String(r.stderr))
  process.exit(r.status ?? 1)
}
