// A branded cover for an export (22 Nov 2026, the owner: branding is "the Narrative Text, Titles, Thumbnail, company
// stamp/logo"): the cover frame the export picked, with a soft dark fade at the bottom, the title in the brand's
// headline font over an accent bar, and the brand's logo (or its name, while the kit has none) in the top-right corner.
// Drawn at 1280×720-ish (the export's shape, 720 px on the short side) in the export's sandboxed browser
// (media/drawing.ts, which loads the brand's fonts), by fixed code rather than an AI. It becomes the export's thumbnail
// and share-page poster; a failure leaves the plain cover.
import fs from 'node:fs'
import path from 'node:path'
import type { BrandKitDoc } from '@producer/core'

export interface CoverOptions {
  title: string
  /** The brand's name, stamped while it has no logo. */
  name: string
  accent: string
}

/** The code that paints the cover: the frame as a cover-fit picture, the fade, the title and the stamp. */
export function coverCode(o: CoverOptions): string {
  return `const O = ${JSON.stringify(o)};
function draw(ctx, t, env) {
  const W = env.W, H = env.H, S = Math.min(W, H);
  const frame = env.image('frame');
  if (frame) {
    const k = Math.max(W / frame.width, H / frame.height);
    const w = frame.width * k, h = frame.height * k;
    ctx.drawImage(frame, (W - w) / 2, (H - h) / 2, w, h);
  }
  // a fade so white text reads on any picture
  const g = ctx.createLinearGradient(0, H * 0.45, 0, H);
  g.addColorStop(0, 'rgba(0,0,0,0)');
  g.addColorStop(1, 'rgba(0,0,0,0.78)');
  ctx.fillStyle = g;
  ctx.fillRect(0, H * 0.45, W, H * 0.55);
  // the title: the brand's headline font, as big as fits in two lines
  const left = W * 0.06, maxW = W * 0.84;
  let size = Math.round(Math.min(H * 0.12, W * 0.09)), lines = [];
  for (; size > S * 0.04; size = Math.round(size * 0.9)) {
    ctx.font = '900 ' + size + 'px "' + env.fonts.headline + '", sans-serif';
    lines = [];
    let line = '';
    for (const word of O.title.split(/\\s+/).filter(Boolean)) {
      const next = line ? line + ' ' + word : word;
      if (ctx.measureText(next).width > maxW && line) { lines.push(line); line = word; } else line = next;
    }
    if (line) lines.push(line);
    if (lines.length <= 2 && lines.every((l) => ctx.measureText(l).width <= maxW)) break;
  }
  const lh = size * 1.12;
  const bottom = H * 0.9;
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = '#ffffff';
  ctx.shadowColor = 'rgba(0,0,0,0.45)';
  ctx.shadowBlur = size * 0.18;
  lines.forEach((l, i) => ctx.fillText(l, left, bottom - (lines.length - 1 - i) * lh));
  ctx.shadowBlur = 0;
  // the accent bar over the title
  const barY = bottom - (lines.length - 1) * lh - size * 1.05;
  ctx.fillStyle = O.accent;
  ctx.fillRect(left, barY - S * 0.016, Math.max(W * 0.1, S * 0.12), S * 0.016);
  // the stamp, top right
  const m = S * 0.04;
  const logo = env.image('logo');
  if (logo) {
    const k = Math.min((S * 0.16) / logo.height, (W * 0.22) / logo.width);
    const w = logo.width * k, h = logo.height * k;
    ctx.drawImage(logo, W - m - w, m, w, h);
  } else if (O.name) {
    const fs = Math.round(S * 0.045);
    ctx.font = '700 ' + fs + 'px "' + env.fonts.headline + '", sans-serif';
    const w = ctx.measureText(O.name).width;
    ctx.fillStyle = 'rgba(0,0,0,0.45)';
    ctx.fillRect(W - m - w - fs * 0.6, m, w + fs * 1.2, fs * 1.6);
    ctx.fillStyle = '#ffffff';
    ctx.textBaseline = 'middle';
    ctx.fillText(O.name, W - m - w, m + fs * 0.8);
  }
}`
}

/** The cover's size: the export's shape at 720 px on its short side (even numbers). */
export function coverSize(width: number, height: number): { width: number; height: number } {
  const k = 720 / Math.min(width, height)
  const even = (v: number) => Math.max(2, Math.round((v * k) / 2) * 2)
  return { width: even(width), height: even(height) }
}

/** Test hook: what draws the cover (the real one is the sandboxed browser). */
export const COVER = {
  async paint(code: string, env: import('../media/drawing').DrawingEnv, signal?: AbortSignal): Promise<Buffer> {
    const { testDrawing } = await import('../media/drawing')
    return (await testDrawing(code, env, [0], signal))[0]
  },
}

/**
 * The branded cover as a JPEG at `out`: `frame` (a JPEG of the cover frame) with the title and the brand's stamp.
 * `logo` is the brand's logo as a file (any picture sharp reads); it is drawn from a PNG copy.
 */
export async function brandedCover(o: { frame: string; width: number; height: number; title: string; brand: Pick<BrandKitDoc, 'name' | 'colors' | 'fonts'>; logo?: string; out: string; signal?: AbortSignal }): Promise<void> {
  const sharp = (await import('sharp')).default
  const size = coverSize(o.width, o.height)
  const dataUrl = (buf: Buffer, mime: string) => `data:${mime};base64,${buf.toString('base64')}`
  const frame = await sharp(o.frame).resize(size.width, size.height, { fit: 'cover' }).jpeg({ quality: 90 }).toBuffer()
  const images: Record<string, string> = { frame: dataUrl(frame, 'image/jpeg') }
  if (o.logo && fs.existsSync(o.logo)) {
    try {
      images.logo = dataUrl(await sharp(o.logo).resize({ width: 600, height: 600, fit: 'inside', withoutEnlargement: true }).png().toBuffer(), 'image/png')
    } catch {
      // a logo sharp can't read: the brand's name is stamped instead
    }
  }
  const accent = o.brand.colors[1] ?? o.brand.colors[0] ?? '#ff5a5f'
  const code = coverCode({ title: o.title.trim().slice(0, 120), name: images.logo ? '' : o.brand.name, accent })
  const env = { width: size.width, height: size.height, duration: 0.1, fps: 10, words: [], palette: { canvas: '#000000', accent, ink: '#ffffff' }, fonts: { headline: o.brand.fonts.headline || 'Inter', body: o.brand.fonts.body || 'Inter' }, images }
  const png = await COVER.paint(code, env, o.signal)
  fs.mkdirSync(path.dirname(o.out), { recursive: true })
  await sharp(png).jpeg({ quality: 88 }).toFile(o.out)
}
