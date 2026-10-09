/**
 * Money-safety invariants for ExplicitGate.
 *
 * Regression tests for the 2026-10-09 finding: the gate persisted `paid` BEFORE
 * running the tool, so a failed run left the order retryable and the next call
 * re-ran it - two fiat attempts against one sats payment. Concurrent callers
 * could both pass, and replay protection was a 10-minute in-memory cache that a
 * restart erased.
 */
import { describe, expect, test } from "bun:test";
import {
  ExplicitGate,
  MemoryOrderStore,
  PaymentRequiredError,
  type Invoice,
  type PaymentProcessor,
} from "./payment.ts";
// NOTE: gate-store.ts imports "bun:sqlite", and a STATIC import of it makes
// `bun test` hang before any test runs in this environment (measured
// 2026-10-09). Import it dynamically inside the SQLite tests instead - they get
// the same coverage without wedging collection.

class FakeProcessor implements PaymentProcessor {
  readonly pmi = "pmi:fake";
  paid = false;
  invoices = 0;
  async createInvoice(a: {
    tool: string;
    orderId: string;
    amountSats: number;
    caller: string;
  }): Promise<Invoice> {
    this.invoices++;
    return {
      orderId: a.orderId,
      paymentHash: "hash-" + a.orderId,
      amountSats: a.amountSats,
      request: "lnbc-fake-" + a.orderId,
      pmi: this.pmi,
    };
  }
  async verify(): Promise<boolean> {
    return this.paid;
  }
}

const req = (orderId: string, run: () => Promise<unknown>) => ({
  tool: "tool:place_order",
  caller: "npub1facilitator",
  amountSats: 5022,
  orderId,
  proof: "proof",
  run,
});

const invoiceFor = (orderId: string): Invoice => ({
  orderId,
  paymentHash: "hash-" + orderId,
  amountSats: 5022,
  request: "lnbc-fake-" + orderId,
  pmi: "pmi:fake",
});

describe("ExplicitGate money safety", () => {
  test("a failed run is terminal: a retry never re-runs the tool", async () => {
    const processor = new FakeProcessor();
    processor.paid = true;
    const gate = new ExplicitGate(processor, new MemoryOrderStore());
    let runs = 0;
    const boom = async () => {
      runs++;
      throw new Error("venue refused");
    };

    await expect(gate.gate(req("o1", boom))).rejects.toThrow("venue refused");
    // The sats were taken and the venue action failed. A retry must NOT attempt
    // a second fiat action against the same payment.
    await expect(gate.gate(req("o1", boom))).rejects.toThrow();
    expect(runs).toBe(1);
  });

  test("concurrent calls run the tool exactly once", async () => {
    const processor = new FakeProcessor();
    processor.paid = true;
    const gate = new ExplicitGate(processor, new MemoryOrderStore());
    let runs = 0;
    const run = async () => {
      runs++;
      await new Promise((r) => setTimeout(r, 25));
      return "placed";
    };

    const results = await Promise.allSettled([
      gate.gate(req("c1", run)),
      gate.gate(req("c1", run)),
    ]);
    const ok = results.filter((r) => r.status === "fulfilled").length;

    expect(runs).toBe(1);
    expect(ok).toBe(1);
  });

  test("a settled order replays its cached result without re-running", async () => {
    const processor = new FakeProcessor();
    processor.paid = true;
    const gate = new ExplicitGate(processor, new MemoryOrderStore());
    let runs = 0;
    const run = async () => {
      runs++;
      return "placed";
    };

    expect(await gate.gate(req("s1", run))).toBe("placed");
    expect(await gate.gate(req("s1", run))).toBe("placed");
    expect(runs).toBe(1);
  });

  test("an unpaid order raises PaymentRequiredError and never runs", async () => {
    const processor = new FakeProcessor();
    processor.paid = false;
    const gate = new ExplicitGate(processor, new MemoryOrderStore());
    let runs = 0;
    const run = async () => {
      runs++;
      return "placed";
    };

    await expect(gate.gate(req("u1", run))).rejects.toBeInstanceOf(
      PaymentRequiredError,
    );
    expect(runs).toBe(0);
  });
});

describe("SqliteGateStore money safety", () => {
  test("claim is compare-and-set", async () => {
    const { SqliteGateStore } = await import("./gate-store.ts");
    const store = new SqliteGateStore(`/tmp/gate-claim-${Date.now()}.db`);
    store.put({
      orderId: "x",
      tool: "t",
      caller: "c",
      amountSats: 1,
      invoice: invoiceFor("x"),
      status: "awaiting_payment",
      createdAt: 1,
      updatedAt: 1,
    });

    // Only the first claim may win.
    const claim = (store as unknown as {
      claim?: (a: string, b: string, c: string) => boolean;
    }).claim;
    expect(typeof claim).toBe("function");
    expect(claim!(`x`, "awaiting_payment", "settlement_reserved")).toBe(true);
    expect(claim!(`x`, "awaiting_payment", "settlement_reserved")).toBe(false);
    expect(store.get("x")!.status).toBe("settlement_reserved");
  });

  test("a replayed proof does not re-run the tool after a restart", async () => {
    const { SqliteGateStore } = await import("./gate-store.ts");
    const path = `/tmp/gate-restart-${Date.now()}.db`;
    const p1 = new FakeProcessor();
    p1.paid = true;
    const gate1 = new ExplicitGate(p1, new SqliteGateStore(path));
    let runs = 0;
    const first = async () => {
      runs++;
      return "placed";
    };
    expect(await gate1.gate(req("r1", first))).toBe("placed");
    expect(runs).toBe(1);

    // Simulate a control-plane restart: new gate + new store over the same file.
    const p2 = new FakeProcessor();
    p2.paid = true;
    const gate2 = new ExplicitGate(p2, new SqliteGateStore(path));
    const second = async () => {
      runs++;
      return "placed-AGAIN";
    };
    expect(await gate2.gate(req("r1", second))).toBe("placed");
    expect(runs).toBe(1);
  });
});
