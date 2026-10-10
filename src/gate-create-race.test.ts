/**
 * The gate's CREATE path, which the CAS fix in PR #13 did not cover.
 *
 * `gate()` creates the order when it does not find one, and the write it uses is
 * an unconditional upsert. Two callers that both read `undefined` BEFORE either
 * write - which is exactly what a second service process starting mid-flight
 * looks like, and what a restart during an in-flight request looks like - both
 * take the create path. The second `put` then overwrites a row its peer has
 * already advanced to a TERMINAL state, resurrecting a settled order as
 * `awaiting_payment`; the loser of the race now owns a fresh
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
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ExplicitGate,
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
    "two racing creators converge on ONE row: the second create returns the first one's row",
    async () => {
      const { store: a, path } = mkStore();
      const b = new SqliteGateStore(path);
      const now = Date.now();
      const mk = (orderId: string): GateOrder => ({
        orderId,
        tool: "create_sms_order",
        caller: "npub1customer",
        amountSats: 2100,
        invoice: {
          orderId,
          paymentHash: "hash",
          amountSats: 2100,
          request: "lnbc-fake",
          pmi: "pmi:fake",
        },
        status: "awaiting_payment",
        createdAt: now,
        updatedAt: now,
      });

      const first = a.create(mk("converge"));
      expect(first.status).toBe("awaiting_payment");

      // B's create must be a no-op that returns A's row, never an overwrite.
      a.claim("converge", "awaiting_payment", "settlement_reserved");
      a.put({ ...mk("converge"), status: "settled", result: "sent-A" });

      const second = b.create(mk("converge"));
      expect(second.status).toBe("settled");
      expect(second.result).toBe("sent-A");
      expect(a.get("converge")!.status).toBe("settled");

      a.close();
      b.close();
    },
    SLOW,
  );
});
