import type { BrandFont, BrandKitDoc, BrandKitSummary, TextStyle } from '@producer/core'
import { CAPTION_PRESETS, DEFAULT_KIT_ID, FONTS, contrastPairs, isHexColour, relativeLuminance } from '@producer/core'
import clsx from 'clsx'
import { ImagePlus, Palette, Pipette, Plus, RotateCcw, Save, Star, Trash2, Type, Upload, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { api, mediaUrl } from '../../lib/api'
import { brandApi, familyFromFileName, registerBrandFonts, weightFromFileName } from '../../lib/brandApi'
import { useSession } from '../../lib/session'
import { toast, toastError } from '../../lib/toast'
import { PlaySample, useVoices } from '../components/VoiceCard'
import { ConfirmDialog, Modal, Spinner, useFilePicker, usePageTitle } from '../ui'
import './brand.css'

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

const isHex = isHexColour
const luminance = relativeLuminance

/**
 * Unsaved edits per person, space and kit, kept while they're elsewhere in the app (another page, another space or
 * kit): coming back brings them back instead of discarding them. In memory only, so a sign-out or reload never hands
 * them on.
 */
const drafts = new Map<string, BrandKitDoc>()
const draftKey = (userId: string, ws: string, kitId: string) => `${userId}|${ws}|${kitId}`

/** What the person asked for while edits were unsaved: it waits for Save, Discard or Cancel. */
interface Pending {
  label: string
  run: () => void | Promise<void>
}

function ContrastCheck({ colors }: { colors: string[] }) {
  const pairs = contrastPairs(colors).slice(0, 6)
  if (!pairs.length) return <p className="muted" style={{ fontSize: '0.8125rem', margin: 0 }}>Add at least two colours to check how readable text is on them.</p>
  return (
    <div className="ps-contrast" role="list" aria-label="Contrast of text colours on background colours">
      {pairs.map((p) => {
        const cls = p.grade === 'Fail' ? 'fail' : p.grade === 'AA large' ? 'large' : 'pass'
        const words = p.grade === 'Fail' ? 'too low for text' : p.grade === 'AA large' ? 'headlines and captions only' : p.grade === 'AA' ? 'body text' : 'any text'
        return (
          <div key={`${p.fg}-${p.bg}`} className="ps-contrast-row" role="listitem" aria-label={`${p.fg} on ${p.bg}: ${p.ratio} to 1, ${p.grade} (${words})`}>
            <span className="ps-contrast-sample" style={{ background: p.bg, color: p.fg }} aria-hidden>Aa</span>
            <span className="ps-contrast-hex">{p.fg} on {p.bg}</span>
            <span className="ps-contrast-ratio muted">{p.ratio.toFixed(2)}:1</span>
            <span className={clsx('ps-grade', cls)} title={words}>{p.grade}</span>
          </div>
        )
      })}
    </div>
  )
}

export default function BrandPage() {
  usePageTitle('Brand kit')
  const workspaceId = useSession((s) => s.workspaceId)
  const userId = useSession((s) => s.user?.id ?? '')
  const ws = useSession((s) => s.workspaces.find((w) => w.id === s.workspaceId))
  const voices = useVoices()
  const [doc, setDoc] = useState<BrandKitDoc>()
  const [saved, setSaved] = useState<BrandKitDoc>()
  // the space and kit on screen (until a switch's new kit has loaded)
  const [kitSpace, setKitSpace] = useState<string>()
  const [loadedKit, setLoadedKit] = useState<string>(DEFAULT_KIT_ID)
  const [etag, setEtag] = useState<string>()
  // the kit picked, with the space it was picked in (another space starts on its default)
  const [pick, setPick] = useState<{ ws?: string; kitId: string }>({ kitId: DEFAULT_KIT_ID })
  const kitId = pick.ws === workspaceId ? pick.kitId : DEFAULT_KIT_ID
  const [kits, setKits] = useState<BrandKitSummary[]>()
  const [fonts, setFonts] = useState<BrandFont[]>([])
  const [restored, setRestored] = useState(false)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string>()
  const [attempt, setAttempt] = useState(0)
  const [saving, setSaving] = useState(false)
  const [logoBusy, setLogoBusy] = useState(0)
  const [logoErr, setLogoErr] = useState(false)
  const [suggest, setSuggest] = useState<string[]>()
  const [pulling, setPulling] = useState(false)
  const [fontBusy, setFontBusy] = useState(false)
  const [pending, setPending] = useState<Pending>()
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [kitBusy, setKitBusy] = useState(false)
  const canEdit = ws?.role !== 'viewer'

  // the space's kits and uploaded fonts
  useEffect(() => {
    if (!workspaceId) return
    let alive = true
    brandApi
      .kits(workspaceId)
      .then((l) => alive && setKits(l.items))
      // an older server keeps one kit: the default still works on its own
      .catch(() => alive && setKits(undefined))
    brandApi
      .fonts(workspaceId)
      .then((f) => {
        if (!alive || !Array.isArray(f)) return
        setFonts(f)
        void registerBrandFonts(f)
      })
      .catch(() => alive && setFonts([]))
    return () => {
      alive = false
    }
  }, [workspaceId])

  useEffect(() => {
    if (!workspaceId) return
    let alive = true
    setLoading(true)
    setLoadError(undefined)
    const load: Promise<{ doc: BrandKitDoc | undefined; etag?: string }> =
      kitId === DEFAULT_KIT_ID
        ? api.brand(workspaceId).then((b) => ({ doc: b }))
        : brandApi.kits(workspaceId).then((l) => {
            if (alive) setKits(l.items)
            const k = l.items.find((x) => x.id === kitId)
            if (!k) throw new Error('this kit was deleted')
            return { doc: k.doc, etag: k.etag }
          })
    load
      .then(({ doc: b, etag: tag }) => {
        if (!alive) return
        // a space without a kit gets the server's defaults here
        const d = { ...EMPTY, ...b, fonts: { ...EMPTY.fonts, ...(b?.fonts ?? {}) }, colors: b?.colors ?? EMPTY.colors }
        const draft = drafts.get(draftKey(userId, workspaceId, kitId))
        setDoc(draft ?? d)
        setSaved(d)
        setEtag(tag)
        setKitSpace(workspaceId)
        setLoadedKit(kitId)
        setRestored(!!draft)
        setSuggest(undefined)
      })
      .catch((e) => {
        if (!alive) return
        // never stand in defaults for a kit we couldn't read: saving them would replace the real one
        setDoc(undefined)
        setSaved(undefined)
        setKitSpace(undefined)
        setLoadError(e instanceof Error ? e.message : String(e))
      })
      .finally(() => alive && setLoading(false))
    return () => {
      alive = false
    }
  }, [workspaceId, kitId, attempt, userId])

  const dirty = !!doc && !!saved && JSON.stringify(doc) !== JSON.stringify(saved)
  // keep unsaved edits with the space and kit they were made in
  useEffect(() => {
    if (!kitSpace || !doc || !saved) return
    const key = draftKey(userId, kitSpace, loadedKit)
    if (dirty) drafts.set(key, doc)
    else drafts.delete(key)
  }, [doc, saved, dirty, kitSpace, loadedKit, userId])
  // closing or reloading the tab would lose them: the browser asks first
  useEffect(() => {
    if (!dirty) return
    const onUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault()
      e.returnValue = ''
    }
    window.addEventListener('beforeunload', onUnload)
    return () => window.removeEventListener('beforeunload', onUnload)
  }, [dirty])
  // a switch away with unsaved edits says they're kept, so nobody thinks they were lost
  const prevSpace = useRef(workspaceId)
  useEffect(() => {
    const was = prevSpace.current
    prevSpace.current = workspaceId
    if (!was || was === workspaceId || ![...drafts.keys()].some((k) => k.startsWith(`${userId}|${was}|`))) return
    const name = useSession.getState().workspaces.find((w) => w.id === was)?.name ?? 'the other space'
    toast(`Your unsaved brand kit changes for “${name}” are kept: they’re back when you return to it.`)
  }, [workspaceId, userId])

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

  const pickFont = useFilePicker('.woff2,.woff,.ttf,.otf,font/woff2,font/woff,font/ttf,font/otf', false, async ([file]) => {
    if (!workspaceId || !file) return
    setFontBusy(true)
    try {
      const family = familyFromFileName(file.name) || 'Brand font'
      const f = await brandApi.uploadFont(workspaceId, file, { family, weight: weightFromFileName(file.name), italic: /italic|oblique/i.test(file.name) })
      await registerBrandFonts([f])
      setFonts((cur) => [...cur.filter((x) => x.id !== f.id), f])
      toast(`“${f.family}” uploaded: pick it as the headline or body font`)
    } catch (e) {
      toastError(e)
    } finally {
      setFontBusy(false)
    }
  })

  /** Run `action` now, or (with unsaved edits) once the person has saved or discarded them. */
  function guard(label: string, run: () => void | Promise<void>) {
    if (dirty) setPending({ label, run })
    else void run()
  }

  const selectKit = (id: string) => {
    if (!workspaceId || id === kitId) return
    guard('switch kits', () => setPick({ ws: workspaceId, kitId: id }))
  }

  async function newKit() {
    if (!workspaceId) return
    setKitBusy(true)
    try {
      const k = await brandApi.createKit(workspaceId, { from: kitId })
      setKits((cur) => [...(cur ?? []), k])
      setPick({ ws: workspaceId, kitId: k.id })
      toast(`Made “${k.doc.name}”, a copy of this kit`)
    } catch (e) {
      toastError(e)
    } finally {
      setKitBusy(false)
    }
  }

  async function makeDefault() {
    if (!workspaceId || kitId === DEFAULT_KIT_ID) return
    setKitBusy(true)
    try {
      const l = await brandApi.makeDefault(workspaceId, kitId)
      setKits(l.items)
      setPick({ ws: workspaceId, kitId: DEFAULT_KIT_ID })
      setAttempt((n) => n + 1)
      toast(`“${l.items[0]?.doc.name}” is now the default kit: Producer AI, templates and new projects use it`)
    } catch (e) {
      toastError(e)
    } finally {
      setKitBusy(false)
    }
  }

  async function deleteKit() {
    if (!workspaceId || kitId === DEFAULT_KIT_ID) return
    setKitBusy(true)
    try {
      await brandApi.deleteKit(workspaceId, kitId)
      drafts.delete(draftKey(userId, workspaceId, kitId))
      setKits((cur) => cur?.filter((k) => k.id !== kitId))
      setConfirmDelete(false)
      setPick({ ws: workspaceId, kitId: DEFAULT_KIT_ID })
      toast('Brand kit deleted')
    } catch (e) {
      toastError(e)
    } finally {
      setKitBusy(false)
    }
  }

  async function pullColours() {
    if (!workspaceId || !doc?.logoAssetId) return
    setPulling(true)
    try {
      const r = await brandApi.palette(workspaceId, doc.logoAssetId)
      setSuggest(r.colors)
    } catch (e) {
      toastError(e)
    } finally {
      setPulling(false)
    }
  }

  async function removeFont(f: BrandFont) {
    if (!workspaceId) return
    try {
      await brandApi.deleteFont(workspaceId, f.id)
      setFonts((cur) => cur.filter((x) => x.id !== f.id))
    } catch (e) {
      toastError(e)
    }
  }

  const kitBar = kits && kits.length > 0 && (
    <div className="ps-kitbar" role="group" aria-label="Brand kits">
      <label className="label" htmlFor="brand-kit" style={{ margin: 0 }}>Kit</label>
      <select id="brand-kit" className="input" value={kitId} onChange={(e) => selectKit(e.target.value)} disabled={kitBusy}>
        {kits.map((k) => (
          <option key={k.id} value={k.id}>{k.doc.name || 'Untitled kit'}{k.default ? ' (default)' : ''}</option>
        ))}
      </select>
      {kitId === DEFAULT_KIT_ID ? <span className="ps-kit-default">Default kit</span> : null}
      <span className="spacer" />
      <button className="btn sm" onClick={() => guard('make a new kit', newKit)} disabled={!canEdit || kitBusy} title="A new kit, starting as a copy of this one"><Plus size={13} /> New kit</button>
      {kitId !== DEFAULT_KIT_ID && (
        <>
          <button className="btn sm" onClick={() => guard('make this the default kit', makeDefault)} disabled={!canEdit || kitBusy}><Star size={13} /> Make default</button>
          <button className="btn ghost sm" onClick={() => setConfirmDelete(true)} disabled={!canEdit || kitBusy}><Trash2 size={13} /> Delete kit</button>
        </>
      )}
    </div>
  )

  if (loadError && !loading) {
    return (
      <div className="ps-page">
        <div className="ps-page-head">
          <div>
            <span className="eyebrow">{ws?.name}</span>
            <h1>Brand kit</h1>
          </div>
        </div>
        <div className="ps-alert" role="alert" style={{ alignItems: 'center' }}>
          <span style={{ flex: 1 }}>Couldn’t load this space’s brand kit: {loadError}. Nothing was changed; try again before editing it.</span>
          <button className="btn sm" onClick={() => setAttempt((n) => n + 1)}><RotateCcw size={13} /> Retry</button>
          {kitId !== DEFAULT_KIT_ID && <button className="btn sm ghost" onClick={() => setPick({ ws: workspaceId, kitId: DEFAULT_KIT_ID })}>Open the default kit</button>}
        </div>
      </div>
    )
  }

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
  // a colour that isn't hex is said at the field, and holds Save, instead of being dropped on save without a word
  const badColour = doc.colors.findIndex((c) => !isHex(c))
  const primary = doc.colors[0] ?? '#ff5a5f'
  const secondary = doc.colors[1] ?? '#35e0ff'
  // Darkest brand colour (if dark enough) becomes the preview ground.
  const darkest = doc.colors.filter(isHex).sort((a, b) => luminance(a) - luminance(b))[0]
  const ground = darkest && luminance(darkest) < 0.12 ? darkest : '#0c0e14'
  const cap = CAPTION_PRESETS.find((c) => c.id === (doc.captionPreset ?? 'clean')) ?? CAPTION_PRESETS[0]
  const families = [...new Set(fonts.map((f) => f.family))].filter((f) => !(FONTS as readonly string[]).includes(f))
  const newColours = (suggest ?? []).filter((c) => !doc.colors.some((x) => x.toLowerCase() === c.toLowerCase()))

  async function save(): Promise<boolean> {
    // only ever over a kit that loaded
    if (!kitSpace || !doc || !saved || badColour >= 0) return false
    setSaving(true)
    try {
      let out: BrandKitDoc
      if (loadedKit === DEFAULT_KIT_ID) out = await api.saveBrand(kitSpace, doc)
      else {
        const k = await brandApi.saveKit(kitSpace, loadedKit, doc, etag)
        out = k.doc
        setEtag(k.etag)
        setKits((cur) => cur?.map((x) => (x.id === k.id ? k : x)))
      }
      setDoc(out)
      setSaved(out)
      setRestored(false)
      if (loadedKit === DEFAULT_KIT_ID) setKits((cur) => cur?.map((x) => (x.default ? { ...x, doc: out } : x)))
      toast('Brand kit saved')
      return true
    } catch (e) {
      toastError(e)
      return false
    } finally {
      setSaving(false)
    }
  }

  const discard = () => {
    if (saved) setDoc(saved)
    setRestored(false)
  }

  return (
    <div className="ps-page">
      <div className="ps-page-head">
        <div>
          <span className="eyebrow">{ws?.name}</span>
          <h1>Brand kit</h1>
          <p>Colours, fonts, logo and defaults used by Producer AI and offered in the editor for every project in this space. Keep a kit per brand or client; the default is used unless another is picked.</p>
        </div>
        <span className="spacer" />
        {dirty && <button className="btn ghost" onClick={discard} disabled={!saved}><RotateCcw size={14} /> Discard</button>}
        <button className="btn primary" onClick={() => void save()} disabled={!dirty || saving || !canEdit || !saved || badColour >= 0}>{saving ? <Spinner /> : <Save size={15} />} {dirty ? 'Save changes' : 'Saved'}</button>
      </div>
      {kitBar}
      {!canEdit && <div className="ps-alert info" style={{ marginBottom: 18 }}>You have view-only access to this space’s brand kit.</div>}
      {restored && dirty && <div className="ps-alert info" role="status" style={{ marginBottom: 18 }}>Your unsaved changes from earlier are back. Save them, or Discard to see the kit as saved.</div>}

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
                  <input className={clsx('input ps-swatch-hex', !isHex(c) && 'bad')} value={c} onChange={(e) => set({ colors: doc.colors.map((x, j) => (j === i ? e.target.value.trim() : x)) })} disabled={!canEdit} aria-label={`Hex for colour ${i + 1}`} aria-invalid={!isHex(c)} aria-describedby={!isHex(c) ? 'brand-colour-err' : undefined} spellCheck={false} />
                  {i === 0 && <span className="ps-swatch-tag">Primary</span>}
                  <button className="btn ghost sm icon" onClick={() => set({ colors: doc.colors.filter((_, j) => j !== i) })} disabled={!canEdit || doc.colors.length <= 1} aria-label={`Remove colour ${c}`}><X size={13} /></button>
                </div>
              ))}
              {doc.colors.length < 10 && (
                <button className="ps-swatch-add" onClick={() => set({ colors: [...doc.colors, '#ffffff'] })} disabled={!canEdit}><Plus size={14} /> Add colour</button>
              )}
            </div>
            {badColour >= 0 && (
              <div id="brand-colour-err" className="ps-field-err" role="alert" style={{ marginTop: 8 }}>
                Colour {badColour + 1} (“{doc.colors[badColour]}”) isn’t a hex colour. Use #RGB or #RRGGBB, e.g. #ff5a5f, or remove it.
              </div>
            )}
            <div className="row" style={{ marginTop: 12, gap: 8, flexWrap: 'wrap' }}>
              <button className="btn sm" onClick={() => void pullColours()} disabled={!canEdit || !doc.logoAssetId || pulling} title={doc.logoAssetId ? 'Find the main colours in the logo' : 'Upload a logo first'}>
                {pulling ? <Spinner size={13} /> : <Pipette size={13} />} Colours from the logo
              </button>
              {!doc.logoAssetId && <span className="muted" style={{ fontSize: '0.75rem' }}>Upload a logo below to pull its colours.</span>}
            </div>
            {suggest && (
              <div className="ps-suggest" role="group" aria-label="Colours found in the logo">
                <span className="muted" style={{ fontSize: '0.75rem' }}>In the logo:</span>
                {suggest.map((c) => <span key={c} className="ps-suggest-dot" style={{ background: c }} title={c} aria-label={c} role="img" />)}
                <span className="spacer" />
                <button className="btn sm primary" onClick={() => { set({ colors: suggest.slice(0, 10) }); setSuggest(undefined) }}>Use these colours</button>
                {newColours.length > 0 && doc.colors.length < 10 && (
                  <button className="btn sm" onClick={() => { set({ colors: [...doc.colors, ...newColours].slice(0, 10) }); setSuggest(undefined) }}>Add the new ones</button>
                )}
                <button className="btn ghost sm icon" onClick={() => setSuggest(undefined)} aria-label="Dismiss the logo colours"><X size={13} /></button>
              </div>
            )}
          </section>

          <section className="card ps-brand-sec">
            <div className="ps-brand-sec-head"><strong>Contrast check</strong><span className="muted">Text in one colour on another: 4.5:1 for body text (AA), 3:1 for headlines and captions</span></div>
            <ContrastCheck colors={doc.colors} />
          </section>

          <section className="card ps-brand-sec">
            <div className="ps-brand-sec-head"><Type size={15} /> <strong>Fonts</strong><span className="spacer" />
              <button className="btn sm" onClick={pickFont} disabled={!canEdit || fontBusy} title="Upload a WOFF2, WOFF, TTF or OTF file you are licensed to use">{fontBusy ? <Spinner size={13} /> : <Upload size={13} />} Upload a font</button>
            </div>
            <div className="ps-font-grid">
              {(['headline', 'body'] as const).map((k) => (
                <div key={k}>
                  <label className="label" htmlFor={`font-${k}`}>{k === 'headline' ? 'Headline font' : 'Body font'}</label>
                  <select id={`font-${k}`} className="input" value={doc.fonts[k]} onChange={(e) => set({ fonts: { ...doc.fonts, [k]: e.target.value } })} style={{ fontFamily: `'${doc.fonts[k]}'` }} disabled={!canEdit}>
                    {families.length > 0 && (
                      <optgroup label="Uploaded to this space">
                        {families.map((f) => <option key={f} value={f} style={{ fontFamily: `'${f}'` }}>{f}</option>)}
                      </optgroup>
                    )}
                    <optgroup label="Included">
                      {FONTS.map((f) => <option key={f} value={f} style={{ fontFamily: `'${f}'` }}>{f}</option>)}
                    </optgroup>
                    {!families.includes(doc.fonts[k]) && !(FONTS as readonly string[]).includes(doc.fonts[k]) && <option value={doc.fonts[k]}>{doc.fonts[k]} (missing)</option>}
                  </select>
                  <div className="ps-font-sample" style={{ fontFamily: `'${doc.fonts[k]}', sans-serif`, fontWeight: k === 'headline' ? 700 : 400, fontSize: k === 'headline' ? '1.625rem' : '0.9375rem' }}>
                    {k === 'headline' ? 'Built for teams' : 'The quick brown fox jumps over the lazy dog.'}
                  </div>
                </div>
              ))}
            </div>
            {fonts.length > 0 && (
              <div className="ps-fontfiles" role="list" aria-label="Uploaded fonts">
                {fonts.map((f) => (
                  <span key={f.id} className="ps-fontfile" role="listitem" style={{ fontFamily: `'${f.family}', sans-serif` }}>
                    {f.family} · {f.weight}{f.italic ? ' italic' : ''}
                    <button className="btn ghost sm icon" onClick={() => void removeFont(f)} disabled={!canEdit} aria-label={`Remove the font file ${f.family} ${f.weight}${f.italic ? ' italic' : ''}`}><X size={12} /></button>
                  </span>
                ))}
              </div>
            )}
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
                {voices.map((v) => <option key={v.id} value={v.id}>{v.name} — {v.lang.replace(' English', '')} · {v.style}{v.available === false ? ' (desktop offline)' : ''}</option>)}
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
          <div className="muted" style={{ fontSize: '0.75rem', marginTop: 10 }}>
            {doc.fonts.headline} / {doc.fonts.body} · {cap.name} captions{doc.voice ? ` · ${voices.find((v) => v.id === doc.voice)?.name ?? doc.voice} voice` : ''}
          </div>
        </aside>
      </div>

      {pending && (
        <Modal
          title="Save your changes first?"
          subtitle={`You have unsaved changes to “${saved?.name || 'this kit'}”. Save or discard them to ${pending.label}.`}
          onClose={() => setPending(undefined)}
          width={460}
          footer={
            <>
              <button className="btn ghost" onClick={() => setPending(undefined)}>Cancel</button>
              <button className="btn" onClick={() => { const p = pending; setPending(undefined); if (kitSpace) drafts.delete(draftKey(userId, kitSpace, loadedKit)); discard(); void p.run() }}>Discard changes</button>
              <button className="btn primary" autoFocus disabled={saving || badColour >= 0} onClick={async () => { const p = pending; if (await save()) { setPending(undefined); void p.run() } }}>{saving ? <Spinner /> : <Save size={14} />} Save changes</button>
            </>
          }
        />
      )}
      {confirmDelete && (
        <ConfirmDialog
          title={`Delete “${doc.name || 'this kit'}”?`}
          body="Projects already made with it keep their look. Videos that were going to use it use the default kit instead."
          confirmLabel={<><Trash2 size={14} /> Delete kit</>}
          busy={kitBusy}
          onConfirm={() => void deleteKit()}
          onClose={() => setConfirmDelete(false)}
        />
      )}
    </div>
  )
}
