// Share-link management (A-16): a list of links with who made each, views and when last viewed, and for editors
// copy, settings (expiry, password, downloads, comments) and revoke. Used by the Exports page (the space's links)
// and the editor's Share dialog (one project's).
import type { ShareLinkDetails, ShareLinkSettings } from '@producer/core'
import { SHARE_PASSWORD_MIN } from '@producer/core'
import { Check, Copy, Download, Eye, KeyRound, Link2, Link2Off, MessageSquare, Plus, Settings2 } from 'lucide-react'
import { useEffect, useId, useState } from 'react'
import { HttpError } from '../../lib/api'
import { collabApi } from '../../lib/collabApi'
import { toast, toastError } from '../../lib/toast'
import { ConfirmDialog, Modal, Spinner, useEditGate } from '../ui'
import { absoluteUrl, copyText, relativeTime } from '../util'
import './share-links.css'

const DAY = 24 * 3600_000
const EXPIRY: Array<{ id: string; label: string; ms: number | null }> = [
  { id: 'never', label: 'Never', ms: null },
  { id: '1d', label: 'In 1 day', ms: DAY },
  { id: '7d', label: 'In 7 days', ms: 7 * DAY },
  { id: '30d', label: 'In 30 days', ms: 30 * DAY },
]

export interface Gate {
  canEdit: boolean
  tip?: string
}

/** "Expires in 3 days", "Expired 2 hours ago", "Never expires". */
export function expiryText(l: Pick<ShareLinkDetails, 'expiresAt'>, now = Date.now()): string {
  if (l.expiresAt == null) return 'Never expires'
  const d = l.expiresAt - now
  if (d <= 0) return `Expired ${relativeTime(l.expiresAt, now)}`
  const days = Math.round(d / DAY)
  if (days >= 1) return `Expires in ${days} day${days === 1 ? '' : 's'}`
  const h = Math.max(1, Math.round(d / 3600_000))
  return `Expires in ${h} hour${h === 1 ? '' : 's'}`
}

function SettingsForm({ link, onSaved, onCancel }: { link: ShareLinkDetails; onSaved: (l: ShareLinkDetails) => void; onCancel: () => void }) {
  const id = useId()
  const [expiry, setExpiry] = useState('keep')
  const [password, setPassword] = useState('')
  const [removePassword, setRemovePassword] = useState(false)
  const [allowDownload, setAllowDownload] = useState(link.allowDownload)
  const [allowComments, setAllowComments] = useState(link.allowComments)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string>()

  async function save(e: React.FormEvent) {
    e.preventDefault()
    const body: ShareLinkSettings = {}
    if (expiry !== 'keep') {
      const ms = EXPIRY.find((x) => x.id === expiry)!.ms
      body.expiresAt = ms === null ? null : Date.now() + ms
    }
    if (password) {
      if (password.length < SHARE_PASSWORD_MIN) return setErr(`A password needs at least ${SHARE_PASSWORD_MIN} characters.`)
      body.password = password
    } else if (removePassword) body.password = null
    if (allowDownload !== link.allowDownload) body.allowDownload = allowDownload
    if (allowComments !== link.allowComments) body.allowComments = allowComments
    setBusy(true)
    setErr(undefined)
    try {
      onSaved(await collabApi.updateShare(link.token, body))
      toast('Link settings saved')
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : String(e2))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className="ps-share-settings" onSubmit={save} aria-label="Link settings">
      <div className="ps-share-settings-grid">
        <div>
          <label className="label" htmlFor={`${id}-exp`}>Expiry</label>
          <select id={`${id}-exp`} className="input" value={expiry} onChange={(e) => setExpiry(e.target.value)}>
            <option value="keep">{expiryText(link)} (keep)</option>
            {EXPIRY.map((x) => (
              <option key={x.id} value={x.id}>{x.id === 'never' ? 'Never expires' : `Expires ${x.label.toLowerCase()}`}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="label" htmlFor={`${id}-pw`}>{link.hasPassword ? 'New password' : 'Password'}</label>
          <input id={`${id}-pw`} className="input" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder={link.hasPassword ? 'Leave empty to keep it' : 'None: anyone with the link can watch'} />
          {link.hasPassword && (
            <label className="ps-share-check">
              <input type="checkbox" checked={removePassword} disabled={!!password} onChange={(e) => setRemovePassword(e.target.checked)} /> Remove the password
            </label>
          )}
        </div>
      </div>
      <label className="ps-share-check">
        <input type="checkbox" checked={allowDownload} onChange={(e) => setAllowDownload(e.target.checked)} /> Allow downloads <span className="muted">(the page offers the file; the video plays either way)</span>
      </label>
      <label className="ps-share-check">
        <input type="checkbox" checked={allowComments} onChange={(e) => setAllowComments(e.target.checked)} /> Allow comments <span className="muted">(visitors leave timecoded notes with their name)</span>
      </label>
      {err && <div className="ps-field-err" role="alert">{err}</div>}
      <div className="row" style={{ gap: 6, justifyContent: 'flex-end' }}>
        <button type="button" className="btn sm ghost" onClick={onCancel}>Cancel</button>
        <button type="submit" className="btn sm primary" disabled={busy}>{busy && <Spinner size={12} />} Save</button>
      </div>
    </form>
  )
}

function LinkRow({ link, gate, showProject, onChange, onRemove }: { link: ShareLinkDetails; gate: Gate; showProject: boolean; onChange: (l: ShareLinkDetails) => void; onRemove: (token: string) => void }) {
  const [editing, setEditing] = useState(false)
  const [confirm, setConfirm] = useState(false)
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState(false)
  const url = absoluteUrl(link.url)
  const name = showProject ? link.projectName : link.exportName ?? 'Shared export'

  async function copy() {
    if (await copyText(url)) {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } else toast(url)
  }
  async function revoke() {
    setBusy(true)
    try {
      await collabApi.revokeShare(link.token)
      onRemove(link.token)
      toast('Link revoked: it no longer works for anyone')
    } catch (e) {
      toastError(e)
    } finally {
      setBusy(false)
      setConfirm(false)
    }
  }

  return (
    <li className={`ps-share-link${link.expired ? ' expired' : ''}`} aria-label={`${name} link`}>
      <div className="ps-share-link-main">
        <div className="ps-share-link-head">
          <strong>{name}</strong>
          {showProject && link.exportName && <span className="muted">{link.exportName}</span>}
          <span className="ps-share-chips">
            {link.expired && <span className="chip danger">Expired</span>}
            {link.hasPassword && <span className="chip"><KeyRound size={11} aria-hidden="true" /> Password</span>}
            <span className="chip"><Download size={11} aria-hidden="true" /> {link.allowDownload ? 'Downloads on' : 'Downloads off'}</span>
            <span className="chip"><MessageSquare size={11} aria-hidden="true" /> {link.allowComments ? 'Comments on' : 'Comments off'}</span>
          </span>
        </div>
        <div className="ps-share-link-meta">
          <span>Made by {link.createdBy.name} {relativeTime(link.createdAt)}</span>
          <span><Eye size={12} aria-hidden="true" /> {link.views} view{link.views === 1 ? '' : 's'}{link.lastViewedAt ? `, last ${relativeTime(link.lastViewedAt)}` : ''}</span>
          <span>{expiryText(link)}</span>
        </div>
      </div>
      <div className="row" style={{ gap: 6 }}>
        <button className="btn sm" onClick={() => void copy()} aria-label={`Copy the ${name} link`}>{copied ? <Check size={13} /> : <Copy size={13} />} {copied ? 'Copied' : 'Copy'}</button>
        <button className="btn sm" onClick={() => setEditing((e) => !e)} aria-expanded={editing} disabled={!gate.canEdit} data-tip={gate.tip} aria-label={`Settings for the ${name} link`}>
          <Settings2 size={13} /> Settings
        </button>
        <button className="btn sm ghost" onClick={() => setConfirm(true)} disabled={!gate.canEdit || busy} data-tip={gate.tip ?? 'Revoke'} data-tip-desc={gate.tip ? undefined : 'The link stops working for everyone who has it'} aria-label={`Revoke the ${name} link`}>
          <Link2Off size={13} />
        </button>
      </div>
      {editing && (
        <SettingsForm
          link={link}
          onCancel={() => setEditing(false)}
          onSaved={(l) => {
            onChange(l)
            setEditing(false)
          }}
        />
      )}
      {confirm && <ConfirmDialog title="Revoke this link?" body="Everyone who has it loses access at once. You can always make a new link." confirmLabel="Revoke link" busy={busy} onConfirm={() => void revoke()} onClose={() => setConfirm(false)} />}
    </li>
  )
}

export function ShareLinkList({ links, gate, showProject = false, onChange }: { links: ShareLinkDetails[]; gate: Gate; showProject?: boolean; onChange: (links: ShareLinkDetails[]) => void }) {
  if (!links.length) return <p className="muted ps-share-none">No share links yet.</p>
  return (
    <ul className="ps-share-links" aria-label="Share links">
      {links.map((l) => (
        <LinkRow key={l.token} link={l} gate={gate} showProject={showProject} onChange={(n) => onChange(links.map((x) => (x.token === n.token ? n : x)))} onRemove={(t) => onChange(links.filter((x) => x.token !== t))} />
      ))}
    </ul>
  )
}

/** The editor's Share dialog: this project's links, a new one, and their settings. */
export function ShareLinksDialog({ projectId, gate, onClose, onExportFirst }: { projectId: string; gate: Gate; onClose: () => void; onExportFirst: () => void }) {
  const [links, setLinks] = useState<ShareLinkDetails[]>()
  const [error, setError] = useState<string>()
  const [noExport, setNoExport] = useState(false)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let alive = true
    collabApi
      .projectShares(projectId)
      .then((l) => alive && setLinks(l))
      .catch((e) => alive && setError(e instanceof Error ? e.message : String(e)))
    return () => {
      alive = false
    }
  }, [projectId])

  async function create() {
    setBusy(true)
    try {
      const l = await collabApi.createShare(projectId, { new: !!links?.length })
      setLinks((cur) => [l, ...(cur ?? []).filter((x) => x.token !== l.token)])
      if (await copyText(absoluteUrl(l.url))) toast('New review link copied')
    } catch (e) {
      if (e instanceof HttpError && e.status === 409) setNoExport(true)
      else toastError(e)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      title="Share for review"
      subtitle="Each link shows a finished export. Give different people different links: each has its own expiry, password, downloads and comments."
      onClose={onClose}
      width={720}
      footer={
        <>
          <button className="btn ghost" onClick={onClose}>Done</button>
          <button className="btn primary" onClick={() => void create()} disabled={!gate.canEdit || busy} data-tip={gate.tip}>
            {busy ? <Spinner size={13} /> : links?.length ? <Plus size={14} /> : <Link2 size={14} />} {links?.length ? 'New link' : 'Create a link'}
          </button>
        </>
      }
    >
      {noExport && (
        <div className="ps-alert info" role="status">
          <span>Export the video first: a share link shows a finished export.</span>
          <span className="spacer" />
          <button className="btn sm primary" onClick={onExportFirst}>Export</button>
        </div>
      )}
      {error ? <div className="ps-alert" role="alert">{error}</div> : !links ? <Spinner size={18} /> : <ShareLinkList links={links} gate={gate} onChange={setLinks} />}
    </Modal>
  )
}

/** The Exports page's section: every share link in the space, newest first. */
export function SpaceShareLinks({ workspaceId }: { workspaceId: string }) {
  const gate = useEditGate()
  const [links, setLinks] = useState<ShareLinkDetails[]>()
  const [error, setError] = useState(false)
  useEffect(() => {
    let alive = true
    setLinks(undefined)
    setError(false)
    collabApi
      .spaceShares(workspaceId)
      .then((l) => alive && setLinks(l))
      .catch(() => alive && setError(true))
    return () => {
      alive = false
    }
  }, [workspaceId])
  return (
    <section className="ps-section" aria-labelledby="ps-share-links-title">
      <div className="ps-share-links-head">
        <h2 id="ps-share-links-title">Share links</h2>
        <span className="muted">Who made each, how often it was watched, and its settings.</span>
      </div>
      {error ? <div className="ps-alert">Couldn’t load the share links.</div> : !links ? <Spinner size={18} /> : <ShareLinkList links={links} gate={gate} showProject onChange={setLinks} />}
    </section>
  )
}
