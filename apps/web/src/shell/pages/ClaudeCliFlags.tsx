// Settings → AI (desktop): the Claude Code CLI that was found, and which of its options Producer Studio detected in
// `claude --help` and passes on its runs (D-16). Optional options it can do without are only passed when listed, so
// this is where a person sees what an older CLI is missing.
import type { ClaudeCliInfo } from '@producer/core'
import { Check, Minus, X } from 'lucide-react'

const SOURCE: Record<string, string> = {
  settings: 'the path in these settings',
  'desktop-bundle': 'the Claude desktop app',
  msix: 'the Claude app (Microsoft Store)',
  'local-bin': '~/.local/bin',
  path: 'your PATH',
}

function Mark({ on, yes, no }: { on: boolean; yes: string; no: string }) {
  return (
    <span className="ps-cli-mark" data-on={on || undefined}>
      {on ? <Check size={13} aria-hidden /> : <X size={13} aria-hidden />} {on ? yes : no}
    </span>
  )
}

export function ClaudeCliFlags({ cli }: { cli: ClaudeCliInfo }) {
  const used = cli.flags.filter((f) => f.used).length
  const missing = cli.flags.filter((f) => f.required && !f.detected)
  return (
    <details className="ps-ai-adv ps-cli-flags">
      <summary>
        Claude Code options · {cli.optionsUnknown ? 'not known yet' : `${used} of ${cli.flags.length} used`}
        {missing.length > 0 && ` · ${missing.length} required missing`}
      </summary>
      <p className="ps-hint" style={{ margin: '8px 0' }}>
        {cli.version ? `Claude Code ${cli.version}` : 'Claude Code'} at <span className="mono">{cli.path}</span>, found through {SOURCE[cli.source] ?? cli.source}.{' '}
        {cli.optionsUnknown
          ? 'It didn’t list its options in time (claude --help), so they’re checked again next time.'
          : 'Options marked required keep your own Claude Code settings out of Producer Studio’s runs: without them it isn’t used at all. The others are passed when this CLI lists them.'}
      </p>
      <div className="ps-table-wrap">
        <table className="ps-table ps-cli-table" aria-label="Claude Code options detected and used">
          <thead>
            <tr>
              <th scope="col">Option</th>
              <th scope="col">Detected</th>
              <th scope="col">Used</th>
              <th scope="col">On</th>
              <th scope="col">What it does</th>
            </tr>
          </thead>
          <tbody>
            {cli.flags.map((f) => (
              <tr key={f.flag}>
                <th scope="row" className="mono">
                  {f.flag}
                  {f.required && <span className="ps-cli-req"> required</span>}
                </th>
                <td>{cli.optionsUnknown ? <span className="ps-cli-mark"><Minus size={13} aria-hidden /> unknown</span> : <Mark on={f.detected} yes="yes" no="no" />}</td>
                <td><Mark on={f.used} yes="yes" no="no" /></td>
                <td>{f.when}</td>
                <td>{f.purpose}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  )
}
