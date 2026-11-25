// Model licences (VoiceStudio 0.5.7+): a model whose weights aren't licensed for commercial use is only used once its
// licence is accepted on this computer (VoiceStudio answers 403 `model_licence_required` until then, OmniVoice, the
// default engine, included). The Engine tab lists the models that ask (ModelLicences); a request refused for one opens
// the same dialog wherever it happened (LicenceAsk, fed by vsApi's readError).
import { CheckCircle2, ExternalLink, ShieldAlert } from 'lucide-react'
import { useEffect, useState } from 'react'
import { toast, toastError } from '../../lib/toast'
import { Modal, Spinner, useAsync } from '../ui'
import { type LicenceDetails, useLicenceAsk, vsApi } from './vsApi'

/** The models VoiceStudio 0.5.8 asks a licence for (its registry: every model not licensed for commercial use). */
export const GATED_MODELS: Array<{ repo: string; what: string }> = [
  { repo: 'k2-fsa/OmniVoice', what: 'OmniVoice, the default voice engine' },
  { repo: 'facebook/nllb-200-distilled-600M', what: 'NLLB, which translates dubbing scripts offline' },
  { repo: 'IndexTeam/IndexTTS-2.5', what: 'IndexTTS2, an extra engine with emotion control' },
  { repo: 'Serveurperso/OmniVoice-GGUF', what: 'OmniVoice GGUF, an extra engine' },
]

const COMMERCIAL: Record<string, string> = {
  restricted: 'Not for commercial use.',
  allowed: 'Commercial use allowed.',
  unknown: 'Commercial use isn’t settled by its terms: assume it isn’t allowed.',
}

const STATE: Record<string, string> = {
  accepted: 'Accepted',
  not_required: 'No acceptance needed',
  not_accepted: 'Needs accepting',
  withdrawn: 'Withdrawn',
  terms_updated: 'Terms changed: accept again',
}

const httpsLink = (u?: string | null) => (u && /^https:\/\//.test(u) ? u : undefined)

/** One model's terms and the Accept button. */
export function AcceptLicenceDialog({ details, onClose, onAccepted }: { details: LicenceDetails; onClose: () => void; onAccepted: () => void }) {
  const [agreed, setAgreed] = useState(false)
  const [busy, setBusy] = useState(false)
  const i = details.info ?? {}
  const accept = async () => {
    setBusy(true)
    try {
      await vsApi.acceptLicence(details.repo_id, details.acceptance.fingerprint)
      onAccepted()
    } catch (e) {
      toastError(e)
    } finally {
      setBusy(false)
    }
  }
  const source = httpsLink(i.evidence_url) ?? httpsLink(i.source_url)
  return (
    <Modal
      title={`Licence: ${details.repo_id}`}
      subtitle="VoiceStudio uses this model only once you accept its licence on this computer."
      onClose={onClose}
      width={540}
      footer={
        <>
          <button className="btn ghost" autoFocus onClick={onClose}>Not now</button>
          <button className="btn primary" disabled={!agreed || busy} onClick={() => void accept()}>{busy && <Spinner size={12} />} Accept</button>
        </>
      }
    >
      <div className="vs-licence">
        <strong>{i.license || details.acceptance.license || 'Licence not stated'}</strong>
        <div className="muted" style={{ fontSize: '0.8125rem', marginTop: 4 }}>
          {COMMERCIAL[i.commercial_inference ?? 'unknown'] ?? COMMERCIAL.unknown}
          {i.credit ? ` ${i.credit}.` : ''}
        </div>
        {i.notes && <p className="muted" style={{ fontSize: '0.8125rem', marginTop: 8 }}>{i.notes}</p>}
        {details.acceptance.state === 'terms_updated' && <p style={{ fontSize: '0.8125rem', marginTop: 8 }}>The terms changed since you last accepted them.</p>}
        {source && (
          <a className="btn sm" style={{ marginTop: 12 }} href={source} target="_blank" rel="noreferrer noopener">
            <ExternalLink size={13} /> Read the licence on the model card
          </a>
        )}
        <label className="row" style={{ gap: 8, marginTop: 14, alignItems: 'flex-start', fontSize: '0.875rem' }}>
          <input type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} style={{ marginTop: 3 }} />
          <span>I’ve read these terms and hold the rights they require for how I’ll use this model.</span>
        </label>
      </div>
    </Modal>
  )
}

/** Engine tab: the models that ask for a licence, whether each is accepted, and Accept. */
export function ModelLicences() {
  const [rev, setRev] = useState(0)
  const rows = useAsync(() => Promise.all(GATED_MODELS.map((m) => vsApi.licenceDetails(m.repo).then((d) => ({ ...m, d }), () => ({ ...m, d: undefined })))), [rev])
  const [open, setOpen] = useState<LicenceDetails>()
  return (
    <section className="card vs-engine-card">
      <h3 style={{ margin: 0 }}>Model licences</h3>
      <p className="muted" style={{ fontSize: '0.8125rem', margin: '4px 0 12px' }}>
        These models’ licences don’t allow commercial use, so VoiceStudio uses each only once you’ve accepted its terms on this computer. Voices made on the
        website with a voice from this computer wait for this too.
      </p>
      {rows.loading && <Spinner size={14} />}
      {(rows.data ?? []).map((r) => {
        const a = r.d?.acceptance
        const needs = !!a && a.required && !a.accepted
        return (
          <div key={r.repo} className="row" style={{ gap: 10, padding: '8px 0', borderTop: '1px solid var(--border)' }}>
            {needs ? <ShieldAlert size={16} style={{ color: 'var(--amber)', flexShrink: 0 }} /> : <CheckCircle2 size={16} style={{ color: 'var(--green)', flexShrink: 0 }} />}
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 600 }}>{r.repo}</div>
              <div className="muted" style={{ fontSize: '0.8125rem' }}>
                {r.what} · {a ? (STATE[a.state] ?? a.state) : 'Couldn’t read its licence state'}
              </div>
            </div>
            {needs && (
              <button className="btn sm primary" onClick={() => setOpen(r.d)}>
                Review &amp; accept
              </button>
            )}
          </div>
        )
      })}
      {open && (
        <AcceptLicenceDialog
          details={open}
          onClose={() => setOpen(undefined)}
          onAccepted={() => {
            toast('Licence accepted')
            setOpen(undefined)
            setRev((n) => n + 1)
          }}
        />
      )}
    </section>
  )
}

/** Shown wherever VoiceStudio refused a request for a model whose licence isn't accepted yet (mounted once by the Voice Studio page). */
export function LicenceAsk() {
  const models = useLicenceAsk((s) => s.models)
  const clear = useLicenceAsk((s) => s.clear)
  const [details, setDetails] = useState<LicenceDetails>()
  const first = models?.[0]
  useEffect(() => {
    setDetails(undefined)
    if (!first) return
    let live = true
    vsApi.licenceDetails(first.repo_id).then(
      (d) => live && setDetails(d),
      (e) => {
        if (!live) return
        toastError(e)
        clear()
      },
    )
    return () => {
      live = false
    }
  }, [first, clear])
  if (!first || !details) return null
  const rest = models!.slice(1)
  return (
    <AcceptLicenceDialog
      details={details}
      onClose={clear}
      onAccepted={() => {
        if (rest.length) useLicenceAsk.getState().ask(rest)
        else {
          clear()
          toast('Licence accepted. Try that again.')
        }
      }}
    />
  )
}
