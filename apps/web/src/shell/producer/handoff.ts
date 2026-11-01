// In-memory handoff from the Home prompt box to the Producer wizard (File objects can't go in the URL).
export interface ProducerHandoff {
  prompt: string
  aspect: '16:9' | '9:16' | '1:1'
  files: File[]
  /** Where the video comes from; absent: from recordings when only videos are attached, else from an idea. */
  source?: 'recordings' | 'idea'
}

/**
 * What a handoff makes the video from. Nothing attached, or any image: an idea (the prompt is the idea, the files
 * are clips and images for it). Only videos: recordings, as they may be screen captures to transcribe; the wizard
 * keeps them if the person switches to an idea.
 */
export function handoffSource(h: Pick<ProducerHandoff, 'files' | 'source'>): 'recordings' | 'idea' {
  if (h.source) return h.source
  return h.files.length > 0 && h.files.every((f) => f.type.startsWith('video/')) ? 'recordings' : 'idea'
}

let pending: ProducerHandoff | undefined

export function setProducerHandoff(h: ProducerHandoff) {
  pending = h
}

export function takeProducerHandoff(): ProducerHandoff | undefined {
  const h = pending
  pending = undefined
  return h
}
