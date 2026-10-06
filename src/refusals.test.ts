import { describe, expect, test } from "bun:test";
import { CvmRefusalError, REFUSALS, refuse } from "./refusals.ts";
import { InsufficientTreasuryError } from "./reseller.ts";
import { RateLimitError } from "./ratelimit.ts";
import { QueueTimeoutError } from "./concurrency.ts";
import { PaymentRequiredError } from "./payment.ts";

describe("refusal catalogue", () => {
  test("every refusal has a reason, remedy and negative code", () => {
    for (const [key, v] of Object.entries(REFUSALS)) {
      expect(String(v.reason)).toBe(key);
      expect(v.remedy.length).toBeGreaterThan(0);
      expect(v.code).toBeLessThan(0);
    }
  });

  test("catalogue codes match the thrown errors", () => {
    expect(REFUSALS.payment_required.code).toBe(new PaymentRequiredError("x", {} as any).code);
    expect(REFUSALS.treasury_insufficient.code).toBe(
      new InsufficientTreasuryError("x", { balanceSats: 0, requiredSats: 0, floorSats: 0 }).code,
    );
    expect(REFUSALS.rate_limited.code).toBe(new RateLimitError("x", { retryAfterMs: 0, capacity: 0 }).code);
    expect(REFUSALS.queue_timeout.code).toBe(new QueueTimeoutError("x", { max: 1, queueTimeoutMs: 0 }).code);
  });

  test("refuse throws with reason + remedy", () => {
    try {
      refuse("unsupported_language", { language: "cobol" });
      throw new Error("no throw");
    } catch (e) {
      expect(e).toBeInstanceOf(CvmRefusalError);
      const err = e as CvmRefusalError;
      expect(err.code).toBe(-32602);
      expect(err.data.remedy).toContain("availability");
      expect(err.data.language).toBe("cobol");
    }
  });
});
