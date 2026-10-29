// One lock for everything that rewrites sync state (D-11): link, unlink, conflict resolution, sync cycles and the
// space changes made through the cloud. Each waits for the one before it, in order, so a cycle never runs half way
// through an unlink and a conflict is never resolved under a pull.
export class SyncLock {
  private tail: Promise<void> = Promise.resolve()
  private queue: string[] = []
  /** What holds the lock now (undefined when free). */
  holder?: string

  /** Run `fn` once everything queued before it has finished (whether it failed or not). */
  run<T>(name: string, fn: () => Promise<T>): Promise<T> {
    const before = this.tail
    let release!: () => void
    this.tail = new Promise<void>((r) => (release = r))
    this.queue.push(name)
    return before.then(async () => {
      this.queue.shift()
      this.holder = name
      try {
        return await fn()
      } finally {
        this.holder = undefined
        release()
      }
    })
  }

  /** What waits for the lock, oldest first. */
  waiting(): string[] {
    return [...this.queue]
  }
}
