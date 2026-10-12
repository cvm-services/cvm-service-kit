import { Database } from "bun:sqlite";
import { TERMINAL_STATUSES, type GateOrder, type GateOrderStore } from "./payment.ts";

/**
 * The `IN (...)` list for the new-generation `CASE` below, derived from the ONE
 * terminal-status list in `payment.ts` so the two bundled stores cannot drift.
 * Hardcoded string literals (not caller input), so interpolating them is safe.
 */
const TERMINAL_STATUS_SQL = TERMINAL_STATUSES.map((s) => `'${s}'`).join(", ");

/**
 * Durable implementation of the payment gate's order store. Without this, a
 * control-plane restart forgets paid orders and could re-run (or re-charge) a
 * replayed call.
 */
export class SqliteGateStore implements GateOrderStore {
  private readonly db: Database;

  constructor(path: string) {
    this.db = new Database(path);
    // Measured (2026-10-09): with no busy timeout, three simultaneous `claim()`
    // callers gave one winner and TWO raw `SQLITE_BUSY` throws. `claim` runs after
    // `verify()` has accepted a real payment, so that escapes as an opaque 500 for
    // a paid call - and the same throw from the terminal `put()` would leave the
    // row stuck at `settlement_reserved` forever. With a busy timeout, contention
    // becomes an ordinary lost CAS (or a slightly slower winner) instead.
    this.db.run("PRAGMA busy_timeout = 5000");
    this.db.run(`
      CREATE TABLE IF NOT EXISTS gate_orders (
        order_id TEXT PRIMARY KEY,
        tool TEXT NOT NULL,
        caller TEXT NOT NULL,
        amount_sats INTEGER NOT NULL,
        invoice_json TEXT NOT NULL,
        status TEXT NOT NULL,
        result_json TEXT,
        failure_json TEXT,
        proof_hash TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )`);
    // `failure_json` (the recorded reason a settlement failed terminally) was added
    // after this table shipped. `CREATE TABLE IF NOT EXISTS` is a no-op on an
    // existing deployed file, so migrate explicitly - otherwise every pre-existing
    // deployment keeps the column-less schema and loses the failure reason on the
    // very restart the reason exists to survive.
    const columns = this.db.query(`PRAGMA table_info(gate_orders)`).all() as { name: string }[];
    if (!columns.some((c) => c.name === "failure_json")) {
      this.db.run(`ALTER TABLE gate_orders ADD COLUMN failure_json TEXT`);
    }
    // `proof_hash` (the digest of the proof that settled the order, so a replay
    // can be bound to it) has the same migration trap as `failure_json`.
    if (!columns.some((c) => c.name === "proof_hash")) {
      this.db.run(`ALTER TABLE gate_orders ADD COLUMN proof_hash TEXT`);
    }
  }

  get(orderId: string): GateOrder | undefined {
    const row = this.db.query(`SELECT * FROM gate_orders WHERE order_id = ?`).get(orderId) as any;
    if (!row) return undefined;
    return {
      orderId: row.order_id,
      tool: row.tool,
      caller: row.caller,
      amountSats: row.amount_sats,
      invoice: JSON.parse(row.invoice_json),
      status: row.status,
      result: row.result_json ? JSON.parse(row.result_json) : undefined,
      failure: row.failure_json ? JSON.parse(row.failure_json) : undefined,
      proofHash: row.proof_hash ?? undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  /**
   * Compare-and-set on the order status. A single conditional UPDATE is atomic
   * in SQLite, so exactly one concurrent caller can move awaiting_payment ->
   * settlement_reserved and thus exactly one may run the downstream action.
   *
   * Deliberately NOT wrapped in an explicit transaction: the comparison and the
   * write are one statement, so a BEGIN/COMMIT pair would add no atomicity and
   * would add a second place that can fail on a locked database.
   */
  claim(
    orderId: string,
    from: GateOrder["status"],
    to: GateOrder["status"],
    proofHash?: string,
  ): boolean {
    // COALESCE, not an assignment: a claim that carries no evidence (a status
    // transition on an already-bound row) must not ERASE the recorded binding.
    const res = this.db.run(
      `UPDATE gate_orders SET status = ?, updated_at = ?, proof_hash = COALESCE(?, proof_hash)
       WHERE order_id = ? AND status = ?`,
      [to, Date.now(), proofHash ?? null, orderId, from],
    );
    return Number(res.changes ?? 0) === 1;
  }

  /** Release the SQLite handle, so a test runner can exit. */
  close(): void {
    this.db.close();
  }

  put(order: GateOrder): void {
    this.db.run(
      `INSERT INTO gate_orders (order_id, tool, caller, amount_sats, invoice_json,
                                status, result_json, failure_json, proof_hash,
                                created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(order_id) DO UPDATE SET
         status=excluded.status, result_json=excluded.result_json,
         failure_json=excluded.failure_json,
         -- COALESCE: a write that omits the digest must never clear the binding
         -- a claim recorded (only a fresh claim sets one).
         --
         -- EXCEPT when the write moves a TERMINAL row back to awaiting_payment:
         -- that is a new order generation on a reused orderId, so the previous
         -- generation's binding is dropped rather than inherited (inheriting it
         -- would settle the new order bound to the previous payer's digest).
         -- DENY-LIST HAZARD: a terminal status missing from this list fails
         -- toward the old bug (R2-3). The list is INTERPOLATED from
         -- TERMINAL_STATUSES in payment.ts, so the memory store and this store
         -- cannot disagree; replay_binding.test.ts pins both directions of that
         -- constant (an entry deleted, and an entry added without being mirrored).
         proof_hash=CASE
           WHEN excluded.status = 'awaiting_payment'
            AND gate_orders.status IN (${TERMINAL_STATUS_SQL})
           THEN excluded.proof_hash
           ELSE COALESCE(excluded.proof_hash, gate_orders.proof_hash)
         END,
         updated_at=excluded.updated_at`,
      [
        order.orderId,
        order.tool,
        order.caller,
        order.amountSats,
        JSON.stringify(order.invoice),
        order.status,
        order.result === undefined ? null : JSON.stringify(order.result),
        order.failure === undefined ? null : JSON.stringify(order.failure),
        order.proofHash ?? null,
        order.createdAt,
        order.updatedAt,
      ],
    );
  }
}
