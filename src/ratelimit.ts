/** Per-caller token-bucket rate limiter. In-memory (per process) — v1. */

export interface RateLimitConfig {
  /** Burst size. */
  capacity: number;
  /** Tokens refilled per second. */
  refillPerSec: number;
}

export class RateLimitError extends Error {
  readonly code = -32004;
  constructor(message: string, readonly data: { retryAfterMs: number; capacity: number }) {
    super(message);
    this.name = "RateLimitError";
  }
}

interface Bucket {
  tokens: number;
  last: number;
}

export class RateLimiter {
  private readonly buckets = new Map<string, Bucket>();

  constructor(private readonly cfg: RateLimitConfig) {}

  /** Returns remaining tokens if allowed, else null. */
  take(key: string, now = Date.now()): number | null {
    const b = this.buckets.get(key) ?? { tokens: this.cfg.capacity, last: now };
    const elapsed = (now - b.last) / 1000;
    b.tokens = Math.min(this.cfg.capacity, b.tokens + elapsed * this.cfg.refillPerSec);
    b.last = now;
    if (b.tokens < 1) {
      this.buckets.set(key, b);
      return null;
    }
    b.tokens -= 1;
    this.buckets.set(key, b);
    return b.tokens;
  }

  retryAfterMs(key: string, now = Date.now()): number {
    const b = this.buckets.get(key) ?? { tokens: this.cfg.capacity, last: now };
    const elapsed = (now - b.last) / 1000;
    const tokens = Math.min(this.cfg.capacity, b.tokens + elapsed * this.cfg.refillPerSec);
    if (tokens >= 1) return 0;
    return Math.ceil(((1 - tokens) / this.cfg.refillPerSec) * 1000);
  }

  assert(key: string): void {
    if (this.take(key) === null) {
      throw new RateLimitError("rate_limited", {
        retryAfterMs: this.retryAfterMs(key),
        capacity: this.cfg.capacity,
      });
    }
  }
}
