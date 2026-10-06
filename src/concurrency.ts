/**
 * Bounded admission queue: at most `max` tasks run at once; the rest wait in
 * FIFO order up to `queueTimeoutMs`, then fail closed. Used to serialize work
 * against a single-slot executor instead of erroring immediately.
 */
export class QueueTimeoutError extends Error {
  readonly code = -32005;
  constructor(message: string, readonly data: { max: number; queueTimeoutMs: number }) {
    super(message);
    this.name = "QueueTimeoutError";
  }
}

export class ConcurrencyLimiter {
  private active = 0;
  private readonly waiters: Array<{ resolve: (release: () => void) => void; timer: ReturnType<typeof setTimeout> }> = [];

  constructor(
    private readonly max: number,
    private readonly queueTimeoutMs = 30_000,
  ) {
    if (max < 1) throw new Error("max must be >= 1");
  }

  private makeRelease(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active--;
      this.pump();
    };
  }

  private pump(): void {
    while (this.active < this.max && this.waiters.length > 0) {
      const w = this.waiters.shift()!;
      clearTimeout(w.timer);
      this.active++;
      w.resolve(this.makeRelease());
    }
  }

  acquire(): Promise<() => void> {
    if (this.active < this.max) {
      this.active++;
      return Promise.resolve(this.makeRelease());
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const i = this.waiters.findIndex((x) => x.timer === timer);
        if (i >= 0) this.waiters.splice(i, 1);
        reject(new QueueTimeoutError("queue_timeout", { max: this.max, queueTimeoutMs: this.queueTimeoutMs }));
      }, this.queueTimeoutMs);
      this.waiters.push({ resolve, timer });
    });
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    const release = await this.acquire();
    try {
      return await fn();
    } finally {
      release();
    }
  }

  stats(): { active: number; queued: number; max: number } {
    return { active: this.active, queued: this.waiters.length, max: this.max };
  }
}
