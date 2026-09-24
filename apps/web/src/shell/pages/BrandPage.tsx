import type { BrandKitDoc, TextStyle } from '@producer/core'
import { CAPTION_PRESETS, FONTS } from '@producer/core'
import clsx from 'clsx'
import { ImagePlus, Palette, Plus, RotateCcw, Save, Trash2, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { api, mediaUrl } from '../../lib/api'
import { useSession } from '../../lib/session'
import { toast, toastError } from '../../lib/toast'
import { PlaySample, useVoices } from '../components/VoiceCard'
import { Spinner, useFilePicker, usePageTitle } from '../ui'

const EMPTY: BrandKitDoc = { name: '', colors: ['#ff5a5f', '#35e0ff', '#0c0e14'], fonts: { headline: 'Space Grotesk', body: 'Inter' } }

function captionCss(st: TextStyle, scale: number): React.CSSProperties {
  return {
    fontFamily: `'${st.fontFamily}', sans-serif`,
    fontWeight: st.fontWeight,
    fontStyle: st.italic ? 'italic' : undefined,
    textTransform: st.uppercase ? 'uppercase' : undefined,
    fontSize: st.fontSize * scale,
    color: st.color,
    letterSpacing: st.letterSpacing * scale,
    WebkitTextStroke: st.stroke ? `${Math.max(1, st.stroke.width * scale * 0.5)}px ${st.stroke.color}` : undefined,
    paintOrder: 'stroke fill',
    textShadow: st.shadow ? `${st.shadow.x * scale}px ${st.shadow.y * scale}px ${st.shadow.blur * scale}px ${st.shadow.color}` : st.glow ? `0 0 ${st.glow.blur * scale}px ${st.glow.color}` : undefined,
    background: st.background ? `color-mix(in srgb, ${st.background.color} ${Math.round(st.background.opacity * 100)}%, transparent)` : undefined,
    padding: st.background ? `${st.background.padding * scale * 0.6}px ${st.background.padding * scale}px` : undefined,
    borderRadius: st.background ? st.background.radius * scale : undefined,
  }
}

function isHex(v: string) {
  return /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(v)
}

/** Relative luminance 0..1 of a #rgb / #rrggbb colour. */
function luminance(hex: string): number {
  let h = hex.replace('#', '')
  if (h.length === 3) h = h.split('').map((c) => c + c).join('')
  const [r, g, b] = [0, 2, 4].map((i) => {
    const c = parseInt(h.slice(i, i + 2), 16) / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

export default function BrandPage() {
  usePageTitle('Brand kit')
  const workspaceId = useSession((s) => s.workspaceId)
  const ws = useSession((s) => s.workspaces.find((w) => w.id === s.workspaceId))
  const voices = useVoices()
  const [doc, setDoc] = useState<BrandKitDoc>()
  const [saved, setSaved] = useState<BrandKitDoc>()
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [logoBusy, setLogoBusy] = useState(0)
  const [logoErr, setLogoErr] = useState(false)
  const canEdit = ws?.role !== 'viewer'

  useEffect(() => {
    if (!workspaceId) return
    let alive = true
    setLoading(true)
    api
      .brand(workspaceId)
      .then((b) => {
        if (!alive) return
        const d = { ...EMPTY, ...b, fonts: { ...EMPTY.fonts, ...(b?.fonts ?? {}) }, colors: b?.colors ?? EMPTY.colors }
        setDoc(d)
        setSaved(d)
      })
      .catch(() => {
        if (!alive) return
        setDoc({ ...EMPTY, name: ws?.name ?? '' })
        setSaved(undefined)
      })
      .finally(() => alive && setLoading(false))
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId])

  const pickLogo = useFilePicker('image/png,image/svg+xml,image/jpeg,image/webp', false, async ([file]) => {
    if (!workspaceId || !file) return
    setLogoBusy(0.01)
    try {
      const rec = await api.upload(workspaceId, file, (f) => setLogoBusy(Math.max(0.01, f)))
      setLogoErr(false)
      setDoc((d) => d && { ...d, logoAssetId: rec.asset.id })
    } catch (e) {
      toastError(e)
    } finally {
      setLogoBusy(0)
    }
  })

  if (loading || !doc) {
    return (
      <div className="ps-page">
        <div className="skeleton" style={{ height: 50, width: 300 }} />
        <div className="ps-brand" style={{ marginTop: 26 }}>
          <div className="skeleton" style={{ height: 560, borderRadius: 16 }} />
          <div className="skeleton" style={{ height: 380, borderRadius: 16 }} />
        </div>
      </div>
    )
  }

  const set = (p: Partial<BrandKitDoc>) => setDoc((d) => d && { ...d, ...p })
  const dirty = JSON.stringify(doc) !== JSON.stringify(saved)
  const primary = doc.colors[0] ?? '#ff5a5f'
  const secondary = doc.colors[1] ?? '#35e0ff'
  // Darkest brand colour (if dark enough) becomes the preview ground.
  const darkest = doc.colors.filter(isHex).sort((a, b) => luminance(a) - luminance(b))[0]
  const ground = darkest && luminance(darkest) < 0.12 ? darkest : '#0c0e14'
  const cap = CAPTION_PRESETS.find((c) => c.id === (doc.captionPreset ?? 'clean')) ?? CAPTION_PRESETS[0]

  async function save() {
    if (!workspaceId || !doc) return
    setSaving(true)
    try {
      const out = await api.saveBrand(workspaceId, { ...doc, colors: doc.colors.filter(isHex) })
      setDoc(out)
      setSaved(out)
      toast('Brand kit saved')
    } catch (e) {
      toastError(e)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="ps-page">
      <div className="ps-page-head">
        <div>
          <span className="eyebrow">{ws?.name}</span>
          <h1>Brand kit</h1>
          <p>Colours, fonts, logo and defaults used by Producer AI and offered in the editor for every project in this space.</p>
        </div>
        <span className="spacer" />
        {dirty && <button className="btn ghost" onClick={() => saved && setDoc(saved)} disabled={!saved}><RotateCcw size={14} /> Discard</button>}
        <button className="btn primary" onClick={save} disabled={!dirty || saving || !canEdit}>{saving ? <Spinner /> : <Save size={15} />} {dirty ? 'Save changes' : 'Saved'}</button>
      </div>
      {!canEdit && <div className="ps-alert info" style={{ marginBottom: 18 }}>You have view-only access to this space’s brand kit.</div>}

      <div className="ps-brand">
        <div className="ps-brand-form">
          <section className="card ps-brand-sec">
            <label className="label" htmlFor="brand-name">Brand name</label>
            <input id="brand-name" className="input" value={doc.name} onChange={(e) => set({ name: e.target.value })} placeholder="e.g. Northwind" disabled={!canEdit} />
          </section>

          <section className="card ps-brand-sec">
            <div className="ps-brand-sec-head"><Palette size={15} /> <strong>Colour palette</strong><span className="muted">First colour is your primary accent</span></div>
            <div className="ps-swatches">
              {doc.colors.map((c, i) => (
                <div key={i} className="ps-swatch">
                  <label className="ps-swatch-chip" style={{ background: isHex(c) ? c : 'transparent' }} title="Pick a colour">
                    <input type="color" value={isHex(c) && c.length === 7 ? c : '#000000'} onChange={(e) => set({ colors: doc.colors.map((x, j) => (j === i ? e.target.value : x)) })} disabled={!canEdit} aria-label={`Colour ${i + 1}`} />
                  </label>
                  <input className={clsx('input ps-swatch-hex', !isHex(c) && 'bad')} value={c} onChange={(e) => set({ colors: doc.colors.map((x, j) => (j === i ? e.target.value.trim() : x)) })} disabled={!canEdit} aria-label={`Hex for colour ${i + 1}`} spellCheck={false} />
                  {i === 0 && <span className="ps-swatch-tag">Primary</span>}
                  <button className="btn ghost sm icon" onClick={() => set({ colors: doc.colors.filter((_, j) => j !== i) })} disabled={!canEdit || doc.colors.length <= 1} aria-label={`Remove colour ${c}`}><X size={13} /></button>
                </div>
              ))}
              {doc.colors.length < 10 && (
                <button className="ps-swatch-add" onClick={() => set({ colors: [...doc.colors, '#ffffff'] })} disabled={!canEdit}><Plus size={14} /> Add colour</button>
              )}
            </div>
          </section>

          <section className="card ps-brand-sec">
            <div className="ps-brand-sec-head"><strong>Fonts</strong></div>
            <div className="ps-font-grid">
              {(['headline', 'body'] as const).map((k) => (
                <div key={k}>
                  <label className="label" htmlFor={`font-${k}`}>{k === 'headline' ? 'Headline font' : 'Body font'}</label>
                  <select id={`font-${k}`} className="input" value={doc.fonts[k]} onChange={(e) => set({ fonts: { ...doc.fonts, [k]: e.target.value } })} style={{ fontFamily: `'${doc.fonts[k]}'` }} disabled={!canEdit}>
                    {FONTS.map((f) => <option key={f} value={f} style={{ fontFamily: `'${f}'` }}>{f}</option>)}
                  </select>
                  <div className="ps-font-sample" style={{ fontFamily: `'${doc.fonts[k]}', sans-serif`, fontWeight: k === 'headline' ? 700 : 400, fontSize: k === 'headline' ? 26 : 15 }}>
                    {k === 'headline' ? 'Built for teams' : 'The quick brown fox jumps over the lazy dog.'}
                  </div>
                </div>
              ))}
            </div>
          </section>

          <section className="card ps-brand-sec">
            <div className="ps-brand-sec-head"><strong>Logo</strong><span className="muted">PNG or SVG with a transparent background works best</span></div>
            <div className="row" style={{ gap: 16 }}>
              <div className="ps-logo-box">
                {logoBusy ? <Spinner /> : doc.logoAssetId && !logoErr ? <img src={mediaUrl(doc.logoAssetId, 'source')} alt="Logo" onError={() => setLogoErr(true)} /> : <ImagePlus size={22} />}
              </div>
              <div className="row">
                <button className="btn" onClick={pickLogo} disabled={!canEdit || !!logoBusy}><ImagePlus size={14} /> {doc.logoAssetId ? 'Replace logo' : 'Upload logo'}</button>
                {doc.logoAssetId && <button className="btn ghost" onClick={() => set({ logoAssetId: undefined })} disabled={!canEdit}><Trash2 size={14} /> Remove</button>}
              </div>
            </div>
          </section>

          <section className="card ps-brand-sec">
            <div className="ps-brand-sec-head"><strong>Default caption style</strong></div>
            <div className="ps-cap-grid">
              {CAPTION_PRESETS.map((c) => (
                <button key={c.id} className={clsx('ps-cap', (doc.captionPreset ?? 'clean') === c.id && 'on')} onClick={() => set({ captionPreset: c.id })} disabled={!canEdit}>
                  <span className="ps-cap-stage"><span style={captionCss(c.caption.style, 0.3)}>{c.caption.mode === 'word' ? 'WOW' : 'Hello there'}</span></span>
                  <span>{c.name}</span>
                </button>
              ))}
            </div>
          </section>

          <section className="card ps-brand-sec">
            <div className="ps-brand-sec-head"><strong>Default narration voice</strong><span className="muted">Used by Producer AI and Voice Studio</span></div>
            <div className="row">
              <select className="input" value={doc.voice ?? ''} onChange={(e) => set({ voice: e.target.value || undefined })} disabled={!canEdit} aria-label="Default voice">
                <option value="">No default</option>
                {voices.map((v) => <option key={v.id} value={v.id}>{v.name} — {v.lang.replace(' English', '')} · {v.style}</option>)}
              </select>
              {doc.voice && <PlaySample voiceId={doc.voice} size="md" />}
            </div>
          </section>
        </div>

        <aside className="ps-brand-preview">
          <span className="eyebrow">Live preview</span>
          <div className="ps-bp-frame" style={{ background: `radial-gradient(120% 90% at 85% 10%, ${secondary}40, transparent 55%), radial-gradient(90% 80% at 0% 100%, ${primary}55, transparent 60%), ${ground}` }}>
            <div className="ps-bp-top">
              {doc.logoAssetId && !logoErr ? <img src={mediaUrl(doc.logoAssetId, 'source')} alt="" onError={() => setLogoErr(true)} /> : <span className="ps-bp-mark" style={{ background: primary }}>{(doc.name || 'B').slice(0, 1).toUpperCase()}</span>}
              <span style={{ fontFamily: `'${doc.fonts.body}', sans-serif`, fontWeight: 600 }}>{doc.name || 'Your brand'}</span>
            </div>
            <div className="ps-bp-copy">
              <span className="ps-bp-kicker" style={{ background: primary }}>New</span>
              <h3 style={{ fontFamily: `'${doc.fonts.headline}', sans-serif` }}>Ship your story faster</h3>
              <p style={{ fontFamily: `'${doc.fonts.body}', sans-serif` }}>Recordings become on-brand videos in minutes.</p>
            </div>
            <div className="ps-bp-caption"><span style={captionCss(cap.caption.style, 0.22)}>{cap.caption.mode === 'word' ? 'MINUTES' : 'and it takes just minutes'}</span></div>
          </div>
          <div className="ps-bp-swatches">
            {doc.colors.filter(isHex).map((c, i) => <span key={i} style={{ background: c }} title={c} />)}
          </div>
          <div className="muted" style={{ fontSize: 12, marginTop: 10 }}>
            {doc.fonts.headline} / {doc.fonts.body} · {cap.name} captions{doc.voice ? ` · ${voices.find((v) => v.id === doc.voice)?.name ?? doc.voice} voice` : ''}
          </div>
        </aside>
      </div>
    </div>
  )
}
