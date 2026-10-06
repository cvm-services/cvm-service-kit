import { describe, expect, test } from "bun:test";
import { ConcurrencyLimiter, QueueTimeoutError } from "./concurrency.ts";

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

describe("ConcurrencyLimiter", () => {
  test("serializes above max", async () => {
    const lim = new ConcurrencyLimiter(1);
    const order: string[] = [];
    const a = lim.run(async () => {
      order.push("a-start");
      await tick(30);
      order.push("a-end");
    });
    const b = lim.run(async () => {
      order.push("b-start");
    });
    await Promise.all([a, b]);
    expect(order).toEqual(["a-start", "a-end", "b-start"]);
  });

  test("runs up to max concurrently", async () => {
    const lim = new ConcurrencyLimiter(2);
    let peak = 0;
    const job = async () => {
      peak = Math.max(peak, lim.stats().active);
      await tick(20);
    };
    await Promise.all([lim.run(job), lim.run(job), lim.run(job)]);
    expect(peak).toBe(2);
  });

  test("queue timeout fails closed", async () => {
    const lim = new ConcurrencyLimiter(1, 20);
    const hold = lim.run(() => tick(200));
    await tick(5);
    await expect(lim.run(async () => {})).rejects.toBeInstanceOf(QueueTimeoutError);
    await hold;
  });

  test("stats", () => {
    const lim = new ConcurrencyLimiter(3);
    expect(lim.stats()).toEqual({ active: 0, queued: 0, max: 3 });
  });
});
