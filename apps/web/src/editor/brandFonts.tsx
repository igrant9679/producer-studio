// Fonts uploaded to the project's space for its brand kits (A-21): loaded into the page when the editor opens (so the
// preview draws text in them, as the export does) and offered in the font pickers.
import type { BrandFont } from '@producer/core'
import { FONTS } from '@producer/core'
import { useEffect, useState } from 'react'
import { brandApi, registerBrandFonts } from '../lib/brandApi'
import { useEditor } from './store'

const bySpace = new Map<string, Promise<BrandFont[]>>()

function spaceFonts(ws: string): Promise<BrandFont[]> {
  let p = bySpace.get(ws)
  if (!p) {
    p = brandApi
      .fonts(ws)
      .then((f) => (Array.isArray(f) ? f : []))
      .catch(() => {
        bySpace.delete(ws)
        return [] as BrandFont[]
      })
    bySpace.set(ws, p)
  }
  return p
}

/** The families uploaded to the open project's space (registered with the page once loaded). */
export function useBrandFamilies(): string[] {
  const ws = useEditor((s) => s.workspaceId)
  const demo = useEditor((s) => s.demo)
  const [families, setFamilies] = useState<string[]>([])
  useEffect(() => {
    if (!ws || demo) return setFamilies([])
    let alive = true
    void spaceFonts(ws).then(async (f) => {
      await registerBrandFonts(f)
      if (alive) setFamilies([...new Set(f.map((x) => x.family))].filter((x) => !(FONTS as readonly string[]).includes(x)))
    })
    return () => {
      alive = false
    }
  }, [ws, demo])
  return families
}

/** The brand fonts as a group of options in a font <select>. */
export function BrandFontOptions() {
  const families = useBrandFamilies()
  if (!families.length) return null
  return (
    <optgroup label="Brand fonts">
      {families.map((f) => (
        <option key={f} value={f} style={{ fontFamily: f }}>{f}</option>
      ))}
    </optgroup>
  )
}
