// AI assistant: chat that edits the timeline. Streams text + tool events; on `done` with a project the new
// document is committed through the store (one undo step) and the change list is shown.
import type { AssistantMessage } from '@producer/core'
import clsx from 'clsx'
import { ArrowUp, Bot, Loader2, Sparkles, Undo2, Wrench } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { api } from '../../lib/api'
import { toastError } from '../../lib/toast'
import * as A from '../actions'
import { useEditor } from '../store'

interface ChatMsg {
  role: 'user' | 'assistant'
  text: string
  tools?: Array<{ name: string; summary: string }>
  changes?: string[]
  pending?: boolean
  error?: boolean
}

const SUGGESTIONS = ['Add captions', 'Cut the pauses', 'Add a title at the start', 'Make it vertical 9:16']

const history = new Map<string, ChatMsg[]>()

export function AssistantPanel() {
  const projectId = useEditor((s) => s.projectId)
  const [msgs, setMsgs] = useState<ChatMsg[]>(() => history.get(projectId) ?? [])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const listRef = useRef<HTMLDivElement>(null)
  const abort = useRef<AbortController | null>(null)

  useEffect(() => {
    history.set(projectId, msgs)
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: 'smooth' })
  }, [msgs, projectId])
  useEffect(() => () => abort.current?.abort(), [])

  const send = async (text: string) => {
    const t = text.trim()
    if (!t || busy) return
    if (A.demoBlocked('the AI assistant')) return
    const s = useEditor.getState()
    const next: ChatMsg[] = [...msgs, { role: 'user', text: t }, { role: 'assistant', text: '', tools: [], pending: true }]
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
      if (res.project) useEditor.getState().commit(res.project, 'AI edit')
      patchLast((m) => ({ ...m, text: res.text || m.text, changes: res.changes, pending: false }))
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
                  <div className="eyebrow">Changes</div>
                  <ul>{m.changes.map((c, j) => <li key={j}>{c}</li>)}</ul>
                  {i === msgs.length - 1 && (
                    <button className="btn sm" onClick={() => useEditor.getState().undo()}><Undo2 size={13} /> Undo</button>
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
      </div>
    </div>
  )
}
