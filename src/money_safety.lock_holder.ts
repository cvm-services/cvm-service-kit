/**
 * Hold a write lock on a gate database for `holdMs`, then release it.
 *
 * WHY THIS IS A SEPARATE PROCESS: `GateOrderStore.claim` is synchronous, so while
 * SQLite busy-waits inside it the JS event loop is blocked and no same-process
 * timer can ever fire to release the lock - a same-process version of this test
 * deadlocks by construction (measured 2026-10-10: the claim sat in the busy
 * timeout for the full 5 s and then threw, because the release timer could not
 * run). A second OS process is both what actually happens (two control-plane
 * workers over one gate.sqlite) and the only way to observe contention at all.
 *
 * Prints `holding` once the lock is held, so the test does not have to race.
 *
 * Usage: bun src/money_safety.lock_holder.ts <db-path> <hold-ms>
 */
import { Database } from "bun:sqlite";

const [path, holdMsRaw] = process.argv.slice(2);
const holdMs = Number(holdMsRaw ?? 200);

const db = new Database(path);
db.run("PRAGMA busy_timeout = 5000");
db.run("BEGIN IMMEDIATE");
console.log("holding");
await new Promise((r) => setTimeout(r, holdMs));
db.run("COMMIT");
db.close();
