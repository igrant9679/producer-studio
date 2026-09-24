// Cross-page actions (create project → open editor, etc.).
import { useCallback, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '../lib/api'
import { useSession } from '../lib/session'
import { toastError } from '../lib/toast'

export type EditorTab = 'media' | 'text' | 'captions' | 'transcript' | 'audio' | 'effects' | 'transitions' | 'filters' | 'brand' | 'ai'

/** Returns [create, busy]. create() makes a new edit project and opens it in the editor. */
export function useCreateAndOpen() {
  const navigate = useNavigate()
  const workspaceId = useSession((s) => s.workspaceId)
  const [busy, setBusy] = useState(false)
  const create = useCallback(
    async (opts: { width?: number; height?: number; name?: string; templateId?: string; tab?: EditorTab } = {}) => {
      if (!workspaceId) return
      setBusy(true)
      try {
        const res = await api.createProject({ workspaceId, width: opts.width, height: opts.height, name: opts.name ?? (opts.templateId ? undefined : 'Untitled project'), templateId: opts.templateId })
        navigate(`/edit/${res.summary.id}${opts.tab ? `?tab=${opts.tab}` : ''}`)
        return res
      } catch (e) {
        toastError(e)
      } finally {
        setBusy(false)
      }
    },
    [workspaceId, navigate],
  )
  return [create, busy] as const
}
