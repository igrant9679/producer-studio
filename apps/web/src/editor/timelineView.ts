// The timeline's view, for commands that live outside it (Shift+Z): the mounted timeline registers how to fit.
let fitter: (() => void) | null = null

export function registerTimelineFit(fn: (() => void) | null) {
  fitter = fn
}

/** Zoom the timeline so the whole project fits the view (Shift+Z). */
export function fitTimeline() {
  fitter?.()
}
