// In-memory handoff from the Home prompt box to the Producer wizard (File objects can't go in the URL).
export interface ProducerHandoff {
  prompt: string
  aspect: '16:9' | '9:16' | '1:1'
  files: File[]
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
