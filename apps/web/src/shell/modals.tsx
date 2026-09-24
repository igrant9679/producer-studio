// Modals opened from the shell chrome: aspect picker, create space, invite, help.
import { ASPECT_RATIOS } from '@producer/core'
import { Check, Copy, Keyboard, Link2, Mail } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { api, HttpError } from '../lib/api'
import { useSession } from '../lib/session'
import { toast, toastError } from '../lib/toast'
import { absoluteUrl, copyText } from './util'
import { Logo, Modal, Spinner } from './ui'

export function AspectBox({ w, h, max = 56 }: { w: number; h: number; max?: number }) {
  const s = max / Math.max(w, h)
  return <i style={{ width: Math.round(w * s), height: Math.round(h * s) }} />
}

export function AspectPickerModal({ onClose, onPick, busy, title = 'New video', subtitle = 'Pick a canvas size. You can change it any time in the editor.' }: {
  onClose: () => void
  onPick: (a: { id: string; width: number; height: number; name?: string }) => void
  busy?: boolean
  title?: string
  subtitle?: string
}) {
  const [sel, setSel] = useState<string>('16:9')
  const [name, setName] = useState('')
  const a = ASPECT_RATIOS.find((x) => x.id === sel)!
  return (
    <Modal
      title={title}
      subtitle={subtitle}
      onClose={onClose}
      width={680}
      footer={
        <>
          <button className="btn ghost" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={busy} onClick={() => onPick({ id: a.id, width: a.width, height: a.height, ...(name.trim() ? { name: name.trim() } : {}) })}>
            {busy && <Spinner />} Create {a.name} project
          </button>
        </>
      }
    >
      <div className="ps-aspects" role="radiogroup" aria-label="Aspect ratio">
        {ASPECT_RATIOS.map((r) => (
          <button key={r.id} role="radio" aria-checked={sel === r.id} className={`ps-aspect ${sel === r.id ? 'on' : ''}`} onClick={() => setSel(r.id)} onDoubleClick={() => onPick({ id: r.id, width: r.width, height: r.height })}>
            <div className="ps-aspect-box"><AspectBox w={r.width} h={r.height} /></div>
            <strong>{r.name}</strong>
            <span>{r.hint}</span>
          </button>
        ))}
      </div>
      <div style={{ marginTop: 18 }}>
        <label className="label" htmlFor="np-name">Project name (optional)</label>
        <input id="np-name" className="input" placeholder="Untitled project" value={name} onChange={(e) => setName(e.target.value)} />
      </div>
    </Modal>
  )
}

export function CreateSpaceModal({ onClose }: { onClose: () => void }) {
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const refresh = useSession((s) => s.refreshWorkspaces)
  const setWorkspace = useSession((s) => s.setWorkspace)
  async function submit(e: FormEvent) {
    e.preventDefault()
    if (!name.trim()) return
    setBusy(true)
    try {
      const ws = await api.createWorkspace(name.trim())
      await refresh()
      setWorkspace(ws.id)
      toast(`Created “${ws.name}”`)
      onClose()
    } catch (err) {
      toastError(err)
    } finally {
      setBusy(false)
    }
  }
  return (
    <Modal title="Create a space" subtitle="Spaces keep a team's projects, media and brand kit together. You can invite people next." onClose={onClose} width={480}>
      <form onSubmit={submit}>
        <label className="label" htmlFor="space-name">Space name</label>
        <input id="space-name" className="input" autoFocus placeholder="e.g. Marketing team" value={name} onChange={(e) => setName(e.target.value)} maxLength={60} />
        <div className="row" style={{ justifyContent: 'flex-end', marginTop: 20 }}>
          <button type="button" className="btn ghost" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={busy || !name.trim()}>{busy && <Spinner />} Create space</button>
        </div>
      </form>
    </Modal>
  )
}

export function InviteForm({ workspaceId, onInvited }: { workspaceId: string; onInvited?: () => void }) {
  const [email, setEmail] = useState('')
  const [role, setRole] = useState('editor')
  const [busy, setBusy] = useState(false)
  const [url, setUrl] = useState<string>()
  const [err, setErr] = useState<string>()
  const [copied, setCopied] = useState(false)
  async function submit(e: FormEvent) {
    e.preventDefault()
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) return setErr('Enter a valid email address')
    setBusy(true)
    setErr(undefined)
    try {
      const r = await api.invite(workspaceId, email.trim(), role)
      setUrl(absoluteUrl(r.inviteUrl))
      setCopied(false)
      onInvited?.()
    } catch (e2) {
      setErr(e2 instanceof HttpError ? e2.body.error || e2.message : String(e2))
    } finally {
      setBusy(false)
    }
  }
  return (
    <div>
      <form onSubmit={submit} className="row" style={{ alignItems: 'flex-start', flexWrap: 'wrap' }}>
        <div style={{ flex: '1 1 240px', position: 'relative' }}>
          <Mail size={15} style={{ position: 'absolute', left: 11, top: 11, color: 'var(--text-3)' }} />
          <input className="input" style={{ paddingLeft: 34 }} type="email" placeholder="teammate@company.com" value={email} onChange={(e) => setEmail(e.target.value)} aria-label="Email to invite" />
        </div>
        <select className="input" style={{ width: 130 }} value={role} onChange={(e) => setRole(e.target.value)} aria-label="Role">
          <option value="editor">Editor</option>
          <option value="viewer">Viewer</option>
          <option value="owner">Owner</option>
        </select>
        <button className="btn primary" disabled={busy || !email}>{busy && <Spinner />} Send invite</button>
      </form>
      {err && <div className="ps-field-err">{err}</div>}
      {url && (
        <div className="ps-alert info" style={{ marginTop: 14, alignItems: 'center' }}>
          <Link2 size={16} style={{ flex: 'none' }} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontWeight: 600, marginBottom: 2 }}>Invite link ready — share it with {email}</div>
            <code style={{ fontFamily: 'var(--font-mono)', fontSize: 12, wordBreak: 'break-all' }}>{url}</code>
          </div>
          <button
            className="btn sm"
            onClick={async () => {
              if (await copyText(url)) setCopied(true)
            }}
          >
            {copied ? <Check size={14} /> : <Copy size={14} />} {copied ? 'Copied' : 'Copy'}
          </button>
        </div>
      )}
    </div>
  )
}

export function InviteModal({ onClose }: { onClose: () => void }) {
  const workspaceId = useSession((s) => s.workspaceId)
  const ws = useSession((s) => s.workspaces.find((w) => w.id === s.workspaceId))
  return (
    <Modal title={`Invite to ${ws?.name ?? 'space'}`} subtitle="Invitees get access to this space's projects, media and brand kit." onClose={onClose} width={620}>
      {ws?.personal && <div className="ps-alert info" style={{ marginBottom: 14 }}>This is your personal space. For team work, create a shared space and invite people there.</div>}
      {workspaceId && <InviteForm workspaceId={workspaceId} />}
    </Modal>
  )
}

const SHORTCUTS: Array<[string, Array<[string, string]>]> = [
  ['Anywhere', [['Search projects & media', 'Ctrl K'], ['Show this help', '?'], ['Close dialogs & menus', 'Esc']]],
  ['Editor — global', [['Play / pause', 'Space'], ['Undo', 'Ctrl Z'], ['Redo', 'Ctrl Shift Z'], ['Select all', 'Ctrl A'], ['Copy / paste', 'Ctrl C / V'], ['Delete', 'Backspace']]],
  ['Editor — timeline', [['Split at playhead', 'Ctrl B'], ['Zoom timeline', 'Ctrl + / −'], ['Previous / next frame', 'Ctrl ← / →'], ['Separate audio', 'Ctrl Shift S']]],
  ['Editor — canvas', [['Move tool', 'V'], ['Hand tool', 'H'], ['Fit canvas', 'Shift F'], ['Nudge 1 px', '↑ ↓ ← →']]],
]

export function HelpModal({ onClose }: { onClose: () => void }) {
  const [tab, setTab] = useState<'keys' | 'about'>('keys')
  return (
    <Modal title="Help" onClose={onClose} width={720}>
      <div className="ps-seg" style={{ marginBottom: 18 }}>
        <button className={tab === 'keys' ? 'on' : ''} onClick={() => setTab('keys')}><Keyboard size={14} /> Keyboard shortcuts</button>
        <button className={tab === 'about' ? 'on' : ''} onClick={() => setTab('about')}>About</button>
      </div>
      {tab === 'keys' ? (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 22 }}>
          {SHORTCUTS.map(([group, rows]) => (
            <div key={group}>
              <div className="eyebrow" style={{ marginBottom: 10 }}>{group}</div>
              {rows.map(([label, key]) => (
                <div key={label} className="row" style={{ padding: '6px 0', borderBottom: '1px solid var(--border)' }}>
                  <span style={{ color: 'var(--text-2)' }}>{label}</span>
                  <span className="spacer" />
                  <span className="kbd">{key}</span>
                </div>
              ))}
            </div>
          ))}
        </div>
      ) : (
        <div>
          <Logo />
          <p style={{ color: 'var(--text-2)', marginTop: 16 }}>
            Producer Studio turns screen recordings into finished, on-brand videos. <b>Producer AI</b> transcribes your footage, writes a script with Claude, narrates it and assembles
            the cut; the <b>Video Editor</b> gives you a full multi-track timeline to finish it; <b>Voice Studio</b> generates voiceovers from text.
          </p>
          <ul style={{ color: 'var(--text-2)', paddingLeft: 18, lineHeight: 1.8 }}>
            <li>Upload recordings from <b>Create new → Upload media</b> or drag files onto the Library.</li>
            <li>Everything in a space — projects, media, brand kit — is shared with its members.</li>
            <li>Exports and share links live under <b>Exports &amp; sharing</b>.</li>
          </ul>
          <p className="muted" style={{ fontSize: 12 }}>Version 0.1 · Phase 1</p>
        </div>
      )}
    </Modal>
  )
}
