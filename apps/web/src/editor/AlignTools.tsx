// Align and distribute buttons: in the properties panel and on the canvas's group toolbar.
import { AlignCenterHorizontal, AlignCenterVertical, AlignEndHorizontal, AlignEndVertical, AlignHorizontalDistributeCenter, AlignStartHorizontal, AlignStartVertical, AlignVerticalDistributeCenter } from 'lucide-react'
import { alignSelection, distributeSelection } from './canvasActions'
import type { AlignMode } from './canvasSnap'

const ALIGN: Array<{ mode: AlignMode; label: string; Icon: typeof AlignStartVertical }> = [
  { mode: 'left', label: 'Align left', Icon: AlignStartVertical },
  { mode: 'hcenter', label: 'Align centre', Icon: AlignCenterVertical },
  { mode: 'right', label: 'Align right', Icon: AlignEndVertical },
  { mode: 'top', label: 'Align top', Icon: AlignStartHorizontal },
  { mode: 'vcenter', label: 'Align middle', Icon: AlignCenterHorizontal },
  { mode: 'bottom', label: 'Align bottom', Icon: AlignEndHorizontal },
]

/** `count`: how many objects are selected (one aligns to the canvas; distributing needs three). */
export function AlignButtons({ count, className = 'ed-iconbtn', size = 14 }: { count: number; className?: string; size?: number }) {
  const toCanvas = count === 1
  return (
    <div className="row cv-align" role="group" aria-label={toCanvas ? 'Align to canvas' : 'Align and distribute'}>
      {ALIGN.map(({ mode, label, Icon }) => (
        <button key={mode} type="button" className={className} aria-label={toCanvas ? `${label} of the canvas` : label} title={toCanvas ? `${label} of the canvas` : label} onClick={() => alignSelection(mode)}>
          <Icon size={size} />
        </button>
      ))}
      {!toCanvas && (
        <>
          <button type="button" className={className} aria-label="Distribute horizontally" title="Distribute horizontally (3 or more)" disabled={count < 3} onClick={() => distributeSelection('x')}>
            <AlignHorizontalDistributeCenter size={size} />
          </button>
          <button type="button" className={className} aria-label="Distribute vertically" title="Distribute vertically (3 or more)" disabled={count < 3} onClick={() => distributeSelection('y')}>
            <AlignVerticalDistributeCenter size={size} />
          </button>
        </>
      )}
    </div>
  )
}
