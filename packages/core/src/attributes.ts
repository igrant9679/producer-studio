// Paste attributes: copy one clip's colour, effects, transform, speed or volume onto other clips.
import { clone, editable, findItem, setItemSpeed, updateItem } from './ops'
import type { AnimProp, Item, Keyframes, Project } from './types'
import { uid } from './util'

export type AttributeGroup = 'colour' | 'effects' | 'transform' | 'speed' | 'volume'

export const ATTRIBUTE_GROUPS: Array<{ id: AttributeGroup; name: string; hint: string }> = [
  { id: 'colour', name: 'Colour', hint: 'Adjustments, filter, curves, HSL and LUT' },
  { id: 'effects', name: 'Effects', hint: 'The effects and their strengths' },
  { id: 'transform', name: 'Transform', hint: 'Position, scale, rotation, flip, opacity, blend, crop and their keyframes' },
  { id: 'speed', name: 'Speed', hint: 'Playback speed' },
  { id: 'volume', name: 'Volume', hint: 'Level, mute, fades and volume keyframes' },
]

const MOTION: AnimProp[] = ['x', 'y', 'scale', 'rotation', 'opacity']

/** Whether a clip has (and so can give or take) a group of attributes. */
export function hasAttributes(it: Item, g: AttributeGroup): boolean {
  switch (g) {
    case 'colour':
      return it.type === 'video' || it.type === 'image' || it.type === 'adjustment'
    case 'effects':
      return 'effects' in it
    case 'transform':
      return 'transform' in it
    case 'speed':
      return (it.type === 'video' && it.freezeAt === undefined) || it.type === 'audio'
    case 'volume':
      return it.type === 'video' || it.type === 'audio'
  }
}

/** The groups that can go from `src` onto at least one of `targets`. */
export function pastableGroups(src: Item, targets: Item[]): AttributeGroup[] {
  return ATTRIBUTE_GROUPS.map((g) => g.id).filter((g) => hasAttributes(src, g) && targets.some((t) => t.id !== src.id && hasAttributes(t, g)))
}

function pickKeyframes(kf: Keyframes | undefined, props: AnimProp[]): Keyframes {
  const out: Keyframes = {}
  for (const p of props) if (kf?.[p]?.length) out[p] = clone(kf[p])
  return out
}

/**
 * `src`'s attributes in `groups` onto every clip in `targetIds` that has them (locked clips and the source itself are
 * left alone). Keyframes keep their times from the clip's start; fades are kept inside a shorter clip.
 */
export function pasteAttributes(p0: Project, src: Item, targetIds: string[], groups: AttributeGroup[]): Project {
  let p = p0
  for (const id of targetIds) {
    const f = findItem(p, id)
    if (!editable(f) || id === src.id) continue
    const it = f.item
    const patch: Record<string, unknown> = {}
    const keyframes: Keyframes = { ...('keyframes' in it ? it.keyframes : {}) }
    let kfChanged = false
    for (const g of groups) {
      if (!hasAttributes(src, g) || !hasAttributes(it, g)) continue
      if (g === 'colour' && 'adjust' in src) {
        patch.adjust = clone(src.adjust)
        patch.filter = clone(src.filter)
        patch.grade = clone(src.grade)
      } else if (g === 'effects' && 'effects' in src) {
        patch.effects = src.effects.map((e) => ({ ...e, id: uid('fx') }))
      } else if (g === 'transform' && 'transform' in src && 'transform' in it) {
        patch.transform = clone(src.transform)
        patch.opacity = src.opacity
        patch.blend = src.blend
        if ((it.type === 'video' || it.type === 'image') && (src.type === 'video' || src.type === 'image')) {
          patch.crop = clone(src.crop)
          patch.fit = src.fit
        }
        for (const prop of MOTION) delete keyframes[prop]
        Object.assign(keyframes, pickKeyframes(src.keyframes, MOTION))
        kfChanged = true
      } else if (g === 'volume' && (src.type === 'video' || src.type === 'audio') && (it.type === 'video' || it.type === 'audio')) {
        const half = it.duration / 2
        patch.volume = src.volume
        patch.muted = src.muted
        patch.fadeIn = Math.min(src.fadeIn, half)
        patch.fadeOut = Math.min(src.fadeOut, half)
        delete keyframes.volume
        Object.assign(keyframes, pickKeyframes(src.keyframes, ['volume']))
        kfChanged = true
      }
    }
    if (kfChanged) patch.keyframes = keyframes
    if (Object.keys(patch).length) p = updateItem(p, id, patch as Partial<Item>)
    // speed last: it rescales the clip's keyframes and fades to the new length
    if (groups.includes('speed') && hasAttributes(src, 'speed') && hasAttributes(it, 'speed') && 'speed' in src) p = setItemSpeed(p, id, src.speed)
  }
  return p
}
