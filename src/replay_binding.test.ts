/**
 * Settled-replay proof binding (card t_5b30bdec).
 *
 * Cross-family review finding F4 on t_e19ad2e9: the settled branch of
 * `ExplicitGate.gate` returned the cached result keyed on `orderId` alone,
 * without re-checking the presented payment proof against the proof that paid
 * the order. `orderId` is caller-supplied, so a different proof, a proof that
 * paid a DIFFERENT order, or no proof at all collected the cached success.
 *
 * These tests pin the fixed contract:
 *   A. a proof-settled order refuses a different proof on replay;
 *   B. ... refuses no proof at all on replay;
 *   C. ... refuses a proof that is valid but paid another order;
 *   D. ... still replays the cached result for the SAME proof (non-vacuous control);
 *   E. an invoice-settled order (no client proof) keeps the documented
 *      no-proof idempotency contract, but cannot have a proof attached to it;
 *   F. the binding survives a store restart, and the store keeps a DIGEST of the
 *      proof, never the bearer token;
 *   G. the unpaid path is unchanged: it still verifies the proof and never runs.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteGateStore } from "./gate-store.ts";
import {
  ExplicitGate,
  MemoryOrderStore,
  PaymentRequiredError,
  SettlementEvidenceMismatchError,
  proofHash,
  type GateOrder,
  type GateOrderStore,
  type Invoice,
  type PaymentProcessor,
} from "./payment.ts";

const SLOW = 30_000;

/**
 * CEP-8 Cashu semantics (`src/cashu.ts`): the order settles only when the client
 * presents a valid proof, and a token can only pay once.
 */
class ProofProcessor implements PaymentProcessor {
  readonly pmi = "bitcoin-cashu";
  readonly redeemed: string[] = [];
  constructor(private readonly valid: string[]) {}

  async createInvoice(a: { orderId: string; amountSats: number }): Promise<Invoice> {
    return {
      orderId: a.orderId,
      paymentHash: `cashu:${a.orderId}`,
      amountSats: a.amountSats,
      request: `cashu:https://mint.example:${a.amountSats}`,
      pmi: this.pmi,
    };
  }

  async verify(_invoice: Invoice, proof?: string): Promise<boolean> {
    if (proof === undefined) return false;
    if (!this.valid.includes(proof)) return false;
    if (this.redeemed.includes(proof)) return false; // already spent
    this.redeemed.push(proof);
    return true;
  }
}

/** Lightning-shaped pmi: the processor polls the order's own invoice and ignores proofs. */
class PollingProcessor implements PaymentProcessor {
  readonly pmi = "bitcoin-lightning-bolt11";
  paid = true;
  async createInvoice(a: { orderId: string; amountSats: number }): Promise<Invoice> {
    return {
      orderId: a.orderId,
      paymentHash: `ln-${a.orderId}`,
      amountSats: a.amountSats,
      request: `lnbc${a.amountSats}`,
      pmi: this.pmi,
    };
  }
  async verify(): Promise<boolean> {
    return this.paid;
  }
}

const call = (orderId: string, proof: string | undefined, run: () => Promise<unknown>) => ({
  tool: "tool:paid_work",
  caller: "npub1payer",
  amountSats: 21,
  orderId,
  proof,
  run,
});

describe("settled replay must present the proof that paid the order", () => {
  test("A: a DIFFERENT proof is refused", async () => {
    const gate = new ExplicitGate(new ProofProcessor(["token-A", "token-B"]));
    let runs = 0;
    const run = async () => {
      runs++;
      return "paid-result";
    };
    expect(await gate.gate(call("o-1", "token-A", run))).toBe("paid-result");
    expect(runs).toBe(1);

    await expect(gate.gate(call("o-1", "token-B", run))).rejects.toBeInstanceOf(
      SettlementEvidenceMismatchError,
    );
    // The refusal is fail-closed: no cached result, and the tool never re-ran.
    expect(runs).toBe(1);
  });

  test("B: NO proof at all is refused (the proof is what identifies the payer)", async () => {
    const gate = new ExplicitGate(new ProofProcessor(["token-A"]));
    let runs = 0;
    const run = async () => {
      runs++;
      return "paid-result";
    };
    await gate.gate(call("o-1", "token-A", run));

    await expect(gate.gate(call("o-1", undefined, run))).rejects.toBeInstanceOf(
      SettlementEvidenceMismatchError,
    );
    // An empty string is not evidence either - it is the same as presenting none.
    await expect(gate.gate(call("o-1", "", run))).rejects.toBeInstanceOf(
      SettlementEvidenceMismatchError,
    );
    expect(runs).toBe(1);
  });

  test("C: a VALID proof that paid a DIFFERENT order cannot collect this order's result", async () => {
    const processor = new ProofProcessor(["token-A", "token-C"]);
    const gate = new ExplicitGate(processor);
    let runs = 0;
    const run = async () => {
      runs++;
      return "paid-result";
    };
    await gate.gate(call("o-2", "token-A", run));
    // token-C is a real, unspent token - it just paid a different order.
    expect(await gate.gate(call("o-3", "token-C", async () => "other-order-result"))).toBe(
      "other-order-result",
    );

    await expect(gate.gate(call("o-2", "token-C", run))).rejects.toBeInstanceOf(
      SettlementEvidenceMismatchError,
    );
    expect(runs).toBe(1);
  });

  test("C2: the same token cannot fund a second order on the unpaid path", async () => {
    const gate = new ExplicitGate(new ProofProcessor(["token-A"]));
    let runs = 0;
    const run = async () => {
      runs++;
      return "paid-result";
    };
    await gate.gate(call("o-4", "token-A", run));
    // o-5 is new, so it goes through verify() - which refuses a spent token.
    await expect(gate.gate(call("o-5", "token-A", run))).rejects.toBeInstanceOf(
      PaymentRequiredError,
    );
    expect(runs).toBe(1);
  });

  test("D: the SAME proof still replays the cached result (control - not a refuse-everything gate)", async () => {
    const gate = new ExplicitGate(new ProofProcessor(["token-A"]));
    let runs = 0;
    const run = async () => {
      runs++;
      return "paid-result";
    };
    expect(await gate.gate(call("o-6", "token-A", run))).toBe("paid-result");
    expect(await gate.gate(call("o-6", "token-A", run))).toBe("paid-result");
    expect(await gate.gate(call("o-6", "token-A", run))).toBe("paid-result");
    expect(runs).toBe(1);
  });

  test("the refusal does not hand the caller an invoice to pay again", async () => {
    const gate = new ExplicitGate(new ProofProcessor(["token-A"]));
    await gate.gate(call("o-7", "token-A", async () => "paid-result"));
    const err = (await gate
      .gate(call("o-7", "token-B", async () => "paid-result"))
      .catch((e) => e)) as SettlementEvidenceMismatchError;
    expect(err).toBeInstanceOf(SettlementEvidenceMismatchError);
    expect(err.data.orderId).toBe("o-7");
    // The order is already paid; re-presenting its invoice would invite a second charge.
    expect(err.data).not.toHaveProperty("invoice");
    expect(err.data).not.toHaveProperty("paymentHash");
  });
});

describe("orders settled without a client proof (invoice-polling pmi)", () => {
  test("E: a no-proof replay keeps its cached result (documented idempotency)", async () => {
    const gate = new ExplicitGate(new PollingProcessor());
    let runs = 0;
    const run = async () => {
      runs++;
      return "paid-result";
    };
    expect(await gate.gate(call("o-8", undefined, run))).toBe("paid-result");
    expect(await gate.gate(call("o-8", undefined, run))).toBe("paid-result");
    expect(runs).toBe(1);
  });

  test("E2: a proof attached to an order it did not pay is refused", async () => {
    const gate = new ExplicitGate(new PollingProcessor());
    let runs = 0;
    const run = async () => {
      runs++;
      return "paid-result";
    };
    await gate.gate(call("o-9", undefined, run));
    await expect(gate.gate(call("o-9", "token-A", run))).rejects.toBeInstanceOf(
      SettlementEvidenceMismatchError,
    );
    expect(runs).toBe(1);
  });

  test("a legacy settled row with no recorded evidence keeps the pre-fix contract", async () => {
    // Rows settled before this change carry no digest. Refusing them would strand
    // a result the customer already paid for, so they keep the old semantics.
    const store = new MemoryOrderStore();
    const legacy: GateOrder = {
      orderId: "legacy",
      tool: "tool:paid_work",
      caller: "npub1payer",
      amountSats: 21,
      invoice: {
        orderId: "legacy",
        paymentHash: "hash-legacy",
        amountSats: 21,
        request: "lnbc21",
        pmi: "bitcoin-lightning-bolt11",
      },
      status: "settled",
      result: "paid-result",
      createdAt: 1,
      updatedAt: 1,
    };
    store.put(legacy);
    const gate = new ExplicitGate(new PollingProcessor(), store);
    let runs = 0;
    expect(
      await gate.gate(
        call("legacy", undefined, async () => {
          runs++;
          return "re-run";
        }),
      ),
    ).toBe("paid-result");
    expect(runs).toBe(0);
  });
});

describe("the binding is durable and is a digest, not the token", () => {
  const mkStore = (): { store: SqliteGateStore; path: string } => {
    const path = join(mkdtempSync(join(tmpdir(), "replay-binding-")), "gate.sqlite");
    return { store: new SqliteGateStore(path), path };
  };

  test("F: the store keeps the proof DIGEST, never the bearer token", async () => {
    const { store } = mkStore();
    const gate = new ExplicitGate(new ProofProcessor(["token-A"]), store);
    await gate.gate(call("d-1", "token-A", async () => "paid-result"));

    const row = store.get("d-1")!;
    expect(row.proofHash).toBe(proofHash("token-A"));
    expect(row.proofHash).not.toBe("token-A");
    expect(JSON.stringify(row)).not.toContain("token-A");
    store.close();
  }, SLOW);

  test("F2: the binding survives a restart, and a different proof is still refused", async () => {
    const { store, path } = mkStore();
    const gate = new ExplicitGate(new ProofProcessor(["token-A", "token-B"]), store);
    await gate.gate(call("r-1", "token-A", async () => "paid-result"));
    store.close();

    // A control-plane restart: new gate, new store handle, same file.
    const store2 = new SqliteGateStore(path);
    const gate2 = new ExplicitGate(new ProofProcessor(["token-A", "token-B"]), store2);
    expect(await gate2.gate(call("r-1", "token-A", async () => "paid-AGAIN"))).toBe("paid-result");
    await expect(
      gate2.gate(call("r-1", "token-B", async () => "paid-AGAIN")),
    ).rejects.toBeInstanceOf(SettlementEvidenceMismatchError);
    store2.close();
  }, SLOW);

  test("F3: the claim records the binding atomically (a claimed row always has it)", async () => {
    const { store } = mkStore();
    const order: GateOrder = {
      orderId: "a-1",
      tool: "tool:paid_work",
      caller: "npub1payer",
      amountSats: 21,
      invoice: {
        orderId: "a-1",
        paymentHash: "cashu:a-1",
        amountSats: 21,
        request: "cashu:https://mint.example:21",
        pmi: "bitcoin-cashu",
      },
      status: "awaiting_payment",
      createdAt: 1,
      updatedAt: 1,
    };
    store.put(order);
    expect(store.claim("a-1", "awaiting_payment", "settlement_reserved", proofHash("token-A"))).toBe(
      true,
    );
    expect(store.get("a-1")!.proofHash).toBe(proofHash("token-A"));

    // A later transition that carries no evidence must not erase the binding.
    expect(store.claim("a-1", "settlement_reserved", "settled")).toBe(true);
    expect(store.get("a-1")!.proofHash).toBe(proofHash("token-A"));

    // A losing claim must not write a binding either.
    expect(store.claim("a-1", "awaiting_payment", "settlement_reserved", proofHash("token-B"))).toBe(
      false,
    );
    expect(store.get("a-1")!.proofHash).toBe(proofHash("token-A"));
    store.close();
  }, SLOW);

  test("F4: the in-memory store honours the same contract", () => {
    const store: GateOrderStore = new MemoryOrderStore();
    store.put({
      orderId: "m-1",
      tool: "t",
      caller: "c",
      amountSats: 1,
      invoice: { orderId: "m-1", paymentHash: "p", amountSats: 1, request: "r", pmi: "x" },
      status: "awaiting_payment",
      createdAt: 1,
      updatedAt: 1,
    });
    expect(store.claim("m-1", "awaiting_payment", "settlement_reserved", proofHash("token-A"))).toBe(
      true,
    );
    expect(store.get("m-1")!.proofHash).toBe(proofHash("token-A"));
    expect(store.claim("m-1", "settlement_reserved", "settled")).toBe(true);
    expect(store.get("m-1")!.proofHash).toBe(proofHash("token-A"));
  });
});

describe("the unpaid path is unchanged", () => {
  test("G: an unpaid order still refuses with payment_required and never runs", async () => {
    const gate = new ExplicitGate(new ProofProcessor(["token-A"]));
    let runs = 0;
    await expect(
      gate.gate(
        call("u-1", "token-BAD", async () => {
          runs++;
          return "paid-result";
        }),
      ),
    ).rejects.toBeInstanceOf(PaymentRequiredError);
    // ... and presenting no proof at all on the unpaid path is refused too.
    await expect(gate.gate(call("u-1", undefined, async () => "paid-result"))).rejects.toBeInstanceOf(
      PaymentRequiredError,
    );
    expect(runs).toBe(0);
  });
});
