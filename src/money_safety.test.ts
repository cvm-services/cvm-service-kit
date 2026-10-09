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
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { SqliteGateStore } from "./gate-store.ts";
import {
  ExplicitGate,
  MemoryOrderStore,
  PaymentRequiredError,
  type GateOrder,
  type Invoice,
  type PaymentProcessor,
} from "./payment.ts";

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

/** A fresh on-disk store per test, so a stale /tmp file can never mask a result. */
function mkStore(): { store: SqliteGateStore; path: string } {
  const path = join(mkdtempSync(join(tmpdir(), "gate-money-")), "gate.sqlite");
  return { store: new SqliteGateStore(path), path };
}

/**
 * Generous per-test timeout for the on-disk store tests.
 *
 * The assertions below are logical, not timing-based, but SQLite file I/O and
 * process spawning are timing-sensitive on a busy machine: with this box at
 * load 14-17 on 4 cores the whole file ran 5-10x slower and hit bun's 5s default
 * timeout while doing nothing wrong. Measured: with these timeouts the file is
 * 10/10 green at load 17.4.
 */
const SLOW = 30_000;

const awaitingOrder = (orderId: string): GateOrder => ({
  orderId,
  tool: "tool:place_order",
  caller: "npub1facilitator",
  amountSats: 5022,
  invoice: invoiceFor(orderId),
  status: "awaiting_payment",
  createdAt: 1,
  updatedAt: 1,
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
  /**
   * The heartbeat of the whole fix: `claim` is what makes exactly one caller
   * the owner of a paid order, and therefore the only caller allowed to run the
   * downstream action.
   *
   * Regression note (2026-10-09): this test previously extracted the method
   * unbound - `const claim = (store as ...).claim; claim(...)` - so `this` was
   * `undefined` inside `SqliteGateStore.claim` and the test failed with
   * `TypeError: undefined is not an object (evaluating 'this.db')`. It now calls
   * `store.claim(...)` as a method, and asserts the property the name promises
   * rather than merely that the method exists.
   */
  test("claim is compare-and-set on the order status", () => {
    const { store } = mkStore();
    store.put(awaitingOrder("x"));

    // The one transition that hands a single caller the right to act.
    expect(store.claim("x", "awaiting_payment", "settlement_reserved")).toBe(true);
    // A second claim for the same transition loses: still exactly one owner.
    expect(store.claim("x", "awaiting_payment", "settlement_reserved")).toBe(false);
    expect(store.get("x")!.status).toBe("settlement_reserved");

    // A losing claim must not touch the row, so the loser cannot smuggle in a
    // second transition behind the winner's back.
    expect(store.claim("x", "awaiting_payment", "settled")).toBe(false);
    expect(store.claim("x", "awaiting_payment", "refused")).toBe(false);
    expect(store.get("x")!.status).toBe("settlement_reserved");

    // `from` is genuinely compared, not ignored. Positive control - a claim from
    // the status the row is ACTUALLY in still wins, so this is not an
    // implementation that simply answers "true" once and "false" forever.
    expect(store.claim("x", "settlement_reserved", "settled")).toBe(true);
    expect(store.get("x")!.status).toBe("settled");

    // A claim from a status the row is NOT in always loses, whatever the target:
    // `claim` compares `from`, so it can never resurrect a terminal order by
    // pretending the row is somewhere else.
    expect(store.claim("x", "settlement_failed", "settlement_reserved")).toBe(false);
    expect(store.claim("x", "settlement_reserved", "settlement_reserved")).toBe(false);
    expect(store.get("x")!.status).toBe("settled");

    // A claim against an order that does not exist never wins.
    expect(store.claim("no-such-order", "awaiting_payment", "settlement_reserved")).toBe(false);

    store.close();
  }, SLOW);

  test("claim is compare-and-set across independent connections", () => {
    // Two SqliteGateStore instances are two SQLite connections over one file:
    // exactly what two control-plane workers look like.
    const { store: a, path } = mkStore();
    const b = new SqliteGateStore(path);
    a.put(awaitingOrder("y"));

    // b reads a pre-image BEFORE the winner commits ...
    expect(b.get("y")!.status).toBe("awaiting_payment");
    expect(a.claim("y", "awaiting_payment", "settlement_reserved")).toBe(true);
    // ... and must still lose: the comparison is evaluated by the row at UPDATE
    // time, not against b's stale snapshot. An implementation that decided from
    // a cached / earlier read would win here and hand out two owners.
    expect(b.claim("y", "awaiting_payment", "settlement_reserved")).toBe(false);
    expect(b.get("y")!.status).toBe("settlement_reserved");

    a.close();
    a.close();
    b.close();
  }, SLOW);

  test("a replayed proof does not re-run the tool after a restart", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "gate-restart-")), "gate.sqlite");
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
  }, SLOW);

  test(
    "exactly one truly concurrent caller wins the claim",
    async () => {
      // The deterministic tests above pin the COMPARISON; this one pins the
      // ATOMICITY, under real parallelism. One OS PROCESS per caller - separate
      // processes, not worker threads, because SQLite's POSIX advisory locks are
      // per-process (see the runner's header). Released together by a common
      // start barrier, they mirror three workers that all saw `awaiting_payment`,
      // which is the double-spend scenario: two fiat attempts against one sats
      // payment.
      //
      // What this test can and cannot see (measured, see REPORT.md): with all
      // callers colliding on SQLite's write lock, exactly one takes the row and
      // the rest fail closed, so it demonstrates the "never two winners"
      // invariant. It cannot distinguish an implementation whose decision and
      // write are not one statement, because the write lock serialises them; the
      // truth-table and cross-connection tests above are what catch a claim that
      // drops the `from` guard or answers from a snapshot.
      const CALLERS = 3;
      const { store: seed, path } = mkStore();
      seed.put(awaitingOrder("race"));
      seed.close();

      const runner = fileURLToPath(new URL("./money_safety.cas_runner.ts", import.meta.url));
      const startAt = Date.now() + 300;
      const procs = Array.from({ length: CALLERS }, () =>
        Bun.spawn({
          cmd: [process.execPath, runner, path, "race", String(startAt)],
          stdout: "pipe",
        }),
      );

      let outcomes: string[];
      try {
        outcomes = await Promise.all(
          procs.map(async (p) => (await new Response(p.stdout).text()).trim()),
        );
      } finally {
        await Promise.all(procs.map((p) => p.exited));
      }

      // Exactly one caller takes the transition. Two or more is the double spend
      // this fix exists to prevent.
      expect(outcomes.filter((o) => o === "won").length).toBe(1);
      // Nobody produced an unexpected outcome: every caller either took the row,
      // lost the comparison, or failed closed on the lock.
      expect(outcomes.filter((o) => o !== "won" && o !== "lost" && o !== "locked")).toEqual([]);

      const check = new SqliteGateStore(path);
      expect(check.get("race")!.status).toBe("settlement_reserved");
      check.close();
    },
    30_000,
  );
});
