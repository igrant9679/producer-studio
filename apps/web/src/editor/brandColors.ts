// The brand colours every colour field offers (tracker #5): the space's brand kit, loaded once per space (again when
// it is saved elsewhere), else the colours the project carries from its kit. No kit: none.
import { useEffect, useState } from 'react'
import { api } from '../lib/api'
import { useEditor } from './store'
import { useLibrary } from './uploads'

const cache = new Map<string, Promise<string[]>>()

function kitColours(workspaceId: string, rev: number): Promise<string[]> {
  const key = `${workspaceId}:${rev}`
  let p = cache.get(key)
  if (!p) {
    p = api
      .brand(workspaceId)
      .then((b) => b?.colors ?? [])
      .catch(() => [])
    cache.set(key, p)
  }
  return p
}

export function useBrandColors(): string[] {
  const demo = useEditor((s) => s.demo)
  const workspaceId = useEditor((s) => s.workspaceId)
  const projectColours = useEditor((s) => s.project.brand?.colors)
  const rev = useLibrary((s) => s.brandRev)
  const [kit, setKit] = useState<string[] | null>(null)
  useEffect(() => {
    if (demo || !workspaceId) return
    let alive = true
    void kitColours(workspaceId, rev).then((c) => alive && setKit(c))
    return () => {
      alive = false
    }
  }, [demo, workspaceId, rev])
  const list = kit?.length ? kit : (projectColours ?? [])
  return [...new Set(list.map((c) => c.toLowerCase()))].slice(0, 12)
}
