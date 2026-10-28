// AI assistant: chat that edits the timeline. Streams text + tool events; on `done` with a project its changes are
// applied to the project as it is by then (one undo step) and the change list is shown.
import type { AssistantMessage, Project } from '@producer/core'
import clsx from 'clsx'
import { ArrowUp, Bot, Loader2, Sparkles, TriangleAlert, Undo2, Wrench } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { scrollBehavior } from '../../lib/appearance'
import { api } from '../../lib/api'
import { aiLabel, aiProviderLabel, systemApi, useSystem } from '../../shell/system'
import { toastError } from '../../lib/toast'
import * as A from '../actions'
import { rebase } from '../rebase'
import { useEditor } from '../store'

interface ChatMsg {
  role: 'user' | 'assistant'
  text: string
  tools?: Array<{ name: string; summary: string }>
  changes?: string[]
  /** The project changed in the same places while the assistant worked, so its edit was not applied. */
  notApplied?: boolean
  pending?: boolean
  error?: boolean
}

const SUGGESTIONS = ['Add captions', 'Cut the pauses', 'Add a title at the start', 'Make it vertical 9:16']

const history = new Map<string, ChatMsg[]>()

/**
 * The assistant edited the project as it was when you asked (`base`). Apply its changes to the project as it is
 * now, keeping what you did meanwhile; false when both touched the same thing (nothing is overwritten).
 */
function applyResult(base: Project, theirs: Project, session: number): boolean {
  const now = useEditor.getState()
  // another project is open now: the answer was for the one you left
  if (now.session !== session) return false
  const result = A.captionsAtLeastOneFrame(theirs)
  const next = now.project === base ? result : rebase(base, result, now.project)
  if (!next) return false
  now.commit(next, 'AI edit')
  return true
}

/** "Answered by Gemini · gemini-3-pro": the provider the editor assistant resolves to for this workspace. */
function useAssistantProvider(): string | undefined {
  const workspaceId = useEditor((s) => s.workspaceId)
  const demo = useEditor((s) => s.demo)
  const info = useSystem((s) => s.info)
  const [label, setLabel] = useState<string>()
  useEffect(() => {
    // desktop ignores workspaceId; the editor route may not have loaded /api/system, so don't depend on it
    if (demo || !workspaceId) return
    let alive = true
    systemApi
      .aiSettings(workspaceId)
      .then((st) => alive && setLabel(aiProviderLabel(st.effective.assistant.provider, st.effective.assistant.model)))
      .catch(() => alive && setLabel(info?.ai.available ? aiLabel(info) : undefined))
    return () => {
      alive = false
    }
  }, [workspaceId, demo, info])
  return label === 'AI unavailable' ? undefined : label
}

export function AssistantPanel() {
  const projectId = useEditor((s) => s.projectId)
  const answeredBy = useAssistantProvider()
  const [msgs, setMsgs] = useState<ChatMsg[]>(() => history.get(projectId) ?? [])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const listRef = useRef<HTMLDivElement>(null)
  const abort = useRef<AbortController | null>(null)

  useEffect(() => {
    history.set(projectId, msgs)
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: scrollBehavior() })
  }, [msgs, projectId])
  useEffect(() => () => abort.current?.abort(), [])

  /** `again`: the same request on the edit as it is now, in place of the reply that couldn't be applied. */
  const send = async (text: string, again = false) => {
    const t = text.trim()
    if (!t || busy) return
    if (A.demoBlocked('the AI assistant')) return
    const s = useEditor.getState()
    const next: ChatMsg[] = [...(again ? msgs.slice(0, -2) : msgs), { role: 'user', text: t }, { role: 'assistant', text: '', tools: [], pending: true }]
    setMsgs(next)
    setInput('')
    setBusy(true)
    const messages: AssistantMessage[] = next.filter((m) => !m.pending && !m.error).map((m) => ({ role: m.role, text: m.text }))
    const patchLast = (fn: (m: ChatMsg) => ChatMsg) => setMsgs((cur) => cur.map((m, i) => (i === cur.length - 1 ? fn(m) : m)))
    abort.current = new AbortController()
    try {
      const res = await api.assistant(
        { projectId: s.projectId, project: s.project, playhead: s.playhead, selection: s.selection, messages },
        {
          text: (d) => patchLast((m) => ({ ...m, text: m.text + d })),
          tool: (name, summary) => patchLast((m) => ({ ...m, tools: [...(m.tools ?? []), { name, summary }] })),
        },
        abort.current.signal,
      )
      const applied = res.project ? applyResult(s.project, res.project, s.session) : true
      patchLast((m) => ({ ...m, text: res.text || m.text, changes: res.changes, pending: false, notApplied: !applied }))
    } catch (e) {
      patchLast((m) => ({ ...m, text: m.text || (e instanceof Error ? e.message : 'Something went wrong'), pending: false, error: true }))
      if (!(e instanceof DOMException && e.name === 'AbortError')) toastError(e)
    } finally {
      setBusy(false)
      abort.current = null
    }
  }

  return (
    <div className="ed-ai">
      <div className="ai-list" ref={listRef}>
        {!msgs.length && (
          <div className="ai-intro">
            <div className="ai-badge"><Sparkles size={18} /></div>
            <h4>Edit by asking</h4>
            <p>Describe the change — the assistant edits the timeline with the same tools you use, and every change lands on the undo stack.</p>
          </div>
        )}
        {msgs.map((m, i) => (
          <div key={i} className={clsx('ai-msg', m.role, m.error && 'error')}>
            {m.role === 'assistant' && <div className="ai-av"><Bot size={13} /></div>}
            <div className="ai-bubble">
              {m.text && <div className="ai-text">{m.text}</div>}
              {m.tools && m.tools.length > 0 && (
                <ul className="ai-tools">
                  {m.tools.map((t, j) => (
                    <li key={j}><Wrench size={11} /> <b>{t.name}</b> {t.summary}</li>
                  ))}
                </ul>
              )}
              {m.pending && !m.text && <div className="ai-typing"><Loader2 size={13} className="spin" /> Thinking…</div>}
              {m.changes && m.changes.length > 0 && (
                <div className="ai-changes">
                  <div className="eyebrow">{m.notApplied ? 'Changes (not applied)' : 'Changes'}</div>
                  <ul>{m.changes.map((c, j) => <li key={j}>{c}</li>)}</ul>
                  {i === msgs.length - 1 && !m.notApplied && (
                    <button className="btn sm" onClick={() => useEditor.getState().undo()}><Undo2 size={13} /> Undo</button>
                  )}
                </div>
              )}
              {m.notApplied && (
                <div className="ai-stale" role="status">
                  <TriangleAlert size={13} />
                  <span>You changed the same part of the edit while I was working, so I didn’t apply this: it would have undone your changes.</span>
                  {i === msgs.length - 1 && i > 0 && msgs[i - 1].role === 'user' && (
                    <button className="btn sm" disabled={busy} onClick={() => void send(msgs[i - 1].text, true)}>Run again on the current edit</button>
                  )}
                </div>
              )}
            </div>
          </div>
        ))}
      </div>
      <div className="ai-foot">
        <div className="ed-chiprow">
          {SUGGESTIONS.map((s) => (
            <button key={s} className="chip" onClick={() => void send(s)} disabled={busy}>{s}</button>
          ))}
        </div>
        <form
          className="ai-input"
          onSubmit={(e) => {
            e.preventDefault()
            void send(input)
          }}
        >
          <textarea
            rows={2}
            aria-label="Ask the assistant"
            placeholder="e.g. Split at the playhead and add a zoom transition"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                void send(input)
              }
            }}
          />
          <button className="btn primary sm icon" type="submit" disabled={busy || !input.trim()} title="Send">
            {busy ? <Loader2 size={14} className="spin" /> : <ArrowUp size={15} />}
          </button>
        </form>
        {answeredBy && <div className="ai-caption">Answered by {answeredBy}</div>}
      </div>
    </div>
  )
}
