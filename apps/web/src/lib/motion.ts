// Reduced motion for video (A-24). CSS animations already stop under data-reduce-motion (theme.css); video is not
// CSS, so: hover previews don't play (useReducedMotion), and a video that would start by itself (autoplay) waits
// for the person to press play. Covers every <video autoPlay> in the app without each page opting in.
import { useAppearance } from './appearance'

/** Reduce motion is on: the person's setting, or the system's when they haven't chosen. */
export function reducedMotion(): boolean {
  return typeof document !== 'undefined' && document.documentElement.dataset.reduceMotion === 'true'
}

export function useReducedMotion(): boolean {
  return useAppearance((s) => s.reduceMotionActive)
}

function holdAutoplay(e: Event) {
  const v = e.target
  if (!(v instanceof HTMLVideoElement) || !v.autoplay || !reducedMotion()) return
  // dropping the attribute stops the start; a play pressed later is the person's own
  v.autoplay = false
  if (e.type === 'play') v.pause()
}

let installed = false
/** Media events don't bubble: listen in the capture phase, before a video's own load starts it. */
export function installAutoplayGuard() {
  if (installed || typeof document === 'undefined') return
  installed = true
  document.addEventListener('loadstart', holdAutoplay, true)
  document.addEventListener('play', holdAutoplay, true)
}
