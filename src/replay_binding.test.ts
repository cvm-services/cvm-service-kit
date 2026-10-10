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
  SettlementBindingNotPersistedError,
  SettlementEvidenceMismatchError,
  SettlementFailedError,
  SettlementInProgressError,
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

/**
 * Round 2 (cross-family review of the fix): the reviewer's F1/F4/F5 all route
 * through the STORE and the TYPE of the presented proof rather than the settled
 * branch itself, so each gets a test of its own.
 */
describe("a store write that carries no evidence must not unbind an order (F1)", () => {
  test("MemoryOrderStore.put keeps a recorded digest and matches the sqlite store", () => {
    const stores: [string, GateOrderStore][] = [
      ["memory", new MemoryOrderStore()],
      ["sqlite", new SqliteGateStore(join(mkdtempSync(join(tmpdir(), "unbind-")), "g.sqlite"))],
    ];
    for (const [name, store] of stores) {
      const base: GateOrder = {
        orderId: `u-${name}`,
        tool: "t",
        caller: "c",
        amountSats: 1,
        invoice: { orderId: `u-${name}`, paymentHash: "p", amountSats: 1, request: "r", pmi: "x" },
        status: "awaiting_payment",
        createdAt: 1,
        updatedAt: 1,
      };
      store.put(base);
      expect(
        store.claim(base.orderId, "awaiting_payment", "settlement_reserved", proofHash("token-A")),
      ).toBe(true);
      // A stale object (a pre-claim read, say) with no digest: the write must not
      // wipe the binding, on either store.
      store.put({ ...base, status: "settled", result: "paid-result" });
      expect(store.get(base.orderId)!.proofHash).toBe(proofHash("token-A"));
      if (store instanceof SqliteGateStore) store.close();
    }
  });

  test("end to end: a settled row written without the digest cannot re-open the orderId-only replay", async () => {
    const gate = new ExplicitGate(new ProofProcessor(["token-A"]));
    const run = async () => "paid-result";
    await gate.gate(call("s-1", "token-A", run));

    // A second code path writes the settled row back WITHOUT the digest (a stale
    // pre-claim object, a rollback handler, an admin script).
    const store = (gate as unknown as { store: GateOrderStore }).store;
    const settled = store.get("s-1")!;
    expect(settled.proofHash).toBe(proofHash("token-A"));
    store.put({ ...settled, proofHash: undefined, updatedAt: Date.now() });

    // The binding survived the unbound write, so the hole stays closed.
    expect(store.get("s-1")!.proofHash).toBe(proofHash("token-A"));
    await expect(gate.gate(call("s-1", undefined, run))).rejects.toBeInstanceOf(
      SettlementEvidenceMismatchError,
    );
    await expect(gate.gate(call("s-1", "token-B", run))).rejects.toBeInstanceOf(
      SettlementEvidenceMismatchError,
    );
  });
});

describe("a non-string proof is not evidence (F5)", () => {
  test("a non-string proof never settles an order unbound", async () => {
    // A processor that accepts ANY non-undefined proof, i.e. one that coerces the
    // argument (a redeemer doing `redeem(String(proof))`). It is the only shape
    // that can turn a non-string into a settled order, so the guard must hold
    // against IT, not against a processor that already rejects unknown strings.
    class CoercingProcessor implements PaymentProcessor {
      readonly pmi = "bitcoin-cashu";
      async createInvoice(a: { orderId: string; amountSats: number }): Promise<Invoice> {
        return {
          orderId: a.orderId,
          paymentHash: `cashu:${a.orderId}`,
          amountSats: a.amountSats,
          request: `cashu:https://mint.example:${a.amountSats}`,
          pmi: this.pmi,
        };
      }
      async verify(_i: Invoice, proof?: string): Promise<boolean> {
        return proof !== undefined;
      }
    }
    const gate = new ExplicitGate(new CoercingProcessor());
    let runs = 0;
    const run = async () => {
      runs++;
      return "paid-result";
    };
    // 42 is a plausible JSON-RPC slip. It must NOT settle the order (which would
    // leave it bound to nothing, hence replayable by orderId alone).
    await expect(
      gate.gate({ ...call("n-1", undefined, run), proof: 42 as unknown as string }),
    ).rejects.toBeInstanceOf(PaymentRequiredError);
    expect(runs).toBe(0);
    // Pin WHY it did not settle: with the coercing processor a non-undefined
    // proof is enough, so this order is unsettled only because the non-string was
    // normalised away. It is not a settled no-proof order either.
    await expect(
      gate.gate({ ...call("n-1", undefined, run), proof: 42 as unknown as string }),
    ).rejects.toBeInstanceOf(PaymentRequiredError);
    await expect(gate.gate(call("n-1", undefined, run))).rejects.toBeInstanceOf(PaymentRequiredError);
    expect(runs).toBe(0);
  });

  test("a non-string proof cannot satisfy a settled order's replay", async () => {
    const gate = new ExplicitGate(new ProofProcessor(["token-A"]));
    await gate.gate(call("n-2", "token-A", async () => "paid-result"));
    await expect(
      gate.gate({
        ...call("n-2", undefined, async () => "paid-result"),
        proof: 42 as unknown as string,
      }),
    ).rejects.toBeInstanceOf(SettlementEvidenceMismatchError);
  });
});

/** A store that accepts every write but persists no digest - finding F4. */
class LossyStore implements GateOrderStore {
  private readonly m = new Map<string, GateOrder>();
  get(id: string): GateOrder | undefined {
    const o = this.m.get(id);
    if (!o) return undefined;
    const c = { ...o };
    delete c.proofHash;
    return c;
  }
  put(o: GateOrder): void {
    const c = { ...o };
    delete c.proofHash;
    this.m.set(o.orderId, c);
  }
  claim(id: string, from: GateOrder["status"], to: GateOrder["status"]): boolean {
    const cur = this.m.get(id);
    if (!cur || cur.status !== from) return false;
    this.m.set(id, { ...cur, status: to, updatedAt: Date.now() });
    return true;
  }
}

describe("a store that drops the digest fails closed (F4)", () => {
  test("the gate refuses to hand back a result whose binding did not land", async () => {
    const gate = new ExplicitGate(new ProofProcessor(["token-A"]), new LossyStore());
    await expect(gate.gate(call("L-1", "token-A", async () => "paid-result"))).rejects.toBeInstanceOf(
      SettlementBindingNotPersistedError,
    );
    // Fail-closed: even after the failed call, no replay shape collects the result.
    await expect(gate.gate(call("L-1", "token-A", async () => "paid-result"))).rejects.toBeInstanceOf(
      SettlementFailedError,
    );
  });
});

/**
 * A redeeming processor whose `verify` parks every caller until two have
 * arrived. `verify()` runs BEFORE the claim, so a claim race is only reachable
 * with two callers inside `verify()` at the same time - which is what this makes
 * deterministic instead of timing-dependent.
 */
class RendezvousProcessor implements PaymentProcessor {
  readonly pmi = "bitcoin-cashu";
  private parked = 0;
  private release!: () => void;
  private openGate = false;
  private readonly gateState = new Promise<void>((r) => {
    this.release = () => {
      this.openGate = true;
      r();
    };
  });
  private bothArrived!: () => void;
  private readonly both = new Promise<void>((r) => {
    this.bothArrived = r;
  });

  async createInvoice(a: { orderId: string; amountSats: number }): Promise<Invoice> {
    return {
      orderId: a.orderId,
      paymentHash: `cashu:${a.orderId}`,
      amountSats: a.amountSats,
      request: `cashu:https://mint.example:${a.amountSats}`,
      pmi: this.pmi,
    };
  }

  async verify(_i: Invoice, proof?: string): Promise<boolean> {
    if (proof === undefined) return false;
    this.parked++;
    if (this.parked === 2) this.bothArrived();
    await this.gateState;
    return proof === "token-A";
  }

  /** Resolves once two callers are simultaneously inside `verify()`. */
  get whenBothParked(): Promise<void> {
    return this.openGate ? Promise.resolve() : this.both;
  }

  open(): void {
    this.release();
  }
}

describe("the legitimate retry still works (F2)", () => {
  test("a retry with the same proof after a lost response returns the cached result", async () => {
    const gate = new ExplicitGate(new ProofProcessor(["token-A"]));
    let runs = 0;
    const run = async () => {
      runs++;
      return "paid-result";
    };
    expect(await gate.gate(call("retry-1", "token-A", run))).toBe("paid-result");
    // The response never reached the client (crash, network), so it retries the
    // same call verbatim: same result, action not re-run, payment not re-taken.
    expect(await gate.gate(call("retry-1", "token-A", run))).toBe("paid-result");
    expect(runs).toBe(1);
  });

  test("characterisation: a re-serialised proof is NOT the same evidence (accepted boundary)", async () => {
    // The same underlying payment re-encoded (a Cashu v3<->v4 token re-write, a
    // wallet that re-serialises on retry) is a DIFFERENT string, hence a
    // different digest, hence refused. This is the accepted false positive of
    // binding on the proof the processor was handed: the alternative - trusting
    // `orderId` alone - is the hole this card closes. Closing it properly needs a
    // processor-supplied stable `evidenceKey` (the token's secret set, not its
    // serialisation), an interface change recorded as a residual gap, not a
    // gate-side guess.
    const gate = new ExplicitGate(new ProofProcessor(["token-A", "token-A-v4"]));
    await gate.gate(call("enc-1", "token-A", async () => "paid-result"));
    await expect(
      gate.gate(call("enc-1", "token-A-v4", async () => "paid-result")),
    ).rejects.toBeInstanceOf(SettlementEvidenceMismatchError);
  });
});

describe("a claim-race loser is not stranded (F3)", () => {
  test("the loser is told in_progress and its own proof still collects the result", async () => {
    const processor = new RendezvousProcessor();
    const gate = new ExplicitGate(processor);
    let runs = 0;
    const run = async () => {
      runs++;
      return "paid-result";
    };
    // Two concurrent first-calls for one order, both paying with the same token
    // (a client that retried because the first response was slow, say).
    const first = gate.gate(call("race-1", "token-A", run));
    const second = gate.gate(call("race-1", "token-A", run));
    await processor.whenBothParked; // both are inside verify(): the race is real
    processor.open();

    const settled = await Promise.allSettled([first, second]);
    expect(settled.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(settled.filter((r) => r.status === "rejected")).toHaveLength(1);
    const loser = settled.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(loser.reason).toBeInstanceOf(SettlementInProgressError);
    // Exactly one action for one payment.
    expect(runs).toBe(1);
    // And the loser is not stranded: the proof that paid collects the cached
    // result once the winner has settled.
    expect(await gate.gate(call("race-1", "token-A", run))).toBe("paid-result");
    expect(runs).toBe(1);
  });
});

describe("the refusal does not reveal how the order was settled (F6)", () => {
  test("every mismatch shape reports the same stable reason", async () => {
    const proofSettled = new ExplicitGate(new ProofProcessor(["token-A"]));
    await proofSettled.gate(call("f6-a", "token-A", async () => "r"));
    const noProofSettled = new ExplicitGate(new PollingProcessor());
    await noProofSettled.gate(call("f6-b", undefined, async () => "r"));

    const cases: [ExplicitGate, string, string | undefined][] = [
      [proofSettled, "f6-a", undefined], // presented nothing to a proof-settled order
      [proofSettled, "f6-a", "token-B"], // presented a different proof
      [noProofSettled, "f6-b", "token-C"], // presented a proof to a no-proof order
    ];
    const reasons = new Set<string>();
    for (const [gate, orderId, proof] of cases) {
      try {
        await gate.gate(call(orderId, proof, async () => "r"));
        throw new Error("expected the replay to be refused");
      } catch (err) {
        expect(err).toBeInstanceOf(SettlementEvidenceMismatchError);
        reasons.add((err as SettlementEvidenceMismatchError).reason);
      }
    }
    // One reason, so a caller who presented nothing cannot learn whether a
    // guessed orderId was settled with a client proof.
    expect([...reasons]).toEqual(["settlement_evidence_mismatch"]);
  });
});

/**
 * A store written BEFORE the binding existed: its `claim` has the old three-arg
 * shape and cannot take a digest, but its `put`/`get` round-trip the whole
 * `GateOrder`. This is the only store shape the settle-time backfill exists for
 * (finding R2-2 of the round-2 review: without this test, deleting the backfill
 * left the suite green).
 */
class LegacyClaimStore implements GateOrderStore {
  private readonly m = new Map<string, GateOrder>();
  get(id: string): GateOrder | undefined {
    return this.m.get(id);
  }
  put(o: GateOrder): void {
    this.m.set(o.orderId, o);
  }
  claim(id: string, from: GateOrder["status"], to: GateOrder["status"]): boolean {
    const cur = this.m.get(id);
    if (!cur || cur.status !== from) return false;
    this.m.set(id, { ...cur, status: to, updatedAt: Date.now() });
    return true;
  }
}

describe("the settle-time backfill rescues a pre-binding store (R2-2)", () => {
  test("a store whose claim ignores the digest still settles BOUND", async () => {
    const store = new LegacyClaimStore();
    const gate = new ExplicitGate(new ProofProcessor(["token-A"]), store);
    // The claim could not record the digest, so this must settle rather than fail.
    expect(await gate.gate(call("legacy-1", "token-A", async () => "paid-result"))).toBe(
      "paid-result",
    );
    expect(store.get("legacy-1")!.proofHash).toBe(proofHash("token-A"));
    // Bound for real: the payer's own proof collects the result, and nothing else does.
    expect(await gate.gate(call("legacy-1", "token-A", async () => "paid-result"))).toBe(
      "paid-result",
    );
    await expect(
      gate.gate(call("legacy-1", "token-B", async () => "paid-result")),
    ).rejects.toBeInstanceOf(SettlementEvidenceMismatchError);
    await expect(gate.gate(call("legacy-1", undefined, async () => "paid-result"))).rejects.toBeInstanceOf(
      SettlementEvidenceMismatchError,
    );
  });
});

describe("a reused orderId does not inherit the previous order's binding (R2-3)", () => {
  test("a new generation settles with its own evidence, on both bundled stores", async () => {
    const stores: [string, GateOrderStore][] = [
      ["memory", new MemoryOrderStore()],
      ["sqlite", new SqliteGateStore(join(mkdtempSync(join(tmpdir(), "reuse-")), "g.sqlite"))],
    ];
    for (const [name, store] of stores) {
      const id = `reuse-${name}`;
      // Generation 1: a proof-settled order.
      const proofGate = new ExplicitGate(new ProofProcessor(["token-A"]), store);
      expect(await proofGate.gate(call(id, "token-A", async () => "first-result"))).toBe("first-result");
      expect(store.get(id)!.proofHash).toBe(proofHash("token-A"));

      // The orderId is reused for a NEW order: a write that takes the terminal row
      // back to awaiting_payment (a client that recycles its id, an operator reset).
      const settled = store.get(id)!;
      store.put({
        ...settled,
        status: "awaiting_payment",
        result: undefined,
        proofHash: undefined,
        invoice: { ...settled.invoice, paymentHash: `ln-${id}`, request: `lnbc${id}` },
        updatedAt: Date.now(),
      });

      // Generation 2 settles with NO client proof (an invoice-polling pmi).
      const pollGate = new ExplicitGate(new PollingProcessor(), store);
      expect(await pollGate.gate(call(id, undefined, async () => "second-result"))).toBe("second-result");
      // Its binding is its own (none) - NOT the previous generation's digest.
      expect(store.get(id)!.proofHash).toBeUndefined();
      // So its own payer collects it...
      expect(await pollGate.gate(call(id, undefined, async () => "second-result"))).toBe("second-result");
      // ...and the previous generation's proof does not.
      await expect(
        proofGate.gate(call(id, "token-A", async () => "first-result")),
      ).rejects.toBeInstanceOf(SettlementEvidenceMismatchError);

      if (store instanceof SqliteGateStore) store.close();
    }
  });
});
