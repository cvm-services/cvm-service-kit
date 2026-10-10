/**
 * The recovery path for orders the gate refuses to re-run: what an operator can
 * see, what they are allowed to change, and what must stay impossible.
 *
 * The invariants under test:
 *  - nothing is released automatically (a crashed action and a slow action are
 *    indistinguishable from the store, so a lease expiry may only SURFACE);
 *  - a release goes through the same CAS as the gate, so it cannot create a
 *    second owner;
 *  - a terminal order can never be resurrected into a second run;
 *  - recording a compensation is bookkeeping and never licenses a retry.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteGateStore } from "./gate-store.ts";
import {
  DEFAULT_RESERVATION_LEASE_MS,
  findStuckOrders,
  recordCompensation,
  releaseReservation,
} from "./gate-recovery.ts";
import { type CliIo, main as cliMain } from "./gate-recovery-cli.ts";
import {
  ExplicitGate,
  SettlementFailedError,
  SettlementInProgressError,
  type GateOrder,
  type Invoice,
  type PaymentProcessor,
} from "./payment.ts";

const MINUTE = 60_000;

class FakeProcessor implements PaymentProcessor {
  readonly pmi = "pmi:fake";
  paid = true;
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

function mkStore(): { store: SqliteGateStore; path: string } {
  const path = join(mkdtempSync(join(tmpdir(), "gate-recovery-")), "gate.sqlite");
  return { store: new SqliteGateStore(path), path };
}

function awaiting(orderId: string): GateOrder {
  return {
    orderId,
    tool: "tool:place_order",
    caller: "npub1facilitator",
    amountSats: 5022,
    invoice: {
      orderId,
      paymentHash: "hash-" + orderId,
      amountSats: 5022,
      request: "lnbc-fake-" + orderId,
      pmi: "pmi:fake",
    },
    status: "awaiting_payment",
    createdAt: 1,
    updatedAt: 1,
  };
}

const req = (orderId: string, run: () => Promise<unknown>) => ({
  tool: "tool:place_order",
  caller: "npub1facilitator",
  amountSats: 5022,
  orderId,
  proof: "proof",
  run,
});

/** Park an order exactly where a crash mid-action leaves it: claimed, no outcome. */
function crashAfterClaim(store: SqliteGateStore, orderId: string): void {
  store.put(awaiting(orderId));
  expect(store.claim(orderId, "awaiting_payment", "settlement_reserved")).toBe(true);
}

function captureIo(): { io: CliIo; lines: string[]; errors: string[] } {
  const lines: string[] = [];
  const errors: string[] = [];
  return {
    lines,
    errors,
    io: { log: (l) => lines.push(l), error: (e) => errors.push(e) },
  };
}

describe("gate recovery: inspecting stuck orders", () => {
  test("a crashed reservation is surfaced, and inspecting it changes nothing", async () => {
    const { store } = mkStore();
    crashAfterClaim(store, "c1");
    const claimedAt = store.get("c1")!.updatedAt;

    // Still inside the lease: surfaced, but flagged as possibly-still-running.
    const fresh = findStuckOrders(store, { now: claimedAt + 1 * MINUTE, leaseMs: 15 * MINUTE });
    expect(fresh.reserved).toHaveLength(1);
    expect(fresh.reserved[0]!.order.orderId).toBe("c1");
    expect(fresh.reserved[0]!.ageMs).toBe(1 * MINUTE);
    expect(fresh.reserved[0]!.leaseExpired).toBe(false);
    expect(fresh.failed).toHaveLength(0);

    // Past the lease: flagged for a human - and NOT moved by the flagging.
    const stale = findStuckOrders(store, { now: claimedAt + 20 * MINUTE });
    expect(stale.leaseMs).toBe(DEFAULT_RESERVATION_LEASE_MS);
    expect(stale.reserved[0]!.leaseExpired).toBe(true);
    expect(store.get("c1")!.status).toBe("settlement_reserved");

    // And the gate itself is still refusing, which is the state being recovered.
    const gate = new ExplicitGate(new FakeProcessor(), store);
    const err = await gate.gate(req("c1", async () => "placed")).catch((e) => e);
    expect(err).toBeInstanceOf(SettlementInProgressError);
    store.close();
  });
});

describe("gate recovery: releasing a reservation", () => {
  test("a live lease is refused, and clearing it enables exactly one real retry", async () => {
    const { store } = mkStore();
    crashAfterClaim(store, "c2");
    const claimedAt = store.get("c2")!.updatedAt;

    // A slow action and a crashed one look identical, so a live lease must refuse.
    const refused = releaseReservation(store, "c2", { now: claimedAt + 1 * MINUTE });
    expect(refused.released).toBe(false);
    expect(refused.refusal).toBe("lease_active");
    expect(refused.ageMs).toBe(1 * MINUTE);
    expect(store.get("c2")!.status).toBe("settlement_reserved");

    // Past the lease, after the operator has verified the venue never saw it.
    const released = releaseReservation(store, "c2", { now: claimedAt + 20 * MINUTE });
    expect(released.released).toBe(true);
    expect(store.get("c2")!.status).toBe("awaiting_payment");

    // The escape hatch works end to end: the retry now runs the action, once.
    let runs = 0;
    const gate = new ExplicitGate(new FakeProcessor(), store);
    const run = async () => {
      runs++;
      return "placed";
    };
    expect(await gate.gate(req("c2", run))).toBe("placed");
    expect(await gate.gate(req("c2", run))).toBe("placed");
    expect(runs).toBe(1);
    expect(store.get("c2")!.status).toBe("settled");
    store.close();
  }, 30_000);

  test("release goes through the CAS: an already-moved row is never re-released", () => {
    // Control for "release is a CAS, not a blind put". Two connections over one
    // file, exactly like two operators (or an operator and a live caller).
    const { store: a, path } = mkStore();
    crashAfterClaim(a, "race1");
    const claimedAt = a.get("race1")!.updatedAt;
    const b = new SqliteGateStore(path);

    // b releases it (the operator's own connection, or a second operator).
    expect(releaseReservation(b, "race1", { now: claimedAt + 20 * MINUTE }).released).toBe(true);
    // a must NOT be able to release the same row again - a blind-put
    // implementation would happily report success here and hand out two retries.
    const lost = releaseReservation(a, "race1", { now: claimedAt + 20 * MINUTE });
    expect(lost.released).toBe(false);
    expect(lost.refusal).toBe("not_reserved");
    expect(a.get("race1")!.status).toBe("awaiting_payment");
    a.close();
    b.close();
  }, 30_000);

  test("release can never resurrect a terminal order", () => {
    const { store } = mkStore();

    const settled = awaiting("s1");
    settled.status = "settled";
    settled.result = "placed";
    store.put(settled);
    const onSettled = releaseReservation(store, "s1");
    expect(onSettled.released).toBe(false);
    expect(onSettled.refusal).toBe("not_reserved");
    expect(store.get("s1")!.status).toBe("settled");

    const failed = awaiting("f0");
    failed.status = "settlement_failed";
    failed.failure = { message: "venue refused", at: 2 };
    store.put(failed);
    const onFailed = releaseReservation(store, "f0");
    expect(onFailed.released).toBe(false);
    expect(onFailed.refusal).toBe("not_reserved");
    // The failure stays terminal, so it keeps refusing rather than re-running.
    expect(store.get("f0")!.status).toBe("settlement_failed");

    const missing = releaseReservation(store, "nope");
    expect(missing.released).toBe(false);
    expect(missing.refusal).toBe("not_found");
    store.close();
  }, 30_000);
});

describe("gate recovery: compensating a terminal failure", () => {
  test("a compensation is recorded durably and does NOT license a retry", async () => {
    const { store, path } = mkStore();
    const failed = awaiting("f1");
    failed.status = "settlement_failed";
    failed.failure = { message: "venue refused the card", at: 2 };
    store.put(failed);

    const recorded = recordCompensation(store, "f1", {
      outcome: "refunded",
      note: "mint swap back to the customer, tx 0xabc",
      now: 3,
    });
    expect(recorded.recorded).toBe(true);
    expect(recorded.resolution).toEqual({
      orderId: "f1",
      outcome: "refunded",
      note: "mint swap back to the customer, tx 0xabc",
      at: 3,
    });

    // Durable: a restarted process still sees the audit record.
    store.close();
    const reopened = new SqliteGateStore(path);
    expect(reopened.listResolutions()).toHaveLength(1);
    const report = findStuckOrders(reopened, { now: 10 * MINUTE });
    expect(report.failed).toHaveLength(1);
    expect(report.failed[0]!.resolution?.outcome).toBe("refunded");

    // The status is untouched on purpose: a replay still fails closed.
    expect(reopened.get("f1")!.status).toBe("settlement_failed");
    let runs = 0;
    const err = await new ExplicitGate(new FakeProcessor(), reopened)
      .gate(req("f1", async () => (runs++, "placed")))
      .catch((e) => e);
    expect(err).toBeInstanceOf(SettlementFailedError);
    expect(runs).toBe(0);

    // Only a terminally FAILED order can be compensated.
    const other = new SqliteGateStore(path);
    crashAfterClaim(other, "live1");
    expect(recordCompensation(other, "live1", { outcome: "abandoned", note: "x" }).refusal).toBe(
      "not_failed",
    );
    expect(recordCompensation(other, "ghost", { outcome: "abandoned", note: "x" }).refusal).toBe(
      "not_found",
    );
    other.close();
    reopened.close();
  }, 30_000);
});

describe("gate recovery: the operator command", () => {
  test("list reports, release refuses a live lease then honours --force", async () => {
    const { store, path } = mkStore();
    crashAfterClaim(store, "cli1");

    const empty = captureIo();
    expect(await cliMain(["list", "--db", path], empty.io)).toBe(0);
    expect(empty.lines.join("\n")).toContain("reserved cli1");
    expect(empty.lines.join("\n")).toContain("lease live");
    expect(empty.lines.join("\n")).toContain("Do NOT release a live one");

    const refused = captureIo();
    expect(await cliMain(["release", "--db", path, "--order", "cli1"], refused.io)).toBe(1);
    expect(refused.errors.join("\n")).toContain("lease");
    expect(store.get("cli1")!.status).toBe("settlement_reserved");

    const forced = captureIo();
    expect(await cliMain(["release", "--db", path, "--order", "cli1", "--force"], forced.io)).toBe(0);
    expect(forced.lines.join("\n")).toContain("awaiting_payment");
    expect(store.get("cli1")!.status).toBe("awaiting_payment");

    const cleared = captureIo();
    expect(await cliMain(["list", "--db", path], cleared.io)).toBe(0);
    expect(cleared.lines.join("\n")).toContain("no stuck orders");

    // A usage error is a usage error, not a money-path surprise.
    const usage = captureIo();
    expect(await cliMain(["nonsense", "--db", path], usage.io)).toBe(2);
    expect(usage.errors.join("\n")).toContain("unknown command");
    store.close();
  }, 30_000);
});
