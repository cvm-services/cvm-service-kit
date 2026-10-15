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
import { SqliteGateStore, type GateResolution } from "./gate-store.ts";
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

    // An order that is NOT compensatable (settled / awaiting_payment) is refused,
    // so a compensation can never brand a live or successful order as resolved.
    const other = new SqliteGateStore(path);
    crashAfterClaim(other, "live1");
    // A reservation IS compensatable (review finding B3: the runbook tells the
    // operator to record a compensation for a crashed-after-venue order, and
    // before this fix the API refused exactly that row).
    expect(recordCompensation(other, "live1", { outcome: "abandoned", note: "x" }).recorded).toBe(true);
    const settled = awaiting("set1");
    settled.status = "settled";
    other.put(settled);
    expect(recordCompensation(other, "set1", { outcome: "abandoned", note: "x" }).refusal).toBe(
      "not_compensatable",
    );
    expect(recordCompensation(other, "ghost", { outcome: "abandoned", note: "x" }).refusal).toBe(
      "not_found",
    );
    other.close();
    reopened.close();
  }, 30_000);
});

describe("gate recovery: round-2 review findings", () => {
  test("B2: a legacy 'paid' row is surfaced AND compensatable (it had no surface at all)", async () => {
    const { store } = mkStore();
    const legacy = awaiting("legacy1");
    // `paid` is the pre-2026-10-09 status, written BEFORE the action ran.
    legacy.status = "paid";
    store.put(legacy);

    const report = findStuckOrders(store, { now: 60 * MINUTE });
    expect(report.legacy).toHaveLength(1);
    expect(report.legacy[0]!.order.orderId).toBe("legacy1");
    expect(report.reserved).toHaveLength(0);
    expect(report.failed).toHaveLength(0);

    // Release refuses it (it is not a reservation) and it is never re-driven ...
    expect(releaseReservation(store, "legacy1", { force: true }).refusal).toBe("not_reserved");
    // ... but the money can be recorded, which is the only possible operator act.
    expect(recordCompensation(store, "legacy1", { outcome: "refunded", note: "unverifiable" }).recorded)
      .toBe(true);
    expect(store.get("legacy1")!.status).toBe("paid");

    // The operator command surfaces the bucket explicitly.
    const path = join(mkdtempSync(join(tmpdir(), "gate-legacy-")), "gate.sqlite");
    const s2 = new SqliteGateStore(path);
    s2.put({ ...legacy, orderId: "legacy2" });
    const cap = captureIo();
    expect(await cliMain(["list", "--db", path], cap.io)).toBe(0);
    expect(cap.lines.join("\n")).toContain("legacy-paid legacy2");
    expect(cap.lines.join("\n")).toContain("outcome is unverifiable");
    s2.close();
    store.close();
  }, 30_000);

  test("B4/B1: a live lease cannot be released without --force, and --lease-min cannot be lowered", async () => {
    const { store, path } = mkStore();
    crashAfterClaim(store, "aba1");

    // (a) The non-force path: the row is live, so the release refuses. This is
    // what makes the ABA sequence impossible WITHOUT --force: a second operator
    // re-reads, sees a freshly-claimed row, and is refused by the lease.
    const first = releaseReservation(store, "aba1", { leaseMs: DEFAULT_RESERVATION_LEASE_MS });
    expect(first.released).toBe(false);
    expect(first.refusal).toBe("lease_active");

    // (b) The ABA shape: release, a caller re-claims, then a SECOND release.
    const forced = releaseReservation(store, "aba1", { leaseMs: DEFAULT_RESERVATION_LEASE_MS, force: true });
    expect(forced.released).toBe(true);
    expect(store.claim("aba1", "awaiting_payment", "settlement_reserved")).toBe(true); // caller C
    const second = releaseReservation(store, "aba1", { leaseMs: DEFAULT_RESERVATION_LEASE_MS });
    expect(second.released).toBe(false);
    expect(second.refusal).toBe("lease_active"); // C's claim reset updatedAt
    expect(store.get("aba1")!.status).toBe("settlement_reserved");

    // (c) --lease-min may only raise the guard, never lower it: shrinking the
    // lease would be --force without the flag (and without the audit trail).
    const lowered = captureIo();
    expect(await cliMain(["release", "--db", path, "--order", "aba1", "--lease-min", "0.001"], lowered.io))
      .toBe(2);
    expect(lowered.errors.join("\n")).toContain("may not be lower");
    const raised = captureIo();
    expect(await cliMain(["list", "--db", path, "--lease-min", "30"], raised.io)).toBe(0);
    store.close();
  }, 30_000);

  test("B6: an un-computable age FAILS CLOSED instead of reading as long-expired", async () => {
    // The schema declares `updated_at INTEGER NOT NULL`, so SQLite refuses to
    // write a NULL there — the reachable shapes are a row written by a different
    // store implementation, a hand-edited file, or a future schema change. Drive
    // the guard directly with a store that reports a non-finite `updatedAt`; the
    // point under test is `releaseReservation`'s behaviour, not how the row got
    // that way.
    const nanOrder: GateOrder = {
      ...awaiting("nan1"),
      status: "settlement_reserved",
      updatedAt: Number.NaN,
    };
    let claims = 0;
    const stub = {
      get: () => nanOrder,
      list: () => [nanOrder],
      listResolutions: () => [],
      releaseIfUnchanged: () => {
        claims++;
        return true;
      },
    } as unknown as SqliteGateStore;

    const report = findStuckOrders(stub, { now: 999 * MINUTE });
    expect(report.reserved).toHaveLength(1);
    expect(Number.isFinite(report.reserved[0]!.ageMs)).toBe(false);
    expect(report.reserved[0]!.leaseExpired).toBe(false); // never "safe because old"

    // Fail closed: refused as if the lease were live, and the CAS is never
    // reached. `Number.NaN <= leaseMs` is FALSE, so the unguarded form would
    // have fallen straight through to `claim()`.
    const out = releaseReservation(stub, "nan1", { leaseMs: DEFAULT_RESERVATION_LEASE_MS });
    expect(out.released).toBe(false);
    expect(out.refusal).toBe("lease_active");
    expect(claims).toBe(0);

    // --force remains the explicit, deliberate override.
    expect(releaseReservation(stub, "nan1", { force: true }).released).toBe(true);
    expect(claims).toBe(1);
  }, 30_000);

  test("B1 round-4 / M1 round-5: a STALE read cannot cancel a live re-claim — even in the same ms", () => {
    // The exact interleaving the round-4 review described, driven THROUGH
    // releaseReservation. A reads the row in `get()`; before A's CAS lands, B
    // releases it and a caller C re-claims it back to `settlement_reserved`. A
    // status-only CAS would match that status again and cancel C's live lease.
    // `updated_at` alone would ALSO match when the two transitions land in the same
    // millisecond — so the CAS uses the monotonic `rev` (round-5 finding M1).
    const { store } = mkStore();
    crashAfterClaim(store, "aba3");
    const observed = store.get("aba3")!;
    expect(observed.status).toBe("settlement_reserved");

    let interfered = false;
    const racing = {
      get: (id: string) => {
        const row = store.get(id);
        if (!interfered) {
          interfered = true;
          // B releases using the revision it inspected, then C re-claims.
          expect(store.releaseIfUnchanged(id, observed.rev ?? 0)).toBe(true);
          expect(store.claim(id, "awaiting_payment", "settlement_reserved")).toBe(true);
        }
        return row; // A's STALE snapshot
      },
      list: (s: Parameters<SqliteGateStore["list"]>[0]) => store.list(s),
      listResolutions: () => store.listResolutions(),
      releaseIfUnchanged: (id: string, exp: number) => store.releaseIfUnchanged(id, exp),
      claim: (id: string, from: GateOrder["status"], to: GateOrder["status"]) =>
        store.claim(id, from, to),
    } as unknown as SqliteGateStore;

    const out = releaseReservation(racing, "aba3", {
      now: observed.updatedAt + 60 * MINUTE, // A believes the lease is long expired
    });
    expect(out.released).toBe(false);
    expect(out.refusal).toBe("raced"); // NOT a silent success
    // C's live claim survived, and the row advanced one revision per transition.
    const after = store.get("aba3")!;
    expect(after.status).toBe("settlement_reserved");
    expect(after.rev).toBe((observed.rev ?? 0) + 2);
    // The round-5 point: the version is monotonic, so it does not matter whether
    // the two transitions shared a millisecond.
    expect(after.rev).not.toBe(observed.rev);
  }, 30_000);

  test("H1 round-5: a COMPENSATED reservation can never be released (no refund AND service)", async () => {
    const { store, path } = mkStore();
    crashAfterClaim(store, "comp1");

    // The operator checked the venue, found it delivered, and refunded the customer.
    expect(recordCompensation(store, "comp1", { outcome: "refunded", note: "venue confirms" }).recorded)
      .toBe(true);

    // A release afterwards would let a retry run the action: the customer would
    // hold both the refund and the service. It must be REFUSED - even with --force,
    // and even with a long-expired lease.
    const expired = releaseReservation(store, "comp1", { now: 10 * 60 * MINUTE });
    expect(expired.released).toBe(false);
    expect(expired.refusal).toBe("compensated");
    const forced = releaseReservation(store, "comp1", { now: 10 * 60 * MINUTE, force: true });
    expect(forced.released).toBe(false);
    expect(forced.refusal).toBe("compensated");
    expect(store.get("comp1")!.status).toBe("settlement_reserved");

    // And end to end through the CLI (exit 1, nothing moved).
    const cap = captureIo();
    expect(await cliMain(["release", "--db", path, "--order", "comp1", "--force"], cap.io)).toBe(1);
    expect(cap.errors.join("\n")).toContain("CLOSED");
    expect(store.get("comp1")!.status).toBe("settlement_reserved");
    store.close();
  }, 30_000);

  test("H2 round-5: a compensation cannot be recorded for a row that moved (it settled)", () => {
    const { store } = mkStore();
    crashAfterClaim(store, "race2");
    const observed = store.get("race2")!;
    expect(observed.status).toBe("settlement_reserved");

    // The action finishes successfully between the operator's read and the write.
    expect(store.claim("race2", "settlement_reserved", "settled")).toBe(true);

    // The conditional append must lose: no refund is recorded against an order
    // that actually succeeded.
    const stale = {
      get: () => observed, // the STALE snapshot
      list: (s: Parameters<SqliteGateStore["list"]>[0]) => store.list(s),
      listResolutions: () => store.listResolutions(),
      putResolution: (r: GateResolution, expect: { status: GateOrder["status"]; rev: number }) =>
        store.putResolution(r, expect),
    } as unknown as SqliteGateStore;

    const res = recordCompensation(stale, "race2", { outcome: "refunded", note: "too late" });
    expect(res.recorded).toBe(false);
    expect(res.refusal).toBe("raced");
    expect(store.listResolutions()).toHaveLength(0);
    store.close();
  }, 30_000);

  test("M2 round-5: a zero/epoch `updatedAt` also FAILS CLOSED", () => {
    const epochOrder: GateOrder = {
      ...awaiting("epoch1"),
      status: "settlement_reserved",
      updatedAt: 0, // finite, but "no real timestamp was ever written"
    };
    let releases = 0;
    const stub = {
      get: () => epochOrder,
      list: () => [epochOrder],
      listResolutions: () => [],
      releaseIfUnchanged: () => {
        releases++;
        return true;
      },
    } as unknown as SqliteGateStore;

    const report = findStuckOrders(stub, { now: 999 * MINUTE });
    expect(report.reserved[0]!.leaseExpired).toBe(false);
    const out = releaseReservation(stub, "epoch1", {});
    expect(out.refusal).toBe("lease_active");
    expect(releases).toBe(0); // the guard ran; 0 is NOT "infinitely old"
  }, 30_000);

  test("L1 round-5: a flag the command does not honour is a USAGE ERROR, not silently ignored", async () => {
    const { store, path } = mkStore();
    crashAfterClaim(store, "flag1");
    const cap = captureIo();

    // `compensate` has no break-glass: accepting --force would imply it does.
    expect(await cliMain(
      ["compensate", "--db", path, "--order", "flag1", "--outcome", "refunded", "--note", "x", "--force"],
      cap.io,
    )).toBe(2);
    expect(cap.errors.join("\n")).toContain("not a valid option for `compensate`");

    // `list` has no --force either, and `release` records no --outcome.
    const cap2 = captureIo();
    expect(await cliMain(["list", "--db", path, "--force"], cap2.io)).toBe(2);
    const cap3 = captureIo();
    expect(await cliMain(
      ["release", "--db", path, "--order", "flag1", "--outcome", "refunded"],
      cap3.io,
    )).toBe(2);
    expect(store.get("flag1")!.status).toBe("settlement_reserved");
    store.close();
  }, 30_000);

  test("B5 round-4: the CURRENT compensation is the last WRITTEN, not the largest `at`", () => {
    // Append-only correctness must not depend on the clock: a later correction
    // written with a skewed-back `at` is still the current record.
    const { store } = mkStore();
    const failed = awaiting("skew1");
    failed.status = "settlement_failed";
    store.put(failed);

    recordCompensation(store, "skew1", { outcome: "abandoned", note: "written first", now: 1000 });
    recordCompensation(store, "skew1", {
      outcome: "refunded",
      note: "written second, clock skewed back",
      now: 500,
    });

    // History keeps both, in insertion order ...
    expect(store.listResolutions().map((r) => r.note)).toEqual([
      "written first",
      "written second, clock skewed back",
    ]);
    // ... and the operator sees the LAST WRITTEN record.
    const report = findStuckOrders(store, { now: 60 * MINUTE });
    expect(report.failed[0]!.resolution?.outcome).toBe("refunded");
    store.close();
  }, 30_000);

  test("B5: the compensation log is APPEND-ONLY — a correction adds, it does not erase", async () => {
    const { store, path } = mkStore();
    const failed = awaiting("hist1");
    failed.status = "settlement_failed";
    store.put(failed);

    recordCompensation(store, "hist1", { outcome: "abandoned", note: "first read", now: 10 });
    recordCompensation(store, "hist1", { outcome: "refunded", note: "corrected: refunded", now: 20 });

    // Both records survive, oldest first ...
    expect(store.listResolutions().map((r) => `${r.outcome}:${r.note}`)).toEqual([
      "abandoned:first read",
      "refunded:corrected: refunded",
    ]);
    // ... and it is durable across a process restart.
    store.close();
    const reopened = new SqliteGateStore(path);
    expect(reopened.listResolutions()).toHaveLength(2);
    // The stuck report shows the LATEST record for the order, not the first.
    const report = findStuckOrders(reopened, { now: 60 * MINUTE });
    expect(report.failed[0]!.resolution?.outcome).toBe("refunded");
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
