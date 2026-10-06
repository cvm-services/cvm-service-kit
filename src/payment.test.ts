import { describe, expect, test } from "bun:test";
import {
  ExplicitGate,
  PaymentRequiredError,
  parseCapTags,
  type Invoice,
  type PaymentProcessor,
} from "./payment.ts";

class FakeProcessor implements PaymentProcessor {
  readonly pmi = "bitcoin-lightning-bolt11";
  paid = false;
  created = 0;
  async createInvoice(a: { orderId: string; amountSats: number }): Promise<Invoice> {
    this.created++;
    return {
      orderId: a.orderId,
      paymentHash: "hash-" + a.orderId,
      amountSats: a.amountSats,
      request: "lnbc" + a.amountSats,
      pmi: this.pmi,
    };
  }
  async isPaid(_i: Invoice) {
    return this.paid;
  }
}

describe("parseCapTags", () => {
  test("reads cap tags", () => {
    const caps = parseCapTags([["cap", "tool:run_code", "10", "sats"]]);
    expect(caps).toEqual([{ scope: "tool:run_code", amount: 10, unit: "sats" }]);
  });
});

describe("ExplicitGate", () => {
  test("refuses unpaid with payment_required", async () => {
    const p = new FakeProcessor();
    const gate = new ExplicitGate(p);
    let ran = 0;
    await expect(
      gate.gate({
        tool: "run_code",
        caller: "ff",
        amountSats: 10,
        orderId: "o1",
        run: async () => { ran++; return 1; },
      }),
    ).rejects.toBeInstanceOf(PaymentRequiredError);
    expect(ran).toBe(0);
    expect(p.created).toBe(1);
  });

  test("runs once when paid, then caches on replay", async () => {
    const p = new FakeProcessor();
    p.paid = true;
    const gate = new ExplicitGate(p);
    let ran = 0;
    const run = async () => { ran++; return { ok: true }; };
    const a = await gate.gate({ tool: "run_code", caller: "ff", amountSats: 10, orderId: "o2", run });
    const b = await gate.gate({ tool: "run_code", caller: "ff", amountSats: 10, orderId: "o2", run });
    expect(a).toEqual({ ok: true });
    expect(b).toEqual({ ok: true });
    expect(ran).toBe(1); // replay did not execute the tool again
    expect(p.created).toBe(1); // same order, one invoice
  });
});
