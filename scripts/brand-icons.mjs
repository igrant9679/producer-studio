// Generates every Producer Studio icon from the master mark (apps/web/public/favicon.svg, "Track play"):
// web favicons + PWA icons, and the Windows app/installer icon for the desktop build.
// Run: node scripts/brand-icons.mjs
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const pub = path.join(repo, 'apps', 'web', 'public')
const iconsDir = path.join(pub, 'icons')
const deskAssets = path.join(repo, 'apps', 'desktop', 'assets')
fs.mkdirSync(iconsDir, { recursive: true })
fs.mkdirSync(deskAssets, { recursive: true })

const master = fs.readFileSync(path.join(pub, 'favicon.svg'), 'utf8')
const BARS = '<rect x="17" y="17" width="16" height="8" rx="4" fill="#ff5a5f"/><rect x="17" y="28" width="30" height="8" rx="4" fill="#7c5cff"/><rect x="17" y="39" width="16" height="8" rx="4" fill="#35e0ff"/>'
// Maskable (Android adaptive): full-bleed ground, mark inside the 80 % safe zone.
const maskable = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" fill="#0c0e14"/><g transform="translate(32 32) scale(0.8) translate(-32 -32)">${BARS}</g></svg>`
// Opaque square (iOS rounds it itself).
const apple = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" fill="#0c0e14"/>${BARS}</svg>`

const png = (svg, size) => sharp(Buffer.from(svg), { density: Math.max(72, (size / 64) * 72 * 2) }).resize(size, size).png({ compressionLevel: 9 }).toBuffer()

/** ICO container with PNG-encoded entries (supported by Windows Vista+ and every browser). */
function ico(entries) {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(entries.length, 4)
  const dir = Buffer.alloc(16 * entries.length)
  let offset = 6 + dir.length
  entries.forEach(({ size, data }, i) => {
    const o = i * 16
    dir.writeUInt8(size >= 256 ? 0 : size, o)
    dir.writeUInt8(size >= 256 ? 0 : size, o + 1)
    dir.writeUInt8(0, o + 2)
    dir.writeUInt8(0, o + 3)
    dir.writeUInt16LE(1, o + 4)
    dir.writeUInt16LE(32, o + 6)
    dir.writeUInt32LE(data.length, o + 8)
    dir.writeUInt32LE(offset, o + 12)
    offset += data.length
  })
  return Buffer.concat([header, dir, ...entries.map((e) => e.data)])
}

const out = []
const write = (file, buf) => {
  fs.writeFileSync(file, buf)
  out.push(`${path.relative(repo, file)} (${buf.length} B)`)
}

// web
const webIco = await Promise.all([16, 32, 48].map(async (size) => ({ size, data: await png(master, size) })))
write(path.join(pub, 'favicon.ico'), ico(webIco))
for (const size of [32, 192, 512]) write(path.join(iconsDir, `icon-${size}.png`), await png(master, size))
write(path.join(iconsDir, 'maskable-512.png'), await png(maskable, 512))
write(path.join(iconsDir, 'apple-touch-icon.png'), await png(apple, 180))
write(
  path.join(pub, 'site.webmanifest'),
  Buffer.from(
    JSON.stringify(
      {
        name: 'Producer Studio',
        short_name: 'Producer',
        start_url: '/',
        display: 'standalone',
        background_color: '#0c0e14',
        theme_color: '#0c0e14',
        icons: [
          { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: '/icons/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      null,
      2,
    ) + '\n',
  ),
)

// desktop (window, taskbar, installer, shortcuts)
write(path.join(deskAssets, 'icon.png'), await png(master, 1024))
const deskIco = await Promise.all([16, 20, 24, 32, 40, 48, 64, 128, 256].map(async (size) => ({ size, data: await png(master, size) })))
write(path.join(deskAssets, 'icon.ico'), ico(deskIco))

console.log(out.join('\n'))
