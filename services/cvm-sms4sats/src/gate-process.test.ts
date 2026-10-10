/**
 * The two proofs that only a DURABLE gate store can give, for `cvm-sms4sats`
 * specifically - i.e. through the service's own wiring (`buildGate` +
 * `configFromEnv`), not through a hand-built gate that a test author could get
 * right while production stays wrong.
 *
 *   1. RESTART DURABILITY: a claim / settle / terminal failure is still there
 *      for a FRESH handle after the process that wrote it is gone, including the
 *      recorded failure reason.
 *   2. CROSS-PROCESS: a second claim attempt from a DIFFERENT PROCESS loses.
 *      Threads cannot exercise this (POSIX advisory locks are per-process; see
 *      `gate-process.runner.ts`), so a real second service process is spawned.
 *
 * The CONTROL test is deliberate: it shows the scenario REALLY catches an
 * in-process store (two sends from one payment), so the durable test passing is
 * evidence and not a tautology.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  SettlementFailedError,
  SqliteGateStore,
  type GateOrder,
  type Invoice,
  type PaymentProcessor,
} from "../../../src/index.ts";
import { buildGate } from "./server.ts";

const RUNNER = fileURLToPath(new URL("./gate-process.runner.ts", import.meta.url));
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

interface Case {
  db: string;
  outFile: string;
  sends: () => string[];
}

function mkCase(name: string): Case {
  const dir = mkdtempSync(join(tmpdir(), `sms4sats-${name}-`));
  const db = join(dir, "gate.sqlite");
  const outFile = join(dir, "sends.txt");
  writeFileSync(outFile, "");
  return { db, outFile, sends: () => readFileSync(outFile, "utf8").split("\n").filter(Boolean) };
}

function order(orderId: string, over: Partial<GateOrder> = {}): GateOrder {
  return {
    orderId,
    tool: "create_sms_order",
    caller: "npub1customer",
    amountSats: 2100,
    invoice: {
      orderId,
      paymentHash: "hash-" + orderId,
      amountSats: 2100,
      request: "lnbc-fake-" + orderId,
      pmi: "pmi:fake",
    },
    status: "awaiting_payment",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...over,
  };
}

/** Seed a state another process left behind, through a handle the service never sees. */
function seed(db: string, o: GateOrder): void {
  const store = new SqliteGateStore(db);
  store.put(o);
  store.close();
}

function statusOf(db: string, orderId: string): GateOrder | undefined {
  const store = new SqliteGateStore(db);
  const got = store.get(orderId);
  store.close();
  return got;
}

async function readAll(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const dec = new TextDecoder();
  let out = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return out;
    out += dec.decode(value, { stream: true });
  }
}

interface Run {
  token: string;
  stderr: string;
  code: number;
}

/** Spawn one real service process; resolve once it has exited and its pipes are drained. */
async function runServiceProcess(a: {
  db: string;
  orderId: string;
  outFile: string;
  startAt: number;
  shape?: "durable" | "no-store";
}): Promise<Run> {
  const proc = Bun.spawn({
    cmd: [
      process.execPath,
      RUNNER,
      a.db,
      a.orderId,
      a.outFile,
      String(a.startAt),
      `--shape=${a.shape ?? "durable"}`,
    ],
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    readAll(proc.stdout as ReadableStream<Uint8Array>),
    readAll(proc.stderr as ReadableStream<Uint8Array>),
  ]);
  const code = await proc.exited;
  const token = stdout.trim().split("\n").filter(Boolean).pop() ?? "";
  return { token, stderr, code };
}

function describeRuns(runs: Run[]): string {
  return runs.map((r, i) => `#${i} rc=${r.code} token=${r.token} stderr=${r.stderr.trim()}`).join(" | ");
}

describe("cvm-sms4sats gate: cross-process settlement", () => {
  test(
    "CONTROL: two service PROCESSES on the pre-fix no-store wiring both send (one payment, two SMS)",
    async () => {
      const c = mkCase("control-xproc");
      const startAt = Date.now() + 300;
      const [a, b] = await Promise.all([
        runServiceProcess({ db: c.db, orderId: "ctrl", outFile: c.outFile, startAt, shape: "no-store" }),
        runServiceProcess({ db: c.db, orderId: "ctrl", outFile: c.outFile, startAt, shape: "no-store" }),
      ]);
      expect(describeRuns([a, b])).toContain("ran");
      // The defect: each process has its own in-process Map, so nothing stops
      // the second process from spending the SAME payment a second time.
      expect(c.sends().length).toBe(2);
    },
    SLOW,
  );

  test(
    "one payment, one SMS send across two INDEPENDENT service processes (durable wiring)",
    async () => {
      const c = mkCase("race-xproc");
      const startAt = Date.now() + 400;
      const [a, b] = await Promise.all([
        runServiceProcess({ db: c.db, orderId: "race", outFile: c.outFile, startAt }),
        runServiceProcess({ db: c.db, orderId: "race", outFile: c.outFile, startAt }),
      ]);
      expect(describeRuns([a, b])).toContain("rc=0");
      expect(a.code).toBe(0);
      expect(b.code).toBe(0);

      // THE invariant: exactly one sender for one payment.
      expect(c.sends().length).toBe(1);

      const tokens = [a.token, b.token].sort();
      expect(tokens.filter((t) => t === "ran").length).toBe(1);
      // The loser LOST - it did not run, it refused (claim in flight) or replayed
      // (already settled). It must not be "ran" and it must not be a crash.
      const loser = tokens.find((t) => t !== "ran")!;
      expect(loser.startsWith("refused:") || loser.startsWith("replay:")).toBe(true);

      // And the shared database is what makes that true: it holds the terminal state.
      expect(statusOf(c.db, "race")!.status).toBe("settled");
    },
    SLOW,
  );

  test(
    "an order another PROCESS already claimed is refused; an already-settled one replays - neither sends",
    async () => {
      // Deterministic (no race): seed the two states a peer process can leave
      // behind, then run one real service process against each.
      const claimed = mkCase("seeded-claimed");
      seed(claimed.db, order("seeded-claimed", { status: "settlement_reserved" }));
      const r1 = await runServiceProcess({
        db: claimed.db,
        orderId: "seeded-claimed",
        outFile: claimed.outFile,
        startAt: 0,
      });
      expect(describeRuns([r1])).toContain("refused:SettlementInProgressError");
      expect(claimed.sends().length).toBe(0);
      expect(statusOf(claimed.db, "seeded-claimed")!.status).toBe("settlement_reserved");

      const settled = mkCase("seeded-settled");
      seed(
        settled.db,
        order("seeded-settled", { status: "settled", result: "sent-earlier" }),
      );
      const r2 = await runServiceProcess({
        db: settled.db,
        orderId: "seeded-settled",
        outFile: settled.outFile,
        startAt: 0,
      });
      expect(describeRuns([r2])).toContain("replay:sent-earlier");
      expect(settled.sends().length).toBe(0);
    },
    SLOW,
  );

  test(
    "restart durability through the service wiring: settled state and a terminal failure's reason survive a FRESH handle",
    async () => {
      const c = mkCase("restart");
      let runs = 0;
      const args = (orderId: string, run: () => Promise<string>) => ({
        tool: "create_sms_order",
        caller: "npub1customer",
        amountSats: 2100,
        orderId,
        proof: "cashu-proof",
        run,
      });

      // Process 1: one paid send.
      const gate1 = buildGate(new FakeProcessor(), c.db);
      expect(
        await gate1.gate(args("restart-ok", async () => (runs++, "sent-1"))),
      ).toBe("sent-1");
      expect(runs).toBe(1);

      // A FRESH handle - a new connection the service did not hand out - must see
      // the terminal state. This is what a restart looks like from SQLite's side.
      const fresh1 = new SqliteGateStore(c.db);
      expect(fresh1.get("restart-ok")!.status).toBe("settled");
      expect(fresh1.get("restart-ok")!.result).toBe("sent-1");
      fresh1.close();

      // Process 2 (a restart): same file, new gate, new store. The cached result
      // replays and the SMS is NOT sent a second time.
      const gate2 = buildGate(new FakeProcessor(), c.db);
      expect(
        await gate2.gate(args("restart-ok", async () => (runs++, "sent-2"))),
      ).toBe("sent-1");
      expect(runs).toBe(1);

      // The failure path: a run that failed must be TERMINAL, and its reason must
      // survive the restart - otherwise the operator loses the only evidence of
      // why a customer's payment did not turn into service.
      const failing = async (): Promise<string> => {
        runs++;
        throw new Error("upstream sms4sats refused the order");
      };
      await expect(gate2.gate(args("restart-fail", failing))).rejects.toThrow(
        "upstream sms4sats refused the order",
      );
      expect(runs).toBe(2);

      const fresh2 = new SqliteGateStore(c.db);
      expect(fresh2.get("restart-fail")!.status).toBe("settlement_failed");
      expect(fresh2.get("restart-fail")!.failure?.message).toContain(
        "upstream sms4sats refused the order",
      );
      fresh2.close();

      // Process 3: the retry after the restart re-throws the recorded reason and
      // never runs the action again.
      const gate3 = buildGate(new FakeProcessor(), c.db);
      const err = await gate3.gate(args("restart-fail", failing)).catch((e) => e);
      expect(err).toBeInstanceOf(SettlementFailedError);
      expect((err as SettlementFailedError).message).toContain(
        "upstream sms4sats refused the order",
      );
      expect(runs).toBe(2);
    },
    SLOW,
  );
});
