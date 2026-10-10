/**
 * The gate's CREATE path, which the CAS fix in PR #13 did not cover.
 *
 * `gate()` creates the order when it does not find one, and the write it used is
 * an unconditional upsert. Two callers that both read `undefined` BEFORE either
 * write - which is exactly what a second service process starting mid-flight
 * looks like, and what a restart during an in-flight request looks like - both
 * take the create path. The second `put` then overwrites a row its peer has
 * already advanced (claimed or terminal), so the loser of the race owns a fresh
 * `awaiting_payment -> settlement_reserved` transition and runs the paid action
 * a second time on one payment.
 *
 * Measured, not theorised: this is the mechanism behind the intermittent
 * `Expected: 1 / Received: 2` on the two-service-process SMS test in
 * `services/cvm-sms4sats/src/gate-process.test.ts` under full-suite load. The
 * `StaleAbsentStore` below makes that interleaving deterministic instead of
 * timing-dependent - it is a store that answers the FIRST `get` with the
 * pre-image the second process really read (`undefined`), and delegates
 * afterwards.
 *
 * Every test here runs through `ExplicitGate.gate()`, not through the store
 * directly, so the store-level mutation `create() -> put()` (evidence/
 * mutation_M3_put_create.txt) makes them fail: they pin the GATE's use of
 * `create`, which is where the defect was.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ExplicitGate,
  PaymentRequiredError,
  SettlementInProgressError,
  SqliteGateStore,
  type GateOrder,
  type GateOrderStatus,
  type GateOrderStore,
  type Invoice,
  type PaymentProcessor,
} from "./index.ts";

const SLOW = 30_000;

class FakeProcessor implements PaymentProcessor {
  readonly pmi = "pmi:fake";
  async createInvoice(a: { orderId: string; amountSats: number }): Promise<Invoice> {
    return {
      orderId: a.orderId,
      paymentHash: "hash-" + a.orderId,
      amountSats: a.amountSats,
      request: "lnbc-fake-" + a.orderId,
      pmi: this.pmi,
    };
  }
  async verify(): Promise<boolean> {
    return true;
  }
}

/**
 * A processor whose `verify` is BOUND to the invoice it is handed: the proof is
 * only good for the invoice it was minted for. This is what makes the
 * fail-closed claim testable - a proof minted for the caller's own invoice must
 * be rejected once the gate is verifying the SURVIVING row's invoice.
 */
class InvoiceBindingProcessor implements PaymentProcessor {
  readonly pmi = "pmi:binding";
  async createInvoice(a: { orderId: string; amountSats: number }): Promise<Invoice> {
    return {
      orderId: a.orderId,
      paymentHash: "hash-" + a.orderId,
      amountSats: a.amountSats,
      request: "lnbc-own-" + a.orderId,
      pmi: this.pmi,
    };
  }
  async verify(invoice: Invoice, proof?: string): Promise<boolean> {
    return proof === "proof-for:" + invoice.request;
  }
}

/**
 * Models the pre-image: the first `get` returns what a peer read before the row
 * existed. Everything else is the real store.
 */
class StaleAbsentStore implements GateOrderStore {
  private staled = false;
  constructor(private readonly inner: GateOrderStore) {}
  get(orderId: string): GateOrder | undefined {
    if (!this.staled) {
      this.staled = true;
      return undefined;
    }
    return this.inner.get(orderId);
  }
  put(order: GateOrder): void {
    this.inner.put(order);
  }
  create(order: GateOrder): GateOrder {
    return this.inner.create(order);
  }
  claim(orderId: string, from: GateOrderStatus, to: GateOrderStatus): boolean {
    return this.inner.claim(orderId, from, to);
  }
}

const req = (orderId: string, run: () => Promise<string>) => ({
  tool: "create_sms_order",
  caller: "npub1customer",
  amountSats: 2100,
  orderId,
  proof: "cashu-proof",
  run,
});

function mkStore(): { store: SqliteGateStore; path: string } {
  const path = join(mkdtempSync(join(tmpdir(), "gate-create-race-")), "gate.sqlite");
  return { store: new SqliteGateStore(path), path };
}

function mkOrder(orderId: string, request: string, status: GateOrderStatus = "awaiting_payment"): GateOrder {
  const now = Date.now();
  return {
    orderId,
    tool: "create_sms_order",
    caller: "npub1customer",
    amountSats: 2100,
    invoice: { orderId, paymentHash: "hash-" + orderId, amountSats: 2100, request, pmi: "pmi:fake" },
    status,
    createdAt: now,
    updatedAt: now,
  };
}

describe("ExplicitGate: an order is CREATED at most once, even with a stale pre-image", () => {
  test(
    "a peer's 'no such order' pre-image cannot resurrect a settled order into a second run",
    async () => {
      const { store: real } = mkStore();

      // Process B has already read the order book and seen "no such order".
      const staleB = new StaleAbsentStore(real);
      const gateB = new ExplicitGate(new FakeProcessor(), staleB);

      // Process A: creates the order, takes the payment, runs the action, settles.
      let runsA = 0;
      const gateA = new ExplicitGate(new FakeProcessor(), real);
      expect(await gateA.gate(req("create-race", async () => (runsA++, "sent-A")))).toBe("sent-A");
      expect(runsA).toBe(1);
      expect(real.get("create-race")!.status).toBe("settled");

      // Process B now calls gate() and takes the create path from its stale
      // pre-image. It must observe the settle, not overwrite it.
      let runsB = 0;
      const result = await gateB
        .gate(req("create-race", async () => (runsB++, "sent-B")))
        .catch((e) => e);

      // THE invariant: one payment, one run - B replays A's cached result.
      expect(runsB).toBe(0);
      expect(result).toBe("sent-A");
      expect(real.get("create-race")!.status).toBe("settled");
    },
    SLOW,
  );

  test(
    "a stale pre-image cannot clobber a row a peer already CLAIMED: create returns the peer's row, invoice and all",
    async () => {
      const { store: real } = mkStore();

      // A peer process created this order and claimed it - the request is
      // IN FLIGHT. `create()` must hand the loser this row, not replace it.
      real.create(mkOrder("claimed-by-peer", "lnbc-A"));
      expect(real.claim("claimed-by-peer", "awaiting_payment", "settlement_reserved")).toBe(true);

      // Process B takes the create path from its stale "no such order" pre-image.
      const gateB = new ExplicitGate(new FakeProcessor(), new StaleAbsentStore(real));
      let runsB = 0;
      const err = await gateB
        .gate(req("claimed-by-peer", async () => (runsB++, "sent-B")))
        .catch((e) => e);

      // B loses the claim it thought it was starting, and does NOT run.
      expect(err).toBeInstanceOf(SettlementInProgressError);
      expect(runsB).toBe(0);
      const row = real.get("claimed-by-peer")!;
      expect(row.status).toBe("settlement_reserved");
      // The peer's invoice survived: B's create was a no-op, not an overwrite.
      expect(row.invoice.request).toBe("lnbc-A");
    },
    SLOW,
  );

  test(
    "fail-closed: the loser is verified against the SURVIVING row's invoice, so a proof minted for its OWN invoice settles nothing",
    async () => {
      const { store: real } = mkStore();

      // The surviving row is the peer's, still awaiting payment, invoice `lnbc-A`.
      real.create(mkOrder("mismatch", "lnbc-A"));

      // B's processor mints its own invoice (`lnbc-own-<id>`), so B holds a proof
      // for an invoice the order book does not have.
      const gate = new ExplicitGate(new InvoiceBindingProcessor(), new StaleAbsentStore(real));
      let runs = 0;
      const err = await gate
        .gate({ ...req("mismatch", async () => (runs++, "sent")), proof: "proof-for:lnbc-own-mismatch" })
        .catch((e) => e);

      expect(err).toBeInstanceOf(PaymentRequiredError);
      expect(runs).toBe(0);
      expect(real.get("mismatch")!.status).toBe("awaiting_payment");

      // Positive control: this processor's verify is invoice-bound and CAN return
      // true - the same row settles once the proof is for the surviving invoice.
      const ok = await gate.gate({ ...req("mismatch", async () => (runs++, "sent")), proof: "proof-for:lnbc-A" });
      expect(ok).toBe("sent");
      expect(runs).toBe(1);
      expect(real.get("mismatch")!.status).toBe("settled");
    },
    SLOW,
  );
});
