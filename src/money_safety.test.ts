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
import { Database } from "bun:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { SqliteGateStore } from "./gate-store.ts";
import {
  ExplicitGate,
  GateOrderStateError,
  MemoryOrderStore,
  PaymentRequiredError,
  SettlementFailedError,
  type GateOrder,
  type GateOrderStatus,
  type GateOrderStore,
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
    // a second fiat action against the same payment, and it must say WHY it is
    // refusing rather than "any throw will do": a bare `rejects.toThrow()` would
    // also pass for an unrelated crash (e.g. the store throwing SQLITE_BUSY).
    const second = await gate.gate(req("o1", boom)).catch((e) => e);
    expect(second).toBeInstanceOf(SettlementFailedError);
    expect((second as SettlementFailedError).code).toBe(-32004);
    expect((second as SettlementFailedError).orderId).toBe("o1");
    expect((second as Error).message).toContain("venue refused");
    expect(runs).toBe(1);
  });

  test("an unrecognised order status is refused, never run", async () => {
    // A row written by a build that does not exist yet (a future status, or a
    // status a rollback re-introduced). Enumerating the statuses we know and
    // letting everything else fall through to `run()` is a fail-OPEN: an
    // unverified order would execute the downstream action with no claim.
    const processor = new FakeProcessor();
    processor.paid = true;
    const store = new MemoryOrderStore();
    store.put({ ...awaitingOrder("w1"), status: "status_from_the_future" as GateOrderStatus });
    const gate = new ExplicitGate(processor, store);
    let runs = 0;
    const run = async () => {
      runs++;
      return "placed";
    };

    const err = await gate.gate(req("w1", run)).catch((e) => e);
    expect(err).toBeInstanceOf(GateOrderStateError);
    expect((err as GateOrderStateError).code).toBe(-32005);
    expect((err as GateOrderStateError).status).toBe("status_from_the_future");
    expect(runs).toBe(0);
  });

  test("a legacy `paid` row is refused as an unverifiable state", async () => {
    // `paid` was written BEFORE the action ran by the pre-2026-10-09 code, so the
    // outcome (did the venue get called?) is unknowable. Fail closed: refuse, do
    // not run, and do not report it as a settlement failure it may never have had.
    const processor = new FakeProcessor();
    processor.paid = true;
    const store = new MemoryOrderStore();
    store.put({ ...awaitingOrder("legacy1"), status: "paid" });
    const gate = new ExplicitGate(processor, store);
    let runs = 0;

    const err = await gate.gate(req("legacy1", async () => (runs++, "placed"))).catch((e) => e);
    expect(err).toBeInstanceOf(GateOrderStateError);
    expect((err as GateOrderStateError).status).toBe("paid");
    expect(runs).toBe(0);
  });

  test("a void tool (run() returns undefined) still replays from the cache", async () => {
    // The replay guard must key on the order STATUS, not on `result !== undefined`.
    // A void tool legitimately returns `undefined`; if the guard tested the result,
    // such a settled order would fall through every status guard and call
    // `run()` again against the same payment - the original double spend, back
    // for that tool shape. Both stores are exercised: `SqliteGateStore` stores a
    // missing result as SQL NULL and reads it back as `undefined`, so a
    // result-keyed guard fails there too.
    const stores: Array<[string, GateOrderStore]> = [
      ["memory", new MemoryOrderStore()],
      ["sqlite", (() => {
        const { store } = mkStore();
        return store;
      })()],
    ];

    for (const [kind, store] of stores) {
      const processor = new FakeProcessor();
      processor.paid = true;
      const gate = new ExplicitGate(processor, store);
      let runs = 0;
      const voidRun = async () => {
        runs++;
        return undefined;
      };

      expect(await gate.gate(req(`void-${kind}`, voidRun))).toBeUndefined();
      expect(await gate.gate(req(`void-${kind}`, voidRun))).toBeUndefined();
      expect(runs).toBe(1);
    }
  }, SLOW);

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
    b.close();
  }, SLOW);

  test("a failed run stays terminal ACROSS A RESTART, with its reason recorded", async () => {
    // The mirror of the restart-replay test above, for the failure path. The card
    // requires a failed settlement to be TERMINAL *and* to "return the recorded
    // failure". A store that persists the status but drops `failure` on write
    // leaves a restart reporting "unknown", i.e. the operator loses the reason the
    // customer's payment did not turn into service - the only evidence there is.
    const path = join(mkdtempSync(join(tmpdir(), "gate-fail-restart-")), "gate.sqlite");
    const p1 = new FakeProcessor();
    p1.paid = true;
    const gate1 = new ExplicitGate(p1, new SqliteGateStore(path));
    let runs = 0;
    const boom = async () => {
      runs++;
      throw new Error("venue refused the card");
    };
    await expect(gate1.gate(req("fr1", boom))).rejects.toThrow("venue refused the card");

    // Restart: new gate, new store, same file. Same proof, same order.
    const p2 = new FakeProcessor();
    p2.paid = true;
    const store2 = new SqliteGateStore(path);
    expect(store2.get("fr1")!.status).toBe("settlement_failed");

    const err = await new ExplicitGate(p2, store2).gate(req("fr1", boom)).catch((e) => e);
    expect(err).toBeInstanceOf(SettlementFailedError);
    expect((err as SettlementFailedError).message).toContain("venue refused the card");
    expect(runs).toBe(1);
    store2.close();
  }, SLOW);

  test("lock contention busy-waits and then claims cleanly, never throwing raw SQLITE_BUSY", async () => {
    // `claim` is called AFTER `verify` accepted a real payment, so a raw
    // SQLITE_BUSY escaping from it turns a paid call into an opaque 500. Worse,
    // the same throw from the terminal `put()` leaves the row at
    // `settlement_reserved` forever - the customer paid and can never retry.
    // PRAGMA busy_timeout turns lock contention into an ordinary lost CAS.
    const { store, path } = mkStore();
    store.put(awaitingOrder("busy"));

    // A different PROCESS holds the write lock for 200 ms, exactly like another
    // worker's in-flight claim on the same order file. It must be a real process:
    // claim() is synchronous, so a same-process timer can never release the lock
    // while SQLite busy-waits (see money_safety.lock_holder.ts).
    const holder = Bun.spawn({
      cmd: [
        process.execPath,
        fileURLToPath(new URL("./money_safety.lock_holder.ts", import.meta.url)),
        path,
        "400",
      ],
      stdout: "pipe",
      stderr: "pipe",
    });
    const reader = holder.stdout.getReader();
    // Do not race the claim against the lock: wait until the child really holds it.
    const first = await reader.read();
    reader.releaseLock();
    expect(new TextDecoder().decode(first.value).trim()).toBe("holding");

    // Without a busy timeout this THROWS SQLITE_BUSY instead of waiting (that is
    // the failure mode this test exists for). With one, it waits for the holder to
    // release and then wins the still-free transition: contention becomes a slow
    // CAS, not an opaque 500 on a call whose payment was already verified.
    const started = performance.now();
    const won = store.claim("busy", "awaiting_payment", "settlement_reserved");
    const waited = performance.now() - started;
    expect(won).toBe(true);
    // It must have actually waited for the other writer (the holder keeps the lock
    // for 400 ms), not merely got lucky because the lock was already released.
    expect(waited).toBeGreaterThan(150);
    expect(store.get("busy")!.status).toBe("settlement_reserved");
    expect(await holder.exited).toBe(0);
    store.close();
  }, SLOW);

  test("an existing pre-fix database is migrated, not left column-less", () => {
    // Deployed services already have a gate.sqlite on disk. `CREATE TABLE IF NOT
    // EXISTS` does nothing to an existing file, so without an explicit migration
    // every running deployment would keep the old schema and hit "no such column"
    // (or silently drop the failure reason) on the first failed settlement.
    const path = join(mkdtempSync(join(tmpdir(), "gate-migrate-")), "gate.sqlite");
    const legacy = new Database(path);
    legacy.run(`CREATE TABLE gate_orders (
      order_id TEXT PRIMARY KEY,
      tool TEXT NOT NULL,
      caller TEXT NOT NULL,
      amount_sats INTEGER NOT NULL,
      invoice_json TEXT NOT NULL,
      status TEXT NOT NULL,
      result_json TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`);
    // A row the live code may already hold: sats taken, outcome unknown.
    legacy.run(
      `INSERT INTO gate_orders VALUES ('m1','tool','npub1c',1,'{}','paid',NULL,1,1)`,
    );
    legacy.close();

    const store = new SqliteGateStore(path);
    // The legacy row survives the migration untouched - it is refused, not rewritten.
    expect(store.get("m1")!.status).toBe("paid");
    const order = store.get("m1")!;
    order.status = "settlement_failed";
    order.failure = { message: "venue refused", at: 7 };
    store.put(order);
    store.close();

    // Restart over the migrated file: the reason is still there.
    const again = new SqliteGateStore(path);
    expect(again.get("m1")!.status).toBe("settlement_failed");
    expect(again.get("m1")!.failure).toEqual({ message: "venue refused", at: 7 });
    again.close();
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
      // What this test can and cannot see (measured 2026-10-10, see REPORT.md and
      // evidence/mutation_M*.txt): with all callers colliding on SQLite's write
      // lock, exactly one takes the row and the rest fail closed, so it
      // demonstrates the "never two winners" invariant.
      //
      // A single round is NOT enough to rely on as a mutant-killer. Against a
      // mutant whose claim reads the row and only THEN writes it unguarded (the
      // TOCTOU shape), one round caught it in 4 of 6 runs - the losing window is
      // one synchronous statement pair, so it only trips when two processes
      // genuinely interleave. Four rounds are kept as defence in depth, but the
      // committed 6-run measurement of the 4-round loop caught that mutant in the
      // SAME 4 of 6 runs, so this sample shows NO measured improvement and NO
      // detection percentage is claimed for this test (REPORT.md, "Mutation
      // re-measurement"). What carries the guarantee is the DETERMINISTIC
      // truth-table and cross-connection tests above: an implementation that
      // answers from a comparison instead of a statement fails those on every run
      // (measured: 2 failures).
      const CALLERS = 3;
      const ROUNDS = 4;
      const runner = fileURLToPath(new URL("./money_safety.cas_runner.ts", import.meta.url));
      const failures: string[] = [];

      for (let round = 0; round < ROUNDS; round++) {
        const { store: seed, path } = mkStore();
        seed.put(awaitingOrder("race"));
        seed.close();

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

        const check = new SqliteGateStore(path);
        const finalStatus = check.get("race")!.status;
        check.close();

        // Exactly one caller takes the transition per round. Two or more is the
        // double spend this fix exists to prevent.
        const winners = outcomes.filter((o) => o === "won").length;
        // Nobody produced an unexpected outcome: every caller either took the row,
        // lost the comparison, or failed closed on the lock.
        const unexpected = outcomes.filter((o) => o !== "won" && o !== "lost" && o !== "locked");
        if (winners !== 1 || unexpected.length > 0 || finalStatus !== "settlement_reserved") {
          failures.push(
            `round ${round}: winners=${winners} final=${finalStatus} outcomes=[${outcomes.join(",")}]`,
          );
        }
      }

      expect(failures).toEqual([]);
    },
    60_000,
  );
});
