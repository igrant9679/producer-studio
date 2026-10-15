// Preset voices: VoiceStudio's built-in voice "archetypes" (designed voices). Preview, then add one to My voices.
import type { VoiceProfile } from '@producer/core'
import { Pause, Play, Plus, Search } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useSession } from '../../lib/session'
import { toastError } from '../../lib/toast'
import { Modal, Spinner, useAsync, useAudioPreview } from '../ui'
import { useTtsEngines } from './shared'
import { vsApi, vsFetch, vsGet, vsUrl } from './vsApi'

interface Archetype {
  id: string
  name: string
  icon?: string
  use_case?: string
  instruct?: string
  sample_script?: string
  is_featured?: boolean
  language?: string
  facets?: { gender?: string; age?: string; pitch?: string; accent?: string; whisper?: boolean; lang?: string }
}

interface Category {
  id: string
  name: string
  icon?: string
}

export function PresetVoices({ onClose, onCreated }: { onClose: () => void; onCreated: (v: VoiceProfile) => void }) {
  const workspaceId = useSession((s) => s.workspaceId)!
  const engines = useTtsEngines(true)
  const cats = useAsync(() => vsGet<Category[]>('/archetypes/categories').catch(() => [] as Category[]), [])
  const [q, setQ] = useState('')
  const [cat, setCat] = useState('')
  const [gender, setGender] = useState('')
  const [debounced, setDebounced] = useState('')
  const [busy, setBusy] = useState<string>()
  const playing = useAudioPreview((s) => s.playing)
  const loadingKey = useAudioPreview((s) => s.loading)
  const toggle = useAudioPreview((s) => s.toggle)
  useEffect(() => {
    const t = setTimeout(() => setDebounced(q.trim()), 250)
    return () => clearTimeout(t)
  }, [q])
  const list = useAsync(
    () => vsGet<{ total: number; items: Archetype[] }>('/archetypes', { query: { q: debounced || undefined, use_case: cat || undefined, gender: gender || undefined, limit: 120 } }),
    [debounced, cat, gender],
  )

  async function add(a: Archetype) {
    setBusy(a.id)
    try {
      const r = await (await vsFetch(`/archetypes/${encodeURIComponent(a.id)}/use`, { method: 'POST', query: { name: a.name } })).json() as { profile_id: string; name: string }
      const v = await vsApi.adoptVoice({
        workspaceId,
        vsProfileId: r.profile_id,
        name: r.name || a.name,
        kind: 'design',
        engine: engines.data?.active ?? 'omnivoice',
        language: a.language,
        description: [a.use_case, a.instruct].filter(Boolean).join(' — '),
        consent: { agreed: true, speaker: 'preset', statement: `VoiceStudio preset voice “${a.name}”; designed, not based on a recording of a real person.` },
      })
      onCreated(v)
    } catch (e) {
      toastError(e)
    } finally {
      setBusy(undefined)
    }
  }

  return (
    <Modal title="Preset voices" subtitle="Ready-made designed voices from VoiceStudio. Preview one, then add it to this space." onClose={onClose} width={820}>
      <div className="row" style={{ gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
        <div style={{ position: 'relative', flex: 1, minWidth: 200 }}>
          <Search size={14} style={{ position: 'absolute', left: 11, top: 11, color: 'var(--text-3)' }} />
          <input className="input" style={{ paddingLeft: 32 }} placeholder="Search: narrator, warm, teen, British…" value={q} onChange={(e) => setQ(e.target.value)} autoFocus />
        </div>
        <select className="input" style={{ width: 'auto' }} value={cat} onChange={(e) => setCat(e.target.value)} aria-label="Category">
          <option value="">All uses</option>
          {(cats.data ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <select className="input" style={{ width: 'auto' }} value={gender} onChange={(e) => setGender(e.target.value)} aria-label="Gender">
          <option value="">Any voice</option>
          <option value="female">Female</option>
          <option value="male">Male</option>
        </select>
      </div>
      {list.loading && !list.data ? (
        <div className="muted"><Spinner size={13} /> Loading presets…</div>
      ) : list.error ? (
        <div className="ps-alert">Couldn’t load preset voices. <button className="btn sm" onClick={list.reload}>Retry</button></div>
      ) : (
        <>
          <div className="muted" style={{ fontSize: '0.75rem', marginBottom: 8 }}>{list.data?.total ?? 0} voices</div>
          <div className="vs-presets">
            {(list.data?.items ?? []).map((a) => {
              const key = `arch:${a.id}`
              return (
                <div key={a.id} className="vs-preset">
                  <div className="row" style={{ gap: 6 }}>
                    <strong className="ellipsis" style={{ flex: 1 }}>{a.icon ? `${a.icon} ` : ''}{a.name}</strong>
                    <button className="btn ghost icon sm" aria-label={`Preview ${a.name}`} onClick={() => toggle(key, vsUrl(`/archetypes/${encodeURIComponent(a.id)}/preview?local=true`))}>
                      {loadingKey === key ? <Spinner size={12} /> : playing === key ? <Pause size={13} /> : <Play size={13} />}
                    </button>
                  </div>
                  <span className="muted" style={{ fontSize: '0.7188rem' }}>{[a.use_case, a.facets?.gender, a.facets?.age, a.language].filter(Boolean).join(' · ')}</span>
                  <button className="btn sm" style={{ marginTop: 6 }} disabled={!!busy} onClick={() => add(a)}>{busy === a.id ? <Spinner size={12} /> : <Plus size={13} />} Add to my voices</button>
                </div>
              )
            })}
          </div>
        </>
      )}
    </Modal>
  )
}
