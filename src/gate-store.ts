import { Database } from "bun:sqlite";
import {
  TERMINAL_STATUSES,
  type GateOrder,
  type GateOrderStatus,
  type GateOrderStore,
} from "./payment.ts";

/**
 * Operator bookkeeping for a terminal failure the gate (correctly) refuses to
 * re-run: the sats were taken and the action failed, and an operator has since
 * compensated the customer. This is an AUDIT RECORD, not a status change - see
 * `src/gate-recovery.ts` for why the order status is deliberately left alone.
 */
export interface GateResolution {
  orderId: string;
  outcome: string;
  note: string;
  at: number;
}

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
    // Recovery records are an APPEND-ONLY log: every compensation is kept, so the
    // trail can show a refund followed by a correction (review finding B5). The
    // table was introduced by this same branch with `order_id` as PRIMARY KEY and
    // an upsert on write; that shape silently overwrote history, so it is
    // migrated in place below.
    this.db.run(`
      CREATE TABLE IF NOT EXISTS gate_recovery (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        order_id TEXT NOT NULL,
        outcome TEXT NOT NULL,
        note TEXT NOT NULL,
        at INTEGER NOT NULL
      )`);
    // `PRAGMA table_info` on a real SQLite file: migrate a pre-append-only table
    // (an earlier build of this branch) by rebuilding it and carrying the rows.
    const cols = this.db.query(`PRAGMA table_info(gate_recovery)`).all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === "seq")) {
      this.db.run(`ALTER TABLE gate_recovery RENAME TO gate_recovery_legacy`);
      this.db.run(`
        CREATE TABLE gate_recovery (
          seq INTEGER PRIMARY KEY AUTOINCREMENT,
          order_id TEXT NOT NULL,
          outcome TEXT NOT NULL,
          note TEXT NOT NULL,
          at INTEGER NOT NULL
        )`);
      this.db.run(`
        INSERT INTO gate_recovery (order_id, outcome, note, at)
        SELECT order_id, outcome, note, at FROM gate_recovery_legacy ORDER BY at ASC`);
      this.db.run(`DROP TABLE gate_recovery_legacy`);
    }
  }

  private static rowToOrder(row: any): GateOrder {
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

  get(orderId: string): GateOrder | undefined {
    const row = this.db.query(`SELECT * FROM gate_orders WHERE order_id = ?`).get(orderId) as any;
    if (!row) return undefined;
    return SqliteGateStore.rowToOrder(row);
  }

  /**
   * Every order in one of `statuses` (all orders when omitted), oldest first.
   *
   * An explicitly EMPTY array is not "omitted": it matches nothing. Treating `[]`
   * as "no filter" made `list([])` return the whole table, contradicting the
   * documented contract and turning any caller whose status set happened to come
   * out empty into a full-table scan.
   *
   * Deliberately NOT part of the `GateOrderStore` interface: the gate itself only
   * ever needs point reads, and widening the shared primitive is what the PR #13
   * audit was about. Enumeration is an operator/recovery need that only makes
   * sense over a durable store, so it lives on the concrete implementation.
   */
  list(statuses?: GateOrderStatus | GateOrderStatus[]): GateOrder[] {
    if (statuses !== undefined) {
      const want = Array.isArray(statuses) ? statuses : [statuses];
      if (want.length === 0) return [];
      const rows = this.db
        .query(
          `SELECT * FROM gate_orders WHERE status IN (${want.map(() => "?").join(",")})
           ORDER BY updated_at ASC`,
        )
        .all(...want);
      return (rows as any[]).map(SqliteGateStore.rowToOrder);
    }
    const rows = this.db.query(`SELECT * FROM gate_orders ORDER BY updated_at ASC`).all();
    return (rows as any[]).map(SqliteGateStore.rowToOrder);
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

  /**
   * Release a reservation ONLY if the row is still exactly the revision the
   * operator inspected: `settlement_reserved` AND the same `updated_at`.
   *
   * The status-only CAS the gate uses for its own transitions is NOT enough here.
   * An operator reads the row, sees an expired lease, and then CASes some time
   * later; in between, another operator may release the row and a retry caller may
   * re-claim it, putting it back to `settlement_reserved` — a status the
   * status-only CAS matches. The release would then cancel a LIVE claim without
   * `--force`, and a second caller could start the same action. `updated_at` is
   * set by every transition, so requiring it makes a stale read lose (as `raced`)
   * instead of stealing the new owner's lease. (Review finding B1, round 4.)
   */
  releaseIfUnchanged(orderId: string, expectedUpdatedAt: number): boolean {
    const res = this.db.run(
      `UPDATE gate_orders SET status = 'awaiting_payment', updated_at = ?
       WHERE order_id = ? AND status = 'settlement_reserved' AND updated_at = ?`,
      [Date.now(), orderId, expectedUpdatedAt],
    );
    return Number(res.changes ?? 0) === 1;
  }

  /**
   * Append an operator compensation to the audit log. Deliberately an INSERT, not
   * an upsert: a second compensation (a correction, or a refund following an
   * abandonment) must ADD to the history rather than erase the first entry.
   * Readers that want "the current state" take the LAST record per order.
   */
  putResolution(resolution: GateResolution): void {
    this.db.run(
      `INSERT INTO gate_recovery (order_id, outcome, note, at) VALUES (?, ?, ?, ?)`,
      [resolution.orderId, resolution.outcome, resolution.note, resolution.at],
    );
  }

  /**
   * The full compensation history, oldest first. Append-only: nothing is lost.
   * Ordered by INSERTION (`seq`), not by `at`: the "current" record for an order
   * must be the one written last, and a clock skew or an explicit `now` on a later
   * correction must not resurrect an earlier entry. (Review finding, round 4.)
   */
  listResolutions(): GateResolution[] {
    const rows = this.db
      .query(`SELECT * FROM gate_recovery ORDER BY seq ASC`)
      .all() as any[];
    return rows.map((r) => ({
      orderId: r.order_id,
      outcome: r.outcome,
      note: r.note,
      at: r.at,
    }));
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
