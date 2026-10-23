// Says so when the server can't use its media storage (added 23 Oct 2026). Railway rotated the bucket's
// credentials and producerstudio.app kept running on the old ones: every thumbnail went black and every new
// upload sat on "Processing", with nothing on screen saying why. The server now checks its storage every few
// minutes (/api/system → storage); this shows the result while it's broken and leaves once it's fixed.
import { AlertTriangle } from 'lucide-react'
import { useEffect } from 'react'
import { useSystem } from './system'

export function StorageBanner() {
  const storage = useSystem((s) => s.info?.storage)
  const load = useSystem((s) => s.load)
  useEffect(() => {
    if (!useSystem.getState().loaded) void load()
    // keep looking while it's broken, so the banner goes away by itself once storage works again
    const t = window.setInterval(() => {
      if (useSystem.getState().info?.storage?.status === 'error') void load()
    }, 60_000)
    return () => window.clearInterval(t)
  }, [load])
  if (storage?.status !== 'error') return null
  return (
    <div className="ps-storage-banner" role="alert">
      <AlertTriangle size={16} />
      <div>
        <b>Media storage isn't working right now.</b> Thumbnails, previews and new uploads will fail until it's fixed.
        {storage.error && <span className="why">{storage.error}</span>}
      </div>
    </div>
  )
}
