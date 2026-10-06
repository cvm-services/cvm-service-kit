import { describe, expect, test } from "bun:test";
import { RateLimiter, RateLimitError } from "./ratelimit.ts";

describe("RateLimiter", () => {
  test("allows up to capacity then refuses", () => {
    const rl = new RateLimiter({ capacity: 2, refillPerSec: 1 });
    expect(rl.take("a", 1000)).not.toBeNull();
    expect(rl.take("a", 1000)).not.toBeNull();
    expect(rl.take("a", 1000)).toBeNull();
  });

  test("refills over time", () => {
    const rl = new RateLimiter({ capacity: 1, refillPerSec: 1 });
    rl.take("a", 0);
    expect(rl.take("a", 0)).toBeNull();
    expect(rl.take("a", 1000)).not.toBeNull();
  });

  test("keys are independent", () => {
    const rl = new RateLimiter({ capacity: 1, refillPerSec: 0 });
    expect(rl.take("a")).not.toBeNull();
    expect(rl.take("b")).not.toBeNull();
  });

  test("assert throws RateLimitError with retry info", () => {
    const rl = new RateLimiter({ capacity: 1, refillPerSec: 1 });
    rl.assert("a");
    try {
      rl.assert("a");
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(RateLimitError);
      expect((e as RateLimitError).data.retryAfterMs).toBeGreaterThan(0);
    }
  });
});
