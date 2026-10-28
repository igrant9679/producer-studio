// The space's usage (A-18): its limits and how much of each is used, AI requests and an estimated cost per provider,
// processing minutes, storage (this space and every space you're in), who used what (owners), and the switch for the
// server's own AI key (P-1, owners on cloud).
import type { JobKind, UsageLimitView, UsageSummary } from '@producer/core'
import { BarChart3, Bot, Clock, HardDrive, History, Sparkles, Users } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { usageApi } from '../../lib/usageApi'
import { currentWorkspace, useSession } from '../../lib/session'
import { toastError } from '../../lib/toast'
import { Spinner, usePageTitle } from '../ui'
import { JOB_LABELS, formatBytes } from '../util'
import './usage.css'

const PERIODS = [7, 30, 90]

const nf = (n: number) => Math.round(n).toLocaleString('en-US')
const usd = (n: number) => (n > 0 && n < 0.01 ? '< $0.01' : `$${n.toFixed(2)}`)

/** A provider id in words. */
export function providerLabel(id: string): string {
  if (id === 'anthropic-api') return 'Claude (the server’s key)'
  if (id === 'anthropic-key') return 'Anthropic (your key)'
  if (id === 'openai') return 'OpenAI (your key)'
  if (id === 'gemini') return 'Gemini (your key)'
  if (id === 'claude-cli') return 'Claude Code (desktop)'
  return id
}

function amount(n: number, unit: UsageLimitView['unit']): string {
  if (unit === 'bytes') return n ? formatBytes(n) : '0 B'
  if (unit === 'minutes') return `${n.toLocaleString('en-US', { maximumFractionDigits: 1 })} min`
  return nf(n)
}

function Limit({ l }: { l: UsageLimitView }) {
  const pct = l.limit ? Math.min(100, (l.used / l.limit) * 100) : 0
  const state = !l.limit ? 'off' : pct >= 100 ? 'full' : pct >= 80 ? 'near' : 'ok'
  return (
    <li className={`ps-usage-limit ${state}`}>
      <div className="ps-usage-limit-head">
        <span>{l.label}</span>
        <span className="muted">{l.limit ? `${amount(l.used, l.unit)} of ${amount(l.limit, l.unit)}` : `${amount(l.used, l.unit)} · no limit`}</span>
      </div>
      {l.limit > 0 && (
        <div className="ps-usage-bar" role="meter" aria-label={l.label} aria-valuemin={0} aria-valuemax={l.limit} aria-valuenow={Math.min(l.used, l.limit)} aria-valuetext={`${amount(l.used, l.unit)} of ${amount(l.limit, l.unit)}`}>
          <i style={{ width: `${Math.max(pct, 1)}%` }} />
        </div>
      )}
    </li>
  )
}

function Section({ icon, title, children, note }: { icon: ReactNode; title: string; children: ReactNode; note?: ReactNode }) {
  const id = `usage-${title.toLowerCase().replace(/[^a-z]+/g, '-')}`
  return (
    <section className="card ps-usage-sec" aria-labelledby={id}>
      <div className="ps-usage-sec-head">
        <span className="ps-usage-icon" aria-hidden="true">{icon}</span>
        <h2 id={id}>{title}</h2>
      </div>
      {note && <p className="muted ps-usage-note">{note}</p>}
      {children}
    </section>
  )
}

function BuiltinAi({ data, onChange }: { data: UsageSummary; onChange: (on: boolean) => void }) {
  const [busy, setBusy] = useState(false)
  const { enabled, available, canChange } = data.builtinAi
  const toggle = async () => {
    setBusy(true)
    try {
      const r = await usageApi.setBuiltinAi(data.workspaceId, !enabled)
      onChange(r.enabled)
    } catch (e) {
      toastError(e, 'Couldn’t change the setting')
    } finally {
      setBusy(false)
    }
  }
  // the desktop (its own Claude sign-in), or a server without a key and nothing to switch: nothing to say here
  if (!available && enabled) return null
  const words = !available ? 'This server has no AI key of its own: add your own key in Settings → AI.' : enabled ? 'AI in this space can use the server’s own key.' : 'This space doesn’t use the server’s AI: add your own key in Settings → AI, or turn it on.'
  return (
    <Section icon={<Bot size={16} />} title="The server’s AI key">
      <div className="ps-usage-switch-row">
        <p className="muted" style={{ margin: 0 }}>{words}</p>
        {canChange && available && (
          <button type="button" role="switch" aria-checked={enabled} aria-label="Use the server’s AI key in this space" className={`ps-usage-switch${enabled ? ' on' : ''}`} onClick={() => void toggle()} disabled={busy}>
            <span className="ps-usage-knob" aria-hidden="true" />
            <span>{enabled ? 'On' : 'Off'}</span>
          </button>
        )}
      </div>
      {!canChange && available && <p className="muted ps-usage-note">Only an owner of this space can change this.</p>}
    </Section>
  )
}

export default function UsagePage() {
  usePageTitle('Usage')
  const ws = useSession(currentWorkspace)
  const [days, setDays] = useState(30)
  const [data, setData] = useState<UsageSummary>()
  const [error, setError] = useState<string>()

  useEffect(() => {
    if (!ws) return
    let alive = true
    setError(undefined)
    usageApi
      .usage(ws.id, days)
      .then((d) => alive && setData(d))
      .catch((e) => alive && setError(e instanceof Error ? e.message : String(e)))
    return () => {
      alive = false
    }
  }, [ws, days])

  const shown = data && data.workspaceId === ws?.id ? data : undefined

  return (
    <div className="ps-page narrow">
      <div className="ps-page-head">
        <div>
          <span className="eyebrow">{ws?.name ?? 'Space'}</span>
          <h1>Usage</h1>
          <p>What this space used: AI requests and their estimated cost, processing time and storage, against the limits this server sets.</p>
        </div>
      </div>
      <div className="row ps-usage-periods" role="group" aria-label="Period">
        {PERIODS.map((d) => (
          <button key={d} type="button" className={`chip${days === d ? ' active' : ''}`} aria-pressed={days === d} onClick={() => setDays(d)}>
            Last {d} days
          </button>
        ))}
        <span className="spacer" />
        <Link className="btn ghost sm" to="/jobs"><History size={14} /> Job history</Link>
      </div>
      {error ? (
        <div className="ps-alert" role="alert">Couldn’t load the usage: {error}</div>
      ) : !shown ? (
        <Spinner size={20} />
      ) : (
        <div className="ps-usage">
          <Section icon={<BarChart3 size={16} />} title="Limits" note="Request counts run over a rolling day; tokens and minutes over the calendar month (UTC).">
            <ul className="ps-usage-limits">
              {shown.limits.map((l) => (
                <Limit key={l.label} l={l} />
              ))}
            </ul>
          </Section>

          <Section icon={<Sparkles size={16} />} title="AI" note={`Costs are estimates from list prices, not your provider’s bill. Last ${shown.days} days.`}>
            {!shown.ai.providers.length ? (
              <p className="muted">No AI requests in this period.</p>
            ) : (
              <div className="ps-table-wrap">
                <table className="ps-usage-table">
                  <caption className="ps-usage-sr">AI requests per provider and model</caption>
                  <thead>
                    <tr>
                      <th scope="col">Provider</th>
                      <th scope="col">Model</th>
                      <th scope="col" className="num">Requests</th>
                      <th scope="col" className="num">Tokens in</th>
                      <th scope="col" className="num">Tokens out</th>
                      <th scope="col" className="num">Est. cost</th>
                    </tr>
                  </thead>
                  <tbody>
                    {shown.ai.providers.map((p) => (
                      <tr key={`${p.provider}|${p.model}`}>
                        <td>{providerLabel(p.provider)}</td>
                        <td className="mono">{p.model || '—'}</td>
                        <td className="num">{nf(p.requests)}</td>
                        <td className="num">{nf(p.inputTokens)}</td>
                        <td className="num">{nf(p.outputTokens)}</td>
                        <td className="num">{usd(p.estCostUsd)}</td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr>
                      <th scope="row" colSpan={2}>Total</th>
                      <td className="num">{nf(shown.ai.requests)}</td>
                      <td className="num">{nf(shown.ai.inputTokens)}</td>
                      <td className="num">{nf(shown.ai.outputTokens)}</td>
                      <td className="num">{usd(shown.ai.estCostUsd)}</td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            )}
          </Section>

          <Section icon={<Clock size={16} />} title="Processing" note={`${shown.jobs.minutes.toLocaleString('en-US', { maximumFractionDigits: 1 })} minutes of exports, voiceovers, transcriptions and processing in the last ${shown.days} days.`}>
            {!shown.jobs.byKind.length ? (
              <p className="muted">Nothing ran in this period.</p>
            ) : (
              <ul className="ps-usage-rows" aria-label="Processing time by kind">
                {shown.jobs.byKind.map((k) => (
                  <li key={k.kind}>
                    <span>{JOB_LABELS[k.kind as JobKind] ?? k.kind}</span>
                    <span className="muted">{k.runs} run{k.runs === 1 ? '' : 's'} · {k.minutes.toLocaleString('en-US', { maximumFractionDigits: 1 })} min</span>
                  </li>
                ))}
              </ul>
            )}
          </Section>

          <Section icon={<HardDrive size={16} />} title="Storage" note={`${formatBytes(shown.storage.bytes) === '—' ? '0 B' : formatBytes(shown.storage.bytes)} in ${shown.storage.files} file${shown.storage.files === 1 ? '' : 's'} in this space.`}>
            {shown.storage.byKind.length > 0 && (
              <ul className="ps-usage-rows" aria-label="Storage in this space by kind">
                {shown.storage.byKind.map((k) => (
                  <li key={k.kind}>
                    <span style={{ textTransform: 'capitalize' }}>{k.kind}</span>
                    <span className="muted">{k.files} · {formatBytes(k.bytes)}</span>
                  </li>
                ))}
              </ul>
            )}
            {shown.spaces.length > 1 && (
              <>
                <h3 className="ps-usage-sub">Your spaces</h3>
                <ul className="ps-usage-rows" aria-label="Storage per space">
                  {shown.spaces.map((s) => (
                    <li key={s.id} aria-current={s.id === shown.workspaceId ? 'true' : undefined}>
                      <span>{s.name}</span>
                      <span className="muted">{s.bytes ? formatBytes(s.bytes) : '0 B'}</span>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </Section>

          {shown.members && (
            <Section icon={<Users size={16} />} title="Who used what" note="Only owners see this.">
              {!shown.members.length ? (
                <p className="muted">Nobody used AI or processing in this period.</p>
              ) : (
                <div className="ps-table-wrap">
                  <table className="ps-usage-table">
                    <caption className="ps-usage-sr">Usage per person</caption>
                    <thead>
                      <tr>
                        <th scope="col">Person</th>
                        <th scope="col" className="num">AI requests</th>
                        <th scope="col" className="num">Tokens</th>
                        <th scope="col" className="num">Processing</th>
                      </tr>
                    </thead>
                    <tbody>
                      {shown.members.map((m) => (
                        <tr key={m.userId || 'auto'}>
                          <th scope="row">{m.name}</th>
                          <td className="num">{nf(m.aiRequests)}</td>
                          <td className="num">{nf(m.tokens)}</td>
                          <td className="num">{m.jobMinutes.toLocaleString('en-US', { maximumFractionDigits: 1 })} min</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Section>
          )}

          <BuiltinAi data={shown} onChange={(enabled) => setData((d) => (d ? { ...d, builtinAi: { ...d.builtinAi, enabled } } : d))} />
        </div>
      )}
    </div>
  )
}
