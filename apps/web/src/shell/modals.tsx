// Modals opened from the shell chrome: aspect picker, create / rename / delete space, invite, help.
import { ASPECT_RATIOS } from '@producer/core'
import type { Workspace } from '@producer/core'
import { Check, Copy, Download, Keyboard, Link2, Mail, MonitorDown, Trash2 } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { api, HttpError } from '../lib/api'
import { useSession } from '../lib/session'
import { toast, toastError } from '../lib/toast'
import { DESKTOP_DOWNLOAD_URL, useSystem } from './system'
import { absoluteUrl, copyText } from './util'
import { ConfirmDialog, Logo, Modal, Spinner, TabPanel, Tabs } from './ui'

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
  // double-click and Enter create too, with the name typed so far
  const pick = (r: (typeof ASPECT_RATIOS)[number]) => !busy && onPick({ id: r.id, width: r.width, height: r.height, ...(name.trim() ? { name: name.trim() } : {}) })
  return (
    <Modal
      title={title}
      subtitle={subtitle}
      onClose={onClose}
      width={680}
      footer={
        <>
          <button className="btn ghost" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={busy} onClick={() => pick(a)}>
            {busy && <Spinner />} Create {a.name} project
          </button>
        </>
      }
    >
      <div className="ps-aspects" role="radiogroup" aria-label="Aspect ratio">
        {ASPECT_RATIOS.map((r) => (
          <button key={r.id} role="radio" aria-checked={sel === r.id} className={`ps-aspect ${sel === r.id ? 'on' : ''}`} onClick={() => setSel(r.id)} onDoubleClick={() => pick(r)}>
            <div className="ps-aspect-box"><AspectBox w={r.width} h={r.height} /></div>
            <strong>{r.name}</strong>
            <span>{r.hint}</span>
          </button>
        ))}
      </div>
      <div style={{ marginTop: 18 }}>
        <label className="label" htmlFor="np-name">Project name (optional)</label>
        <input id="np-name" className="input" placeholder="Untitled project" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && pick(a)} />
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
        <input id="space-name" className="input" autoFocus placeholder="e.g. Marketing team" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} />
        <div className="row" style={{ justifyContent: 'flex-end', marginTop: 20 }}>
          <button type="button" className="btn ghost" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={busy || !name.trim()}>{busy && <Spinner />} Create space</button>
        </div>
      </form>
    </Modal>
  )
}

export function RenameSpaceModal({ ws, onClose }: { ws: Workspace; onClose: () => void }) {
  const [name, setName] = useState(ws.name)
  const [busy, setBusy] = useState(false)
  const refresh = useSession((s) => s.refreshWorkspaces)
  const trimmed = name.trim()
  async function submit(e: FormEvent) {
    e.preventDefault()
    if (!trimmed || trimmed === ws.name) return onClose()
    setBusy(true)
    try {
      const w = await api.renameWorkspace(ws.id, trimmed)
      await refresh()
      toast(`Renamed to “${w.name}”`)
      onClose()
    } catch (err) {
      toastError(err)
    } finally {
      setBusy(false)
    }
  }
  return (
    <Modal title="Rename space" subtitle="Everyone in the space sees the new name." onClose={onClose} width={480}>
      <form onSubmit={submit}>
        <label className="label" htmlFor="space-rename">Space name</label>
        <input id="space-rename" className="input" autoFocus value={name} onChange={(e) => setName(e.target.value)} onFocus={(e) => e.currentTarget.select()} maxLength={80} />
        <div className="row" style={{ justifyContent: 'flex-end', marginTop: 20 }}>
          <button type="button" className="btn ghost" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={busy || !trimmed}>{busy && <Spinner />} Save</button>
        </div>
      </form>
    </Modal>
  )
}

/** Spaces this tab deleted itself, so the live `workspace` event doesn't toast a second time. */
export const ownSpaceDeletes = new Set<string>()

/** Permanent delete, confirmed by typing the space's name. */
export function DeleteSpaceModal({ ws, onClose }: { ws: Workspace; onClose: () => void }) {
  const [typed, setTyped] = useState('')
  const [busy, setBusy] = useState(false)
  const refresh = useSession((s) => s.refreshWorkspaces)
  const ok = typed.trim() === ws.name.trim()
  async function submit(e: FormEvent) {
    e.preventDefault()
    if (!ok) return
    setBusy(true)
    try {
      ownSpaceDeletes.add(ws.id)
      await api.deleteWorkspace(ws.id)
      await refresh()
      toast(`Deleted “${ws.name}”`)
      onClose()
    } catch (err) {
      ownSpaceDeletes.delete(ws.id)
      toastError(err)
      setBusy(false)
    }
  }
  return (
    <Modal title={`Delete “${ws.name}”?`} subtitle="This can’t be undone." onClose={onClose} width={520}>
      <form onSubmit={submit}>
        <div className="ps-alert" style={{ marginBottom: 16 }}>
          <Trash2 size={16} style={{ flexShrink: 0, marginTop: 1 }} />
          <span>
            Every project, media file, export, template and the brand kit in this space is permanently deleted, {ws.memberCount > 1 ? `for all ${ws.memberCount} members` : 'for everyone in it'}. Share links stop working and
            linked desktops remove the space on their next sync.
          </span>
        </div>
        <label className="label" htmlFor="space-delete-confirm">Type <strong>{ws.name}</strong> to confirm</label>
        <input id="space-delete-confirm" className="input" autoFocus autoComplete="off" value={typed} onChange={(e) => setTyped(e.target.value)} />
        <div className="row" style={{ justifyContent: 'flex-end', marginTop: 20 }}>
          <button type="button" className="btn ghost" onClick={onClose}>Cancel</button>
          <button className="btn danger" disabled={busy || !ok}>{busy && <Spinner />} Delete space</button>
        </div>
      </form>
    </Modal>
  )
}

export function InviteForm({ workspaceId, onInvited }: { workspaceId: string; onInvited?: () => void }) {
  const [email, setEmail] = useState('')
  const [sentTo, setSentTo] = useState('')
  const [role, setRole] = useState('editor')
  const [busy, setBusy] = useState(false)
  const [url, setUrl] = useState<string>()
  const [err, setErr] = useState<string>()
  const [copied, setCopied] = useState(false)
  const [confirmOwner, setConfirmOwner] = useState(false)
  function submit(e: FormEvent) {
    e.preventDefault()
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) return setErr('Enter a valid email address')
    // an owner can delete the space and remove everyone in it: make that a deliberate choice
    if (role === 'owner') return setConfirmOwner(true)
    void create()
  }
  async function create() {
    setConfirmOwner(false)
    setBusy(true)
    setErr(undefined)
    try {
      const r = await api.invite(workspaceId, email.trim(), role)
      setUrl(absoluteUrl(r.inviteUrl))
      setSentTo(email.trim())
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
        <button className="btn primary" disabled={busy || !email}>{busy && <Spinner />} Create invite link</button>
      </form>
      {err && <div className="ps-field-err">{err}</div>}
      {url && (
        <div className="ps-alert info" style={{ marginTop: 14, alignItems: 'center' }}>
          <Link2 size={16} style={{ flex: 'none' }} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontWeight: 600, marginBottom: 2 }}>Invite link ready. Send it to {sentTo}: only that address can use it, once, within 7 days.</div>
            <code style={{ fontFamily: 'var(--font-mono)', fontSize: '0.75rem', wordBreak: 'break-all' }}>{url}</code>
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
      {confirmOwner && (
        <ConfirmDialog
          title={`Invite ${email.trim()} as an owner?`}
          body="Owners can invite and remove people, change everyone’s role, rename the space and delete it with everything in it. Editors can do everything else."
          confirmLabel="Create owner invite"
          onConfirm={() => void create()}
          onClose={() => setConfirmOwner(false)}
        />
      )}
    </div>
  )
}

/** Who may invite to a space: its owners, and nobody on a personal space. */
export const canInvite = (ws: Workspace | undefined) => !!ws && ws.role === 'owner' && !ws.personal
export const ONLY_OWNERS_INVITE = 'Only owners of this space can invite people'

export function InviteModal({ onClose }: { onClose: () => void }) {
  const workspaceId = useSession((s) => s.workspaceId)
  const ws = useSession((s) => s.workspaces.find((w) => w.id === s.workspaceId))
  return (
    <Modal title={`Invite to ${ws?.name ?? 'space'}`} subtitle={ws?.personal ? undefined : "Invitees get access to this space's projects, media and brand kit."} onClose={onClose} width={620}>
      {ws?.personal ? (
        <div className="ps-alert info">This is your personal space, just for you. To work with others, create a team space and invite people there.</div>
      ) : ws?.role !== 'owner' ? (
        <div className="muted">Only owners of {ws?.name ?? 'this space'} can invite people. Ask one of them to send you a link for your teammate.</div>
      ) : (
        workspaceId && <InviteForm workspaceId={workspaceId} />
      )}
    </Modal>
  )
}

const SHORTCUTS: Array<[string, Array<[string, string]>]> = [
  ['Anywhere', [['Search projects & media', 'Ctrl K'], ['Show this help', '?'], ['Cycle theme (system / dark / light)', 'Ctrl Shift L'], ['Close dialogs & menus', 'Esc']]],
  ['Dictation (desktop)', [['Dictate into the focused text box', 'Ctrl Shift Space'], ['Insert / cancel', 'Ctrl Shift Space / Esc'], ['Dictate into any app', 'Ctrl Alt D (Settings → Dictation)']]],
  ['Editor — global', [['Play / pause', 'Space'], ['Undo', 'Ctrl Z'], ['Redo', 'Ctrl Shift Z'], ['Select all', 'Ctrl A'], ['Copy / paste', 'Ctrl C / V'], ['Delete', 'Backspace']]],
  ['Editor — timeline', [['Split at playhead', 'Ctrl B'], ['Zoom timeline', 'Ctrl + / −'], ['Fit timeline', 'Shift Z'], ['Previous / next frame', 'Ctrl ← / →'], ['Separate audio', 'Ctrl Shift S'], ['Link / unlink clips', 'Ctrl L'], ['Add marker', 'M'], ['Next / previous marker', 'Shift M / Alt M']]],
  ['Editor — sound', [['J / L cut (sound leads or trails the picture)', 'Shift drag audio edge'], ['J / L cut to the playhead', 'Shift [ / ]'], ['Add a volume keyframe', 'Double-click the volume line']]],
  ['Editor — canvas', [['Move tool', 'V'], ['Hand tool', 'H'], ['Fit canvas', 'Shift F'], ['Nudge 1 px', '↑ ↓ ← →']]],
]

export function HelpModal({ onClose }: { onClose: () => void }) {
  const [tab, setTab] = useState<'keys' | 'about'>('keys')
  const info = useSystem((s) => s.info)
  const desktop = info?.mode === 'desktop'
  return (
    <Modal title="Help" onClose={onClose} width={720}>
      <div className="row" style={{ marginBottom: 18, gap: 12, flexWrap: 'wrap' }}>
        <Tabs
          id="help"
          className="ps-seg"
          label="Help"
          value={tab}
          onChange={setTab}
          tabs={[
            { id: 'keys', label: 'Keyboard shortcuts', icon: <Keyboard size={14} /> },
            { id: 'about', label: 'About' },
          ]}
        />
        <span className="spacer" />
        {!desktop && (
          <a className="btn sm" href={DESKTOP_DOWNLOAD_URL} target="_blank" rel="noreferrer">
            <MonitorDown size={14} /> Get the Windows app
          </a>
        )}
      </div>
      <TabPanel tabs="help" value={tab}>
        {tab === 'keys' ? (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(280px, 100%), 1fr))', gap: 22 }}>
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
              Producer Studio turns screen recordings into finished, on-brand videos. <b>Producer AI</b> transcribes your footage, writes a script with AI, narrates it and assembles
              the cut; the <b>Video Editor</b> gives you a full multi-track timeline to finish it; <b>Voice Studio</b> generates voiceovers from text.
            </p>
            <ul style={{ color: 'var(--text-2)', paddingLeft: 18, lineHeight: 1.8 }}>
              <li>Upload recordings from <b>Create new → Upload media</b> or drag files onto the Library.</li>
              <li>Everything in a space — projects, media, brand kit — is shared with its members.</li>
              <li>Exports and share links live under <b>Exports &amp; sharing</b>.</li>
            </ul>
            <div className="row" style={{ gap: 14, padding: 14, margin: '18px 0 14px', border: '1px solid var(--border)', borderRadius: 12, flexWrap: 'wrap' }}>
              <MonitorDown size={22} style={{ flex: 'none', color: 'var(--accent)' }} />
              <div style={{ flex: 1, minWidth: 220 }}>
                <strong style={{ display: 'block' }}>Producer Studio for Windows</strong>
                <span className="muted" style={{ fontSize: '0.8125rem' }}>
                  {desktop
                    ? 'You’re using the desktop app. Installing a newer release over it keeps your projects and settings.'
                    : 'Edit offline, keep media on your own drives, and clone voices, dub and dictate with Voice Studio. Link it to this account from its Settings → Account & sync.'}
                </span>
              </div>
              <a className={desktop ? 'btn' : 'btn primary'} href={DESKTOP_DOWNLOAD_URL} target="_blank" rel="noreferrer">
                <Download size={14} /> {desktop ? 'Latest release' : 'Download for Windows'}
              </a>
            </div>
            <p className="muted" style={{ fontSize: '0.75rem' }}>
              {info?.version ? `Version ${info.version}` : 'Version unknown'} · {desktop ? 'desktop' : 'cloud'}
            </p>
          </div>
        )}
      </TabPanel>
    </Modal>
  )
}
