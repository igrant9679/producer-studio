// Renders a synthetic preview.png for each built-in look in apps/server/skill/templates from its template.json
// palette — a fictional "Lumen Analytics" frame (no real footage or data), laid out the way each look arranges
// its scenes. Run: node scripts/template-previews.mjs
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const dir = path.join(repo, 'apps', 'server', 'skill', 'templates')

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;')

/** A generic app window with chart placeholders, drawn at (x,y,w,h). */
function windowUi(x, y, w, h, accent, dark) {
  const bar = dark ? '#1c2233' : '#e6eaf0'
  const card = dark ? '#141a28' : '#ffffff'
  const line = dark ? '#2a3348' : '#d5dbe4'
  const s = w / 600
  const cols = [0, 1, 2]
    .map((i) => `<rect x="${x + (18 + i * 190) * s}" y="${y + 58 * s}" width="${172 * s}" height="${64 * s}" rx="${6 * s}" fill="${card}" stroke="${line}"/><rect x="${x + (30 + i * 190) * s}" y="${y + 72 * s}" width="${70 * s}" height="${7 * s}" rx="${3 * s}" fill="${line}"/><rect x="${x + (30 + i * 190) * s}" y="${y + 90 * s}" width="${(90 - i * 14) * s}" height="${16 * s}" rx="${4 * s}" fill="${i === 0 ? accent : line}"/>`)
    .join('')
  const bars = [62, 88, 46, 104, 74, 118, 92, 58]
    .map((v, i) => `<rect x="${x + (40 + i * 66) * s}" y="${y + (h / s - 26 - v) * s}" width="${34 * s}" height="${v * s}" rx="${4 * s}" fill="${i === 5 ? accent : line}"/>`)
    .join('')
  return `<g><rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${12 * s}" fill="${dark ? '#0f1420' : '#f7f9fc'}" stroke="${line}" stroke-width="${2 * s}"/>
<rect x="${x}" y="${y}" width="${w}" height="${36 * s}" rx="${12 * s}" fill="${bar}"/><rect x="${x}" y="${y + 24 * s}" width="${w}" height="${12 * s}" fill="${bar}"/>
<circle cx="${x + 18 * s}" cy="${y + 18 * s}" r="${5 * s}" fill="${line}"/><circle cx="${x + 34 * s}" cy="${y + 18 * s}" r="${5 * s}" fill="${line}"/><circle cx="${x + 50 * s}" cy="${y + 18 * s}" r="${5 * s}" fill="${line}"/>
${cols}<rect x="${x + 18 * s}" y="${y + 138 * s}" width="${w - 36 * s}" height="${h - 156 * s}" rx="${6 * s}" fill="${card}" stroke="${line}"/>${bars}</g>`
}

function headline(x, y, size, ink, accent, font, anchor = 'start', upper = false) {
  const a = upper ? 'CHARTS BECOME' : 'Charts become'
  const b = upper ? 'DASHBOARDS' : 'dashboards.'
  return `<text x="${x}" y="${y}" font-family="${font}, Montserrat, 'Segoe UI', Arial, sans-serif" font-weight="800" font-size="${size}" fill="${ink}" text-anchor="${anchor}" letter-spacing="-1">${esc(a)} <tspan fill="${accent}">${esc(b)}</tspan></text>`
}

function stat(x, y, value, label, ink, accent, mono, boxed, dark) {
  const box = boxed ? `<rect x="${x - 12}" y="${y - 34}" width="170" height="54" rx="8" fill="none" stroke="${accent}" stroke-width="2"/>` : ''
  return `${box}<text x="${x}" y="${y}" font-family="Montserrat, 'Segoe UI', Arial, sans-serif" font-weight="800" font-size="30" fill="${ink}">${value}</text><text x="${x}" y="${y + 16}" font-family="${mono}, Consolas, monospace" font-size="10" letter-spacing="1.5" fill="${dark ? '#8f98ad' : '#5b6474'}">${label}</text>`
}

function preview(t) {
  const { primary, accent, ink, headlineFont, labelFont } = t.brand
  const dark = t.canvas !== 'light'
  const vertical = t.aspect === '9:16'
  const W = vertical ? 450 : 800
  const H = vertical ? 800 : 450
  const eyebrow = (x, y) => `<text x="${x}" y="${y}" font-family="${labelFont}, Consolas, monospace" font-size="11" letter-spacing="2.5" fill="${accent}">06 · OPERATIONS OVERVIEW</text>`
  let body = ''
  switch (t.id) {
    case 'blueprint-grid': {
      const grid = Array.from({ length: 20 }, (_, i) => `<line x1="${i * 42}" y1="0" x2="${i * 42}" y2="${H}" stroke="#d6e0ec"/><line x1="0" y1="${i * 42}" x2="${W}" y2="${i * 42}" stroke="#d6e0ec"/>`).join('')
      body = `${grid}${eyebrow(40, 44)}${windowUi(40, 64, 470, 280, accent, false)}<line x1="510" y1="120" x2="560" y2="120" stroke="${accent}"/><circle cx="510" cy="120" r="4" fill="${accent}"/>${stat(580, 128, '4,200', 'ORDERS THIS WEEK', ink, accent, labelFont, true, false)}${stat(580, 208, '96%', 'ON TIME', ink, accent, labelFont, true, false)}${stat(580, 288, '31', 'OPEN RETURNS', ink, accent, labelFont, true, false)}${headline(40, 404, 40, ink, accent, headlineFont, 'start', true)}`
      break
    }
    case 'boardroom-slate':
      body = `${eyebrow(40, 60)}${stat(40, 140, '4,200', 'ORDERS THIS WEEK', ink, accent, labelFont, false, true)}${stat(40, 220, '96%', 'SHIPPED ON TIME', ink, accent, labelFont, false, true)}<text x="40" y="300" font-family="Montserrat, Arial" font-weight="800" font-size="30" fill="${accent}">31</text><text x="40" y="316" font-family="${labelFont}, Consolas" font-size="10" letter-spacing="1.5" fill="#8f98ad">OPEN RETURNS</text>${windowUi(300, 70, 460, 250, accent, true)}${headline(40, 404, 34, ink, accent, headlineFont)}`
      break
    case 'cinema-fullbleed':
      body = `${windowUi(0, 0, W, H, accent, true)}<rect width="${W}" height="${H}" fill="url(#scrim)"/>${headline(40, 356, 44, ink, accent, headlineFont)}<rect x="40" y="386" width="120" height="30" rx="4" fill="rgba(0,0,0,.5)" stroke="${accent}"/><text x="52" y="406" font-family="Montserrat, Arial" font-weight="700" font-size="14" fill="${ink}">4,200 orders</text><rect x="172" y="386" width="110" height="30" rx="4" fill="rgba(0,0,0,.5)" stroke="${accent}"/><text x="184" y="406" font-family="Montserrat, Arial" font-weight="700" font-size="14" fill="${ink}">96% on time</text>`
      break
    case 'editorial-light':
      body = `${eyebrow(40, 44)}<line x1="40" y1="56" x2="${W - 40}" y2="56" stroke="${ink}" stroke-width="2"/>${windowUi(40, 72, 480, 262, accent, false)}${stat(560, 120, '4,200', 'ORDERS THIS WEEK', ink, accent, labelFont, false, false)}${stat(560, 200, '96%', 'ON TIME', ink, accent, labelFont, false, false)}<rect x="548" y="250" width="190" height="4" fill="${accent}"/>${headline(40, 396, 38, ink, accent, headlineFont)}`
      break
    case 'minimal-mono':
      body = `<rect x="24" y="24" width="${W - 48}" height="${H - 48}" fill="none" stroke="#3a3a3a"/>${eyebrow(48, 58)}${windowUi(48, 76, 440, 230, '#ffffff', true)}${stat(530, 130, '4,200', 'ORDERS', ink, accent, labelFont, false, true)}${stat(530, 210, '96%', 'ON TIME', ink, accent, labelFont, false, true)}<text x="48" y="360" font-family="Oswald, Impact, 'Arial Narrow', sans-serif" font-weight="700" font-size="40" fill="${ink}" letter-spacing="1">CHARTS BECOME</text><rect x="44" y="370" width="236" height="50" fill="#ffffff"/><text x="52" y="410" font-family="Oswald, Impact, 'Arial Narrow', sans-serif" font-weight="700" font-size="40" fill="#0a0a0a" letter-spacing="1">DASHBOARDS</text>`
      break
    case 'social-vertical':
      body = `${eyebrow(32, 70)}${windowUi(32, 90, W - 64, 250, accent, true)}<text x="32" y="420" font-family="Montserrat, Arial" font-weight="800" font-size="46" fill="${ink}">Charts</text><text x="32" y="470" font-family="Montserrat, Arial" font-weight="800" font-size="46" fill="${ink}">become</text><text x="32" y="520" font-family="Montserrat, Arial" font-weight="800" font-size="46" fill="${accent}">dashboards.</text>${[['4,200', 'ORDERS THIS WEEK'], ['96%', 'SHIPPED ON TIME'], ['31', 'OPEN RETURNS']].map(([v, l], i) => `<rect x="32" y="${566 + i * 66}" width="${W - 64}" height="54" rx="10" fill="#141a28" stroke="#2a3348"/><text x="50" y="${601 + i * 66}" font-family="Montserrat, Arial" font-weight="800" font-size="26" fill="${i === 2 ? accent : ink}">${v}</text><text x="${W - 50}" y="${598 + i * 66}" text-anchor="end" font-family="${labelFont}, Consolas" font-size="10" letter-spacing="1.5" fill="#8f98ad">${l}</text>`).join('')}`
      break
    case 'sunrise-warm':
      body = `<circle cx="120" cy="60" r="260" fill="${accent}" opacity=".16"/><circle cx="720" cy="430" r="220" fill="#ff3d7f" opacity=".12"/>${eyebrow(40, 44)}${headline(40, 92, 36, ink, accent, headlineFont)}${windowUi(170, 116, 460, 250, accent, true)}${['4,200 orders', '96% on time', '31 open returns'].map((c, i) => `<rect x="${200 + i * 140}" y="386" width="128" height="32" rx="16" fill="rgba(255,255,255,.08)" stroke="${accent}"/><text x="${264 + i * 140}" y="407" text-anchor="middle" font-family="Montserrat, Arial" font-weight="700" font-size="13" fill="${ink}">${c}</text>`).join('')}`
      break
    default:
      // studio-dark (house look): framed window left, story column of cards right, headline band below
      body = `<circle cx="700" cy="-40" r="300" fill="${accent}" opacity=".14"/>${eyebrow(40, 44)}${windowUi(40, 60, 470, 280, accent, true)}${[['4,200', 'ORDERS THIS WEEK'], ['96%', 'SHIPPED ON TIME'], ['31', 'OPEN RETURNS']].map(([v, l], i) => `<rect x="540" y="${62 + i * 94}" width="220" height="80" rx="10" fill="#101a33" stroke="#23304f"/><text x="560" y="${104 + i * 94}" font-family="Montserrat, Arial" font-weight="800" font-size="30" fill="${i === 2 ? accent : ink}">${v}</text><text x="560" y="${124 + i * 94}" font-family="${labelFont}, Consolas" font-size="10" letter-spacing="1.5" fill="#8f98ad">${l}</text>`).join('')}${headline(40, 400, 40, ink, accent, headlineFont)}`
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"><defs><linearGradient id="scrim" x1="0" y1="0" x2="0" y2="1"><stop offset=".35" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity=".88"/></linearGradient></defs><rect width="${W}" height="${H}" fill="${primary}"/>${body}</svg>`
}

for (const id of fs.readdirSync(dir)) {
  const tj = path.join(dir, id, 'template.json')
  if (!fs.existsSync(tj)) continue
  const t = JSON.parse(fs.readFileSync(tj, 'utf8'))
  const out = path.join(dir, id, 'preview.png')
  await sharp(Buffer.from(preview(t)), { density: 144 }).png({ compressionLevel: 9 }).toFile(out)
  console.log(`${path.relative(repo, out)}`)
}
