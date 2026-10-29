// The tabs above a space's history: Activity (what happened to the work) and, for owners, Audit (who changed access).
import { NavLink } from 'react-router-dom'
import { currentWorkspace, useSession } from '../../lib/session'

export function SpaceLogTabs() {
  const ws = useSession(currentWorkspace)
  if (ws?.role !== 'owner') return null
  return (
    <nav className="ps-tabs ps-tab-links" aria-label="Space history">
      <NavLink to="/activity" className={({ isActive }) => (isActive ? 'on' : undefined)}>Activity</NavLink>
      <NavLink to="/audit" className={({ isActive }) => (isActive ? 'on' : undefined)}>Audit</NavLink>
    </nav>
  )
}
