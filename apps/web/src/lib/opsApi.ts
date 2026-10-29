// Client for the operations routes (contract: packages/core/src/operations.ts): a space's audit log (P-8) and the
// operator tools (P-10). Kept beside lib/api.ts so the two change independently.
import type { AuditEntry, OperatorJob, OperatorUser, OperatorUserDetail, OrphanScan, Page, StorageUsageRow } from '@producer/core'
import { req } from './api'

const enc = encodeURIComponent
const qs = (o: Record<string, string | number | undefined>) => {
  const p = Object.entries(o).filter(([, v]) => v !== undefined && v !== '')
  return p.length ? `?${p.map(([k, v]) => `${k}=${enc(String(v))}`).join('&')}` : ''
}

export const opsApi = {
  spaceAudit: (workspaceId: string, o: { kind?: string; cursor?: string } = {}) => req<Page<AuditEntry>>('GET', `/workspaces/${enc(workspaceId)}/audit${qs({ limit: 50, ...o })}`),

  users: (q: string) => req<OperatorUser[]>('GET', `/operator/users${qs({ q })}`),
  user: (id: string) => req<OperatorUserDetail>('GET', `/operator/users/${enc(id)}`),
  disable: (id: string, reason?: string) => req<OperatorUserDetail>('POST', `/operator/users/${enc(id)}/disable`, reason ? { reason } : {}),
  enable: (id: string) => req<OperatorUserDetail>('POST', `/operator/users/${enc(id)}/enable`),
  reset: (id: string, mode: 'mail' | 'link') => req<{ ok: true; mode: 'mail' | 'link'; emailed?: boolean; url?: string }>('POST', `/operator/users/${enc(id)}/reset`, { mode }),

  jobs: (o: { status?: string; kind?: string; workspaceId?: string; q?: string; cursor?: string } = {}) => req<Page<OperatorJob>>('GET', `/operator/jobs${qs({ limit: 50, ...o })}`),
  job: (id: string) => req<OperatorJob>('GET', `/operator/jobs/${enc(id)}`),
  requeue: (id: string) => req<OperatorJob>('POST', `/operator/jobs/${enc(id)}/requeue`),
  cancelJob: (id: string) => req<OperatorJob>('POST', `/operator/jobs/${enc(id)}/cancel`),

  storage: (q = '') => req<StorageUsageRow[]>('GET', `/operator/storage${qs({ q })}`),
  orphans: (scanId?: string) => req<OrphanScan>('POST', '/operator/storage/orphans', scanId ? { scanId } : {}),

  audit: (o: { q?: string; kind?: string; userId?: string; workspaceId?: string; cursor?: string } = {}) => req<Page<AuditEntry>>('GET', `/operator/audit${qs({ limit: 50, ...o })}`),
}
