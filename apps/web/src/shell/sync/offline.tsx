// "Available offline" in the library (D-9, desktop while linked): a project menu item to keep a project's clips on
// this computer, a badge on projects kept offline (or still downloading for it), and a badge on clips whose files
// are only in the cloud.
import type { OfflineInfo } from '@producer/core'
import { CloudDownload, HardDriveDownload } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { toast, toastError } from '../../lib/toast'
import { systemApi, useIsDesktop, useSystem } from '../system'
import type { MenuItemDef } from '../ui'
import { formatBytes } from '../util'
import './sync.css'

export function useOffline(workspaceId: string | undefined) {
  const desktop = useIsDesktop()
  const linked = useSystem((s) => !!s.sync?.linked)
  const lastSync = useSystem((s) => s.sync?.lastSyncAt)
  const [info, setInfo] = useState<OfflineInfo>()
  const on = desktop && linked && !!workspaceId
  const load = useCallback(() => {
    if (!on) return
    systemApi
      .offline(workspaceId!)
      .then(setInfo)
      .catch(() => undefined)
  }, [on, workspaceId])
  useEffect(() => {
    if (!on) return setInfo(undefined)
    load()
  }, [on, load, lastSync])
  // while a project kept offline is still downloading, check again every few seconds
  const downloading = !!info && Object.values(info.projects).some((p) => p.missing > 0)
  useEffect(() => {
    if (!downloading) return
    const t = setInterval(load, 4000)
    return () => clearInterval(t)
  }, [downloading, load])
  const setPinned = useCallback(
    async (projectId: string, pinned: boolean, name: string) => {
      try {
        setInfo(await systemApi.setOffline(projectId, pinned))
        toast(pinned ? `“${name}” is being kept on this computer` : `“${name}” is no longer kept offline (what’s downloaded stays)`)
      } catch (e) {
        toastError(e)
      }
    },
    [],
  )
  return { on, info, setPinned }
}

export type OfflineState = ReturnType<typeof useOffline>

/** The project menu's toggle (none when not a linked desktop). */
export function offlineMenuItem(o: OfflineState, p: { id: string; name: string }): MenuItemDef[] {
  if (!o.on) return []
  const pinned = !!o.info?.projects[p.id]?.pinned
  return [{ label: pinned ? 'Stop keeping offline' : 'Keep available offline', icon: <HardDriveDownload size={15} />, sub: pinned ? undefined : 'Download every clip it uses', onClick: () => void o.setPinned(p.id, !pinned, p.name) }]
}

export function OfflineBadge({ o, projectId }: { o: OfflineState; projectId: string }) {
  const p = o.info?.projects[projectId]
  if (!o.on || !p?.pinned) return null
  const label = p.missing ? `Downloading for offline use: ${p.missing} clip${p.missing === 1 ? '' : 's'} left${p.missingBytes ? ` (${formatBytes(p.missingBytes)})` : ''}` : 'Available offline'
  return (
    <span className="ps-offline-badge" data-state={p.missing ? 'downloading' : 'ready'} role="img" title={label} aria-label={label}>
      <HardDriveDownload size={11} />
    </span>
  )
}

export function CloudOnlyBadge({ o, assetId }: { o: OfflineState; assetId: string }) {
  if (!o.on || !o.info?.cloudOnly.includes(assetId)) return null
  const label = 'Only in the cloud: it downloads when you open it'
  return (
    <span className="ps-cloud-badge" role="img" title={label} aria-label={label}>
      <CloudDownload size={11} />
    </span>
  )
}
