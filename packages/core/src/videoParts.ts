/** What a made video is built with, from its brief: everything unless the brief turns it off. */
export interface VideoParts {
  /** A voice reading the script. Only a video made from an idea can go without: a recording's script exists to be read. */
  narration: boolean
  /** Captions of the narration (none without one). */
  captions: boolean
  /** Headlines, labels and the words inside animations and drawings. */
  onScreenText: boolean
  /** The title card at the start and the closing card at the end. */
  cards: boolean
}

export function videoParts(b: { source?: 'recordings' | 'idea'; narration?: boolean; captions?: boolean; onScreenText?: boolean; cards?: boolean }): VideoParts {
  const narration = !(b.source === 'idea' && b.narration === false)
  return { narration, captions: narration && b.captions !== false, onScreenText: b.onScreenText !== false, cards: b.cards !== false }
}
