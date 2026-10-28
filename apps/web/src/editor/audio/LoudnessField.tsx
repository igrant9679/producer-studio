// Export dialog: loudness normalisation of the exported sound (E-14), a target per platform.
import { LOUDNESS_TARGETS, type ExportRequest } from '@producer/core'
import { Field, Segmented } from '../controls'

export type Loudness = NonNullable<ExportRequest['loudness']>

const OPTIONS: Array<{ value: Loudness; label: string; title: string }> = [
  { value: 'off', label: 'Off', title: 'Off: keep the mix as it is' },
  ...LOUDNESS_TARGETS.map((t) => ({ value: t.id, label: t.label, title: `${t.label} LUFS: ${t.hint}` })),
]

export function LoudnessField({ value, onChange, format }: { value: Loudness; onChange: (v: Loudness) => void; format: ExportRequest['format'] }) {
  if (format === 'gif') return null
  const target = LOUDNESS_TARGETS.find((t) => t.id === value)
  return (
    <>
      <Field label="Loudness">
        <Segmented size="sm" value={value} options={OPTIONS} onChange={onChange} />
      </Field>
      {target && <p className="ed-note">The sound is evened out to {target.lufs} LUFS ({target.hint}), peaks kept under −1.5 dB.</p>}
    </>
  )
}
