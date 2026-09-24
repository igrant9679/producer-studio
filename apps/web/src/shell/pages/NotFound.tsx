import { Compass } from 'lucide-react'
import { Link } from 'react-router-dom'
import { EmptyState, usePageTitle } from '../ui'

export default function NotFound() {
  usePageTitle('Not found')
  return (
    <div className="ps-page narrow" style={{ paddingTop: 80 }}>
      <EmptyState icon={<Compass size={24} />} title="This page wandered off" body="The link may be old or mistyped." action={<Link className="btn primary" to="/">Back to Home</Link>} />
    </div>
  )
}
