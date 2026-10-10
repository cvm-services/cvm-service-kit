/**
 * One `cvm-sms4sats` service process, one shot, over one shared gate database.
 *
 * WHY A SEPARATE PROCESS: `GateOrderStore.claim` is synchronous, and SQLite's
 * unix VFS locks are POSIX advisory locks, which are per-*process*. Two threads
 * in one process share lock state that SQLite does not expect to share, so a
 * thread-based "concurrent claim" test is not a model of two control-plane
 * workers at all - it is a model of something that never happens. Two OS
 * processes is both what actually happens in production (a restart mid-flight,
 * or two service replicas over one `GATE_DB`) and the only way to observe the
 * cross-process outcome. Same reasoning as `src/money_safety.cas_runner.ts`.
 *
 * One payment, one SMS send is the invariant. This runner reports what THIS
 * process did, and only ever writes to the shared send log when the downstream
 * paid action really runs:
 *
 *   ran                     - this process ran the paid action (appended a send)
 *   ran+error:<Name>        - it ran the action and something threw after that
 *   replay:<cached result>  - the order was already settled by someone else
 *   refused:<ErrorName>     - it never ran: in-progress, terminal, or unusable
 *
 * `--shape=no-store` reproduces the pre-fix wiring (`new ExplicitGate(processor)`,
 * no store) so the defect can be demonstrated cross-process as a CONTROL, and
 * `--shape=durable` (default) goes through the service's own `buildGate`.
 *
 * Not a test file itself: `bun test` does not collect this name.
 *
 * Usage: bun services/cvm-sms4sats/src/gate-process.runner.ts \
 *          <db-path> <order-id> <send-log-path> <start-at-ms> [--shape=durable|no-store]
 */
import { appendFileSync } from "node:fs";
import { ExplicitGate, type Invoice, type PaymentProcessor } from "../../../src/index.ts";
import { buildGate, configFromEnv } from "./server.ts";

const args = process.argv.slice(2);
const [dbPath, orderId, outFile, startAtArg] = args;
const shape = args.find((a) => a.startsWith("--shape="))?.slice("--shape=".length) ?? "durable";
const startAt = Number(startAtArg);

if (!dbPath || !orderId || !outFile || !Number.isFinite(startAt)) {
  console.error("usage: gate-process.runner.ts <db> <order-id> <send-log> <start-at-ms> [--shape=...]");
  process.exit(2);
}

/** The rail says yes: this scenario is about the gate's memory, not about payment. */
class AlwaysPaid implements PaymentProcessor {
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

const processor = new AlwaysPaid();
// The service's own configuration path (GATE_DB) and its own gate construction.
const cfg = configFromEnv({
  SERVER_SECRET_KEY: "ab".repeat(32),
  GATE_DB: dbPath,
  ANNOUNCE: "false",
});
const gate =
  shape === "no-store" ? new ExplicitGate(processor) : buildGate(processor, cfg.gateDb);

// Common start barrier: without it the first process would finish before its
// peer had even opened the database, and the "race" would be a fiction.
while (Date.now() < startAt) await Bun.sleep(1);

let ran = false;
try {
  const result = await gate.gate({
    tool: "create_sms_order",
    caller: "npub1customer",
    amountSats: 2100,
    orderId,
    proof: "cashu-proof",
    run: async () => {
      ran = true;
      // The downstream paid action: exactly one SMS send. Appending is atomic
      // for a line this size, so the log line count is the number of sends.
      appendFileSync(outFile, "send\n");
      // Hold the claim while the peer races, so the window is real and not
      // a matter of which process happened to win the scheduler.
      await Bun.sleep(250);
      return "sent";
    },
  });
  console.log(ran ? "ran" : `replay:${String(result)}`);
} catch (err) {
  const name = err instanceof Error ? err.name : "Error";
  console.log(ran ? `ran+error:${name}` : `refused:${name}`);
}
