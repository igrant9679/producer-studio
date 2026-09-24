// Brand kit: workspace colours and fonts, applied to the selected text (or shape / project background).
import type { BrandKitDoc, ShapeItem, TextItem } from '@producer/core'
import { addItem, createTextItem, updateItem, updateProject } from '@producer/core'
import { Loader2, Type } from 'lucide-react'
import { useEffect, useState } from 'react'
import { api } from '../../lib/api'
import { toast } from '../../lib/toast'
import * as A from '../actions'
import { useEditor } from '../store'

const DEMO_BRAND: BrandKitDoc = {
  name: 'Producer Studio (sample)',
  colors: ['#ff5a5f', '#35e0ff', '#ffc24d', '#3ddc97', '#0c0e14', '#1b2030', '#ffffff'],
  fonts: { headline: 'Space Grotesk', body: 'Inter' },
}

export function BrandPanel() {
  const demo = useEditor((s) => s.demo)
  const workspaceId = useEditor((s) => s.workspaceId)
  const projectBrand = useEditor((s) => s.project.brand)
  const selection = useEditor((s) => s.selection)
  const project = useEditor((s) => s.project)
  const [brand, setBrand] = useState<BrandKitDoc | null>(demo ? DEMO_BRAND : null)
  const [loading, setLoading] = useState(!demo)

  useEffect(() => {
    if (demo || !workspaceId) {
      setLoading(false)
      return
    }
    let alive = true
    api
      .brand(workspaceId)
      .then((b) => alive && setBrand(b))
      .catch(() => alive && setBrand(projectBrand ? { name: projectBrand.name, colors: projectBrand.colors, fonts: projectBrand.fonts } : null))
      .finally(() => alive && setLoading(false))
    return () => {
      alive = false
    }
  }, [demo, workspaceId, projectBrand])

  const sel = A.selectedItems(project, selection)
  const texts = sel.filter((i): i is TextItem => i.type === 'text')
  const shapes = sel.filter((i): i is ShapeItem => i.type === 'shape')

  const applyColor = (c: string) => {
    let p = project
    if (texts.length || shapes.length) {
      for (const t of texts) p = updateItem<TextItem>(p, t.id, { style: { ...t.style, color: c } })
      for (const s of shapes) p = updateItem<ShapeItem>(p, s.id, { fill: c })
      useEditor.getState().commit(p, 'Brand colour')
    } else if (!sel.length) {
      useEditor.getState().commit(updateProject(p, { background: c }), 'Background colour')
      toast('Applied to the project background')
    } else toast('Select a text or shape to apply a brand colour')
  }
  const applyFont = (f: string) => {
    if (!texts.length) return toast('Select a text to apply the font')
    let p = project
    for (const t of texts) p = updateItem<TextItem>(p, t.id, { style: { ...t.style, fontFamily: f } })
    useEditor.getState().commit(p, 'Brand font')
  }

  const addBrandText = (k: 'headline' | 'body') => {
    const s = useEditor.getState()
    const it = createTextItem(s.playhead, k === 'headline' ? 'heading' : 'body')
    it.style = { ...it.style, fontFamily: brand!.fonts[k], color: brand!.colors[0] ?? it.style.color }
    s.commit(addItem(s.project, it), 'Add brand text', { selection: [it.id] })
  }

  if (loading) return <div className="ed-note"><Loader2 size={13} className="spin" /> Loading brand kit…</div>
  if (!brand) return <p className="ed-note">No brand kit for this workspace yet. Set one up in the Brand kit page.</p>
  return (
    <>
      <div className="ed-group">
        <div className="eyebrow">{brand.name}</div>
        <p className="ed-note">{texts.length || shapes.length ? 'Click a swatch to colour the selection.' : sel.length ? 'Select text or a shape to apply colours.' : 'Nothing selected: swatches set the project background.'}</p>
        <div className="ed-brandsw">
          {brand.colors.map((c) => (
            <button key={c} style={{ background: c }} title={c} onClick={() => applyColor(c)}>
              <span>{c}</span>
            </button>
          ))}
        </div>
      </div>
      <div className="ed-group">
        <div className="eyebrow">Fonts</div>
        {(['headline', 'body'] as const).map((k) => (
          <div key={k} className="ed-brandfont">
            <div>
              <div className="sample" style={{ fontFamily: brand.fonts[k], fontWeight: k === 'headline' ? 700 : 500 }}>{brand.fonts[k]}</div>
              <small>{k === 'headline' ? 'Headline' : 'Body'}</small>
            </div>
            <div className="row" style={{ gap: 4 }}>
              <button className="btn sm" onClick={() => applyFont(brand.fonts[k])} disabled={!texts.length}>Apply</button>
              <button className="btn sm icon" title={`Add ${k} text in the brand style`} onClick={() => addBrandText(k)}>
                <Type size={13} />
              </button>
            </div>
          </div>
        ))}
      </div>
    </>
  )
}
