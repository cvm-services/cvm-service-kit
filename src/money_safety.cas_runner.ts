/**
 * Standalone runner for the compare-and-set concurrency test in
 * `money_safety.test.ts`. Executed as its own OS process - one process per
 * caller, exactly like two control-plane workers.
 *
 * Separate PROCESSES, not worker threads: SQLite's unix VFS uses POSIX advisory
 * locks, which are per-*process*, so threads inside one process fight over lock
 * state that SQLite does not expect to be shared. That produces a storm of
 * spurious SQLITE_BUSY and does not model independent callers at all. One
 * process per caller is both accurate and quiet.
 *
 * Takes one shot, and reports the outcome on stdout:
 *   won     - this caller took the compare-and-set
 *   lost    - this caller reached the row and lost the comparison
 *   locked  - SQLITE_BUSY: this caller could not take the lock and did nothing
 *             (fail closed - a lock error must never run the downstream action)
 *
 * Not a test file itself: `bun test` does not collect this name.
 */
import { SqliteGateStore } from "./gate-store.ts";

const [path, orderId, startAtArg] = process.argv.slice(2);
const startAt = Number(startAtArg);

const store = new SqliteGateStore(path);

// Common start barrier: without it the first process would finish before the
// rest had opened the file and the "race" would be a fiction.
while (Date.now() < startAt) await Bun.sleep(1);

let outcome: string;
try {
  outcome = store.claim(orderId, "awaiting_payment", "settlement_reserved") ? "won" : "lost";
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  outcome = /locked|busy/i.test(message) ? "locked" : `error:${message}`;
}

store.close();
console.log(outcome);
